require('dotenv').config();


const express = require('express');
const path = require('path');
const bodyParser = require('body-parser');
const https = require('https');

const app = express();
let cache = { data: null, timestamp: 0 };
const CACHE_TTL = 60000; // 60 seconds

// Serve static files (index.html, api.js) from project root
app.use(express.static(__dirname));

app.use(bodyParser.json({ limit: '1mb' }));

// ... your existing API routes below ...

// ============================================================
// CORS
// Set DASHBOARD_ORIGINS in Render to comma-separated origins, e.g.
// https://your-site.netlify.app,https://your-custom-domain.com
// ============================================================
const cors = require('cors');

const allowedOrigins = (process.env.DASHBOARD_ORIGINS || process.env.DASHBOARD_ORIGIN || '')
  .split(',')
  .map(origin => origin.trim().replace(/\/$/, ''))
  .filter(Boolean);

app.use(cors({
  origin(origin, callback) {
    // Permit non-browser calls (health checks, curl, server-to-server).
    if (!origin) return callback(null, true);
    if (allowedOrigins.includes(origin.replace(/\/$/, ''))) return callback(null, true);
    return callback(new Error('Origin not allowed by CORS'));
  },
  methods: ['GET', 'POST', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'X-Webhook-Secret', 'X-API-Key'],
  optionsSuccessStatus: 204
}));

// ============================================================
// JSONBIN CONFIGURATION
// IMPORTANT: use environment variables.
// Never commit your JSONBin master key.
// ============================================================

const JSONBIN_BIN_ID = process.env.JSONBIN_BIN_ID;
const JSONBIN_MASTER_KEY = process.env.JSONBIN_MASTER_KEY;
const SIGNAL_WEBHOOK_SECRET = process.env.SIGNAL_WEBHOOK_SECRET || '';
const MARKET_PRICE_API_KEY = process.env.MARKET_PRICE_API_KEY || '';
const ADMIN_API_KEY = process.env.ADMIN_API_KEY || '';

if (!JSONBIN_BIN_ID || !JSONBIN_MASTER_KEY) {
  console.warn(
    'WARNING: JSONBIN_BIN_ID or JSONBIN_MASTER_KEY is not configured.'
  );
}

// ============================================================
// SIGNAL SETTINGS
// ============================================================

const MAX_SIGNALS = Math.max(25, Number.parseInt(process.env.MAX_SIGNALS || '500', 10) || 500);

// Pending signals expire after 12 hours unless TradingView
// explicitly invalidates them earlier.
const DEFAULT_EXPIRY_HOURS = 12;

// How often the server checks for expired pending signals.
const LIFECYCLE_INTERVAL_MS = 60 * 1000;

// ============================================================
// OPTIONAL WRITE-ENDPOINT AUTHENTICATION
// Configure these secrets in Render to enforce authentication.
// Existing integrations keep working until a secret is configured.
// ============================================================
function suppliedSecret(req) {
  const authorization = String(req.get('authorization') || '');
  const bearer = authorization.match(/^Bearer\s+(.+)$/i);
  return req.get('x-webhook-secret') || req.get('x-api-key') ||
    (bearer ? bearer[1] : '') || (req.body && req.body.secret) || '';
}

function requireConfiguredSecret(expectedSecret, label) {
  return (req, res, next) => {
    if (!expectedSecret) return next();
    const actual = String(suppliedSecret(req));
    if (actual.length !== expectedSecret.length ||
        !require('crypto').timingSafeEqual(Buffer.from(actual), Buffer.from(expectedSecret))) {
      return res.status(401).json({ success: false, error: `Unauthorized ${label} request.` });
    }
    return next();
  };
}

const authenticateWebhook = requireConfiguredSecret(SIGNAL_WEBHOOK_SECRET, 'webhook');
const authenticateMarketPrice = requireConfiguredSecret(MARKET_PRICE_API_KEY, 'market-price');
const authenticateAdmin = requireConfiguredSecret(ADMIN_API_KEY, 'admin');

