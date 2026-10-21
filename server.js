'use strict';

/**
 * HARDKNOCKS FX — XAU/USD Signal Engine
 *
 * Neon PostgreSQL persistence + Render/Express API.
 * Lifecycle:
 *   PENDING -> ACTIVE -> WIN / LOSS
 *   PENDING -> INVALIDATED
 *
 * Required environment variable:
 *   DATABASE_URL = Neon pooled connection string
 *
 * Optional environment variables:
 *   PORT=3000
 *   SIGNAL_EXPIRY_HOURS=12
 *   MAX_SIGNALS=1000
 *   PRICE_STALE_SECONDS=120
 *   ENABLE_SERVER_PRICE_POLL=true
 *   MARKET_PRICE_URL=https://api.gold-api.com/price/XAU
 *   STRIPE_SECRET_KEY=...
 *   STRIPE_PRICE_ID=...
 *   PUBLIC_BASE_URL=https://your-render-service.onrender.com
 */

const express = require('express');
const bodyParser = require('body-parser');
const path = require('path');
const { Pool } = require('pg');

const app = express();
const PORT = Number(process.env.PORT || 3000);
const SIGNAL_EXPIRY_HOURS = positiveNumber(process.env.SIGNAL_EXPIRY_HOURS, 12);
const MAX_SIGNALS = Math.max(50, integerOr(process.env.MAX_SIGNALS, 1000));
const PRICE_STALE_SECONDS = Math.max(30, integerOr(process.env.PRICE_STALE_SECONDS, 120));
const MARKET_PRICE_URL = process.env.MARKET_PRICE_URL || 'https://api.gold-api.com/price/XAU';
const ENABLE_SERVER_PRICE_POLL = String(process.env.ENABLE_SERVER_PRICE_POLL || 'true').toLowerCase() === 'true';

if (!process.env.DATABASE_URL) {
  console.error('DATABASE_URL is missing. Add your Neon pooled connection string to Render environment variables.');
  process.exit(1);
}

function positiveNumber(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

function integerOr(value, fallback) {
  const n = Number.parseInt(value, 10);
  return Number.isFinite(n) ? n : fallback;
}

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
  max: 5,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 10000,
  keepAlive: true
});

pool.on('error', err => {
  console.error('Unexpected PostgreSQL pool error:', err.message);
});

// -----------------------------------------------------------------------------
// Middleware
// -----------------------------------------------------------------------------

app.use(bodyParser.json({ limit: '256kb' }));
app.use(bodyParser.urlencoded({ extended: false }));

app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,PATCH,DELETE,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  res.setHeader('Cache-Control', 'no-store');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

// -----------------------------------------------------------------------------
// Utility helpers
// -----------------------------------------------------------------------------

function normalizeSymbol(value) {
  return String(value || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
}

function normalizeSide(value) {
  const raw = String(value || '').toUpperCase().trim().replace(/\s+/g, ' ');
  if (raw.includes('BUY') && raw.includes('LIMIT')) return 'BUY LIMIT';
  if (raw.includes('SELL') && raw.includes('LIMIT')) return 'SELL LIMIT';
  if (raw.includes('BUY')) return 'BUY';
  if (raw.includes('SELL')) return 'SELL';
  return '';
}

function normalizeStatus(value) {
  const raw = String(value || '').toLowerCase().trim().replace(/[- ]/g, '_');
  if (['pending', 'queued', 'pending_limit'].includes(raw)) return 'pending';
  if (['active', 'open', 'filled', 'triggered', 'in_trade'].includes(raw)) return 'active';
  if (['win', 'winner', 'tp', 'take_profit'].includes(raw)) return 'win';
  if (['loss', 'loser', 'sl', 'stop_loss'].includes(raw)) return 'loss';
  if (['invalid', 'invalidated', 'cancelled', 'canceled', 'expired'].includes(raw)) return 'invalidated';
  return '';
}

function toNumber(value, fallback = null) {
  if (value === null || value === undefined || value === '') return fallback;
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function toBoolean(value, fallback = false) {
  if (value === null || value === undefined || value === '') return fallback;
  if (typeof value === 'boolean') return value;
  const s = String(value).toLowerCase().trim();
  if (['true', '1', 'yes', 'y'].includes(s)) return true;
  if (['false', '0', 'no', 'n'].includes(s)) return false;
  return fallback;
}

function asConfluence(value) {
  if (Array.isArray(value)) return value;
  if (value === null || value === undefined || value === '') return [];
  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value);
      return Array.isArray(parsed) ? parsed : [value];
    } catch (_) {
      return value.split(',').map(x => x.trim()).filter(Boolean);
    }
  }
  return [String(value)];
}

