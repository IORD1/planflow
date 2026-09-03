'use strict';
// Planflow — dependency-aware todo board. node:http for the server, PostgreSQL (db.js) for the data.
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const db = require('./db');

const PORT = Number(process.env.PORT) || 8090;
const PUBLIC_DIR = path.join(__dirname, 'public');
const MAX_BODY = 1 << 20; // 1 MiB
const MAX_ID = 2147483647; // ids are Postgres INTEGER

// ---------------------------------------------------------------- queries
const { all, one, run, tx } = db;

const BOARD_SUMMARY = `
  SELECT b.id, b.name, b.created_at,
         (SELECT COUNT(*)::int FROM tasks t WHERE t.board_id = b.id) AS total,
         (SELECT COUNT(*)::int FROM tasks t WHERE t.board_id = b.id AND t.status = 'done') AS done
  FROM boards b`;

const q = {
  boards: () => all(`${BOARD_SUMMARY} ORDER BY b.id`),
  boardSummary: (id) => one(`${BOARD_SUMMARY} WHERE b.id = $1`, [id]),
  board: (id) => one('SELECT id, name, created_at FROM boards WHERE id = $1', [id]),
  insertBoard: async (name) => (await one('INSERT INTO boards (name) VALUES ($1) RETURNING id', [name])).id,
  renameBoard: (name, id) => run('UPDATE boards SET name = $1 WHERE id = $2', [name, id]),
  deleteBoard: (id) => run('DELETE FROM boards WHERE id = $1', [id]),
  tasksOfBoard: (boardId) => all('SELECT * FROM tasks WHERE board_id = $1 ORDER BY id', [boardId]),
  depsOfBoard: (boardId) => all(
    'SELECT from_id AS "from", to_id AS "to", from_side, to_side FROM deps WHERE board_id = $1 ORDER BY from_id, to_id', [boardId]),
  task: (id) => one('SELECT * FROM tasks WHERE id = $1', [id]),
  insertTask: async (boardId, title, notes, x, y) => (await one(
    'INSERT INTO tasks (board_id, title, notes, x, y) VALUES ($1, $2, $3, $4, $5) RETURNING id',
    [boardId, title, notes, x, y])).id,
  updateTask: (title, notes, status, x, y, id) => run(`
    UPDATE tasks SET title = $1, notes = $2, status = $3, x = $4, y = $5,
      done_at = CASE WHEN $3 = 'done' THEN COALESCE(done_at, now()) ELSE NULL END,
      updated_at = now()
    WHERE id = $6`, [title, notes, status, x, y, id]),
  deleteTask: (id) => run('DELETE FROM tasks WHERE id = $1', [id]),
  unfinishedBlockers: async (id) => (await one(`
    SELECT COUNT(*)::int AS n FROM deps d JOIN tasks t ON t.id = d.from_id
    WHERE d.to_id = $1 AND t.status <> 'done'`, [id])).n,
  insertDep: (boardId, from, to, fromSide = 'right', toSide = 'left') => run(
    'INSERT INTO deps (board_id, from_id, to_id, from_side, to_side) VALUES ($1, $2, $3, $4, $5) ON CONFLICT DO NOTHING',
    [boardId, from, to, fromSide, toSide]),
  dep: (from, to) => one(
    'SELECT from_id AS "from", to_id AS "to", from_side, to_side FROM deps WHERE from_id = $1 AND to_id = $2', [from, to]),
  updateDepSides: (from, to, fromSide, toSide) => run(
    'UPDATE deps SET from_side = $3, to_side = $4 WHERE from_id = $1 AND to_id = $2', [from, to, fromSide, toSide]),
  deleteDep: (from, to) => run('DELETE FROM deps WHERE from_id = $1 AND to_id = $2', [from, to]),
  depExists: async (from, to) => Boolean(await one('SELECT 1 FROM deps WHERE from_id = $1 AND to_id = $2', [from, to])),
};

function taskOut(t) {
  return {
    id: t.id, board_id: t.board_id, title: t.title, notes: t.notes, status: t.status,
    x: t.x, y: t.y, created_at: t.created_at, updated_at: t.updated_at, done_at: t.done_at,
  };
}

