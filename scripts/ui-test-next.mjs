// Headless-Chrome UI test for "the next card": Enter after a card's name shows twelve arrows around
// the card, F and J turn the chosen one, the arrow keys point it, Enter adds a linked card that way
// with the caret in its name. Also: where the card lands when the spot is taken, Esc taking a
// fresh card back, the keys and clicks that put the arrows away, clicking an arrow, the panel's
// name field, the view following a chain, the arrows at a small zoom, and the phone (no arrows).
// Run against a LOCAL server on a throwaway database:
//   PLANFLOW_URL=http://localhost:8093 node scripts/ui-test-next.mjs   (node 20 needs --experimental-websocket)
import { spawn } from 'node:child_process';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
const S = process.env.SCRATCH || os.tmpdir();
const BASE = process.env.PLANFLOW_URL || 'http://localhost:8093', PORT = 9227;
const CHROME = process.env.CHROME || '/usr/bin/google-chrome';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function call(method, path, body) {
  const res = await fetch(BASE + path, { method, headers: body ? { 'content-type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined });
  return { status: res.status, data: res.status === 204 ? null : await res.json().catch(() => null) };
}
// --- fixture: a tasks board with one card
const stamp = Date.now();
const board = (await call('POST', '/api/boards', { name: 'ui-next ' + stamp })).data;
const A = (await call('POST', `/api/boards/${board.id}/tasks`, { title: 'Alpha', x: 300, y: 300 })).data;
const server = async () => (await call('GET', `/api/boards/${board.id}`)).data;
// --- chrome
fs.rmSync(`${S}/planflow-chrome-next`, { recursive: true, force: true });
const chrome = spawn(CHROME, ['--headless=new', `--remote-debugging-port=${PORT}`, '--window-size=1400,900', '--no-first-run', '--no-default-browser-check', '--disable-gpu', `--user-data-dir=${S}/planflow-chrome-next`, 'about:blank'], { stdio: 'ignore' });
const cleanup = async () => { chrome.kill(); await call('DELETE', `/api/boards/${board.id}`); };
process.on('exit', () => chrome.kill());
let targets = [];
for (let i = 0; i < 50 && !targets.length; i++) { try { targets = (await (await fetch(`http://127.0.0.1:${PORT}/json`)).json()).filter((t) => t.type === 'page'); } catch {} if (!targets.length) await sleep(200); }
const ws = new WebSocket(targets[0].webSocketDebuggerUrl);
await new Promise((r) => (ws.onopen = r));
let seq = 0; const pending = new Map(); const pageErrors = [];
const send = (method, params = {}) => new Promise((res, rej) => { const id = ++seq; pending.set(id, { res, rej }); ws.send(JSON.stringify({ id, method, params })); });
ws.onmessage = (m) => {
  const msg = JSON.parse(m.data);
  if (msg.id && pending.has(msg.id)) { const { res, rej } = pending.get(msg.id); pending.delete(msg.id); msg.error ? rej(new Error(msg.error.message)) : res(msg.result); }
  else if (msg.method === 'Runtime.exceptionThrown') pageErrors.push(msg.params.exceptionDetails.exception?.description || msg.params.exceptionDetails.text);
};
await send('Page.enable'); await send('Runtime.enable');
const ev = async (expression) => {
  const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
  if (r.exceptionDetails) throw new Error('page error: ' + (r.exceptionDetails.exception?.description || r.exceptionDetails.text));
  return r.result.value;
};
const mouse = (type, x, y, extra = {}) => send('Input.dispatchMouseEvent', { type, x, y, ...extra });
async function click(x, y) { await mouse('mouseMoved', x, y); await mouse('mousePressed', x, y, { button: 'left', clickCount: 1, buttons: 1 }); await mouse('mouseReleased', x, y, { button: 'left', clickCount: 1 }); await sleep(150); }
const KEYS = { Enter: ['Enter', 13], Escape: ['Escape', 27], ArrowUp: ['ArrowUp', 38], ArrowRight: ['ArrowRight', 39], ArrowDown: ['ArrowDown', 40], ArrowLeft: ['ArrowLeft', 37] };
async function key(k, extra = {}) {
  const [code, vk] = KEYS[k] || ['Key' + k.toUpperCase(), k.toUpperCase().charCodeAt(0)];
  await send('Input.dispatchKeyEvent', { type: 'keyDown', key: k, code, windowsVirtualKeyCode: vk, ...extra });
  await send('Input.dispatchKeyEvent', { type: 'keyUp', key: k, code, windowsVirtualKeyCode: vk });
  await sleep(90);
}
const type = (text) => send('Input.insertText', { text });
async function shot(name) { const r = await send('Page.captureScreenshot', { format: 'png' }); fs.writeFileSync(`${S}/${name}.png`, Buffer.from(r.data, 'base64')); }
async function waitFor(fn, label, ms = 8000) {
  const t0 = Date.now();
  for (;;) { const v = await fn(); if (v) return v; if (Date.now() - t0 > ms) throw new Error('timeout waiting for ' + label); await sleep(100); }
}
// What the arrows show: null when they are away, else the chosen hour, the hours that wear F and J,
// the card they are around, where the outline of the next card is (board coordinates) and what it says.
const arrows = () => ev(`(() => {
  const c = document.querySelector('#compass'); if (c.hidden) return null;
  const arm = (sel) => { const a = c.querySelector(sel); return a ? +a.dataset.hour : null; };
  const g = c.querySelector('.ghost');
  return { count: c.querySelectorAll('.arm').length, on: arm('.arm.on'), f: arm('.arm[data-key="F"]'), j: arm('.arm[data-key="J"]'),
    card: +(document.querySelector('.node.selected')?.dataset.id || 0), text: g.textContent,
    ghost: { x: parseFloat(g.style.left), y: parseFloat(g.style.top), w: g.offsetWidth, h: g.offsetHeight },
    tempEdges: document.querySelectorAll('#edgeLayer .edge.temp').length };
})()`);
const cards = () => ev(`[...document.querySelectorAll('.node')].map((n) => ({ id: +n.dataset.id, x: parseFloat(n.style.left), y: parseFloat(n.style.top), w: n.offsetWidth, h: n.offsetHeight, title: n.querySelector('.title').textContent, cls: n.className }))`);
const editingId = () => ev(`(() => { const a = document.activeElement; return a && a.isContentEditable && a.closest('.node') ? +a.closest('.node').dataset.id : 0; })()`);
const centre = (id) => ev(`(() => { const r = document.querySelector('.node[data-id="${id}"]').getBoundingClientRect(); return { cx: (r.left + r.right) / 2, cy: (r.top + r.bottom) / 2 }; })()`);
const apart = (a, b, gap = 0) => a.x + a.w + gap <= b.x || b.x + b.w + gap <= a.x || a.y + a.h + gap <= b.y || b.y + b.h + gap <= a.y;
// Name the card that is being typed in and press Enter: the arrows come up around it.
async function nameIt(text) {
  const id = await waitFor(editingId, 'a card to type in');
  await type(text); await key('Enter');
  await waitFor(async () => (await arrows())?.card === id, 'the arrows around "' + text + '"');
  return id;
}
// Enter on the arrows: wait for the new card and its caret.
async function go(n) {
  await key('Enter');
  await waitFor(async () => (await cards()).length === n && await editingId(), `card ${n} with a caret in it`);
  return editingId();
}
try {
  await send('Page.navigate', { url: BASE + '/#/' });
  await waitFor(() => ev(`document.readyState === 'complete' && document.body.classList.contains('home')`), 'first load');
  await ev(`localStorage.setItem('planflow.theme', 'dark'); localStorage.removeItem('planflow.view.${board.id}'); localStorage.removeItem('planflow.next.${board.id}')`);
  await send('Page.navigate', { url: 'about:blank' }); await sleep(200);
  await send('Page.navigate', { url: BASE + '/#/board/' + board.id });
  await waitFor(() => ev(`document.querySelectorAll('.node').length === 1`).catch(() => false), 'board open');
  await sleep(300);
  assert.equal(await arrows(), null, 'no arrows until a name is finished');

  // 1. rename the card, Enter: twelve arrows, the one at 3 o'clock chosen, F and J on its neighbours
  { const c = await centre(A.id); await click(c.cx, c.cy); }
  await key('Enter');
  assert.equal(await nameIt('Start'), A.id);
  let a = await arrows(), [ca] = await cards();
  assert.equal(a.count, 12, 'twelve arrows');
  assert.deepEqual([a.on, a.f, a.j], [3, 2, 4], 'right is chosen, F is the hour before, J the hour after');
  assert.deepEqual([a.ghost.x, a.ghost.y], [ca.x + 300, ca.y], 'the next card would land to the right, tops level, a column gap away');
  assert.equal(a.text, 'EnterNew task'); assert.equal(a.tempEdges, 1, 'a dashed link to it');
  assert.match(await ev(`document.querySelector('#hint').textContent`), /F and J turn the arrow/);
  assert.equal((await server()).tasks[0].title, 'Start', 'the name is saved');
  await shot('next-arrows');
  console.log('ok Enter after a name: 12 arrows, 3 o\'clock chosen, F/J on the arrows either side, an outline of the next card');

  // 2. J turns on an hour, F back, round the clock; the arrow keys point straight
  const zoom = await ev(`document.querySelector('#zoomLabel').textContent`);
  await key('j'); await key('j'); assert.equal((await arrows()).on, 5);
  await shot('next-turned');
  await key('f'); await key('f'); await key('f'); a = await arrows();
  assert.deepEqual([a.on, a.f, a.j], [2, 1, 3]);
  assert.equal(await ev(`document.querySelector('#zoomLabel').textContent`), zoom, 'F turns the arrow here, it does not fit the view');
  await key('ArrowDown'); a = await arrows(); assert.equal(a.on, 6);
  assert.deepEqual([a.ghost.x, a.ghost.y], [ca.x, ca.y + ca.h + 90], 'straight down: under the card, left edges level');
  await key('ArrowLeft'); assert.equal((await arrows()).on, 9);
  await key('ArrowUp'); a = await arrows(); assert.equal(a.on, 0);
  assert.deepEqual([a.ghost.x, a.ghost.y + a.ghost.h], [ca.x, ca.y - 90], 'straight up');
  await key('f'); a = await arrows(); assert.deepEqual([a.on, a.f, a.j], [11, 10, 0], 'F goes round past twelve');
  await key('J'); await key('J'); assert.equal((await arrows()).on, 1, 'capital letters too');
  for (let hr = 0; hr < 12; hr++) {                 // no hour puts the next card on this one
    while ((await arrows()).on !== hr) await key('j');
    assert.ok(apart((await arrows()).ghost, ca, 20), `hour ${hr} clears the card`);
  }
  await key('ArrowRight'); assert.equal((await arrows()).on, 3);
  console.log('ok J and F turn through all twelve hours, the arrow keys point up, right, down, left');

  // 3. Enter: a card to the right, linked from the first, caret in its name; the hour is remembered
  const B = await go(2);
  let s = await server(), tb = s.tasks.find((t) => t.id === B);
  assert.deepEqual([tb.x, tb.y], [ca.x + 300, ca.y]);
  assert.deepEqual(s.deps, [{ from: A.id, to: B, from_side: 'right', to_side: 'left', label: null }]);
  assert.equal(await arrows(), null, 'the arrows are away while the name is typed');
  assert.equal(await nameIt('Check it'), B);
  assert.ok((await cards()).find((c) => c.id === B).cls.includes('blocked'), 'on a tasks board the new card waits for the one it came from');
  assert.equal((await arrows()).on, 3, 'same way as last time');
  assert.equal((await server()).tasks.find((t) => t.id === B).title, 'Check it');
  console.log('ok Enter adds the card to the right, linked right → left, ready to type');

  // 4. turn to six, Enter: a card below, linked bottom → top
  await key('j'); await key('j'); await key('j');
  const C = await go(3);
  s = await server(); const tc = s.tasks.find((t) => t.id === C), cb = (await cards()).find((c) => c.id === B);
  assert.deepEqual([tc.x, tc.y], [cb.x, cb.y + cb.h + 90]);
  assert.deepEqual(s.deps.find((d) => d.to === C), { from: B, to: C, from_side: 'bottom', to_side: 'top', label: null });
  await nameIt('Fix it');
  assert.equal((await arrows()).on, 6, 'six is remembered');
  console.log('ok a card below, linked bottom → top');

  // 5. Enter again by mistake, then Esc before typing: the new card is taken back, the arrows return
  const D = await go(4);
  await key('Escape');
  await waitFor(async () => (await cards()).length === 3 && (await arrows())?.card === C, 'the card to be taken back');
  s = await server();
  assert.equal(s.tasks.length, 3); assert.ok(!s.tasks.some((t) => t.id === D)); assert.equal(s.deps.length, 2);
  assert.equal((await arrows()).on, 6);
  await key('Escape'); assert.equal(await arrows(), null, 'Esc puts the arrows away');
  assert.equal(await ev(`+document.querySelector('.node.selected').dataset.id`), C, 'the card stays selected');
  await key('Escape'); assert.equal(await ev(`document.querySelectorAll('.node.selected').length`), 0, 'a second Esc deselects');
  console.log('ok Esc in an untouched new card takes it back; Esc again closes the arrows, again deselects');

  // 6. the spot is taken: from the first card to the right again, the new card goes under what is there
  { const c = await centre(A.id); await click(c.cx, c.cy); }
  await key('Enter'); await key('Enter');
  await waitFor(async () => (await arrows())?.card === A.id, 'arrows on the first card');
  await key('ArrowRight');
  a = await arrows(); let all = await cards();
  assert.equal(a.ghost.x, ca.x + 300, 'same column');
  assert.ok(a.ghost.y > cb.y, 'further down');
  for (const c of all) assert.ok(apart(a.ghost, c, 9), 'the outline is on no card: ' + c.title);
  await shot('next-taken');
  const E = await go(4);
  const te = (await server()).tasks.find((t) => t.id === E);
  assert.deepEqual([te.x, te.y], [a.ghost.x, a.ghost.y], 'the card lands where the outline was');
  await nameIt('Second branch');
  console.log('ok a taken spot: the card goes under the ones already there');

  // 7. any other key puts the arrows away; so does a click on the canvas; typing ahead names the card
  await key('x'); assert.equal(await arrows(), null, 'another key');
  await key('Enter'); await key('Enter');
  await waitFor(arrows, 'arrows again');
  await click(120, 760); assert.equal(await arrows(), null, 'a click on the empty canvas');
  { const c = await centre(E); await click(c.cx, c.cy); }
  await key('Enter'); await key('Enter');
  await waitFor(arrows, 'arrows again');
  await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
  for (const ch of 'Typed early') await send('Input.dispatchKeyEvent', { type: 'keyDown', key: ch, text: ch, unmodifiedText: ch });
  const F = await waitFor(async () => (await cards()).length === 5 && await editingId(), 'the fifth card');
  await waitFor(async () => (await server()).tasks.find((t) => t.id === F)?.title === 'Typed early', 'what was typed while it was on its way to become its name');
  await key('Escape');
  assert.equal((await cards()).length, 5, 'Esc keeps a card that has a name');
  console.log('ok other keys and clicks close the arrows; keys typed before the card arrives become its name');

  // 8. clicking an arrow adds the card that way
  await key('Enter'); await key('Enter');
  await waitFor(arrows, 'arrows'); await sleep(450);      // the view may be panning to show the outline
  const armAt = await ev(`(() => { const r = document.querySelector('#compass .arm[data-hour="0"]').getBoundingClientRect(); return { x: (r.left + r.right) / 2, y: (r.top + r.bottom) / 2 }; })()`);
  await click(armAt.x, armAt.y);
  const G = await waitFor(async () => (await cards()).length === 6 && await editingId(), 'the card from a click');
  assert.deepEqual((await server()).deps.find((d) => d.to === G), { from: F, to: G, from_side: 'top', to_side: 'bottom', label: null });
  await nameIt('Above'); await key('Escape');
  console.log('ok a click on an arrow adds the card there (top → bottom for twelve o\'clock)');

  // 9. Enter in the panel's name field shows the arrows too
  await ev(`(() => { const i = document.querySelector('#panel .title-input'); i.focus(); i.select(); })()`);
  await type('Above it'); await key('Enter');
  await waitFor(async () => (await arrows())?.card === G, 'arrows from the panel');
  assert.equal((await server()).tasks.find((t) => t.id === G).title, 'Above it');
  await ev(`document.querySelector('#panel textarea').focus()`);
  assert.equal(await arrows(), null, 'typing in the notes puts them away');
  await ev(`document.activeElement.blur()`);
  console.log('ok the panel\'s name field does the same; the notes put the arrows away');

  // 10. a chain to the right runs off the screen: the view follows it
  { const c = await centre(B); await click(c.cx, c.cy); }
  await key('Enter'); await key('Enter'); await waitFor(arrows, 'arrows'); await key('ArrowUp'); await key('j'); await key('j'); await key('j');
  let n = 6;
  for (const name of ['One', 'Two', 'Three', 'Four', 'Five']) { await go(++n); await nameIt(name); }
  await sleep(400);
  const last = await ev(`(() => { const v = document.querySelector('#viewport').getBoundingClientRect(), r = document.querySelector('.node.selected').getBoundingClientRect(), g = document.querySelector('#compass .ghost').getBoundingClientRect();
    return { card: r.left >= v.left && r.right <= v.right && r.top >= v.top && r.bottom <= v.bottom, ghost: g.left >= v.left && g.right <= v.right && g.top >= v.top && g.bottom <= v.bottom, scroll: document.querySelector('#viewport').scrollLeft + document.querySelector('#viewport').scrollTop }; })()`);
  assert.deepEqual(last, { card: true, ghost: true, scroll: 0 }, 'the last card and the outline of the next are on screen, by panning');
  all = await cards();
  for (const p of all) for (const q of all) if (p.id < q.id) assert.ok(apart(p, q), `"${p.title}" and "${q.title}" do not overlap`);
  assert.equal(new Set(all.filter((c) => ['Check it', 'One', 'Two', 'Three', 'Four', 'Five'].includes(c.title)).map((c) => c.y)).size, 1, 'the chain is a straight row');
  await shot('next-chain');
  console.log('ok a chain of five: a straight row, nothing overlaps, the view pans to keep up');

  // 11. zoomed far out the arrows keep a size the eye can find
  await key('Escape');
  for (let i = 0; i < 12; i++) await mouse('mouseWheel', 700, 450, { deltaX: 0, deltaY: 120 });
  await sleep(200);
  await key('Enter'); await key('Enter'); await waitFor(arrows, 'arrows');
  const small = await ev(`(() => { const r = document.querySelector('#compass .arm.on').getBoundingClientRect(); return { z: parseInt(document.querySelector('#zoomLabel').textContent), px: Math.round(r.width) }; })()`);
  assert.ok(small.z < 50, 'zoomed out to ' + small.z + '%'); assert.ok(small.px >= 14, 'the chosen arrow is ' + small.px + 'px on screen');
  await shot('next-small');
  await key('Escape');
  console.log(`ok at ${small.z}% the chosen arrow is still ${small.px}px wide`);

  // 12. on a phone the name is typed in the sheet and there are no arrows
  await send('Emulation.setDeviceMetricsOverride', { width: 390, height: 800, deviceScaleFactor: 2, mobile: true });
  await ev(`localStorage.setItem('planflow.list', '1')`);
  await send('Page.navigate', { url: 'about:blank' }); await sleep(200);
  await send('Page.navigate', { url: BASE + '/#/board/' + board.id });
  await waitFor(() => ev(`document.querySelectorAll('#panel li.clickable').length > 0`).catch(() => false), 'the phone list');
  await ev(`document.querySelector('#panel li.clickable').click()`);
  await waitFor(() => ev(`!!document.querySelector('#panel .title-input')`), 'a card in the list');
  await ev(`(() => { const i = document.querySelector('#panel .title-input'); i.focus(); })()`);
  await key('Enter'); await sleep(200);
  assert.equal(await arrows(), null, 'no arrows on a phone');
  console.log('ok phone: Enter in the name field just finishes the name');

  assert.deepEqual(pageErrors, [], 'no uncaught errors on the page');
  console.log(`UI NEXT-CARD TESTS PASSED; screenshots ${S}/next-arrows.png, next-turned.png, next-taken.png, next-chain.png, next-small.png`);
} catch (e) {
  console.error('FAILED:', e.message); if (pageErrors.length) console.error('page errors:', pageErrors);
  await shot('next-failed').catch(() => {});
  process.exitCode = 1;
} finally { await cleanup(); }
