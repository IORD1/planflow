'use strict';
// Planflow — dependency-aware todo board. node:http for the server, PostgreSQL (db.js) for the data.
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const db = require('./db');

const PORT = Number(process.env.PORT) || 8090;
const PUBLIC_DIR = path.join(__dirname, 'public');
const MAX_BODY = 1 << 20;            // 1 MiB for JSON bodies
const MAX_UPLOAD = 8 << 20;          // 8 MiB for a pasted image (the browser shrinks big ones first)
const MAX_PREVIEW_IMAGE = 4 << 20;   // an og:image downloaded for a link preview; bigger ones are skipped
const MAX_HTML = 512 * 1024;         // how much of a page to read when looking for its title and og: tags
const FETCH_TIMEOUT = 8000;          // ms, per request, when fetching a link preview
const TRASH_DAYS = 7;                // deleted tasks can be restored for this long
const MAX_ID = 2147483647;           // ids are Postgres INTEGER
const UA = 'Mozilla/5.0 (compatible; Planflow/1.0; +https://github.com/IORD1/planflow)';

// ---------------------------------------------------------------- queries
const { all, one, run, tx } = db;

const BOARD_SUMMARY = `
  SELECT b.id, b.name, b.created_at,
         (SELECT COUNT(*)::int FROM tasks t WHERE t.board_id = b.id AND t.deleted_at IS NULL) AS total,
         (SELECT COUNT(*)::int FROM tasks t WHERE t.board_id = b.id AND t.deleted_at IS NULL AND t.status = 'done') AS done
  FROM boards b`;

// A task row plus its cover's metadata (never the picture bytes: those have their own route).
const TASK_SELECT = `
  SELECT t.id, t.board_id, t.title, t.notes, t.status, t.x, t.y, t.created_at, t.updated_at, t.done_at, t.deleted_at,
         c.kind AS cover_kind, c.url AS cover_url, c.title AS cover_title, c.description AS cover_description,
         c.site AS cover_site, (c.image IS NOT NULL) AS cover_has_image, c.width AS cover_width, c.height AS cover_height,
         c.updated_at AS cover_updated_at
  FROM tasks t LEFT JOIN covers c ON c.task_id = t.id`;

