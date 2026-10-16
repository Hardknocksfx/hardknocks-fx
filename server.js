const express = require('express');
require('dotenv').config();
const https = require('https');

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 3000;
const JSONBIN_API_KEY = process.env.JSONBIN_API_KEY;
const BIN_ID = process.env.BIN_ID;

// Helper function for ultra-fast native HTTPS requests
const makeRequest = (url, options = {}, postData = null) => {
  return new Promise((resolve, reject) => {
    const urlObj = new URL(url);
    const reqOptions = {
      hostname: urlObj.hostname,
      path: urlObj.pathname + urlObj.search,
      method: options.method || 'GET',
      headers: options.headers || {}
    };

    const req = https.request(reqOptions, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        let parsedData = {};
        try { parsedData = JSON.parse(data); } catch (e) { parsedData = { raw: data }; }
        resolve({
          ok: res.statusCode >= 200 && res.statusCode < 300,
          status: res.statusCode,
          data: parsedData
        });
      });
    });

    req.on('error', (err) => { reject(err); });

    if (postData) {
      req.write(postData);
    }
    req.end();
  });
};

// Health check endpoint
app.get('/', (req, res) => {
  res.send('Hardknocks Fx XAUUSD Signal Engine is live & optimized! ⚡');
});

// Webhook endpoint exclusively for XAUUSD real-time alerts
app.post('/api/webhook/signal', async (req, res) => {
  try {
    const newSignal = req.body;

    // Strict validation: enforce XAUUSD only
    const symbol = (newSignal.sym || '').toUpperCase();
    if (symbol !== 'XAUUSD' || !newSignal.side || !newSignal.entry) {
      return res.status(400).json({ 
        success: false, 
        error: 'Rejected: Engine is locked exclusively to XAUUSD signals with valid side and entry.' 
      });
    }

    const jsonBinHeaders = {
      'X-Master-Key': JSONBIN_API_KEY,
      'X-Access-Key': JSONBIN_API_KEY,
      'Content-Type': 'application/json'
    };

    // 1. Fetch current bin data
    const getRes = await makeRequest(`https://api.jsonbin.io/v3/b/${BIN_ID}/latest`, {
      headers: jsonBinHeaders
    });
    
    if (!getRes.ok) {
      throw new Error(`Failed to fetch current signals from JSONBin (Status ${getRes.status})`);
    }
    
    let signalsList = getRes.data.record?.signals || getRes.data.record || [];

    // 2. Format the real-time XAUUSD signal
    const formattedSignal = {
      id: 'sig-' + Date.now(),
      sym: 'XAUUSD',
      side: newSignal.side.toUpperCase(),
      entry: Number(newSignal.entry),
      sl: Number(newSignal.sl),
      tp: Number(newSignal.tp),
      rr: Number(newSignal.rr || 2.5),
      score: Number(newSignal.score || 5),
      htf_aligned: true,
      blackout: Boolean(newSignal.blackout || false),
      status: 'open',
      result: null,
      r_multiple: null,
      confluence: newSignal.confluence || ['Institutional Liquidity Sweep', 'XAUUSD Order Block'],
      published_at: new Date().toISOString(),
      expires_at: new Date(Date.now() + 12 * 60 * 60 * 1000).toISOString()
    };

    // Prepend new signal for instant top-of-feed display
    signalsList.unshift(formattedSignal);

    // Keep latest 25 signals max for peak performance
    if (signalsList.length > 25) {
      signalsList = signalsList.slice(0, 25);
    }

    // 3. Push updated list back to JSONBin
    const postString = JSON.stringify({ signals: signalsList });
    const putRes = await makeRequest(`https://api.jsonbin.io/v3/b/${BIN_ID}`, {
      method: 'PUT',
      headers: {
        ...jsonBinHeaders,
        'Content-Length': Buffer.byteLength(postString)
      }
    }, postString);

    if (!putRes.ok) {
      throw new Error(`Failed to update JSONBin record (Status ${putRes.status})`);
    }

    console.log(`[XAUUSD EXECUTED] ${formattedSignal.side} at ${formattedSignal.entry}`);
    
    res.status(200).json({ success: true, message: 'XAUUSD signal published instantly!', signal: formattedSignal });
  } catch (error) {
    console.error('Server error publishing XAUUSD signal:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

app.listen(PORT, () => {
  console.log(`Hardknocks Fx XAUUSD Engine listening on port ${PORT}`);
});