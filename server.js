const express = require('express');
const fetch = require('node-fetch').default; // <-- Added .default here
require('dotenv').config();

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 3000;
const JSONBIN_API_KEY = process.env.JSONBIN_API_KEY;
const BIN_ID = process.env.BIN_ID;

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

    // 1. Fetch current bin data from JSONBin
    const getRes = await fetch(`https://api.jsonbin.io/v3/b/${BIN_ID}/latest`, {
      headers: { 'X-Master-Key': JSONBIN_API_KEY }
    });
    
    if (!getRes.ok) throw new Error('Failed to fetch current signals from JSONBin');
    
    const binData = await getRes.json();
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

    // 4. Push updated list back to JSONBin
    const putRes = await fetch(`https://api.jsonbin.io/v3/b/${BIN_ID}`, {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
        'X-Master-Key': JSONBIN_API_KEY
      },
      body: JSON.stringify({ signals: signalsList })
    });

    if (!putRes.ok) throw new Error('Failed to update JSONBin record');

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