const q = {
  boards: () => all(`${BOARD_SUMMARY} ORDER BY b.id`),
  boardSummary: (id) => one(`${BOARD_SUMMARY} WHERE b.id = $1`, [id]),
  board: (id) => one('SELECT id, name, created_at FROM boards WHERE id = $1', [id]),
  insertBoard: async (name) => (await one('INSERT INTO boards (name) VALUES ($1) RETURNING id', [name])).id,
  renameBoard: (name, id) => run('UPDATE boards SET name = $1 WHERE id = $2', [name, id]),
  deleteBoard: (id) => run('DELETE FROM boards WHERE id = $1', [id]),
  tasksOfBoard: (boardId) => all(`${TASK_SELECT} WHERE t.board_id = $1 AND t.deleted_at IS NULL ORDER BY t.id`, [boardId]),
  // Links between two live tasks only: a deleted task's links wait in the trash with it.
  depsOfBoard: (boardId) => all(`
    SELECT d.from_id AS "from", d.to_id AS "to", d.from_side, d.to_side
    FROM deps d JOIN tasks a ON a.id = d.from_id JOIN tasks b ON b.id = d.to_id
    WHERE d.board_id = $1 AND a.deleted_at IS NULL AND b.deleted_at IS NULL
    ORDER BY d.from_id, d.to_id`, [boardId]),
  task: (id) => one(`${TASK_SELECT} WHERE t.id = $1 AND t.deleted_at IS NULL`, [id]),
  taskAny: (id) => one(`${TASK_SELECT} WHERE t.id = $1`, [id]),   // including the trash
  insertTask: async (boardId, title, notes, x, y) => (await one(
    'INSERT INTO tasks (board_id, title, notes, x, y) VALUES ($1, $2, $3, $4, $5) RETURNING id',
    [boardId, title, notes, x, y])).id,
  updateTask: (title, notes, status, x, y, id) => run(`
    UPDATE tasks SET title = $1, notes = $2, status = $3, x = $4, y = $5,
      done_at = CASE WHEN $3 = 'done' THEN COALESCE(done_at, now()) ELSE NULL END,
      updated_at = now()
    WHERE id = $6`, [title, notes, status, x, y, id]),
  renameTask: (title, id) => run('UPDATE tasks SET title = $1, updated_at = now() WHERE id = $2', [title, id]),
  // Delete = move to the trash. The row, its links and its cover stay until purgeTrash.
  deleteTask: (id) => run('UPDATE tasks SET deleted_at = now() WHERE id = $1 AND deleted_at IS NULL', [id]),
  restoreTask: (id) => run('UPDATE tasks SET deleted_at = NULL, updated_at = now() WHERE id = $1', [id]),
  purgeTrash: () => run('DELETE FROM tasks WHERE deleted_at < now() - make_interval(days => $1)', [TRASH_DAYS]),
  unfinishedBlockers: async (id) => (await one(`
    SELECT COUNT(*)::int AS n FROM deps d JOIN tasks t ON t.id = d.from_id
    WHERE d.to_id = $1 AND t.status <> 'done' AND t.deleted_at IS NULL`, [id])).n,
  insertDep: (boardId, from, to, fromSide = 'right', toSide = 'left') => run(
    'INSERT INTO deps (board_id, from_id, to_id, from_side, to_side) VALUES ($1, $2, $3, $4, $5) ON CONFLICT DO NOTHING',
    [boardId, from, to, fromSide, toSide]),
  dep: (from, to) => one(
    'SELECT from_id AS "from", to_id AS "to", from_side, to_side FROM deps WHERE from_id = $1 AND to_id = $2', [from, to]),
  updateDepSides: (from, to, fromSide, toSide) => run(
    'UPDATE deps SET from_side = $3, to_side = $4 WHERE from_id = $1 AND to_id = $2', [from, to, fromSide, toSide]),
  deleteDep: (from, to) => run('DELETE FROM deps WHERE from_id = $1 AND to_id = $2', [from, to]),
  depExists: async (from, to) => Boolean(await one('SELECT 1 FROM deps WHERE from_id = $1 AND to_id = $2', [from, to])),
  setCover: (taskId, c) => run(`
    INSERT INTO covers (task_id, kind, url, title, description, site, mime, image, width, height)
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
    ON CONFLICT (task_id) DO UPDATE SET kind = EXCLUDED.kind, url = EXCLUDED.url, title = EXCLUDED.title,
      description = EXCLUDED.description, site = EXCLUDED.site, mime = EXCLUDED.mime, image = EXCLUDED.image,
      width = EXCLUDED.width, height = EXCLUDED.height, updated_at = now()`,
    [taskId, c.kind, c.url, c.title, c.description, c.site, c.mime, c.image, c.width, c.height]),
  deleteCover: (taskId) => run('DELETE FROM covers WHERE task_id = $1', [taskId]),
  coverImage: (taskId) => one('SELECT mime, image FROM covers WHERE task_id = $1 AND image IS NOT NULL', [taskId]),
};

function taskOut(t) {
  const cover = t.cover_kind ? {
    kind: t.cover_kind, url: t.cover_url, title: t.cover_title, description: t.cover_description, site: t.cover_site,
    image: Boolean(t.cover_has_image), width: t.cover_width, height: t.cover_height,
    v: t.cover_updated_at ? new Date(t.cover_updated_at).getTime() : 0,   // cache key for the picture
  } : null;
  return {
    id: t.id, board_id: t.board_id, title: t.title, notes: t.notes, status: t.status,
    x: t.x, y: t.y, created_at: t.created_at, updated_at: t.updated_at, done_at: t.done_at, cover,
  };
}

