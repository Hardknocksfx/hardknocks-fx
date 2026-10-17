const express = require('express');
const bodyParser = require('body-parser');
const https = require('https');

const app = express();

app.use(bodyParser.json({ limit: '1mb' }));

// ============================================================
// CORS
// ============================================================

app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header(
    'Access-Control-Allow-Headers',
    'Origin, X-Requested-With, Content-Type, Accept, X-Master-Key'
  );
  res.header(
    'Access-Control-Allow-Methods',
    'GET, POST, PUT, DELETE, OPTIONS'
  );

  if (req.method === 'OPTIONS') {
    return res.sendStatus(200);
  }

  next();
});

// ============================================================
// JSONBIN CONFIGURATION
// IMPORTANT: use environment variables.
// Never commit your JSONBin master key.
// ============================================================

const JSONBIN_BIN_ID = process.env.JSONBIN_BIN_ID;
const JSONBIN_MASTER_KEY = process.env.JSONBIN_MASTER_KEY;

if (!JSONBIN_BIN_ID || !JSONBIN_MASTER_KEY) {
  console.warn(
    'WARNING: JSONBIN_BIN_ID or JSONBIN_MASTER_KEY is not configured.'
  );
}

// ============================================================
// SIGNAL SETTINGS
// ============================================================

const MAX_SIGNALS = 25;

// Pending signals expire after 12 hours unless TradingView
// explicitly invalidates them earlier.
const DEFAULT_EXPIRY_HOURS = 12;

// How often the server checks for expired pending signals.
const LIFECYCLE_INTERVAL_MS = 60 * 1000;

// ============================================================
// JSONBIN HELPER
// ============================================================

function callJsonBin(method, path, data = null) {
  return new Promise((resolve, reject) => {

    if (!JSONBIN_BIN_ID || !JSONBIN_MASTER_KEY) {
      return reject(
        new Error('JSONBin environment variables are not configured.')
      );
    }

    const url =
      `https://api.jsonbin.io/v3/b/${JSONBIN_BIN_ID}${path}`;

    const options = {
      method,
      headers: {
        'Content-Type': 'application/json',
        'X-Master-Key': JSONBIN_MASTER_KEY
      }
    };

    const req = https.request(url, options, (res) => {

      let body = '';

      res.on('data', chunk => {
        body += chunk;
      });

      res.on('end', () => {

        try {
          const parsed = JSON.parse(body);

          if (res.statusCode >= 400) {
            return reject(
              new Error(
                `JSONBin HTTP ${res.statusCode}: ${JSON.stringify(parsed)}`
              )
            );
          }

          resolve(parsed);

        } catch (err) {

          if (res.statusCode >= 400) {
            return reject(
              new Error(
                `JSONBin HTTP ${res.statusCode}: ${body}`
              )
            );
          }

          resolve(body);
        }
      });
    });

    req.on('error', reject);

    if (data) {
      req.write(JSON.stringify(data));
    }

    req.end();
  });
}

// ============================================================
// GET SIGNAL DATABASE
// ============================================================

async function getSignals() {

  const currentData =
    await callJsonBin('GET', '/latest');

  const record =
    currentData.record || currentData;

  let signals =
    record.signals || [];

  if (!Array.isArray(signals)) {
    signals = [];
  }

  return signals;
}

// ============================================================
// SAVE SIGNAL DATABASE
// ============================================================

async function saveSignals(signals) {

  return await callJsonBin(
    'PUT',
    '',
    {
      signals
    }
  );
}

// ============================================================
// NORMALIZE STATUS
// ============================================================

function normalizeStatus(status) {

  if (!status) {
    return 'pending';
  }

  const value =
    String(status).toLowerCase().trim();

  const aliases = {
    open: 'active',
    live: 'active',
    active: 'active',

    pending: 'pending',
    'pending limit': 'pending',

    closed: 'closed',

    win: 'win',
    winner: 'win',
    tp: 'win',

    loss: 'loss',
    loser: 'loss',
    sl: 'loss',

    invalidated: 'invalidated',
    invalid: 'invalidated',
    expired: 'invalidated'
  };

  return aliases[value] || value;
}

// ============================================================
// DETERMINE ORDER TYPE / DIRECTION
// ============================================================

