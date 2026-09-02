'use strict';
// Planflow — dependency-aware todo board. Zero npm dependencies: node:http + node:sqlite.
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

const PORT = Number(process.env.PORT) || 8090;
const DB_PATH = process.env.DB_PATH || path.join(__dirname, 'data', 'planflow.db');
const PUBLIC_DIR = path.join(__dirname, 'public');
const MAX_BODY = 1 << 20; // 1 MiB

// ---------------------------------------------------------------- database
fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
const db = new DatabaseSync(DB_PATH);
db.exec(`
  PRAGMA journal_mode = WAL;
  PRAGMA foreign_keys = ON;
  CREATE TABLE IF NOT EXISTS boards (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    name       TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
  );
  CREATE TABLE IF NOT EXISTS tasks (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    board_id   INTEGER NOT NULL REFERENCES boards(id) ON DELETE CASCADE,
    title      TEXT NOT NULL,
    notes      TEXT NOT NULL DEFAULT '',
    status     TEXT NOT NULL DEFAULT 'todo' CHECK (status IN ('todo','done')),
    x          REAL NOT NULL DEFAULT 0,
    y          REAL NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    done_at    TEXT
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
`);

const q = {
  boards: db.prepare(`
    SELECT b.id, b.name, b.created_at,
           (SELECT COUNT(*) FROM tasks t WHERE t.board_id = b.id) AS total,
           (SELECT COUNT(*) FROM tasks t WHERE t.board_id = b.id AND t.status = 'done') AS done
    FROM boards b ORDER BY b.id`),
  board: db.prepare('SELECT id, name, created_at FROM boards WHERE id = ?'),
  insertBoard: db.prepare('INSERT INTO boards (name) VALUES (?)'),
  renameBoard: db.prepare('UPDATE boards SET name = ? WHERE id = ?'),
  deleteBoard: db.prepare('DELETE FROM boards WHERE id = ?'),
  tasksOfBoard: db.prepare('SELECT * FROM tasks WHERE board_id = ? ORDER BY id'),
  depsOfBoard: db.prepare('SELECT from_id AS "from", to_id AS "to" FROM deps WHERE board_id = ? ORDER BY from_id, to_id'),
  task: db.prepare('SELECT * FROM tasks WHERE id = ?'),
  insertTask: db.prepare('INSERT INTO tasks (board_id, title, notes, x, y) VALUES (?, ?, ?, ?, ?)'),
  updateTask: db.prepare(`
    UPDATE tasks SET title = ?, notes = ?, status = ?, x = ?, y = ?,
      done_at = CASE WHEN ? = 'done' THEN COALESCE(done_at, strftime('%Y-%m-%dT%H:%M:%fZ','now')) ELSE NULL END,
      updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
    WHERE id = ?`),
  moveTask: db.prepare('UPDATE tasks SET x = ?, y = ? WHERE id = ? AND board_id = ?'),
  deleteTask: db.prepare('DELETE FROM tasks WHERE id = ?'),
  unfinishedBlockers: db.prepare(`
    SELECT COUNT(*) AS n FROM deps d JOIN tasks t ON t.id = d.from_id
    WHERE d.to_id = ? AND t.status <> 'done'`),
  insertDep: db.prepare('INSERT OR IGNORE INTO deps (board_id, from_id, to_id) VALUES (?, ?, ?)'),
  deleteDep: db.prepare('DELETE FROM deps WHERE from_id = ? AND to_id = ?'),
  depExists: db.prepare('SELECT 1 FROM deps WHERE from_id = ? AND to_id = ?'),
};

function taskOut(t) {
  return {
    id: t.id, board_id: t.board_id, title: t.title, notes: t.notes, status: t.status,
    x: t.x, y: t.y, created_at: t.created_at, updated_at: t.updated_at, done_at: t.done_at,
  };
}

// Adding from->to creates a cycle iff `from` is already reachable from `to`.
function wouldCycle(boardId, from, to) {
  if (from === to) return true;
  const next = new Map();
  for (const d of q.depsOfBoard.all(boardId)) {
    if (!next.has(d.from)) next.set(d.from, []);
    next.get(d.from).push(d.to);
  }
  const seen = new Set([to]);
  const stack = [to];
  while (stack.length) {
    const cur = stack.pop();
    for (const n of next.get(cur) || []) {
      if (n === from) return true;
      if (!seen.has(n)) { seen.add(n); stack.push(n); }
    }
  }
  return false;
}