// Adding from->to to `deps` creates a cycle iff `from` is already reachable from `to`.
function cycleIn(deps, from, to) {
  if (from === to) return true;
  const next = new Map();
  for (const d of deps) {
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
const wouldCycle = async (boardId, from, to) => cycleIn(await q.depsOfBoard(boardId), from, to);

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
// A handler returns one of these to answer with something other than JSON (the cover picture).
class Raw {
  constructor(status, headers, body) { this.status = status; this.headers = headers; this.body = body; }
}
const bad = (msg) => { throw new HttpError(400, msg); };
const notFound = (what) => { throw new HttpError(404, `${what} not found`); };

const isNum = (v) => typeof v === 'number' && Number.isFinite(v);
const isId = (v) => Number.isInteger(v) && v > 0 && v <= MAX_ID;
const trunc = (s, n) => (s ? String(s).slice(0, n) : null);
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
function cleanUrl(v) {
  if (typeof v !== 'string' || v.length > 2000) bad('url must be a string');
  let u;
  try { u = new URL(v.trim()); } catch { bad('url is not a valid web address'); }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') bad('url must start with http:// or https://');
  return u.href;
}

function readBody(req, max) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > max) { reject(new HttpError(413, 'body too large')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}
async function readJson(req) {
  const buf = await readBody(req, MAX_BODY);
  if (!buf.length) return {};
  try { return JSON.parse(buf.toString('utf8')); }
  catch { throw new HttpError(400, 'invalid JSON body'); }
}

function send(res, status, body) {
  if (body === undefined) { res.writeHead(status); res.end(); return; }
  if (body instanceof Raw) { res.writeHead(body.status, body.headers); res.end(body.body); return; }
  const json = JSON.stringify(body);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(json);
}

// ---------------------------------------------------------------- images and link previews
// Pictures are stored as they arrive (no image library on the server); the browser already
// shrinks pasted images, and an og:image bigger than MAX_PREVIEW_IMAGE is simply skipped.
function sniffImage(b) {
  if (b.length < 12) return null;
  if (b[0] === 0x89 && b.toString('ascii', 1, 4) === 'PNG') return 'image/png';
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'image/jpeg';
  if (b.toString('ascii', 0, 4) === 'GIF8') return 'image/gif';
  if (b.toString('ascii', 0, 4) === 'RIFF' && b.toString('ascii', 8, 12) === 'WEBP') return 'image/webp';
  if (b.toString('ascii', 4, 12) === 'ftypavif') return 'image/avif';
  if (b[0] === 0x42 && b[1] === 0x4d) return 'image/bmp';
  return null;
}
// Width and height from the file header, so the card can reserve the right space before the
// picture loads. Returns null for formats it does not know (the client then measures on load).
function imageSize(b) {
  try {
    if (b.length > 24 && b[0] === 0x89 && b.toString('ascii', 1, 4) === 'PNG') return { width: b.readUInt32BE(16), height: b.readUInt32BE(20) };
    if (b.length > 10 && b.toString('ascii', 0, 4) === 'GIF8') return { width: b.readUInt16LE(6), height: b.readUInt16LE(8) };
    if (b.length > 4 && b[0] === 0xff && b[1] === 0xd8) {          // JPEG: walk the segments to the first frame header
      let i = 2;
      while (i + 9 < b.length) {
        if (b[i] !== 0xff) { i++; continue; }
        const m = b[i + 1];
        if (m === 0xff) { i++; continue; }
        if (m === 0xd8 || m === 0x01 || (m >= 0xd0 && m <= 0xd7)) { i += 2; continue; }
        if (m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc) return { height: b.readUInt16BE(i + 5), width: b.readUInt16BE(i + 7) };
        i += 2 + b.readUInt16BE(i + 2);
      }
      return null;
    }
    if (b.length > 30 && b.toString('ascii', 0, 4) === 'RIFF' && b.toString('ascii', 8, 12) === 'WEBP') {
      const chunk = b.toString('ascii', 12, 16);
      if (chunk === 'VP8 ') return { width: b.readUInt16LE(26) & 0x3fff, height: b.readUInt16LE(28) & 0x3fff };
      if (chunk === 'VP8L') { const bits = b.readUInt32LE(21); return { width: (bits & 0x3fff) + 1, height: ((bits >>> 14) & 0x3fff) + 1 }; }
      if (chunk === 'VP8X') return { width: b.readUIntLE(24, 3) + 1, height: b.readUIntLE(27, 3) + 1 };
    }
  } catch { /* a malformed header: no size */ }
  return null;
}
const validSize = (s) => (s && isNum(s.width) && isNum(s.height) && s.width > 0 && s.height > 0 && s.width < 100000 && s.height < 100000 ? s : { width: null, height: null });

// GET a URL with a time limit, reading at most `max` bytes (truncated: true when there was more).
async function fetchLimited(url, accept, max) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT);
  try {
    const res = await fetch(url, { signal: ctrl.signal, redirect: 'follow', headers: { 'User-Agent': UA, Accept: accept } });
    const type = (res.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
    const chunks = [];
    let size = 0, truncated = false;
    if (res.body) {
      for await (const chunk of res.body) {
        size += chunk.length;
        if (size > max) { chunks.push(chunk.subarray(0, chunk.length - (size - max))); truncated = true; break; }
        chunks.push(chunk);
      }
    }
    return { ok: res.ok, type, url: res.url || url, body: Buffer.concat(chunks), truncated };
  } finally { clearTimeout(timer); }
}
function decodeEntities(s) {
  const named = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, c) => {
    if (c[0] === '#') { const n = c[1] === 'x' || c[1] === 'X' ? parseInt(c.slice(2), 16) : parseInt(c.slice(1), 10); return Number.isFinite(n) && n > 0 && n < 0x110000 ? String.fromCodePoint(n) : m; }
    return named[c.toLowerCase()] ?? m;
  });
}
const tidy = (s) => (s ? decodeEntities(s).replace(/\s+/g, ' ').trim() || null : null);
function attrOf(tag, name) {
  const m = tag.match(new RegExp('\\s' + name + '\\s*=\\s*(?:"([^"]*)"|\'([^\']*)\'|([^\\s"\'>]+))', 'i'));
  return m ? (m[1] ?? m[2] ?? m[3] ?? '') : null;
}
// The <title> and the <meta property/name=... content=...> tags of a page, first one of each name wins.
function parseMeta(html) {
  const meta = {};
  for (const tag of html.match(/<meta\b[^>]*>/gi) || []) {
    const key = (attrOf(tag, 'property') || attrOf(tag, 'name') || '').toLowerCase();
    const content = attrOf(tag, 'content');
    if (key && content && !(key in meta)) meta[key] = tidy(content);
  }
  const t = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  return { meta, title: t ? tidy(t[1]) : null };
}
const basename = (url) => { try { return decodeURIComponent(new URL(url).pathname.split('/').pop() || '') || null; } catch { return null; } };
const hostOf = (url) => { try { return new URL(url).hostname.replace(/^www\./, ''); } catch { return null; } };