function parseSignalSide(side) {

  const value =
    String(side || 'BUY')
      .toUpperCase()
      .trim();

  const isBuy =
    value.includes('BUY');

  const isSell =
    value.includes('SELL');

  const isLimit =
    value.includes('LIMIT');

  return {
    direction: isSell ? 'SELL' : 'BUY',
    orderType: isLimit ? 'LIMIT' : 'MARKET'
  };
}

// ============================================================
// DETERMINE INITIAL STATUS
// ============================================================

function determineInitialStatus(newSignal) {

  const parsed =
    parseSignalSide(newSignal.side);

  // Explicit status from TradingView gets priority.
  if (newSignal.status) {

    const supplied =
      normalizeStatus(newSignal.status);

    if (
      supplied === 'win' ||
      supplied === 'loss' ||
      supplied === 'invalidated'
    ) {
      return supplied;
    }

    if (supplied === 'active') {
      return 'active';
    }
  }

  // Limit orders begin as PENDING.
  if (parsed.orderType === 'LIMIT') {
    return 'pending';
  }

  // Market orders are immediately ACTIVE.
  return 'active';
}

// ============================================================
// VALIDATE XAUUSD
// ============================================================

function validateXAUUSD(symbol) {

  return String(symbol || 'XAUUSD')
    .toUpperCase()
    .replace('/', '')
    .replace('_', '') === 'XAUUSD';
}

// ============================================================
// CREATE SIGNAL
// ============================================================

app.post('/api/webhook/signal', async (req, res) => {

  try {

    const newSignal =
      req.body || {};

    // --------------------------------------------------------
    // XAUUSD ONLY
    // --------------------------------------------------------

    const assetSym =
      String(newSignal.sym || 'XAUUSD')
        .toUpperCase()
        .replace('/', '')
        .replace('_', '');

    if (!validateXAUUSD(assetSym)) {

      console.log(
        `Rejected non-Gold asset: ${assetSym}`
      );

      return res.status(400).json({
        error:
          'System restricted exclusively to XAUUSD (Gold).'
      });
    }

    // --------------------------------------------------------
    // PARSE SIDE
    // --------------------------------------------------------

    const sideStr =
      String(newSignal.side || 'BUY')
        .toUpperCase();

    const parsedSide =
      parseSignalSide(sideStr);

    // --------------------------------------------------------
    // PRICE VALUES
    // --------------------------------------------------------

    const entry =
      Number(newSignal.entry);

    const sl =
      Number(newSignal.sl);

    const tp =
      Number(newSignal.tp);

    if (
      !Number.isFinite(entry) ||
      !Number.isFinite(sl) ||
      !Number.isFinite(tp)
    ) {

      return res.status(400).json({
        error:
          'Invalid XAUUSD entry, stop-loss or take-profit.'
      });
    }

    // --------------------------------------------------------
    // INITIAL STATUS
    // --------------------------------------------------------

    const initialStatus =
      determineInitialStatus(newSignal);

    // --------------------------------------------------------
    // EXPIRY
    // --------------------------------------------------------

    const expiryHours =
      Number(
        newSignal.expiry_hours ||
        DEFAULT_EXPIRY_HOURS
      );

    const expiresAt =
      new Date(
        Date.now() +
        expiryHours * 60 * 60 * 1000
      ).toISOString();

    // --------------------------------------------------------
    // CREATE SIGNAL OBJECT
    // --------------------------------------------------------

    const formattedSignal = {

      id:
        'sig-' +
        Date.now() +
        '-' +
        Math.random()
          .toString(36)
          .substring(2, 8),

      sym: 'XAUUSD',

      side: sideStr,

      direction:
        parsedSide.direction,

      orderType:
        parsedSide.orderType,

      entry,

      sl,

      tp,

      rr:
        Number(newSignal.rr || 2.5),

      score:
        Number(newSignal.score || 5),

      htf_aligned:
        newSignal.htf_aligned !== false,

      blackout:
        Boolean(
          newSignal.blackout || false
        ),

      status:
        initialStatus,

      result:
        newSignal.result || null,

      r_multiple:
        newSignal.r_multiple !== undefined &&
        newSignal.r_multiple !== null
          ? Number(newSignal.r_multiple)
          : null,

      confluence:
        Array.isArray(newSignal.confluence)
          ? newSignal.confluence
          : [
              'Institutional Order Block',
              'Liquidity Sweep'
            ],

      published_at:
        new Date().toISOString(),

      triggered_at:
        initialStatus === 'active'
          ? new Date().toISOString()
          : null,

      closed_at:
        null,

      invalidated_at:
        null,

      expires_at:
        expiresAt,

      trigger_price:
        initialStatus === 'active'
          ? entry
          : null
    };

    // --------------------------------------------------------
    // FETCH CURRENT SIGNALS
    // --------------------------------------------------------

    const signals =
      await getSignals();

    // --------------------------------------------------------
    // ANTI-DUPLICATE ZONE PROTECTION
    // Only pending/active signals count.
    // --------------------------------------------------------

    const isDuplicate =
      signals.some(signal => {

        const status =
          normalizeStatus(signal.status);

        return (
          (
            status === 'pending' ||
            status === 'active'
          ) &&
          signal.direction ===
            parsedSide.direction &&
          Math.abs(
            Number(signal.entry) - entry
          ) < 0.5
        );
      });

    if (isDuplicate) {

      console.log(
        `Duplicate XAUUSD setup suppressed: ` +
        `${sideStr} @ ${entry}`
      );

      return res.status(200).json({
        success: true,
        message:
          'Duplicate XAUUSD setup suppressed.',
        existing_setup: true
      });
    }

    // --------------------------------------------------------
    // ADD NEW SIGNAL
    // --------------------------------------------------------

    signals.unshift(
      formattedSignal
    );

    // Keep latest 25 records.
    const trimmedSignals =
      signals.slice(0, MAX_SIGNALS);

    // --------------------------------------------------------
    // SAVE
    // --------------------------------------------------------

    await saveSignals(
      trimmedSignals
    );

    console.log(
      `Published XAUUSD ${parsedSide.orderType} ` +
      `${parsedSide.direction} | ` +
      `Entry ${entry} | ` +
      `Status ${initialStatus}`
    );

    return res.status(200).json({
      success: true,
      message:
        'XAUUSD signal published successfully.',
      signal:
        formattedSignal
    });

  } catch (err) {

    console.error(
      'Webhook processing error:',
      err
    );

    return res.status(500).json({
      error:
        'Internal server error processing webhook.'
    });
  }
});

