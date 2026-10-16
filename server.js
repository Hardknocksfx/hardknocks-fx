const express = require('express');
require('dotenv').config();
const https = require('https');

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 3000;
const JSONBIN_API_KEY = process.env.JSONBIN_API_KEY;
const BIN_ID = process.env.BIN_ID;

// Helper function to make HTTPS requests using native Node.js modules
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
  res.send('Hardknocks Fx Automated Signal Server is running live! 🚀');
});

// Webhook endpoint to receive signals from TradingView
app.post('/api/webhook/signal', async (req, res) => {
  try {
    const newSignal = req.body;

    if (!newSignal.sym || !newSignal.side || !newSignal.entry) {
      return res.status(400).json({ success: false, error: 'Invalid signal payload structure.' });
    }

    // Pass both master key and access key headers to prevent 401/403 authorization mismatches
    const jsonBinHeaders = {
      'X-Master-Key': JSONBIN_API_KEY,
      'X-Access-Key': JSONBIN_API_KEY,
      'Content-Type': 'application/json'
    };

    // 1. Fetch current bin data from JSONBin using native HTTPS
    const getRes = await makeRequest(`https://api.jsonbin.io/v3/b/${BIN_ID}/latest`, {
      headers: jsonBinHeaders
    });
    
    if (!getRes.ok) {
      console.error('JSONBin GET Error Status:', getRes.status, getRes.data);
      return res.status(502).json({ 
        success: false, 
        error: `JSONBin API rejected request (Status ${getRes.status})`, 
        details: getRes.data 
      });
    }
    
    const binData = getRes.data;
    let signalsList = binData.record?.signals || binData.record || [];

    // 2. Prepend the new live signal
    const formattedSignal = {
      id: 'sig-' + Date.now(),
      sym: newSignal.sym,
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
      confluence: newSignal.confluence || ['Smart Money Structure Break', 'Order Block Engagement'],
      published_at: new Date().toISOString(),
      expires_at: new Date(Date.now() + 12 * 60 * 60 * 1000).toISOString()
    };

    signalsList.unshift(formattedSignal);

    // 3. Keep latest 25 signals max
    if (signalsList.length > 25) {
      signalsList = signalsList.slice(0, 25);
    }

    // 4. Push updated list back to JSONBin using native HTTPS
    const postString = JSON.stringify({ signals: signalsList });
    const putRes = await makeRequest(`https://api.jsonbin.io/v3/b/${BIN_ID}`, {
      method: 'PUT',
      headers: {
        ...jsonBinHeaders,
        'Content-Length': Buffer.byteLength(postString)
      }
    }, postString);

    if (!putRes.ok) {
      console.error('JSONBin PUT Error Status:', putRes.status, putRes.data);
      return res.status(502).json({ 
        success: false, 
        error: `JSONBin update failed (Status ${putRes.status})`, 
        details: putRes.data 
      });
    }

    console.log(`[SIGNAL PUBLISHED] ${formattedSignal.sym} ${formattedSignal.side} at ${formattedSignal.entry}`);
    
    res.status(200).json({ success: true, message: 'Signal successfully published to dashboard!', signal: formattedSignal });
  } catch (error) {
    console.error('Server error publishing signal:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

app.listen(PORT, () => {
  console.log(`Hardknocks Fx server listening on port ${PORT}`);
});