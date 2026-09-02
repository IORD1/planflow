'use strict';
// One-off: copy boards, tasks and links from the old SQLite file into Postgres
// (DATABASE_URL), keeping the same ids. Replaces whatever Postgres holds.
//
//   docker compose run --rm -v ./data:/data planflow node --no-warnings scripts/migrate-sqlite.js /data/planflow.db
const { DatabaseSync } = require('node:sqlite');
const db = require('../db');

const file = process.argv[2];
if (!file) { console.error('usage: migrate-sqlite.js <path to planflow.db>'); process.exit(2); }

const sqlite = new DatabaseSync(file);
const boards = sqlite.prepare('SELECT * FROM boards ORDER BY id').all();
const tasks = sqlite.prepare('SELECT * FROM tasks ORDER BY id').all();
const deps = sqlite.prepare('SELECT * FROM deps ORDER BY from_id, to_id').all();
sqlite.close();

(async () => {
  await db.init();
  await db.tx(async (c) => {
    await c.query('TRUNCATE deps, tasks, boards RESTART IDENTITY');
    for (const b of boards) {
      await c.query('INSERT INTO boards (id, name, created_at) OVERRIDING SYSTEM VALUE VALUES ($1, $2, $3)',
        [b.id, b.name, b.created_at]);
    }
    for (const t of tasks) {
      await c.query(`INSERT INTO tasks (id, board_id, title, notes, status, x, y, created_at, updated_at, done_at)
                     OVERRIDING SYSTEM VALUE VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
        [t.id, t.board_id, t.title, t.notes, t.status, t.x, t.y, t.created_at, t.updated_at, t.done_at]);
    }
    for (const d of deps) {
      await c.query('INSERT INTO deps (board_id, from_id, to_id) VALUES ($1, $2, $3)', [d.board_id, d.from_id, d.to_id]);
    }
    for (const table of ['boards', 'tasks']) {
      await c.query(`SELECT setval(pg_get_serial_sequence('${table}', 'id'), COALESCE((SELECT max(id) FROM ${table}), 0) + 1, false)`);
    }
  });
  console.log(`migrated ${boards.length} boards, ${tasks.length} tasks, ${deps.length} links from ${file} into ${db.label()}`);
  await db.pool.end();
})().catch((e) => { console.error('migration failed, Postgres left unchanged:', e.message); process.exit(1); });