function seedIfEmpty() {
  if (q.boards.all().length) return;
  const boardId = Number(q.insertBoard.run('My first project').lastInsertRowid);
  const mk = (title, x, y, notes = '') => Number(q.insertTask.run(boardId, title, notes, x, y).lastInsertRowid);
  const a = mk('Design the database schema', 40, 40, 'Independent task. Nothing blocks it.');
  const b = mk('Set up the repo and CI', 40, 170);
  const c = mk('Pick the UI framework', 40, 300);
  const d = mk('Build the first screen', 340, 170, 'Unlocks only when the three tasks on the left are done.');
  const e = mk('Ship v0.1', 640, 170);
  for (const [f, t] of [[a, d], [b, d], [c, d], [d, e]]) q.insertDep.run(boardId, f, t);
}
seedIfEmpty();

// ---------------------------------------------------------------- helpers
class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}
const bad = (msg) => { throw new HttpError(400, msg); };
const notFound = (what) => { throw new HttpError(404, `${what} not found`); };

const isNum = (v) => typeof v === 'number' && Number.isFinite(v);
const cleanTitle = (v) => {
  if (typeof v !== 'string') bad('title must be a string');
  const t = v.trim();
  if (!t) bad('title cannot be empty');
  if (t.length > 300) bad('title too long');
  return t;
};
const cleanNotes = (v) => {
  if (typeof v !== 'string') bad('notes must be a string');
  if (v.length > 20000) bad('notes too long');
  return v;
};

function readJson(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY) { reject(new HttpError(413, 'body too large')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      if (!chunks.length) return resolve({});
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
      catch { reject(new HttpError(400, 'invalid JSON body')); }
    });
    req.on('error', reject);
  });
}

function send(res, status, body) {
  if (body === undefined) { res.writeHead(status); res.end(); return; }
  const json = JSON.stringify(body);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(json);
}

// ---------------------------------------------------------------- routes
const routes = [];
function route(method, pattern, handler) {
  const keys = [];
  const re = new RegExp('^' + pattern.replace(/:(\w+)/g, (_, k) => { keys.push(k); return '(\\d+)'; }) + '$');
  routes.push({ method, re, keys, handler });
}

route('GET', '/api/health', () => ({ ok: true }));

route('GET', '/api/boards', () => q.boards.all());

route('POST', '/api/boards', ({ body }) => {
  const name = cleanTitle(body.name ?? 'Untitled board');
  const id = Number(q.insertBoard.run(name).lastInsertRowid);
  return [201, q.boards.all().find((b) => b.id === id)];
});

route('GET', '/api/boards/:id', ({ params }) => {
  const board = q.board.get(params.id) || notFound('board');
  return { board, tasks: q.tasksOfBoard.all(params.id).map(taskOut), deps: q.depsOfBoard.all(params.id) };
});

route('PATCH', '/api/boards/:id', ({ params, body }) => {
  const board = q.board.get(params.id) || notFound('board');
  if (body.name !== undefined) q.renameBoard.run(cleanTitle(body.name), board.id);
  return q.board.get(board.id);
});

route('DELETE', '/api/boards/:id', ({ params }) => {
  if (!q.board.get(params.id)) notFound('board');
  q.deleteBoard.run(params.id);
  return [204];
});

route('POST', '/api/boards/:id/tasks', ({ params, body }) => {
  const board = q.board.get(params.id) || notFound('board');
  const title = cleanTitle(body.title ?? 'New task');
  const notes = cleanNotes(body.notes ?? '');
  const x = isNum(body.x) ? body.x : 0;
  const y = isNum(body.y) ? body.y : 0;
  const id = Number(q.insertTask.run(board.id, title, notes, x, y).lastInsertRowid);
  return [201, taskOut(q.task.get(id))];
});

// Bulk move (used by auto-arrange).
route('POST', '/api/boards/:id/positions', ({ params, body }) => {
  const board = q.board.get(params.id) || notFound('board');
  if (!Array.isArray(body.positions)) bad('positions must be an array');
  const tx = db.prepare('BEGIN'); tx.run();
  try {
    for (const p of body.positions) {
      if (!p || !Number.isInteger(p.id) || !isNum(p.x) || !isNum(p.y)) bad('bad position entry');
      q.moveTask.run(p.x, p.y, p.id, board.id);
    }
    db.prepare('COMMIT').run();
  } catch (e) { db.prepare('ROLLBACK').run(); throw e; }
  return { ok: true };
});