function makeSignalId() {
  return `sig-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function hoursFromNow(hours) {
  return new Date(Date.now() + hours * 60 * 60 * 1000);
}

function sideIsBuy(side) {
  return String(side).toUpperCase().includes('BUY');
}

function isLimitSide(side) {
  return String(side).toUpperCase().includes('LIMIT');
}

function pendingEntryTriggered(side, marketPrice, entry) {
  if (sideIsBuy(side)) return marketPrice <= entry;
  return marketPrice >= entry;
}

function activeTargetHit(side, marketPrice, tp) {
  if (sideIsBuy(side)) return marketPrice >= tp;
  return marketPrice <= tp;
}

function activeStopHit(side, marketPrice, sl) {
  if (sideIsBuy(side)) return marketPrice <= sl;
  return marketPrice >= sl;
}

function calculateR(side, entry, sl, tp) {
  const risk = sideIsBuy(side) ? entry - sl : sl - entry;
  const reward = sideIsBuy(side) ? tp - entry : entry - tp;
  if (!(risk > 0) || !(reward > 0)) return null;
  return Number((reward / risk).toFixed(2));
}

function isValidGeometry(side, entry, sl, tp) {
  if (sideIsBuy(side)) return sl < entry && tp > entry;
  return sl > entry && tp < entry;
}

function jsonOrObject(value, fallback = {}) {
  if (value === null || value === undefined) return fallback;
  if (typeof value === 'object') return value;
  try { return JSON.parse(value); } catch (_) { return fallback; }
}

function serializeSignal(row) {
  if (!row) return row;
  return {
    ...row,
    entry: row.entry === null ? null : Number(row.entry),
    sl: row.sl === null ? null : Number(row.sl),
    tp: row.tp === null ? null : Number(row.tp),
    rr: row.rr === null ? null : Number(row.rr),
    score: row.score === null ? null : Number(row.score),
    r_multiple: row.r_multiple === null ? null : Number(row.r_multiple),
    trigger_price: row.trigger_price === null ? null : Number(row.trigger_price),
    close_price: row.close_price === null ? null : Number(row.close_price),
    confluence: Array.isArray(row.confluence) ? row.confluence : jsonOrObject(row.confluence, [])
  };
}

const SIGNAL_SELECT = `
  SELECT
    id, sym, side, entry, sl, tp, rr, score,
    htf_aligned, blackout, status, result, r_multiple,
    confluence, published_at, expires_at,
    triggered_at, trigger_price,
    closed_at, close_price,
    invalidated_at, invalidated_reason,
    created_at, updated_at
  FROM xauusd_signals
`;

// -----------------------------------------------------------------------------
// Database initialization
// -----------------------------------------------------------------------------

async function initDatabase() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS xauusd_signals (
      id TEXT PRIMARY KEY,
      sym TEXT NOT NULL DEFAULT 'XAUUSD',
      side TEXT NOT NULL,
      entry NUMERIC(12, 2) NOT NULL,
      sl NUMERIC(12, 2) NOT NULL,
      tp NUMERIC(12, 2) NOT NULL,
      rr NUMERIC(10, 2),
      score NUMERIC(10, 2),
      htf_aligned BOOLEAN NOT NULL DEFAULT TRUE,
      blackout BOOLEAN NOT NULL DEFAULT FALSE,
      status TEXT NOT NULL DEFAULT 'pending',
      result TEXT,
      r_multiple NUMERIC(10, 2),
      confluence JSONB NOT NULL DEFAULT '[]'::jsonb,
      published_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      expires_at TIMESTAMPTZ,
      triggered_at TIMESTAMPTZ,
      trigger_price NUMERIC(12, 2),
      closed_at TIMESTAMPTZ,
      close_price NUMERIC(12, 2),
      invalidated_at TIMESTAMPTZ,
      invalidated_reason TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);

  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_xauusd_signals_status
      ON xauusd_signals(status);
    CREATE INDEX IF NOT EXISTS idx_xauusd_signals_symbol
      ON xauusd_signals(sym);
    CREATE INDEX IF NOT EXISTS idx_xauusd_signals_published
      ON xauusd_signals(published_at DESC);
    CREATE INDEX IF NOT EXISTS idx_xauusd_signals_live
      ON xauusd_signals(status)
      WHERE status IN ('pending', 'active');
    CREATE INDEX IF NOT EXISTS idx_xauusd_signals_history
      ON xauusd_signals(status)
      WHERE status IN ('win', 'loss', 'invalidated');
    CREATE INDEX IF NOT EXISTS idx_xauusd_signals_expiry
      ON xauusd_signals(expires_at)
      WHERE status = 'pending';
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS signal_events (
      id BIGSERIAL PRIMARY KEY,
      signal_id TEXT NOT NULL,
      event_type TEXT NOT NULL,
      price NUMERIC(12, 2),
      previous_status TEXT,
      new_status TEXT,
      metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      CONSTRAINT fk_signal_events_signal
        FOREIGN KEY (signal_id)
        REFERENCES xauusd_signals(id)
        ON DELETE CASCADE
    );
  `);

  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_signal_events_signal
      ON signal_events(signal_id);
    CREATE INDEX IF NOT EXISTS idx_signal_events_created
      ON signal_events(created_at DESC);
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS market_prices (
      symbol TEXT PRIMARY KEY,
      price NUMERIC(12, 2) NOT NULL,
      source TEXT,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);

  await pool.query(`
    CREATE OR REPLACE FUNCTION update_xauusd_signal_timestamp()
    RETURNS TRIGGER AS $$
    BEGIN
      NEW.updated_at = NOW();
      RETURN NEW;
    END;
    $$ LANGUAGE plpgsql;
  `);

  await pool.query(`
    DROP TRIGGER IF EXISTS trg_xauusd_signal_updated_at
      ON xauusd_signals;
    CREATE TRIGGER trg_xauusd_signal_updated_at
      BEFORE UPDATE ON xauusd_signals
      FOR EACH ROW
      EXECUTE FUNCTION update_xauusd_signal_timestamp();
  `);

  // If an older database contains legacy "expired" rows, normalize them once.
  await pool.query(`
    UPDATE xauusd_signals
    SET status = 'invalidated',
        result = 'invalidated',
        invalidated_at = COALESCE(invalidated_at, NOW()),
        invalidated_reason = COALESCE(
          invalidated_reason,
          'Legacy expired signal normalized to invalidated.'
        )
    WHERE status = 'expired';
  `).catch(err => {
    // Older installations with a restrictive CHECK constraint may reject the
    // update. The normal schema uses only the five lifecycle states.
    console.warn('Legacy status normalization skipped:', err.message);
  });
}

