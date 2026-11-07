// Headless-Chrome UI test for the home page: plan cards with thumbnails and a tilt, drag a card
// into the archive box, the archived list, restore, the day/dark switch, and navigation.
// Run against a LOCAL server on a throwaway database:
//   PLANFLOW_URL=http://localhost:8093 node scripts/ui-test-home.mjs   (node 20 needs --experimental-websocket)
import { spawn } from 'node:child_process';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
const S = process.env.SCRATCH || os.tmpdir();
const BASE = process.env.PLANFLOW_URL || 'http://localhost:8093', PORT = 9225;
const CHROME = process.env.CHROME || '/usr/bin/google-chrome';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function call(method, path, body) {
  const res = await fetch(BASE + path, { method, headers: body ? { 'content-type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined });
  return { status: res.status, data: res.status === 204 ? null : await res.json().catch(() => null) };
}
// --- fixture: three plans with different shapes, one of them empty
const stamp = Date.now();
const mkBoard = async (name) => (await call('POST', '/api/boards', { name })).data;
const P1 = await mkBoard('ui-home chain ' + stamp), P2 = await mkBoard('ui-home fan ' + stamp), P3 = await mkBoard('ui-home empty ' + stamp);
const mk = async (b, title, x, y) => (await call('POST', `/api/boards/${b.id}/tasks`, { title, x, y })).data;
{
  const a = await mk(P1, 'A', 0, 0), b = await mk(P1, 'B', 300, 0), c = await mk(P1, 'C', 600, 0), d = await mk(P1, 'D', 600, 140);
  await call('POST', `/api/boards/${P1.id}/deps`, { from: a.id, to: b.id }); await call('POST', `/api/boards/${P1.id}/deps`, { from: b.id, to: c.id });
  await call('POST', `/api/boards/${P1.id}/deps`, { from: b.id, to: d.id, from_side: 'bottom', to_side: 'left' });
  await call('PATCH', `/api/tasks/${a.id}`, { status: 'done' });
  const h = await mk(P2, 'hub', 300, 150);
  for (let i = 0; i < 4; i++) { const t = await mk(P2, 'in ' + i, 0, i * 110); await call('POST', `/api/boards/${P2.id}/deps`, { from: t.id, to: h.id }); }
}
const mine = (ids) => ids.filter((id) => [P1.id, P2.id, P3.id].includes(id));
// --- chrome
fs.rmSync(`${S}/planflow-chrome-home`, { recursive: true, force: true });
const chrome = spawn(CHROME, ['--headless=new', `--remote-debugging-port=${PORT}`, '--window-size=1400,900', '--no-first-run', '--no-default-browser-check', '--disable-gpu', `--user-data-dir=${S}/planflow-chrome-home`, 'about:blank'], { stdio: 'ignore' });
const cleanup = async () => { chrome.kill(); for (const b of [P1, P2, P3]) await call('DELETE', `/api/boards/${b.id}`); };
process.on('exit', () => chrome.kill());
let targets = [];
for (let i = 0; i < 50 && !targets.length; i++) { try { targets = (await (await fetch(`http://127.0.0.1:${PORT}/json`)).json()).filter((t) => t.type === 'page'); } catch {} if (!targets.length) await sleep(200); }
const ws = new WebSocket(targets[0].webSocketDebuggerUrl);
await new Promise((r) => (ws.onopen = r));
let seq = 0; const pending = new Map();
const send = (method, params = {}) => new Promise((res, rej) => { const id = ++seq; pending.set(id, { res, rej }); ws.send(JSON.stringify({ id, method, params })); });
ws.onmessage = (m) => {
  const msg = JSON.parse(m.data);
  if (msg.id && pending.has(msg.id)) { const { res, rej } = pending.get(msg.id); pending.delete(msg.id); msg.error ? rej(new Error(msg.error.message)) : res(msg.result); }
  else if (msg.method === 'Page.javascriptDialogOpening') send('Page.handleJavaScriptDialog', { accept: true });
};
await send('Page.enable'); await send('Runtime.enable');
const ev = async (expression) => {
  const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
  if (r.exceptionDetails) throw new Error('page error: ' + (r.exceptionDetails.exception?.description || r.exceptionDetails.text));
  return r.result.value;
};
const mouse = (type, x, y, extra = {}) => send('Input.dispatchMouseEvent', { type, x, y, ...extra });
async function drag(x1, y1, x2, y2) {
  const steps = 16;
  await mouse('mouseMoved', x1, y1);
  await mouse('mousePressed', x1, y1, { button: 'left', clickCount: 1, buttons: 1 });
  for (let i = 1; i <= steps; i++) { await mouse('mouseMoved', x1 + (x2 - x1) * i / steps, y1 + (y2 - y1) * i / steps, { button: 'left', buttons: 1 }); await sleep(20); }
  await sleep(120);
  await mouse('mouseReleased', x2, y2, { button: 'left', clickCount: 1 });
  await sleep(150);
}
async function click(x, y) { await mouse('mouseMoved', x, y); await mouse('mousePressed', x, y, { button: 'left', clickCount: 1, buttons: 1 }); await mouse('mouseReleased', x, y, { button: 'left', clickCount: 1 }); await sleep(120); }
async function shot(name) { const r = await send('Page.captureScreenshot', { format: 'png' }); fs.writeFileSync(`${S}/${name}.png`, Buffer.from(r.data, 'base64')); }
async function waitFor(fn, label, ms = 8000) {
  const t0 = Date.now();
  for (;;) { const v = await fn(); if (v) return v; if (Date.now() - t0 > ms) throw new Error('timeout waiting for ' + label); await sleep(150); }
}
// Reload and wait for the NEW document (a check right after Page.reload can still see the old one).
async function reload() {
  await ev(`window.__stale = true`); await send('Page.reload');
  await waitFor(() => ev(`!window.__stale && document.readyState === 'complete' && document.querySelectorAll('#planGrid .plan').length > 0`), 'reload');
}
const cardRect = (id) => ev(`(() => { const el = document.querySelector('.plan[data-id="${id}"]'); if (!el) return null; const r = el.getBoundingClientRect(); return { cx: (r.left + r.right) / 2, cy: (r.top + r.bottom) / 2, w: r.width }; })()`);
const homeIds = () => ev(`[...document.querySelectorAll('#planGrid .plan')].map((el) => +el.dataset.id)`);
const boardOf = async (id) => (await call('GET', '/api/boards')).data.find((b) => b.id === id);
try {
  await send('Page.navigate', { url: BASE + '/' });
  await waitFor(() => ev(`document.readyState === 'complete' && document.body.classList.contains('home') && document.querySelectorAll('#planGrid .plan').length > 0`), 'home page');
  // With no saved choice the theme follows the system (headless Chrome prefers light): start from dark on purpose.
  await ev(`localStorage.setItem('planflow.theme', 'dark')`); await reload();
  assert.deepEqual(mine(await homeIds()).sort(), [P1.id, P2.id, P3.id].sort(), 'the three plans are on the home page');
  assert.equal(await ev(`getComputedStyle(document.querySelector('main')).display`), 'none', 'the canvas is hidden on the home page');
  console.log('ok home page shows the plans, canvas hidden');

  // 1. look: a tilt within ±10°, never flat, a gradient or colour, the flow drawn inside
  for (const b of [P1, P2, P3]) {
    const tilt = await ev(`parseFloat(document.querySelector('.plan[data-id="${b.id}"]').style.getPropertyValue('--tilt'))`);
    assert.ok(Math.abs(tilt) >= 1 && Math.abs(tilt) <= 5, `${b.name}: tilt ${tilt} is within 1..5°`);
    const bg = await ev(`document.querySelector('.plan[data-id="${b.id}"] .thumb').style.background`);
    assert.match(bg, /gradient|hsl|rgb/, 'thumbnail has a colour');
  }
  assert.equal(await ev(`document.querySelectorAll('.plan[data-id="${P1.id}"] .mini rect.mn').length`), 4, 'chain thumbnail draws four boxes');
  assert.equal(await ev(`document.querySelectorAll('.plan[data-id="${P1.id}"] .mini path.ml').length`), 3, 'chain thumbnail draws three links');
  assert.equal(await ev(`document.querySelectorAll('.plan[data-id="${P1.id}"] .mini rect.mn.done').length`), 1, 'the done task is filled in');
  assert.equal(await ev(`document.querySelectorAll('.plan[data-id="${P1.id}"] .mini rect.mn.blocked').length`), 2, 'C and D are blocked (dashed)');
  assert.equal(await ev(`document.querySelectorAll('.plan[data-id="${P2.id}"] .mini path.ml').length`), 4, 'fan thumbnail draws four links');
  assert.equal(await ev(`document.querySelector('.plan[data-id="${P3.id}"] .thumb-empty')?.textContent`), 'Empty plan', 'empty plan says so');
  assert.equal(await ev(`document.querySelector('.plan[data-id="${P1.id}"] .thumb-count').textContent`), '1 / 4', 'done / total badge');
  const tilts = await ev(`[...document.querySelectorAll('#planGrid .plan')].map((el) => Math.sign(parseFloat(el.style.getPropertyValue('--tilt'))))`);
  console.log(`ok cards lean (${tilts.filter((s) => s > 0).length} clockwise, ${tilts.filter((s) => s < 0).length} anticlockwise), thumbnails sketch the flow`);
  await shot('home-dark');

  // 2. drag the empty plan onto the archive box
  const box = await ev(`(() => { const r = document.querySelector('#archiveBox').getBoundingClientRect(); return { cx: (r.left + r.right) / 2, cy: (r.top + r.bottom) / 2 }; })()`);
  const r3 = await cardRect(P3.id);
  await drag(r3.cx, r3.cy, box.cx, box.cy);
  await waitFor(async () => (await boardOf(P3.id)).archived_at, 'archived_at set on the server');
  await waitFor(async () => !(await homeIds()).includes(P3.id), 'card gone from the grid');
  assert.equal(await ev(`document.querySelector('#archiveBox .archive-count').textContent`), '1', 'box shows 1 archived');
  assert.equal(await ev(`!!document.querySelector('.plan-ghost')`), false, 'no ghost left behind');
  assert.equal(await ev(`document.querySelector('#toast').textContent`).then((t) => t.includes('Archived')), true, 'toast offers undo');
  console.log('ok dragging a card onto the box archives it');

  // 3. a drag that ends elsewhere moves the card there, and the spot is remembered
  const pos = (id) => ev(`(() => { const el = document.querySelector('.plan[data-id="${id}"]'); return { x: parseFloat(el.style.left), y: parseFloat(el.style.top) }; })()`);
  const before = await pos(P1.id), r1 = await cardRect(P1.id);
  await drag(r1.cx, r1.cy, r1.cx + 60, r1.cy + 200);
  await sleep(300);
  const after = await pos(P1.id);
  assert.ok(Math.abs(after.x - before.x - 60) < 2 && Math.abs(after.y - before.y - 200) < 2, `card moved by the drag (${JSON.stringify(before)} → ${JSON.stringify(after)})`);
  await waitFor(async () => { const b = await boardOf(P1.id); return b.home_x === after.x && b.home_y === after.y; }, 'spot saved on the server');
  assert.equal((await boardOf(P1.id)).archived_at, null, 'dropped on the page: not archived');
  await reload();
  assert.deepEqual(await pos(P1.id), after, 'the card is still there after a reload');
  const others = await ev(`[...document.querySelectorAll('#planGrid .plan')].filter((el) => el.dataset.id !== '${P1.id}').map((el) => ({ x: parseFloat(el.style.left), y: parseFloat(el.style.top) }))`);
  for (const o of others) assert.ok(o.x + 260 <= after.x || o.x >= after.x + 260 || o.y + 230 <= after.y || o.y >= after.y + 230, 'no automatic card sits under the moved one');
  console.log('ok a drag elsewhere moves the card, the spot is saved and kept clear');

  // 4. the box opens the archived list; Restore brings the plan back
  await click(box.cx, box.cy);
  await waitFor(() => ev(`!document.querySelector('#archiveDrawer').hidden`), 'drawer open');
  assert.ok((await ev(`document.querySelector('#archiveDrawer').textContent`)).includes(P3.name), 'drawer lists the archived plan');
  await ev(`[...document.querySelectorAll('#archiveDrawer li')].find((li) => li.textContent.includes(${JSON.stringify(P3.name)})).querySelector('button').click()`);
  await waitFor(async () => !(await boardOf(P3.id)).archived_at, 'unarchived on the server');
  await waitFor(async () => (await homeIds()).includes(P3.id), 'card back in the grid');
  assert.equal(await ev(`document.querySelector('#archiveBox .archive-count').hidden`), true, 'badge hidden again');
  console.log('ok archived list + Restore');

  // 5. day / dark switch, remembered across a reload
  assert.equal(await ev(`document.documentElement.dataset.theme`), 'dark', 'starts dark');
  await ev(`document.querySelector('#btnTheme').click()`);
  assert.equal(await ev(`document.documentElement.dataset.theme`), 'light', 'one click: day mode');
  assert.equal(await ev(`localStorage.getItem('planflow.theme')`), 'light', 'remembered');
  const bgLight = await ev(`getComputedStyle(document.body).backgroundColor`);
  assert.notEqual(bgLight, 'rgb(11, 13, 16)', 'the page is no longer dark');
  await shot('home-light');
  await reload();
  assert.equal(await ev(`document.documentElement.dataset.theme`), 'light', 'day mode survives a reload');
  console.log('ok day mode switch, remembered');

  // 6. clicking a card opens the plan (hash route), the brand goes home, back button works
  const rr = await cardRect(P1.id);
  await click(rr.cx, rr.cy);
  await waitFor(() => ev(`location.hash === '#/board/${P1.id}' && document.querySelectorAll('.node').length === 4`), 'board open');
  assert.equal(await ev(`document.body.classList.contains('home')`), false, 'home hidden');
  assert.equal(await ev(`document.title`), P1.name + ' · Planflow');
  assert.equal(await ev(`getComputedStyle(document.querySelector('#archiveBox')).display`), 'none', 'no archive box on a board');
  await shot('board-light');
  await ev(`document.querySelector('.brand').click()`);
  await waitFor(() => ev(`document.body.classList.contains('home')`), 'home again');
  await ev(`history.back()`);
  await waitFor(() => ev(`!document.body.classList.contains('home') && document.querySelectorAll('.node').length === 4`), 'back button reopens the board');
  console.log('ok card opens the plan, brand goes home, back works');

  // 7. the archived plan is not in the board switcher; archive from the board menu goes home
  await call('PATCH', `/api/boards/${P3.id}`, { archived: true });
  await ev(`document.querySelector('.brand').click()`);
  await waitFor(() => ev(`document.body.classList.contains('home')`), 'home');
  await ev(`document.querySelector('.plan[data-id="${P2.id}"]').click()`);   // keyboard/click fallback: use the hash directly
  await ev(`location.hash = '#/board/${P2.id}'`);
  await waitFor(() => ev(`document.querySelectorAll('.node').length === 5`), 'fan board open');
  const options = await ev(`[...document.querySelectorAll('#boardSelect option')].map((o) => +o.value)`);
  assert.ok(!options.includes(P3.id) && options.includes(P1.id), 'archived plan is not in the switcher, live one is');
  await ev(`document.querySelector('#btnBoardMenu').click()`);
  await ev(`document.querySelector('#boardMenu [data-act=archive]').click()`);
  await waitFor(async () => (await boardOf(P2.id)).archived_at, 'archived from the board menu');
  await waitFor(() => ev(`document.body.classList.contains('home')`), 'back home after archiving');
  assert.equal(await ev(`document.querySelector('#archiveBox .archive-count').textContent`), '2');
  console.log('ok switcher hides archived plans; Archive board in the menu');

  // 8. phone width: cards still render, box still there
  await send('Emulation.setDeviceMetricsOverride', { width: 390, height: 800, deviceScaleFactor: 2, mobile: true });
  await sleep(300);
  assert.ok((await homeIds()).includes(P1.id));
  assert.notEqual(await ev(`getComputedStyle(document.querySelector('#archiveBox')).display`), 'none');
  await shot('home-phone');
  console.log('ok phone layout');
  console.log(`UI HOME TESTS PASSED; screenshots ${S}/home-dark.png, home-light.png, board-light.png, home-phone.png`);
} finally { await cleanup(); }