// ============================================================
// MARKET PRICE ENGINE
// ============================================================
//
// Your price source / frontend / TradingView bridge should POST:
//
// {
//   "symbol": "XAUUSD",
//   "price": 4165.20
// }
//
// The server then determines:
// PENDING -> ACTIVE
// ACTIVE  -> WIN
// ACTIVE  -> LOSS
// ============================================================

app.post('/api/market-price', async (req, res) => {

  try {

    const symbol =
      String(
        req.body.symbol ||
        req.body.sym ||
        'XAUUSD'
      )
      .toUpperCase()
      .replace('/', '')
      .replace('_', '');

    if (!validateXAUUSD(symbol)) {

      return res.status(400).json({
        error:
          'Only XAUUSD price updates are accepted.'
      });
    }

    const price =
      Number(
        req.body.price ||
        req.body.last ||
        req.body.close
      );

    if (!Number.isFinite(price)) {

      return res.status(400).json({
        error:
          'A valid XAUUSD price is required.'
      });
    }

    const signals =
      await getSignals();

    let changed = false;

    for (const signal of signals) {

      const status =
        normalizeStatus(signal.status);

      const direction =
        String(
          signal.direction ||
          parseSignalSide(signal.side).direction
        ).toUpperCase();

      const entry =
        Number(signal.entry);

      const sl =
        Number(signal.sl);

      const tp =
        Number(signal.tp);

      // ======================================================
      // PENDING -> ACTIVE
      // ======================================================

      if (status === 'pending') {

        let triggered = false;

        if (
          direction === 'BUY' &&
          price <= entry
        ) {
          triggered = true;
        }

        if (
          direction === 'SELL' &&
          price >= entry
        ) {
          triggered = true;
        }

        if (triggered) {

          signal.status =
            'active';

          signal.triggered_at =
            new Date().toISOString();

          signal.trigger_price =
            price;

          signal.result =
            null;

          console.log(
            `XAUUSD signal triggered: ` +
            `${signal.id} @ ${price}`
          );

          changed = true;
        }
      }

      // ======================================================
      // ACTIVE -> WIN / LOSS
      // ======================================================

      if (
        normalizeStatus(signal.status) ===
        'active'
      ) {

        // BUY
        if (direction === 'BUY') {

          // TP hit first
          if (price >= tp) {

            signal.status =
              'win';

            signal.result =
              'WIN';

            signal.r_multiple =
              Number(signal.rr || 0);

            signal.closed_at =
              new Date().toISOString();

            console.log(
              `XAUUSD WIN: ${signal.id}`
            );

            changed = true;
          }

          // SL hit
          else if (price <= sl) {

            signal.status =
              'loss';

            signal.result =
              'LOSS';

            signal.r_multiple =
              -1;

            signal.closed_at =
              new Date().toISOString();

            console.log(
              `XAUUSD LOSS: ${signal.id}`
            );

            changed = true;
          }
        }

        // SELL
        if (direction === 'SELL') {

          // TP hit
          if (price <= tp) {

            signal.status =
              'win';

            signal.result =
              'WIN';

            signal.r_multiple =
              Number(signal.rr || 0);

            signal.closed_at =
              new Date().toISOString();

            console.log(
              `XAUUSD WIN: ${signal.id}`
            );

            changed = true;
          }

          // SL hit
          else if (price >= sl) {

            signal.status =
              'loss';

            signal.result =
              'LOSS';

            signal.r_multiple =
              -1;

            signal.closed_at =
              new Date().toISOString();

            console.log(
              `XAUUSD LOSS: ${signal.id}`
            );

            changed = true;
          }
        }
      }
    }

    // --------------------------------------------------------
    // SAVE ONLY IF SOMETHING CHANGED
    // --------------------------------------------------------

    if (changed) {

      await saveSignals(
        signals.slice(0, MAX_SIGNALS)
      );
    }

    return res.json({

      success: true,

      symbol: 'XAUUSD',

      price,

      updated: changed,

      live_signals:
        signals.filter(signal => {

          const status =
            normalizeStatus(signal.status);

          return (
            status === 'pending' ||
            status === 'active'
          );
        }).length,

      track_record:
        signals.filter(signal => {

          const status =
            normalizeStatus(signal.status);

          return (
            status === 'win' ||
            status === 'loss' ||
            status === 'invalidated'
          );
        }).length
    });

  } catch (err) {

    console.error(
      'Market price engine error:',
      err
    );

    return res.status(500).json({
      error:
        'Unable to process XAUUSD market price.'
    });
  }
});