// Adding from->to creates a cycle iff `from` is already reachable from `to`.
async function wouldCycle(boardId, from, to) {
  if (from === to) return true;
  const next = new Map();
  for (const d of await q.depsOfBoard(boardId)) {
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

async function seedIfEmpty() {
  if ((await q.boards()).length) return;
  const boardId = await q.insertBoard('My first project');
  const mk = (title, x, y, notes = '') => q.insertTask(boardId, title, notes, x, y);
  const a = await mk('Design the database schema', 40, 40, 'Independent task. Nothing blocks it.');
  const b = await mk('Set up the repo and CI', 40, 170);
  const c = await mk('Pick the UI framework', 40, 300);
  const d = await mk('Build the first screen', 340, 170, 'Unlocks only when the three tasks on the left are done.');
  const e = await mk('Ship v0.1', 640, 170);
  for (const [f, t] of [[a, d], [b, d], [c, d], [d, e]]) await q.insertDep(boardId, f, t);
}

// ---------------------------------------------------------------- helpers
class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}
const bad = (msg) => { throw new HttpError(400, msg); };
const notFound = (what) => { throw new HttpError(404, `${what} not found`); };

const isNum = (v) => typeof v === 'number' && Number.isFinite(v);
const isId = (v) => Number.isInteger(v) && v > 0 && v <= MAX_ID;
// Which edge of a card a link is attached to. Missing means "keep the default / current value".
const SIDES = new Set(['left', 'right', 'top', 'bottom']);
function cleanSide(v, fallback) {
  if (v === undefined || v === null) return fallback;
  if (typeof v !== 'string' || !SIDES.has(v)) bad('a side must be left, right, top or bottom');
  return v;
}
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

route('GET', '/api/health', async () => { await one('SELECT 1'); return { ok: true }; });

route('GET', '/api/boards', () => q.boards());

route('POST', '/api/boards', async ({ body }) => {
  const name = cleanTitle(body.name ?? 'Untitled board');
  const id = await q.insertBoard(name);
  return [201, await q.boardSummary(id)];
});

route('GET', '/api/boards/:id', async ({ params }) => {
  const board = (await q.board(params.id)) || notFound('board');
  const [tasks, deps] = await Promise.all([q.tasksOfBoard(board.id), q.depsOfBoard(board.id)]);
  return { board, tasks: tasks.map(taskOut), deps };
});

route('PATCH', '/api/boards/:id', async ({ params, body }) => {
  const board = (await q.board(params.id)) || notFound('board');
  if (body.name !== undefined) await q.renameBoard(cleanTitle(body.name), board.id);
  return q.board(board.id);
});

route('DELETE', '/api/boards/:id', async ({ params }) => {
  if (!(await q.board(params.id))) notFound('board');
  await q.deleteBoard(params.id);
  return [204];
});

route('POST', '/api/boards/:id/tasks', async ({ params, body }) => {
  const board = (await q.board(params.id)) || notFound('board');
  const title = cleanTitle(body.title ?? 'New task');
  const notes = cleanNotes(body.notes ?? '');
  const x = isNum(body.x) ? body.x : 0;
  const y = isNum(body.y) ? body.y : 0;
  const id = await q.insertTask(board.id, title, notes, x, y);
  return [201, taskOut(await q.task(id))];
});

// Bulk move (used by auto-arrange).
route('POST', '/api/boards/:id/positions', async ({ params, body }) => {
  const board = (await q.board(params.id)) || notFound('board');
  if (!Array.isArray(body.positions)) bad('positions must be an array');
  for (const p of body.positions) {
    if (!p || !isId(p.id) || !isNum(p.x) || !isNum(p.y)) bad('bad position entry');
  }
  await tx(async (c) => {
    for (const p of body.positions) {
      await c.query('UPDATE tasks SET x = $1, y = $2 WHERE id = $3 AND board_id = $4', [p.x, p.y, p.id, board.id]);
    }
  });
  return { ok: true };
});

route('PATCH', '/api/tasks/:id', async ({ params, body }) => {
  const t = (await q.task(params.id)) || notFound('task');
  const title = body.title !== undefined ? cleanTitle(body.title) : t.title;
  const notes = body.notes !== undefined ? cleanNotes(body.notes) : t.notes;
  const x = body.x !== undefined ? (isNum(body.x) ? body.x : bad('x must be a number')) : t.x;
  const y = body.y !== undefined ? (isNum(body.y) ? body.y : bad('y must be a number')) : t.y;
  let status = t.status;
  if (body.status !== undefined) {
    if (body.status !== 'todo' && body.status !== 'done') bad("status must be 'todo' or 'done'");
    if (body.status === 'done' && t.status !== 'done' && body.force !== true) {
      const n = await q.unfinishedBlockers(t.id);
      if (n > 0) throw new HttpError(409, `blocked by ${n} unfinished task${n === 1 ? '' : 's'}`);
    }
    status = body.status;
  }
  await q.updateTask(title, notes, status, x, y, t.id);
  return taskOut(await q.task(t.id));
});

route('DELETE', '/api/tasks/:id', async ({ params }) => {
  if (!(await q.task(params.id))) notFound('task');
  await q.deleteTask(params.id);
  return [204];
});

route('POST', '/api/boards/:id/deps', async ({ params, body }) => {
  const board = (await q.board(params.id)) || notFound('board');
  const from = body.from, to = body.to;
  if (!isId(from) || !isId(to)) bad('from and to must be task ids');
  if (from === to) bad('a task cannot block itself');
  const fromSide = cleanSide(body.from_side, 'right'), toSide = cleanSide(body.to_side, 'left');
  const [tf, tt] = await Promise.all([q.task(from), q.task(to)]);
  if (!tf || !tt || tf.board_id !== board.id || tt.board_id !== board.id) notFound('task');
  const existing = await q.dep(from, to);
  if (existing) return { ...existing, existed: true };
  if (await wouldCycle(board.id, from, to)) throw new HttpError(409, 'that link would create a cycle');
  await q.insertDep(board.id, from, to, fromSide, toSide);
  return [201, { from, to, from_side: fromSide, to_side: toSide }];
});

// Move an arrow to other sides of its cards (the link itself stays the same).
route('PATCH', '/api/deps/:from/:to', async ({ params, body }) => {
  const dep = (await q.dep(params.from, params.to)) || notFound('link');
  const fromSide = cleanSide(body.from_side, dep.from_side), toSide = cleanSide(body.to_side, dep.to_side);
  await q.updateDepSides(dep.from, dep.to, fromSide, toSide);
  return { from: dep.from, to: dep.to, from_side: fromSide, to_side: toSide };
});

route('DELETE', '/api/deps/:from/:to', async ({ params }) => {
  if (!(await q.depExists(params.from, params.to))) notFound('link');
  await q.deleteDep(params.from, params.to);
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
        if (Object.values(params).some((v) => !isId(v))) { send(res, 404, { error: 'not found' }); return; }
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

async function main() {
  await db.init();
  await seedIfEmpty();
  server.listen(PORT, '0.0.0.0', () => {
    console.log(`Planflow listening on http://0.0.0.0:${PORT}  (db: ${db.label()})`);
  });
}
main().catch((e) => { console.error('startup failed:', e.message); process.exit(1); });

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => { server.close(); db.pool.end().finally(() => process.exit(0)); });
}
