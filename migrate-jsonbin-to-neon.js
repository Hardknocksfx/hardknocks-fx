
require('dotenv').config();

const fs = require('fs');
const { Pool } = require('pg');

const backupPath = './jsonbin-backup.json';

if (!process.env.DATABASE_URL) {
  console.error('DATABASE_URL is missing from .env');
  process.exit(1);
}

if (!fs.existsSync(backupPath)) {
  console.error('jsonbin-backup.json was not found.');
  process.exit(1);
}

const backup = JSON.parse(fs.readFileSync(backupPath, 'utf8'));
const signals = backup.signals;

if (!Array.isArray(signals)) {
  console.error('Backup does not contain a signals array.');
  process.exit(1);
}

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
  max: 1
});

function dateOrNull(value) {
  if (!value) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    throw new Error(`Invalid timestamp: ${value}`);
  }
  return date;
}

function numberOrNull(value) {
  if (value === null || value === undefined || value === '') return null;
  const number = Number(value);
  if (!Number.isFinite(number)) throw new Error('Invalid numeric field.');
  return number;
}

async function main() {
  let inserted = 0;
  let skipped = 0;

  try {
    await pool.query('BEGIN');

    for (const signal of signals) {
      if (!signal.id) throw new Error('A signal is missing its ID.');

      const side = String(signal.side || '').trim().toUpperCase();
      const entry = numberOrNull(signal.entry);
      const sl = numberOrNull(signal.sl);
      const tp = numberOrNull(signal.tp);

      if (!side || entry === null || sl === null || tp === null) {
        throw new Error(`Signal ${signal.id} is missing required trading fields.`);
      }

      const result = await pool.query(`
        INSERT INTO xauusd_signals (
          id, sym, side, entry, sl, tp, rr, score,
          htf_aligned, blackout, status, result, r_multiple,
          confluence, published_at, expires_at, triggered_at,
          trigger_price, closed_at, close_price, invalidated_at,
          invalidated_reason, created_at, updated_at
        )
        VALUES (
          $1, $2, $3, $4, $5, $6, $7, $8,
          $9, $10, $11, $12, $13,
          $14::jsonb, $15, $16, $17,
          $18, $19, $20, $21,
          $22, $23, $24
        )
        ON CONFLICT (id) DO NOTHING
      `, [
        String(signal.id),
        String(signal.sym || signal.symbol || 'XAUUSD'),
        side,
        entry,
        sl,
        tp,
        numberOrNull(signal.rr),
        numberOrNull(signal.score),
        signal.htf_aligned ?? true,
        signal.blackout ?? false,
        String(signal.status || 'pending').toLowerCase(),
        signal.result ?? null,
        numberOrNull(signal.r_multiple ?? signal.r_multiple_result),
        JSON.stringify(Array.isArray(signal.confluence) ? signal.confluence : []),
        dateOrNull(signal.published_at),
        dateOrNull(signal.expires_at),
        dateOrNull(signal.triggered_at),
        numberOrNull(signal.trigger_price),
        dateOrNull(signal.closed_at),
        numberOrNull(signal.close_price),
        dateOrNull(signal.invalidated_at),
        signal.invalidated_reason ?? null,
        dateOrNull(signal.created_at) || dateOrNull(signal.published_at) || new Date(),
        dateOrNull(signal.updated_at) || dateOrNull(signal.published_at) || new Date()
      ]);

      if (result.rowCount === 1) {
        inserted++;
      } else {
        skipped++;
      }
    }

    await pool.query('COMMIT');

    const verification = await pool.query(`
      SELECT COUNT(*)::int AS count
      FROM xauusd_signals
      WHERE id = ANY($1::text[])
    `, [signals.map(signal => String(signal.id))]);

    console.log('Migration completed.');
    console.log('Backup signals:', signals.length);
    console.log('Inserted:', inserted);
    console.log('Skipped existing IDs:', skipped);
    console.log('Original IDs now present in Neon:', verification.rows[0].count);
  } catch (error) {
    await pool.query('ROLLBACK').catch(() => {});
    console.error('Migration failed; transaction rolled back.');
    console.error(error.message);
    process.exitCode = 1;
  } finally {
    await pool.end();
  }
}

main();