// -----------------------------------------------------------------------------
// Event logging
// -----------------------------------------------------------------------------

async function logEvent(client, signalId, eventType, price, previousStatus, newStatus, metadata = {}) {
  await client.query(`
    INSERT INTO signal_events
      (signal_id, event_type, price, previous_status, new_status, metadata)
    VALUES ($1, $2, $3, $4, $5, $6::jsonb)
  `, [
    signalId,
    eventType,
    price === undefined ? null : price,
    previousStatus || null,
    newStatus || null,
    JSON.stringify(metadata || {})
  ]);
}

// -----------------------------------------------------------------------------
// Lifecycle engine
// -----------------------------------------------------------------------------

async function processMarketPrice(marketPrice, source = 'unknown') {
  const price = toNumber(marketPrice);
  if (price === null || price <= 0) {
    throw new Error('Invalid XAUUSD market price.');
  }

  const client = await pool.connect();
  const transitions = [];

  try {
    await client.query('BEGIN');

    await client.query(`
      INSERT INTO market_prices(symbol, price, source, updated_at)
      VALUES ('XAUUSD', $1, $2, NOW())
      ON CONFLICT (symbol)
      DO UPDATE SET
        price = EXCLUDED.price,
        source = EXCLUDED.source,
        updated_at = NOW()
    `, [price, source]);

    // 1. Pending orders: expire first, then trigger orders whose entry has been reached.
    const pending = await client.query(`
      SELECT *
      FROM xauusd_signals
      WHERE sym = 'XAUUSD'
        AND status = 'pending'
      ORDER BY published_at ASC
      FOR UPDATE SKIP LOCKED
    `);

    for (const signal of pending.rows) {
      const entry = Number(signal.entry);
      const expiresAt = signal.expires_at ? new Date(signal.expires_at).getTime() : null;

      if (expiresAt !== null && expiresAt <= Date.now()) {
        await client.query(`
          UPDATE xauusd_signals
          SET status = 'invalidated',
              result = 'invalidated',
              invalidated_at = NOW(),
              invalidated_reason = 'Entry was not triggered before expiry.'
          WHERE id = $1 AND status = 'pending'
        `, [signal.id]);

        await logEvent(
          client,
          signal.id,
          'SIGNAL_INVALIDATED',
          price,
          'pending',
          'invalidated',
          { reason: 'Entry was not triggered before expiry.', source }
        );

        transitions.push({ id: signal.id, from: 'pending', to: 'invalidated', price });
        continue;
      }

      if (pendingEntryTriggered(signal.side, price, entry)) {
        await client.query(`
          UPDATE xauusd_signals
          SET status = 'active',
              result = NULL,
              triggered_at = NOW(),
              trigger_price = $1
          WHERE id = $2 AND status = 'pending'
        `, [price, signal.id]);

        await logEvent(
          client,
          signal.id,
          'ENTRY_TRIGGERED',
          price,
          'pending',
          'active',
          { entry, side: signal.side, source }
        );

        transitions.push({ id: signal.id, from: 'pending', to: 'active', price });
      }
    }

    // 2. Active trades: check TP/SL.
    const active = await client.query(`
      SELECT *
      FROM xauusd_signals
      WHERE sym = 'XAUUSD'
        AND status = 'active'
      ORDER BY triggered_at ASC NULLS LAST
      FOR UPDATE SKIP LOCKED
    `);

    for (const signal of active.rows) {
      const entry = Number(signal.entry);
      const sl = Number(signal.sl);
      const tp = Number(signal.tp);

      let newStatus = null;
      let rMultiple = null;
      let eventType = null;

      if (activeTargetHit(signal.side, price, tp)) {
        newStatus = 'win';
        rMultiple = calculateR(signal.side, entry, sl, tp);
        eventType = 'TAKE_PROFIT';
      } else if (activeStopHit(signal.side, price, sl)) {
        newStatus = 'loss';
        rMultiple = -1;
        eventType = 'STOP_LOSS';
      }

      if (!newStatus) continue;

      await client.query(`
        UPDATE xauusd_signals
        SET status = $1,
            result = $1,
            r_multiple = $2,
            closed_at = NOW(),
            close_price = $3
        WHERE id = $4 AND status = 'active'
      `, [newStatus, rMultiple, price, signal.id]);

      await logEvent(
        client,
        signal.id,
        eventType,
        price,
        'active',
        newStatus,
        {
          source,
          entry,
          sl,
          tp,
          r_multiple: rMultiple
        }
      );

      transitions.push({ id: signal.id, from: 'active', to: newStatus, price, r_multiple: rMultiple });
    }

    // Keep the database from growing without bound if MAX_SIGNALS is configured.
    // We only prune old terminal records; live records are never deleted here.
    await client.query(`
      DELETE FROM xauusd_signals
      WHERE id IN (
        SELECT id
        FROM xauusd_signals
        WHERE sym = 'XAUUSD'
          AND status IN ('win', 'loss', 'invalidated')
        ORDER BY COALESCE(closed_at, invalidated_at, published_at) DESC
        OFFSET $1
      )
    `, [MAX_SIGNALS]);

    await client.query('COMMIT');

    return {
      price,
      source,
      transitions
    };
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

async function invalidateExpiredSignals() {
  const client = await pool.connect();
  let count = 0;

  try {
    await client.query('BEGIN');

    const result = await client.query(`
      UPDATE xauusd_signals
      SET status = 'invalidated',
          result = 'invalidated',
          invalidated_at = NOW(),
          invalidated_reason = 'Entry was not triggered before expiry.'
      WHERE sym = 'XAUUSD'
        AND status = 'pending'
        AND expires_at IS NOT NULL
        AND expires_at <= NOW()
      RETURNING id
    `);

    count = result.rowCount;

    for (const row of result.rows) {
      await logEvent(
        client,
        row.id,
        'SIGNAL_INVALIDATED',
        null,
        'pending',
        'invalidated',
        { reason: 'Entry was not triggered before expiry.', source: 'expiry-worker' }
      );
    }

    await client.query('COMMIT');
    return count;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

// -----------------------------------------------------------------------------
// Webhook
// -----------------------------------------------------------------------------

app.post('/api/webhook/signal', async (req, res) => {
  try {
    const body = req.body || {};
    const sym = normalizeSymbol(body.sym || body.symbol || body.asset || 'XAUUSD');

    if (sym !== 'XAUUSD') {
      return res.status(400).json({
        success: false,
        error: 'Only XAUUSD signals are accepted.'
      });
    }

    const side = normalizeSide(body.side || body.direction || body.action);
    if (!side) {
      return res.status(400).json({ success: false, error: 'Missing or invalid side.' });
    }

    const entry = toNumber(body.entry);
    const sl = toNumber(body.sl ?? body.stop_loss ?? body.stopLoss);
    const tp = toNumber(body.tp ?? body.take_profit ?? body.takeProfit);

    if ([entry, sl, tp].some(v => v === null || v <= 0)) {
      return res.status(400).json({
        success: false,
        error: 'entry, sl and tp must be positive numbers.'
      });
    }

    if (!isValidGeometry(side, entry, sl, tp)) {
      return res.status(400).json({
        success: false,
        error: `Invalid ${side} geometry. BUY requires SL < entry < TP; SELL requires TP < entry < SL.`
      });
    }

    const explicitStatus = normalizeStatus(body.status);
    let initialStatus;

    if (explicitStatus === 'pending' || isLimitSide(side)) {
      initialStatus = 'pending';
    } else if (explicitStatus === 'active' || !explicitStatus) {
      initialStatus = 'active';
    } else if (['win', 'loss', 'invalidated'].includes(explicitStatus)) {
      return res.status(400).json({
        success: false,
        error: 'New TradingView signals must start as pending or active.'
      });
    } else {
      initialStatus = 'active';
    }

    const rr = toNumber(body.rr, calculateR(side, entry, sl, tp));
    const score = toNumber(body.score);
    const htfAligned = toBoolean(body.htf_aligned ?? body.htfAligned, true);
    const blackout = toBoolean(body.blackout, false);
    const confluence = asConfluence(body.confluence);
    const publishedAt = body.published_at || body.publishedAt || new Date().toISOString();
    const expiresAt = body.expires_at || body.expiresAt || hoursFromNow(SIGNAL_EXPIRY_HOURS).toISOString();
    const requestedId = String(body.id || body.signal_id || '').trim();
    const id = requestedId || makeSignalId();

    const client = await pool.connect();

    try {
      await client.query('BEGIN');

      // Idempotency: if TradingView retries the exact signal ID, return the
      // existing record rather than inserting a duplicate.
      if (requestedId) {
        const existingById = await client.query(
          `${SIGNAL_SELECT} WHERE id = $1 LIMIT 1`,
          [id]
        );
        if (existingById.rowCount) {
          await client.query('COMMIT');
          return res.status(200).json({
            success: true,
            duplicate: true,
            signal: serializeSignal(existingById.rows[0])
          });
        }
      }

      // Duplicate protection for retries that do not include a stable signal ID.
      const duplicate = await client.query(`
        ${SIGNAL_SELECT}
        WHERE sym = 'XAUUSD'
          AND status IN ('pending', 'active')
          AND side = $1
          AND ABS(entry - $2) < 0.50
        ORDER BY published_at DESC
        LIMIT 1
        FOR UPDATE
      `, [side, entry]);

      if (duplicate.rowCount) {
        await client.query('COMMIT');
        return res.status(200).json({
          success: true,
          duplicate: true,
          signal: serializeSignal(duplicate.rows[0])
        });
      }

      await client.query(`
        INSERT INTO xauusd_signals (
          id, sym, side, entry, sl, tp, rr, score,
          htf_aligned, blackout, status, result,
          r_multiple, confluence, published_at, expires_at
        )
        VALUES (
          $1, 'XAUUSD', $2, $3, $4, $5, $6, $7,
          $8, $9, $10, NULL,
          NULL, $11::jsonb, $12, $13
        )
      `, [
        id,
        side,
        entry,
        sl,
        tp,
        rr,
        score,
        htfAligned,
        blackout,
        initialStatus,
        JSON.stringify(confluence),
        publishedAt,
        expiresAt
      ]);

      await logEvent(
        client,
        id,
        'SIGNAL_CREATED',
        null,
        null,
        initialStatus,
        {
          source: 'tradingview',
          side,
          entry,
          sl,
          tp,
          rr
        }
      );

      await client.query('COMMIT');

      // A non-limit signal is already active. It may be immediately resolved
      // if the webhook also provides a current market price.
      let processed = null;
      const webhookPrice = toNumber(body.market_price ?? body.marketPrice ?? body.price);
      if (webhookPrice !== null && webhookPrice > 0) {
        processed = await processMarketPrice(webhookPrice, 'tradingview-webhook');
      }

      const result = await pool.query(`${SIGNAL_SELECT} WHERE id = $1`, [id]);

      return res.status(201).json({
        success: true,
        signal: serializeSignal(result.rows[0]),
        lifecycle: processed ? processed.transitions : []
      });
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      throw err;
    } finally {
      client.release();
    }
  } catch (err) {
    console.error('Webhook error:', err);
    return res.status(500).json({
      success: false,
      error: 'Failed to create XAUUSD signal.',
      detail: process.env.NODE_ENV === 'production' ? undefined : err.message
    });
  }
});

// -----------------------------------------------------------------------------
// Signal APIs
// -----------------------------------------------------------------------------

app.get('/api/signals', async (req, res) => {
  try {
    await invalidateExpiredSignals();

    const limit = Math.min(Math.max(integerOr(req.query.limit, 100), 1), MAX_SIGNALS);
    const result = await pool.query(`
      ${SIGNAL_SELECT}
      WHERE sym = 'XAUUSD'
      ORDER BY published_at DESC
      LIMIT $1
    `, [limit]);

    res.json({
      success: true,
      symbol: 'XAUUSD',
      count: result.rowCount,
      signals: result.rows.map(serializeSignal)
    });
  } catch (err) {
    console.error('/api/signals error:', err);
    res.status(500).json({ success: false, error: 'Unable to load XAUUSD signals.' });
  }
});

app.get('/api/signals/live', async (req, res) => {
  try {
    await invalidateExpiredSignals();

    const result = await pool.query(`
      ${SIGNAL_SELECT}
      WHERE sym = 'XAUUSD'
        AND status IN ('pending', 'active')
      ORDER BY published_at DESC
    `);

    res.json({
      success: true,
      symbol: 'XAUUSD',
      count: result.rowCount,
      signals: result.rows.map(serializeSignal)
    });
  } catch (err) {
    console.error('/api/signals/live error:', err);
    res.status(500).json({ success: false, error: 'Unable to load live XAUUSD signals.' });
  }
});

app.get('/api/track-record', async (req, res) => {
  try {
    await invalidateExpiredSignals();

    const [rows, summary] = await Promise.all([
      pool.query(`
        ${SIGNAL_SELECT}
        WHERE sym = 'XAUUSD'
          AND status IN ('win', 'loss', 'invalidated')
        ORDER BY COALESCE(closed_at, invalidated_at, published_at) DESC
        LIMIT $1
      `, [Math.min(Math.max(integerOr(req.query.limit, MAX_SIGNALS), 1), MAX_SIGNALS)]),
      pool.query(`
        SELECT
          COUNT(*) FILTER (WHERE status = 'win')::int AS wins,
          COUNT(*) FILTER (WHERE status = 'loss')::int AS losses,
          COUNT(*) FILTER (WHERE status = 'invalidated')::int AS invalidated,
          COUNT(*) FILTER (WHERE status IN ('win', 'loss'))::int AS completed,
          ROUND(
            100.0 * COUNT(*) FILTER (WHERE status = 'win')
            / NULLIF(COUNT(*) FILTER (WHERE status IN ('win', 'loss')), 0),
            2
          ) AS "winRate",
          ROUND(
            AVG(r_multiple) FILTER (WHERE status IN ('win', 'loss')),
            2
          ) AS "averageR"
        FROM xauusd_signals
        WHERE sym = 'XAUUSD'
      `)
    ]);

    const s = summary.rows[0] || {};

    res.json({
      success: true,
      symbol: 'XAUUSD',
      summary: {
        wins: Number(s.wins || 0),
        losses: Number(s.losses || 0),
        invalidated: Number(s.invalidated || 0),
        completed: Number(s.completed || 0),
        winRate: s.winRate === null ? 0 : Number(s.winRate),
        averageR: s.averageR === null ? null : Number(s.averageR)
      },
      signals: rows.rows.map(serializeSignal)
    });
  } catch (err) {
    console.error('/api/track-record error:', err);
    res.status(500).json({ success: false, error: 'Unable to load XAUUSD track record.' });
  }
});

app.get('/api/performance', async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT
        COUNT(*) FILTER (WHERE status = 'win')::int AS wins,
        COUNT(*) FILTER (WHERE status = 'loss')::int AS losses,
        COUNT(*) FILTER (WHERE status = 'invalidated')::int AS invalidated,
        COUNT(*) FILTER (WHERE status IN ('win','loss'))::int AS completed,
        ROUND(
          100.0 * COUNT(*) FILTER (WHERE status='win')
          / NULLIF(COUNT(*) FILTER (WHERE status IN ('win','loss')),0),
          2
        ) AS win_rate,
        ROUND(AVG(r_multiple) FILTER (WHERE status IN ('win','loss')),2) AS average_r,
        ROUND(AVG(r_multiple) FILTER (WHERE status='win'),2) AS average_win_r,
        ROUND(AVG(r_multiple) FILTER (WHERE status='loss'),2) AS average_loss_r
      FROM xauusd_signals
      WHERE sym='XAUUSD'
    `);

    const s = result.rows[0];
    const wins = Number(s.wins || 0);
    const losses = Number(s.losses || 0);
    const completed = Number(s.completed || 0);
    const winRate = completed ? wins / completed : 0;
    const avgWinR = s.average_win_r === null ? 0 : Number(s.average_win_r);
    const avgLossR = s.average_loss_r === null ? 0 : Number(s.average_loss_r);
    const lossRate = completed ? losses / completed : 0;
    const expectancy = completed ? (winRate * avgWinR) + (lossRate * avgLossR) : null;

    res.json({
      success: true,
      symbol: 'XAUUSD',
      performance: {
        wins,
        losses,
        invalidated: Number(s.invalidated || 0),
        completed,
        winRate: s.win_rate === null ? 0 : Number(s.win_rate),
        averageR: s.average_r === null ? null : Number(s.average_r),
        averageWinR: s.average_win_r === null ? null : Number(s.average_win_r),
        averageLossR: s.average_loss_r === null ? null : Number(s.average_loss_r),
        expectancy: expectancy === null ? null : Number(expectancy.toFixed(2))
      }
    });
  } catch (err) {
    console.error('/api/performance error:', err);
    res.status(500).json({ success: false, error: 'Unable to calculate performance.' });
  }
});

// -----------------------------------------------------------------------------
// Market price APIs
// -----------------------------------------------------------------------------

app.get('/api/market-price', async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT symbol, price, source, updated_at
      FROM market_prices
      WHERE symbol = 'XAUUSD'
      LIMIT 1
    `);

    if (!result.rowCount) {
      return res.json({
        success: true,
        symbol: 'XAUUSD',
        price: null,
        source: null,
        updated_at: null,
        stale: true
      });
    }

    const row = result.rows[0];
    const ageSeconds = (Date.now() - new Date(row.updated_at).getTime()) / 1000;

    res.json({
      success: true,
      symbol: row.symbol,
      price: Number(row.price),
      source: row.source,
      updated_at: row.updated_at,
      stale: ageSeconds > PRICE_STALE_SECONDS,
      age_seconds: Math.max(0, Math.round(ageSeconds))
    });
  } catch (err) {
    console.error('GET /api/market-price error:', err);
    res.status(500).json({ success: false, error: 'Unable to load market price.' });
  }
});

app.post('/api/market-price', async (req, res) => {
  try {
    const symbol = normalizeSymbol(req.body?.symbol || 'XAUUSD');
    if (symbol !== 'XAUUSD') {
      return res.status(400).json({ success: false, error: 'Only XAUUSD is supported.' });
    }

    const price = toNumber(req.body?.price);
    if (price === null || price <= 0) {
      return res.status(400).json({ success: false, error: 'A positive XAUUSD price is required.' });
    }

    const source = String(req.body?.source || 'client').slice(0, 100);
    const result = await processMarketPrice(price, source);

    res.json({
      success: true,
      symbol: 'XAUUSD',
      price,
      source,
      transitions: result.transitions
    });
  } catch (err) {
    console.error('POST /api/market-price error:', err);
    res.status(500).json({
      success: false,
      error: 'Unable to process market price.',
      detail: process.env.NODE_ENV === 'production' ? undefined : err.message
    });
  }
});

// -----------------------------------------------------------------------------
// Health check
// -----------------------------------------------------------------------------

app.get('/api/health', async (req, res) => {
  try {
    const db = await pool.query('SELECT NOW() AS database_time');
    const price = await pool.query(`
      SELECT price, source, updated_at
      FROM market_prices
      WHERE symbol='XAUUSD'
      LIMIT 1
    `);

    res.json({
      success: true,
      service: 'HARDKNOCKS FX — XAU/USD ENGINE',
      status: 'healthy',
      database: 'connected',
      database_time: db.rows[0].database_time,
      symbol: 'XAUUSD',
      lifecycle: ['pending', 'active', 'win', 'loss', 'invalidated'],
      market_price: price.rowCount ? Number(price.rows[0].price) : null,
      market_price_updated_at: price.rowCount ? price.rows[0].updated_at : null,
      server_price_poll: ENABLE_SERVER_PRICE_POLL,
      uptime_seconds: Math.round(process.uptime()),
      timestamp: new Date().toISOString()
    });
  } catch (err) {
    res.status(503).json({
      success: false,
      service: 'HARDKNOCKS FX — XAU/USD ENGINE',
      status: 'unhealthy',
      database: 'disconnected',
      error: err.message,
      timestamp: new Date().toISOString()
    });
  }
});

// -----------------------------------------------------------------------------
// Optional Stripe VIP checkout
// -----------------------------------------------------------------------------

let stripe = null;
if (process.env.STRIPE_SECRET_KEY) {
  try {
    const Stripe = require('stripe');
    stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
  } catch (err) {
    console.warn('Stripe package is not installed. VIP checkout endpoint will return 503.');
  }
}

app.post('/api/create-checkout-session', async (req, res) => {
  if (!stripe || !process.env.STRIPE_PRICE_ID) {
    return res.status(503).json({
      success: false,
      error: 'VIP checkout is not configured on the server.'
    });
  }

  try {
    const base = process.env.PUBLIC_BASE_URL || `${req.protocol}://${req.get('host')}`;
    const session = await stripe.checkout.sessions.create({
      mode: 'subscription',
      line_items: [{
        price: process.env.STRIPE_PRICE_ID,
        quantity: 1
      }],
      success_url: `${base}/?vip=success`,
      cancel_url: `${base}/?vip=cancelled`,
      allow_promotion_codes: true
    });

    res.json({ success: true, url: session.url });
  } catch (err) {
    console.error('Stripe checkout error:', err);
    res.status(500).json({ success: false, error: 'Unable to create VIP checkout session.' });
  }
});

// -----------------------------------------------------------------------------
// Static frontend
// -----------------------------------------------------------------------------

app.use(express.static(path.join(__dirname)));


// -----------------------------------------------------------------------------
// Error handler
// -----------------------------------------------------------------------------

app.use((err, req, res, next) => {
  console.error('Unhandled server error:', err);
  res.status(500).json({ success: false, error: 'Internal server error.' });
});

// -----------------------------------------------------------------------------
// Background workers
// -----------------------------------------------------------------------------

let expiryTimer = null;
let priceTimer = null;
let pricePollBusy = false;

async function pollMarketPrice() {
  if (pricePollBusy) return;
  pricePollBusy = true;

  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 10000);

    try {
      const response = await fetch(MARKET_PRICE_URL, {
        method: 'GET',
        headers: { Accept: 'application/json' },
        signal: controller.signal
      });

      if (!response.ok) throw new Error(`Market price HTTP ${response.status}`);

      const data = await response.json();
      const price = toNumber(data?.price ?? data?.price_usd ?? data?.XAU?.price);
      if (price === null || price <= 0) throw new Error('Market price response did not contain a valid price.');

      const result = await processMarketPrice(price, 'server-gold-api');
      if (result.transitions.length) {
        console.log('Lifecycle transitions:', result.transitions);
      }
    } finally {
      clearTimeout(timer);
    }
  } catch (err) {
    console.warn('Server market-price poll failed:', err.message);
  } finally {
    pricePollBusy = false;
  }
}