// ============================================================
// MANUAL INVALIDATION ENDPOINT
// ============================================================
//
// Useful if TradingView/your strategy determines that a
// pending setup is no longer valid.
//
// POST:
// {
//   "signalId": "sig-..."
// }
// ============================================================

app.post('/api/signals/:id/invalidate', async (req, res) => {

  try {

    const signalId =
      req.params.id;

    const signals =
      await getSignals();

    const signal =
      signals.find(
        s => s.id === signalId
      );

    if (!signal) {

      return res.status(404).json({
        error:
          'XAUUSD signal not found.'
      });
    }

    const status =
      normalizeStatus(signal.status);

    // Never invalidate a completed trade.
    if (
      status === 'win' ||
      status === 'loss'
    ) {

      return res.status(400).json({
        error:
          'Completed XAUUSD trades cannot be invalidated.'
      });
    }

    signal.status =
      'invalidated';

    signal.result =
      'INVALIDATED';

    signal.invalidated_at =
      new Date().toISOString();

    await saveSignals(
      signals.slice(0, MAX_SIGNALS)
    );

    console.log(
      `XAUUSD signal invalidated: ${signalId}`
    );

    return res.json({
      success: true,
      signal
    });

  } catch (err) {

    console.error(
      'Invalidation error:',
      err
    );

    return res.status(500).json({
      error:
        'Unable to invalidate XAUUSD signal.'
    });
  }
});

// ============================================================
// GET ALL SIGNALS
// ============================================================

app.get('/api/signals', async (req, res) => {

  try {

    const signals =
      await getSignals();

    return res.json({
      success: true,
      symbol: 'XAUUSD',
      signals
    });

  } catch (err) {

    console.error(
      'Signal retrieval error:',
      err
    );

    return res.status(500).json({
      error:
        'Unable to retrieve XAUUSD signals.'
    });
  }
});

// ============================================================
// LIVE SIGNAL FEED
// PENDING + ACTIVE ONLY
// ============================================================