// What a pasted link looks like on a card. Never throws: an unreachable page still gives a
// bare link cover (host name only), so the paste itself always works.
async function linkPreview(url) {
  const cover = { kind: 'link', url, title: null, description: null, site: hostOf(url), mime: null, image: null, width: null, height: null };
  let page;
  try { page = await fetchLimited(url, 'text/html,application/xhtml+xml;q=0.9,image/*;q=0.8,*/*;q=0.5', MAX_HTML); }
  catch { return cover; }
  if (page.type.startsWith('image/')) {                       // a link straight to a picture: use it as an image cover
    if (!page.ok || page.truncated) return cover;
    const mime = sniffImage(page.body) || page.type;
    return { ...cover, kind: 'image', title: basename(url), mime, image: page.body, ...validSize(imageSize(page.body)) };
  }
  if (!page.ok || !/html|xml/.test(page.type)) return cover;
  const { meta, title } = parseMeta(page.body.toString('utf8'));
  cover.title = trunc(meta['og:title'] || meta['twitter:title'] || title, 300);
  cover.description = trunc(meta['og:description'] || meta['twitter:description'] || meta.description, 500);
  cover.site = trunc(meta['og:site_name'] || cover.site, 100);
  const img = meta['og:image'] || meta['og:image:url'] || meta['og:image:secure_url'] || meta['twitter:image'] || meta['twitter:image:src'];
  if (img) {
    try {
      const abs = new URL(img, page.url).href;
      if (/^https?:/.test(abs)) {
        const r = await fetchLimited(abs, 'image/*,*/*;q=0.5', MAX_PREVIEW_IMAGE);
        const mime = sniffImage(r.body) || (r.type.startsWith('image/') ? r.type : null);
        if (r.ok && !r.truncated && mime && r.body.length) Object.assign(cover, { mime, image: r.body, ...validSize(imageSize(r.body)) });
      }
    } catch { /* no picture, keep the text */ }
  }
  return cover;
}

