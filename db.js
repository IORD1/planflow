'use strict';
// Planflow data layer: PostgreSQL through `pg`. DATABASE_URL points at the shared
// homelab server (postgres://user:password@host:5432/database).
const { Pool } = require('pg');

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) {
  console.error('DATABASE_URL is not set. Example: postgres://planflow:secret@postgres:5432/planflow');
  process.exit(1);
}

const pool = new Pool({ connectionString: DATABASE_URL, max: 5 });
pool.on('error', (e) => console.error('postgres connection dropped:', e.message));

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS boards (
    id         INTEGER PRIMARY KEY GENERATED ALWAYS AS IDENTITY,
    name       TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
  );
  CREATE TABLE IF NOT EXISTS tasks (
    id         INTEGER PRIMARY KEY GENERATED ALWAYS AS IDENTITY,
    board_id   INTEGER NOT NULL REFERENCES boards(id) ON DELETE CASCADE,
    title      TEXT NOT NULL,
    notes      TEXT NOT NULL DEFAULT '',
    status     TEXT NOT NULL DEFAULT 'todo' CHECK (status IN ('todo','done')),
    x          DOUBLE PRECISION NOT NULL DEFAULT 0,
    y          DOUBLE PRECISION NOT NULL DEFAULT 0,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    done_at    TIMESTAMPTZ
  );
  -- from_id must be done before to_id can start ("from blocks to")
  CREATE TABLE IF NOT EXISTS deps (
    board_id INTEGER NOT NULL REFERENCES boards(id) ON DELETE CASCADE,
    from_id  INTEGER NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
    to_id    INTEGER NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
    PRIMARY KEY (from_id, to_id),
    CHECK (from_id <> to_id)
  );
  CREATE INDEX IF NOT EXISTS idx_tasks_board ON tasks(board_id);
  CREATE INDEX IF NOT EXISTS idx_deps_board  ON deps(board_id);
  CREATE INDEX IF NOT EXISTS idx_deps_to     ON deps(to_id);
`;

const all = async (text, params) => (await pool.query(text, params)).rows;
const one = async (text, params) => (await pool.query(text, params)).rows[0];
const run = async (text, params) => (await pool.query(text, params)).rowCount;

// Run fn(client) inside one transaction.
async function tx(fn) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const out = await fn(client);
    await client.query('COMMIT');
    return out;
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    client.release();
  }
}

// Create the tables. The database may still be booting next to us, so keep trying
// on connection errors (but give up at once on real SQL errors such as bad credentials).
async function init({ retries = 30, delayMs = 2000 } = {}) {
  for (let attempt = 1; ; attempt++) {
    try { await pool.query(SCHEMA); return; }
    catch (e) {
      const sqlError = /^[0-9A-Z]{5}$/.test(e.code || '') && e.code !== '57P03';
      if (sqlError || attempt >= retries) throw e;
      console.error(`postgres not ready (${e.message}), retrying ${attempt}/${retries}`);
      await new Promise((r) => setTimeout(r, delayMs));
    }
  }
}

// Human-readable target without the password, for log lines.
function label() {
  try { const u = new URL(DATABASE_URL); return `${u.hostname}:${u.port || 5432}${u.pathname}`; }
  catch { return 'postgres'; }
}

module.exports = { pool, all, one, run, tx, init, label };
