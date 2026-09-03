// Headless-Chrome UI test for the four-side link handles (CDP over WebSocket, needs google-chrome).
// Run against a LOCAL server on a throwaway database: PLANFLOW_URL=http://localhost:8093 node scripts/ui-test.mjs
import { spawn } from 'node:child_process';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
const S = process.env.SCRATCH || os.tmpdir();
const BASE = process.env.PLANFLOW_URL || 'http://localhost:8093', PORT = 9223;
const CHROME = process.env.CHROME || '/usr/bin/google-chrome';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function call(method, path, body) {
  const res = await fetch(BASE + path, { method, headers: body ? { 'content-type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined });
  return { status: res.status, data: res.status === 204 ? null : await res.json().catch(() => null) };
}
// --- board fixture: four cards in a 2x2 grid
const board = (await call('POST', '/api/boards', { name: 'ui-sides ' + Date.now() })).data;
const mk = async (title, x, y) => (await call('POST', `/api/boards/${board.id}/tasks`, { title, x, y })).data;
const A = await mk('A top-left', 100, 100), B = await mk('B top-right', 520, 100), C = await mk('C bottom-left', 100, 420), D = await mk('D bottom-right', 520, 420);
// --- chrome
fs.rmSync(`${S}/planflow-chrome-profile`, { recursive: true, force: true });
const chrome = spawn(CHROME, ['--headless=new', `--remote-debugging-port=${PORT}`, '--window-size=1400,900', '--no-first-run', '--no-default-browser-check', '--disable-gpu', `--user-data-dir=${S}/planflow-chrome-profile`, 'about:blank'], { stdio: 'ignore' });
const cleanup = async () => { chrome.kill(); await call('DELETE', `/api/boards/${board.id}`); };
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
async function drag(x1, y1, x2, y2, opts = {}) {
  const steps = 14;
  await mouse('mouseMoved', x1, y1);
  await mouse('mousePressed', x1, y1, { button: 'left', clickCount: 1, buttons: 1 });
  for (let i = 1; i <= steps; i++) {
    await mouse('mouseMoved', x1 + (x2 - x1) * i / steps, y1 + (y2 - y1) * i / steps, { button: 'left', buttons: 1 });
    await sleep(15);
    if (opts.midway && i === steps) await opts.midway();
  }
  await mouse('mouseReleased', x2, y2, { button: 'left', clickCount: 1 });
  await sleep(150);
}
async function shot(name) { const r = await send('Page.captureScreenshot', { format: 'png' }); fs.writeFileSync(`${S}/${name}.png`, Buffer.from(r.data, 'base64')); }
// The page talks to a remote database, so wait for things to land instead of sleeping a fixed time.
async function waitFor(fn, label, ms = 8000) {
  const t0 = Date.now();
  for (;;) { const v = await fn(); if (v) return v; if (Date.now() - t0 > ms) throw new Error('timeout waiting for ' + label); await sleep(150); }
}
const deps = async () => (await call('GET', `/api/boards/${board.id}`)).data.deps;
const depWait = (from, to) => waitFor(async () => (await deps()).find((d) => d.from === from && d.to === to), `link ${from}->${to}`);
const loaded = () => waitFor(() => ev(`document.querySelectorAll('.node').length === 4`), 'board to load');
// screen rect of a card, and its world-space anchors
const rect = (id) => ev(`(() => { const r = document.querySelector('.node[data-id="${id}"]').getBoundingClientRect(); return { l: r.left, t: r.top, r: r.right, b: r.bottom, w: r.width, h: r.height, cx: (r.left + r.right) / 2, cy: (r.top + r.bottom) / 2 }; })()`);
const portPos = (id, side) => ev(`(() => { const r = document.querySelector('.node[data-id="${id}"] .port.${side}').getBoundingClientRect(); return { x: (r.left + r.right) / 2, y: (r.top + r.bottom) / 2 }; })()`);
const worldAnchor = (id, side) => ev(`(() => { const el = document.querySelector('.node[data-id="${id}"]'); const x = parseFloat(el.style.left), y = parseFloat(el.style.top), w = el.offsetWidth, h = el.offsetHeight;
  return { right: { x: x + w, y: y + h / 2 }, left: { x, y: y + h / 2 }, top: { x: x + w / 2, y }, bottom: { x: x + w / 2, y: y + h } }['${side}']; })()`);
const edgeD = (from, to) => ev(`(() => { const hit = document.querySelector('.edge-hit[data-from="${from}"][data-to="${to}"]'); return hit ? hit.getAttribute('d') : null; })()`);
const near = (a, b, tol = 1.5) => Math.abs(a - b) <= tol;
// The DOM redraws after the server answers, so wait for the drawn path to reach the expected ends.
async function waitEnds(from, to, a, b, label) {
  let last = null;
  const ok = (d) => { const m = d && d.match(/^M ([-\d.]+) ([-\d.]+) .* ([-\d.]+) ([-\d.]+)$/); return !!m && near(+m[1], a.x) && near(+m[2], a.y) && near(+m[3], b.x) && near(+m[4], b.y); };
  try { await waitFor(async () => ok(last = await edgeD(from, to)), label); }
  catch { assertEnds(last, a, b, label); }
}
function assertEnds(d, a, b, label) {
  const m = d && d.match(/^M ([-\d.]+) ([-\d.]+) .* ([-\d.]+) ([-\d.]+)$/);
  assert.ok(m, 'path parse ' + d);
  assert.ok(near(+m[1], a.x) && near(+m[2], a.y), `${label}: starts at ${m[1]},${m[2]} expected ${a.x},${a.y}`);
  assert.ok(near(+m[3], b.x) && near(+m[4], b.y), `${label}: ends at ${m[3]},${m[4]} expected ${b.x},${b.y}`);
}
try {
  await send('Page.navigate', { url: BASE + '/' });
  await waitFor(() => ev(`document.readyState === 'complete' && !!document.querySelector('#boardSelect option')`), 'first load');
  await ev(`localStorage.setItem('planflow.board', ${board.id}); localStorage.removeItem('planflow.view.${board.id}')`);
  await send('Page.navigate', { url: BASE + '/' }); await loaded(); await sleep(300);
  assert.equal(await ev(`document.querySelectorAll('.node[data-id="${A.id}"] .port').length`), 4, 'each card has four ports');
  console.log('ok board open, 4 ports per card');

  // 0. handles are hidden until the pointer comes near the card
  {
    const ra = await rect(A.id);
    const opacity = () => ev(`getComputedStyle(document.querySelector('.node[data-id="${A.id}"] .port.top')).opacity`);
    await mouse('mouseMoved', 40, 780); await sleep(250);
    assert.equal(await opacity(), '0', 'handles hidden when the pointer is far away');
    await mouse('mouseMoved', ra.l - 18, ra.cy); await sleep(250);
    assert.equal(await ev(`document.querySelector('.node[data-id="${A.id}"]').classList.contains('near')`), true, 'near class set');
    assert.equal(await opacity(), '1', 'handles visible when the pointer is near');
    assert.equal(await ev(`document.querySelectorAll('.node.near').length`), 1, 'only the nearby card shows handles');
    await mouse('mouseMoved', 40, 780); await sleep(250);
    assert.equal(await opacity(), '0', 'handles hide again when the pointer moves away');
    console.log('ok handles appear only when the pointer is near a card');
  }

  // 1. A bottom port -> C (drop just inside C's top edge): bottom -> top
  let p = await portPos(A.id, 'bottom'), r = await rect(C.id);
  await drag(p.x, p.y, r.cx, r.t + 8);
  assert.deepEqual(await depWait(A.id, C.id), { from: A.id, to: C.id, from_side: 'bottom', to_side: 'top' }, 'A->C sides');
  await waitEnds(A.id, C.id, await worldAnchor(A.id, 'bottom'), await worldAnchor(C.id, 'top'), 'A->C path');
  console.log('ok drag from bottom port attaches to top of target');

  // 2. B left port -> D (drop just inside D's right edge): left -> right
  p = await portPos(B.id, 'left'); r = await rect(D.id);
  await drag(p.x, p.y, r.r - 8, r.cy);
  assert.deepEqual(await depWait(B.id, D.id), { from: B.id, to: D.id, from_side: 'left', to_side: 'right' }, 'B->D sides');
  await waitEnds(B.id, D.id, await worldAnchor(B.id, 'left'), await worldAnchor(D.id, 'right'), 'B->D path');
  console.log('ok drag from left port attaches to right of target');

  // 3. A right port -> B centre-left: the classic right -> left link
  p = await portPos(A.id, 'right'); r = await rect(B.id);
  await drag(p.x, p.y, r.l + 20, r.cy);
  assert.deepEqual(await depWait(A.id, B.id), { from: A.id, to: B.id, from_side: 'right', to_side: 'left' }, 'A->B sides');
  console.log('ok classic right->left link unchanged');

  // 4. mid-drag: temp link snaps to the target side and that port lights up
  p = await portPos(C.id, 'right'); r = await rect(D.id);
  let midState;
  await drag(p.x, p.y, r.cx, r.t + 10, { midway: async () => {
    midState = await ev(`(() => { const t = document.querySelector('#edges path.edge.temp'); const hot = document.querySelector('.node[data-id="${D.id}"] .port.hot'); return { d: t && t.getAttribute('d'), hot: hot ? hot.dataset.side : null, target: !!document.querySelector('.node[data-id="${D.id}"].drop-target') }; })()`);
  } });
  assert.ok(midState && midState.d, 'temp path drawn during drag');
  assert.equal(midState.hot, 'top', 'top port of target is hot');
  assert.equal(midState.target, true, 'target outlined');
  assertEnds(midState.d, await worldAnchor(C.id, 'right'), await worldAnchor(D.id, 'top'), 'temp path snapped');
  assert.deepEqual(await depWait(C.id, D.id), { from: C.id, to: D.id, from_side: 'right', to_side: 'top' }, 'C->D sides');
  console.log('ok temp link snaps to the drop side; port highlighted');

  // 5. select the C->D link, change its sides from the panel
  await ev(`(() => { const hit = document.querySelector('.edge-hit[data-from="${C.id}"][data-to="${D.id}"]'); const vp = document.querySelector('#viewport');
    const opts = { bubbles: true, pointerId: 7, isPrimary: true, button: 0, clientX: 5, clientY: 5, pointerType: 'mouse' };
    hit.dispatchEvent(new PointerEvent('pointerdown', opts)); vp.dispatchEvent(new PointerEvent('pointerup', { ...opts })); })()`);
  await waitFor(() => ev(`document.querySelectorAll('#panel .side-pick select').length === 2`), 'link panel');
  assert.deepEqual(await ev(`[...document.querySelectorAll('#panel .side-pick select')].map((s) => s.value)`), ['right', 'top'], 'pickers show current sides');
  await ev(`(() => { const s = document.querySelectorAll('#panel .side-pick select')[1]; s.value = 'bottom'; s.dispatchEvent(new Event('change', { bubbles: true })); })()`);
  await waitFor(async () => (await deps()).find((d) => d.from === C.id && d.to === D.id).to_side === 'bottom', 'picker change to land');
  assert.deepEqual((await deps()).find((d) => d.from === C.id && d.to === D.id), { from: C.id, to: D.id, from_side: 'right', to_side: 'bottom' }, 'C->D after picker');
  await waitEnds(C.id, D.id, await worldAnchor(C.id, 'right'), await worldAnchor(D.id, 'bottom'), 'C->D redrawn');
  await ev(`(() => { const s = document.querySelectorAll('#panel .side-pick select')[0]; s.value = 'top'; s.dispatchEvent(new Event('change', { bubbles: true })); })()`);
  await waitFor(async () => (await deps()).find((d) => d.from === C.id && d.to === D.id).from_side === 'top', 'second picker change');
  console.log('ok side pickers in the panel update the link');

  // 6. reload: sides survive
  await send('Page.navigate', { url: BASE + '/' }); await loaded(); await sleep(300);
  await waitEnds(A.id, C.id, await worldAnchor(A.id, 'bottom'), await worldAnchor(C.id, 'top'), 'A->C after reload');
  await waitEnds(C.id, D.id, await worldAnchor(C.id, 'top'), await worldAnchor(D.id, 'bottom'), 'C->D after reload');
  assert.equal(await ev(`document.querySelectorAll('#edges path.edge').length`), 4, 'four links drawn');
  await ev(`document.querySelector('.node[data-id="${A.id}"]').dispatchEvent(new MouseEvent('mouseover'))`);
  await shot('sides');
  console.log('ok links keep their sides after reload; screenshot saved to', `${S}/sides.png`);

  // 7. regression: grabbing a card by its title still moves it (top port must not steal the drag)
  r = await rect(D.id);
  const before = (await call('GET', `/api/boards/${board.id}`)).data.tasks.find((t) => t.id === D.id);
  const titleY = await ev(`(() => { const t = document.querySelector('.node[data-id="${D.id}"] .title').getBoundingClientRect(); return (t.top + t.bottom) / 2; })()`);
  await drag(r.cx, titleY, r.cx + 90, titleY + 60);
  const after = await waitFor(async () => { const t = (await call('GET', `/api/boards/${board.id}`)).data.tasks.find((t) => t.id === D.id); return t.x > before.x + 30 && t.y > before.y + 20 ? t : null; }, 'card move to save');
  assert.ok(after, 'card moved by title drag');
  assert.equal((await deps()).length, 4, 'no link created by title drag');
  console.log('ok dragging a card by its title still moves it');

  // 8. drop onto nothing: no link
  p = await portPos(A.id, 'top');
  await drag(p.x, p.y, p.x + 200, p.y - 60); await sleep(600);
  assert.equal((await deps()).length, 4, 'drop on empty canvas makes no link');
  console.log('ok drop on empty canvas makes no link');
  console.log('UI TESTS PASSED');
} catch (e) {
  await shot('fail').catch(() => {});
  console.error('FAILED:', e.message);
  process.exitCode = 1;
} finally { await cleanup(); }