route('PATCH', '/api/tasks/:id', ({ params, body }) => {
  const t = q.task.get(params.id) || notFound('task');
  const title = body.title !== undefined ? cleanTitle(body.title) : t.title;
  const notes = body.notes !== undefined ? cleanNotes(body.notes) : t.notes;
  const x = body.x !== undefined ? (isNum(body.x) ? body.x : bad('x must be a number')) : t.x;
  const y = body.y !== undefined ? (isNum(body.y) ? body.y : bad('y must be a number')) : t.y;
  let status = t.status;
  if (body.status !== undefined) {
    if (body.status !== 'todo' && body.status !== 'done') bad("status must be 'todo' or 'done'");
    if (body.status === 'done' && t.status !== 'done' && body.force !== true) {
      const n = q.unfinishedBlockers.get(t.id).n;
      if (n > 0) throw new HttpError(409, `blocked by ${n} unfinished task${n === 1 ? '' : 's'}`);
    }
    status = body.status;
  }
  q.updateTask.run(title, notes, status, x, y, status, t.id);
  return taskOut(q.task.get(t.id));
});

route('DELETE', '/api/tasks/:id', ({ params }) => {
  if (!q.task.get(params.id)) notFound('task');
  q.deleteTask.run(params.id);
  return [204];
});

route('POST', '/api/boards/:id/deps', ({ params, body }) => {
  const board = q.board.get(params.id) || notFound('board');
  const from = body.from, to = body.to;
  if (!Number.isInteger(from) || !Number.isInteger(to)) bad('from and to must be task ids');
  if (from === to) bad('a task cannot block itself');
  const tf = q.task.get(from), tt = q.task.get(to);
  if (!tf || !tt || tf.board_id !== board.id || tt.board_id !== board.id) notFound('task');
  if (q.depExists.get(from, to)) return { from, to, existed: true };
  if (wouldCycle(board.id, from, to)) throw new HttpError(409, 'that link would create a cycle');
  q.insertDep.run(board.id, from, to);
  return [201, { from, to }];
});

route('DELETE', '/api/deps/:from/:to', ({ params }) => {
  if (!q.depExists.get(params.from, params.to)) notFound('link');
  q.deleteDep.run(params.from, params.to);
  return [204];
});

// ---------------------------------------------------------------- static
const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png',
  '.ico': 'image/x-icon', '.json': 'application/json', '.webmanifest': 'application/manifest+json',
};
function serveStatic(req, res, pathname) {
  if (pathname === '/') pathname = '/index.html';
  const file = path.normalize(path.join(PUBLIC_DIR, pathname));
  if (!file.startsWith(PUBLIC_DIR + path.sep)) { send(res, 404, { error: 'not found' }); return; }
  fs.stat(file, (err, st) => {
    if (err || !st.isFile()) { send(res, 404, { error: 'not found' }); return; }
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(file)] || 'application/octet-stream',
      'Content-Length': st.size,
      'Cache-Control': 'no-cache',
    });
    if (req.method === 'HEAD') { res.end(); return; }
    fs.createReadStream(file).pipe(res);
  });
}

// ---------------------------------------------------------------- server
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  try {
    if (url.pathname.startsWith('/api/')) {
      for (const r of routes) {
        const m = url.pathname.match(r.re);
        if (!m || r.method !== req.method) continue;
        const params = {};
        r.keys.forEach((k, i) => { params[k] = Number(m[i + 1]); });
        const body = (req.method === 'POST' || req.method === 'PATCH') ? await readJson(req) : {};
        if (body === null || typeof body !== 'object' || Array.isArray(body)) bad('body must be a JSON object');
        const out = await r.handler({ params, body, url });
        if (Array.isArray(out) && typeof out[0] === 'number') send(res, out[0], out[1]);
        else send(res, 200, out);
        return;
      }
      const known = routes.some((r) => url.pathname.match(r.re));
      send(res, known ? 405 : 404, { error: known ? 'method not allowed' : 'not found' });
      return;
    }
    if (req.method !== 'GET' && req.method !== 'HEAD') { send(res, 405, { error: 'method not allowed' }); return; }
    serveStatic(req, res, decodeURIComponent(url.pathname));
  } catch (e) {
    if (e instanceof HttpError) send(res, e.status, { error: e.message });
    else { console.error(e); send(res, 500, { error: 'internal error' }); }
  }
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`Planflow listening on http://0.0.0.0:${PORT}  (db: ${DB_PATH})`);
});

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => { server.close(); db.close(); process.exit(0); });
}