if (!SIGNAL_WEBHOOK_SECRET || !MARKET_PRICE_API_KEY || !ADMIN_API_KEY) {
  console.warn('SECURITY WARNING: one or more write-endpoint secrets are unset. Configure SIGNAL_WEBHOOK_SECRET, MARKET_PRICE_API_KEY, and ADMIN_API_KEY in Render.');
}

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

    req.setTimeout(10000, () => {
      req.destroy(new Error('JSONBin request timed out after 10 seconds.'));
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
// NORMALIZE STATUS AND LEGACY SIGNALS
// Legacy `open` BUY/SELL LIMIT records without triggered_at are pending,
// not active. Explicit `active` records remain active.
// ============================================================
function normalizeStatus(status, signal = null) {
  if (!status) return signal ? inferLegacyStatus(signal) : 'pending';
  const value = String(status).toLowerCase().trim();
  if (value === 'open' || value === 'live') {
    if (signal) return inferLegacyStatus({ ...signal, status: value });
    return 'open';
  }
  const aliases = {
    active: 'active', pending: 'pending', 'pending limit': 'pending',
    closed: 'closed', win: 'win', winner: 'win', tp: 'win', take_profit: 'win',
    loss: 'loss', loser: 'loss', sl: 'loss', stop_loss: 'loss',
    invalidated: 'invalidated', invalid: 'invalidated', expired: 'invalidated',
    cancelled: 'invalidated', canceled: 'invalidated'
  };
  return aliases[value] || value;
}

function inferLegacyStatus(signal) {
  const raw = String(signal?.status || '').toLowerCase().trim();
  if (['win','winner','tp','take_profit'].includes(raw)) return 'win';
  if (['loss','loser','sl','stop_loss'].includes(raw)) return 'loss';
  if (['invalidated','invalid','expired','cancelled','canceled'].includes(raw)) return 'invalidated';
  if (raw === 'pending' || raw === 'pending limit') return 'pending';
  if (raw === 'active') return 'active';
  const side = String(signal?.side || '').toUpperCase();
  const orderType = String(signal?.orderType || '').toUpperCase();
  if ((orderType === 'LIMIT' || side.includes('LIMIT')) && !signal?.triggered_at) return 'pending';
  if (raw === 'open' || raw === 'live') return 'active';
  return raw || 'pending';
}

// ============================================================
// DETERMINE ORDER TYPE / DIRECTION
// ============================================================
function parseSignalSide(side) {
  const value = String(side || 'BUY').toUpperCase().trim();
  const direction = value.includes('SELL') ? 'SELL' : 'BUY';
  const orderType = value.includes('LIMIT') ? 'LIMIT' : (value.includes('STOP') ? 'STOP' : 'MARKET');
  return { direction, orderType };
}

// ============================================================
// DETERMINE INITIAL STATUS
// ============================================================
function determineInitialStatus(newSignal) {
  const parsed = parseSignalSide(newSignal.side);
  const supplied = newSignal.status ? normalizeStatus(newSignal.status) : '';
  if (['win', 'loss', 'invalidated'].includes(supplied)) return supplied;
  if (supplied === 'active' && parsed.orderType === 'MARKET') return 'active';
  // Limit/stop entries are not active until the market triggers them.
  if (parsed.orderType === 'LIMIT' || parsed.orderType === 'STOP') return 'pending';
  return 'active';
}

function calculateRiskReward(direction, entry, sl, tp) {
  const risk = direction === 'BUY' ? entry - sl : sl - entry;
  const reward = direction === 'BUY' ? tp - entry : entry - tp;
  if (!(risk > 0) || !(reward > 0)) return null;
  return Number((reward / risk).toFixed(2));
}

function validateTradeGeometry(direction, entry, sl, tp) {
  if (![entry, sl, tp].every(Number.isFinite) || entry <= 0 || sl <= 0 || tp <= 0) return false;
  return direction === 'BUY' ? (sl < entry && entry < tp) : (tp < entry && entry < sl);
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

app.post('/api/webhook/signal', authenticateWebhook, async (req, res) => {

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

    if (!validateTradeGeometry(parsedSide.direction, entry, sl, tp)) {
      return res.status(400).json({
        success: false,
        error: `Invalid ${parsedSide.direction} price geometry. BUY requires SL < entry < TP; SELL requires TP < entry < SL.`
      });
    }

    const calculatedRR = calculateRiskReward(parsedSide.direction, entry, sl, tp);

    // --------------------------------------------------------
    // INITIAL STATUS
    // --------------------------------------------------------

    const initialStatus =
      determineInitialStatus(newSignal);

    // --------------------------------------------------------
    // EXPIRY
    // --------------------------------------------------------

    const requestedExpiry = Number(newSignal.expiry_hours ?? DEFAULT_EXPIRY_HOURS);
    const expiryHours = Number.isFinite(requestedExpiry)
      ? Math.min(168, Math.max(0.25, requestedExpiry))
      : DEFAULT_EXPIRY_HOURS;
    const expiresAt = new Date(Date.now() + expiryHours * 60 * 60 * 1000).toISOString();

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

      rr: calculatedRR,

      score: Math.min(5, Math.max(0, Number.isFinite(Number(newSignal.score)) ? Number(newSignal.score) : 0)),

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
          normalizeStatus(signal.status, signal);

        return (
          (
            status === 'pending' ||
            status === 'active'
          ) &&
          String(signal.direction || parseSignalSide(signal.side).direction).toUpperCase() ===
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

app.post('/api/market-price', authenticateMarketPrice, async (req, res) => {

  try {

    const body = req.body || {};
    const symbol =
      String(
        body.symbol ||
        body.sym ||
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
        body.price ??
        body.last ??
        body.close
      );

    if (!Number.isFinite(price) || price <= 0) {

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
        normalizeStatus(signal.status, signal);

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

        const orderType = String(signal.orderType || parseSignalSide(signal.side).orderType).toUpperCase();
        if (orderType === 'LIMIT') {
          if (direction === 'BUY' && price <= entry) triggered = true;
          if (direction === 'SELL' && price >= entry) triggered = true;
        } else if (orderType === 'STOP') {
          if (direction === 'BUY' && price >= entry) triggered = true;
          if (direction === 'SELL' && price <= entry) triggered = true;
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
        normalizeStatus(signal.status, signal) ===
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
  await saveSignals(signals.slice(0, MAX_SIGNALS));
  cache = { data: null, timestamp: 0 };
}

    return res.json({

      success: true,

      symbol: 'XAUUSD',

      price,

      updated: changed,

      live_signals:
        signals.filter(signal => {

          const status =
            normalizeStatus(signal.status, signal);

          return (
            status === 'pending' ||
            status === 'active'
          );
        }).length,

      track_record:
        signals.filter(signal => {

          const status =
            normalizeStatus(signal.status, signal);

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

app.post('/api/signals/:id/invalidate', authenticateAdmin, async (req, res) => {

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
      normalizeStatus(signal.status, signal);

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
  const now = Date.now();

  if (cache.data && now - cache.timestamp < CACHE_TTL) {
    return res.json(cache.data);
  }

  try {
    const allSignals = await getSignals();

    const data = {
      success: true,
      symbol: 'XAUUSD',
      signals: allSignals
    };

    cache = { data, timestamp: now };
    return res.json(data);
  } catch (err) {
    console.error('Signals retrieval error:', err.message);

    return res.status(500).json({
      success: false,
      symbol: 'XAUUSD',
      error: 'Unable to retrieve signals from storage.'
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
          normalizeStatus(signal.status, signal);

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
    const allSignals = await getSignals();

    const wins = allSignals.filter(s =>
      ['WIN', 'WINNER', 'TP', 'TAKE_PROFIT'].includes(
        String(s.status || '').toUpperCase()
      ) ||
      ['WIN'].includes(String(s.result || '').toUpperCase())
    ).length;

    const losses = allSignals.filter(s =>
      ['LOSS', 'LOSER', 'SL', 'STOP_LOSS'].includes(
        String(s.status || '').toUpperCase()
      ) ||
      ['LOSS'].includes(String(s.result || '').toUpperCase())
    ).length;

    const invalidated = allSignals.filter(s =>
      String(s.status || '').toUpperCase() === 'INVALIDATED'
    ).length;

    const completed = wins + losses;
    const winRate = completed > 0
      ? Math.round((wins / completed) * 100)
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
      signals: allSignals
    });
  } catch (err) {
    console.error('Track record retrieval error:', err.message);

    return res.status(500).json({
      success: false,
      symbol: 'XAUUSD',
      error: 'Unable to retrieve track record from storage.'
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
    const signals = await getSignals();
    const now = Date.now();
    let changed = false;

    for (const signal of signals) {
      const status = normalizeStatus(signal.status, signal);

      // Only expire untriggered pending limit/stop orders.
      if (status !== 'pending') {
        continue;
      }

      if (!signal.expires_at) {
        continue;
      }

      const expiry = new Date(signal.expires_at).getTime();

      if (!Number.isFinite(expiry) || now < expiry) {
        continue;
      }

      signal.status = 'invalidated';
      signal.result = 'INVALIDATED';
      signal.invalidated_at =
        signal.invalidated_at || new Date().toISOString();

      console.log(`XAUUSD pending signal expired: ${signal.id}`);
      changed = true;
    }

    if (changed) {
      await saveSignals(signals.slice(0, MAX_SIGNALS));
      cache = { data: null, timestamp: 0 };
      console.log('Expired signals saved to JSONBin.');
    }
  } catch (err) {
    console.error('Pending expiration engine error:', err.message);
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

    storageConfigured: Boolean(JSONBIN_BIN_ID && JSONBIN_MASTER_KEY),

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