app.get('/api/signals/live', async (req, res) => {

  try {

    const signals =
      await getSignals();

    const live =
      signals.filter(signal => {

        const status =
          normalizeStatus(signal.status);

        return (
          status === 'pending' ||
          status === 'active'
        );
      });

    return res.json({
      success: true,
      symbol: 'XAUUSD',
      signals: live
    });

  } catch (err) {

    console.error(
      'Live signal retrieval error:',
      err
    );

    return res.status(500).json({
      error:
        'Unable to retrieve live XAUUSD signals.'
    });
  }
});

// ============================================================
// XAUUSD TRACK RECORD
// WIN + LOSS + INVALIDATED
// ============================================================

app.get('/api/track-record', async (req, res) => {

  try {

    const signals =
      await getSignals();

    const trackRecord =
      signals.filter(signal => {

        const status =
          normalizeStatus(signal.status);

        return (
          status === 'win' ||
          status === 'loss' ||
          status === 'invalidated'
        );
      });

    const wins =
      trackRecord.filter(
        s => normalizeStatus(s.status) === 'win'
      ).length;

    const losses =
      trackRecord.filter(
        s => normalizeStatus(s.status) === 'loss'
      ).length;

    const invalidated =
      trackRecord.filter(
        s => normalizeStatus(s.status) === 'invalidated'
      ).length;

    const completed =
      wins + losses;

    const winRate =
      completed > 0
        ? Number(
            ((wins / completed) * 100).toFixed(2)
          )
        : 0;

    return res.json({

      success: true,

      symbol: 'XAUUSD',

      summary: {
        wins,
        losses,
        invalidated,
        completed,
        winRate
      },

      signals:
        trackRecord
    });

  } catch (err) {

    console.error(
      'Track record error:',
      err
    );

    return res.status(500).json({
      error:
        'Unable to retrieve XAUUSD track record.'
    });
  }
});

// ============================================================
// AUTOMATIC EXPIRATION ENGINE
// ============================================================
//
// Pending orders that reach expires_at without triggering
// become INVALIDATED.
//
// They are NOT counted as losses.
// ============================================================

async function expirePendingSignals() {

  try {

    const signals =
      await getSignals();

    const now =
      Date.now();

    let changed = false;

    for (const signal of signals) {

      const status =
        normalizeStatus(signal.status);

      if (status !== 'pending') {
        continue;
      }

      if (!signal.expires_at) {
        continue;
      }

      const expiry =
        new Date(signal.expires_at).getTime();

      if (
        Number.isFinite(expiry) &&
        now >= expiry
      ) {

        signal.status =
          'invalidated';

        signal.result =
          'INVALIDATED';

        signal.invalidated_at =
          new Date().toISOString();

        console.log(
          `XAUUSD pending signal expired: ${signal.id}`
        );

        changed = true;
      }
    }

    if (changed) {

      await saveSignals(
        signals.slice(0, MAX_SIGNALS)
      );
    }

  } catch (err) {

    console.error(
      'Pending expiration engine error:',
      err
    );
  }
}

// Serverless functions are not persistent workers. Run this timer only
// when started as a conventional Node server; Netlify scheduled work should
// use a Scheduled Function if periodic expiry is required.
if (require.main === module) {
  setInterval(expirePendingSignals, LIFECYCLE_INTERVAL_MS);
  expirePendingSignals();
}

// ============================================================
// HEALTH CHECK
// ============================================================

app.get('/api/health', (req, res) => {

  res.status(200).json({

    status: 'Online',

    engine:
      'Hardknocks Fx XAUUSD Signal Lifecycle Engine',

    symbol:
      'XAUUSD',

    lifecycle: [
      'PENDING',
      'ACTIVE',
      'WIN',
      'LOSS',
      'INVALIDATED'
    ],

    timestamp:
      new Date().toISOString()
  });
});

// ============================================================
// LOCAL SERVER + NETLIFY EXPORT
// ============================================================

if (require.main === module) {
  const PORT = process.env.PORT || 3000;
  app.listen(PORT, () => {
    console.log(`Hardknocks XAUUSD Signal Server running on port ${PORT}`);
    console.log('Lifecycle engine: PENDING → ACTIVE → WIN/LOSS');
    console.log('Expired pending setups → INVALIDATED');
  });
}

module.exports = app;
