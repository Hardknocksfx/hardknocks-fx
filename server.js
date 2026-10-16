const express = require('express');
const bodyParser = require('body-parser');
const https = require('https');

const app = express();
app.use(bodyParser.json());

// Enable CORS for your frontend dashboard
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept, X-Master-Key');
  res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  if (req.method === 'OPTIONS') {
    return res.sendStatus(200);
  }
  next();
});

// JSONBin v3 Configuration
const JSONBIN_BIN_ID = '6ad059c5ac6210605a32ac57';
const JSONBIN_MASTER_KEY = '$2a$10$wX9BjVvXpOGI9Tr8NfKGze8BEzE4.dwvRIA7PLVcIHOvnTjGBqxg.';

// Helper function to make HTTPS requests to JSONBin
function callJsonBin(method, path, data = null) {
  return new Promise((resolve, reject) => {
    const url = `https://api.jsonbin.io/v3/b/${JSONBIN_BIN_ID}${path}`;
    const options = {
      method: method,
      headers: {
        'Content-Type': 'application/json',
        'X-Master-Key': JSONBIN_MASTER_KEY
      }
    };

    const req = https.request(url, options, (res) => {
      let body = '';
      res.on('data', chunk => body += chunk);
      res.on('end', () => {
        try {
          resolve(JSON.parse(body));
        } catch (e) {
          resolve(body);
        }
      });
    });

    req.on('error', err => reject(err));
    if (data) req.write(JSON.stringify(data));
    req.end();
  });
}

// Webhook endpoint to receive TradingView alerts
app.post('/api/webhook/signal', async (req, res) => {
  try {
    const newSignal = req.body;

    // 1. Strict Asset Validation: Only allow XAUUSD (Gold)
    const assetSym = (newSignal.sym || 'XAUUSD').toUpperCase().replace('/', '');
    if (assetSym !== 'XAUUSD') {
      console.log(`Rejected non-Gold asset: ${assetSym}`);
      return res.status(400).json({ error: 'System restricted exclusively to XAUUSD (Gold).' });
    }

    // 2. Force Status Check
    const sideStr = (newSignal.side || 'BUY').toUpperCase();
    
    let initialStatus = 'open';
    if (newSignal.status) {
      initialStatus = String(newSignal.status).toLowerCase();
    } else if (sideStr.includes('LIMIT')) {
      initialStatus = 'pending';
    }

    // 3. Construct formatted XAUUSD signal object
    const formattedSignal = {
      id: 'sig-' + Date.now(),
      sym: 'XAUUSD',
      side: sideStr,
      entry: Number(newSignal.entry),
      sl: Number(newSignal.sl),
      tp: Number(newSignal.tp),
      rr: Number(newSignal.rr || 2.5),
      score: Number(newSignal.score || 5),
      htf_aligned: true,
      blackout: Boolean(newSignal.blackout || false),
      status: initialStatus, // 'pending', 'open', 'closed', or 'invalidated'
      result: newSignal.result || null,
      r_multiple: newSignal.r_multiple ? Number(newSignal.r_multiple) : null,
      confluence: newSignal.confluence || ['Institutional Order Block', 'Liquidity Sweep'],
      published_at: new Date().toISOString(),
      expires_at: new Date(Date.now() + 12 * 60 * 60 * 1000).toISOString()
    };

    // 4. Fetch current JSONBin record
    const currentData = await callJsonBin('GET', '/latest');
    const record = currentData.record || currentData;
    let signals = record.signals || [];

    if (!Array.isArray(signals)) signals = [];

    // ─── ANTI-DUPLICATE ZONE PROTECTION ──────────────────
    const isDuplicate = signals.some(s => 
      (s.status === 'open' || s.status === 'pending') &&
      s.side === sideStr &&
      Math.abs(s.entry - Number(newSignal.entry)) < 0.5 // Within 50 pips/cents of the same zone
    );

    if (isDuplicate) {
      console.log(`Duplicate signal suppressed for XAUUSD ${sideStr} at Entry ${newSignal.entry}`);
      return res.status(200).json({ success: true, message: 'Duplicate signal suppressed. Active setup already exists in this zone.' });
    }
    // ─────────────────────────────────────────────────────

    // 5. Prepend new signal to the top of the list (keep latest 25)
    signals.unshift(formattedSignal);
    if (signals.length > 25) signals = signals.slice(0, 25);

    // 6. Push updated array back to JSONBin
    const updateResult = await callJsonBin('PUT', '', { signals: signals });

    console.log(`Successfully published XAUUSD signal (${sideStr}) with status [${initialStatus}]: Entry ${formattedSignal.entry}`);
    res.status(200).json({ success: true, message: 'XAUUSD signal published successfully', signal: formattedSignal });

  } catch (err) {
    console.error('Webhook processing error:', err);
    res.status(500).json({ error: 'Internal server error processing webhook' });
  }
});

// Serve static frontend files from your project folder first so root '/' loads index.html
app.use(express.static(__dirname));

// Health check endpoint
app.get('/api/health', (req, res) => {
  res.status(200).json({ status: 'Online', engine: 'Hardknocks Fx XAUUSD Signal Distribution Engine' });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});