// ---------------------------------------------------------------- routes
const routes = [];
// opts.raw: a POST whose body is not JSON (Content-Type image/*) is handed to the handler as `raw` bytes.
function route(method, pattern, handler, opts = {}) {
  const keys = [];
  const re = new RegExp('^' + pattern.replace(/:(\w+)/g, (_, k) => { keys.push(k); return '(\\d+)'; }) + '$');
  routes.push({ method, re, keys, handler, raw: Boolean(opts.raw) });
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

// Moves the task to the trash; POST /api/tasks/:id/restore brings it back for TRASH_DAYS.
route('DELETE', '/api/tasks/:id', async ({ params }) => {
  if (!(await q.task(params.id))) notFound('task');
  await q.deleteTask(params.id);
  q.purgeTrash().catch((e) => console.error('purge failed:', e.message));
  return [204];
});

// Undo a delete. Links to other live tasks come back with it, except any that would now form a
// loop (possible if links were added while the task was in the trash); those are dropped.
route('POST', '/api/tasks/:id/restore', async ({ params }) => {
  const t = await q.taskAny(params.id);
  if (!t || !t.deleted_at) notFound('deleted task');
  await q.restoreTask(t.id);
  const deps = await q.depsOfBoard(t.board_id);
  const others = deps.filter((d) => d.from !== t.id && d.to !== t.id);
  const kept = [];
  for (const d of deps.filter((d) => d.from === t.id || d.to === t.id)) {
    if (cycleIn(others.concat(kept), d.from, d.to)) await q.deleteDep(d.from, d.to);
    else kept.push(d);
  }
  return { task: taskOut(await q.task(t.id)), deps: kept };
});

// Set the card's cover. Either raw image bytes (Content-Type image/*, optional ?name=&w=&h=),
// or JSON {url, rename?}: the server fetches the page's title and picture; rename:true also
// makes the page title the task title (used for cards created by pasting a link).
route('POST', '/api/tasks/:id/cover', async ({ params, body, raw, url }) => {
  const t = (await q.task(params.id)) || notFound('task');
  if (raw && raw.length) {
    const mime = sniffImage(raw);
    if (!mime) bad('unsupported image (use PNG, JPEG, GIF, WebP, AVIF or BMP)');
    const hint = { width: Number(url.searchParams.get('w')), height: Number(url.searchParams.get('h')) };
    const size = imageSize(raw) || hint;
    await q.setCover(t.id, { kind: 'image', url: null, title: trunc(url.searchParams.get('name'), 200), description: null,
      site: null, mime, image: raw, ...validSize(size) });
  } else {
    const link = cleanUrl(body.url);
    const cover = await linkPreview(link);
    await q.setCover(t.id, cover);
    if (body.rename === true && cover.title) await q.renameTask(cover.title.slice(0, 300), t.id);
  }
  return taskOut(await q.task(t.id));
}, { raw: true });

route('DELETE', '/api/tasks/:id/cover', async ({ params }) => {
  const t = (await q.task(params.id)) || notFound('task');
  await q.deleteCover(t.id);
  return taskOut(await q.task(t.id));
});

// The cover picture itself. The client adds ?v=<cover.v>, so the response can be cached forever.
route('GET', '/api/tasks/:id/cover-image', async ({ params }) => {
  const c = (await q.coverImage(params.id)) || notFound('image');
  return new Raw(200, { 'Content-Type': c.mime, 'Content-Length': c.image.length, 'Cache-Control': 'public, max-age=31536000, immutable' }, c.image);
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
        let body = {}, raw = null;
        if (req.method === 'POST' || req.method === 'PATCH') {
          const type = (req.headers['content-type'] || '').toLowerCase();
          if (r.raw && type && !type.startsWith('application/json')) raw = await readBody(req, MAX_UPLOAD);
          else body = await readJson(req);
        }
        if (body === null || typeof body !== 'object' || Array.isArray(body)) bad('body must be a JSON object');
        const out = await r.handler({ params, body, raw, url });
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
  await q.purgeTrash().catch((e) => console.error('purge failed:', e.message));
  server.listen(PORT, '0.0.0.0', () => {
    console.log(`Planflow listening on http://0.0.0.0:${PORT}  (db: ${db.label()})`);
  });
}
main().catch((e) => { console.error('startup failed:', e.message); process.exit(1); });

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => { server.close(); db.pool.end().finally(() => process.exit(0)); });
}