async function startBackgroundWorkers() {
  await invalidateExpiredSignals();

  expiryTimer = setInterval(async () => {
    try {
      const count = await invalidateExpiredSignals();
      if (count) console.log(`Invalidated ${count} expired XAUUSD signal(s).`);
    } catch (err) {
      console.error('Expiry worker error:', err.message);
    }
  }, 60 * 1000);

  if (ENABLE_SERVER_PRICE_POLL) {
    await pollMarketPrice();
    priceTimer = setInterval(pollMarketPrice, 15 * 1000);
  }
}

// -----------------------------------------------------------------------------
// Startup / shutdown
// -----------------------------------------------------------------------------

let server;

async function start() {
  try {
    await initDatabase();
    await pool.query('SELECT 1');

    server = app.listen(PORT, () => {
      console.log('');
      console.log('==============================================');
      console.log(' HARDKNOCKS FX — XAU/USD ENGINE');
      console.log('==============================================');
      console.log(` Server: http://localhost:${PORT}`);
      console.log(' Asset: XAUUSD');
      console.log(' Database: Neon PostgreSQL');
      console.log(' Lifecycle:');
      console.log('   PENDING → ACTIVE → WIN/LOSS');
      console.log('   PENDING → INVALIDATED');
      console.log(` Signal expiry: ${SIGNAL_EXPIRY_HOURS} hour(s)`);
      console.log(` History retention: ${MAX_SIGNALS} terminal signals`);
      console.log(` Server price polling: ${ENABLE_SERVER_PRICE_POLL ? 'enabled' : 'disabled'}`);
      console.log('==============================================');
      console.log('');
    });

    await startBackgroundWorkers();
  } catch (err) {
    console.error('Startup failed:', err);
    await pool.end().catch(() => {});
    process.exit(1);
  }
}

async function shutdown(signal) {
  console.log(`Received ${signal}. Shutting down...`);
  if (expiryTimer) clearInterval(expiryTimer);
  if (priceTimer) clearInterval(priceTimer);

  if (server) {
    await new Promise(resolve => server.close(resolve));
  }

  await pool.end();
  process.exit(0);
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

start();
