// Headless-Chrome UI test for board modes: Tasks, Ideas, Planning and Workflow. Switching (and
// undoing the switch), what cards and links look like in each, ticks that nothing waits for,
// loops, words on arrows, decisions, the outline and the step-by-step walk, the home page cards,
// "what is the new plan for?", and the phone's list.
// Run against a LOCAL server on a throwaway database:
//   PLANFLOW_URL=http://localhost:8093 node scripts/ui-test-modes.mjs   (node 20 needs --experimental-websocket)
import { spawn } from 'node:child_process';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
const S = process.env.SCRATCH || os.tmpdir();
const BASE = process.env.PLANFLOW_URL || 'http://localhost:8093', PORT = 9226;
const CHROME = process.env.CHROME || '/usr/bin/google-chrome';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function call(method, path, body) {
  const res = await fetch(BASE + path, { method, headers: body ? { 'content-type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined });
  return { status: res.status, data: res.status === 204 ? null : await res.json().catch(() => null) };
}
// --- fixture: a tasks board, A -> B (so B is blocked) and C on its own
const stamp = Date.now(), NEW_NAME = 'ui-modes new ' + stamp;
const board = (await call('POST', '/api/boards', { name: 'ui-modes ' + stamp })).data;
const mk = async (title, x, y) => (await call('POST', `/api/boards/${board.id}/tasks`, { title, x, y })).data;
const A = await mk('Alpha', 100, 100), B = await mk('Beta', 520, 100), C = await mk('Gamma', 100, 420);
await call('POST', `/api/boards/${board.id}/deps`, { from: A.id, to: B.id });
const server = async () => (await call('GET', `/api/boards/${board.id}`)).data;
// --- chrome
fs.rmSync(`${S}/planflow-chrome-modes`, { recursive: true, force: true });
const chrome = spawn(CHROME, ['--headless=new', `--remote-debugging-port=${PORT}`, '--window-size=1400,900', '--no-first-run', '--no-default-browser-check', '--disable-gpu', `--user-data-dir=${S}/planflow-chrome-modes`, 'about:blank'], { stdio: 'ignore' });
const cleanup = async () => {
  chrome.kill();
  for (const b of (await call('GET', '/api/boards')).data) if (b.id === board.id || b.name === NEW_NAME) await call('DELETE', `/api/boards/${b.id}`);
};
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
  else if (msg.method === 'Page.javascriptDialogOpening') send('Page.handleJavaScriptDialog', { accept: true, promptText: NEW_NAME });
  else if (msg.method === 'Runtime.exceptionThrown') pageErrors.push(msg.params.exceptionDetails.exception?.description || msg.params.exceptionDetails.text);
};
await send('Page.enable'); await send('Runtime.enable');
const ev = async (expression) => {
  const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
  if (r.exceptionDetails) throw new Error('page error: ' + (r.exceptionDetails.exception?.description || r.exceptionDetails.text));
  return r.result.value;
};
const mouse = (type, x, y, extra = {}) => send('Input.dispatchMouseEvent', { type, x, y, ...extra });
async function drag(x1, y1, x2, y2) {
  const steps = 14;
  await mouse('mouseMoved', x1, y1);
  await mouse('mousePressed', x1, y1, { button: 'left', clickCount: 1, buttons: 1 });
  for (let i = 1; i <= steps; i++) { await mouse('mouseMoved', x1 + (x2 - x1) * i / steps, y1 + (y2 - y1) * i / steps, { button: 'left', buttons: 1 }); await sleep(15); }
  await sleep(100);
  await mouse('mouseReleased', x2, y2, { button: 'left', clickCount: 1 });
  await sleep(150);
}
async function click(x, y, count = 1) { await mouse('mouseMoved', x, y); for (let i = 1; i <= count; i++) { await mouse('mousePressed', x, y, { button: 'left', clickCount: i, buttons: 1 }); await mouse('mouseReleased', x, y, { button: 'left', clickCount: i }); } await sleep(150); }
async function key(k, extra = {}) { await send('Input.dispatchKeyEvent', { type: 'keyDown', key: k, ...extra }); await send('Input.dispatchKeyEvent', { type: 'keyUp', key: k, ...extra }); await sleep(120); }
async function shot(name) { const r = await send('Page.captureScreenshot', { format: 'png' }); fs.writeFileSync(`${S}/${name}.png`, Buffer.from(r.data, 'base64')); }
async function waitFor(fn, label, ms = 8000) {
  const t0 = Date.now();
  for (;;) { const v = await fn(); if (v) return v; if (Date.now() - t0 > ms) throw new Error('timeout waiting for ' + label); await sleep(120); }
}
const cls = (id) => ev(`document.querySelector('.node[data-id="${id}"]').className`);
const has = async (id, c) => (await cls(id)).split(' ').includes(c);
const mode = () => ev(`document.body.dataset.mode`);
const toast = () => ev(`document.querySelector('#toast').textContent`);
const rect = (sel) => ev(`(() => { const r = document.querySelector(${JSON.stringify(sel)}).getBoundingClientRect(); return { cx: (r.left + r.right) / 2, cy: (r.top + r.bottom) / 2 }; })()`);
// Pick a mode from the menu the top bar's mode button opens, and wait for the server to have it (or not).
async function pick(m, expect = m) {
  await ev(`document.querySelector('#btnMode').click()`);
  await waitFor(() => ev(`document.querySelectorAll('.menu.ctx .mode-item').length === 4`), 'mode menu');
  await ev(`document.querySelector('.menu.ctx .mode-item[data-mode="${m}"]').click()`);
  await waitFor(async () => (await server()).board.mode === expect && (await mode()) === expect, `mode ${expect}`);
  await sleep(200);
}
const edgeClass = (from, to) => ev(`(() => { const hit = document.querySelector('#edgeLayer .edge-hit[data-from="${from}"][data-to="${to}"]'); return hit ? hit.previousElementSibling.getAttribute('class') + ' | ' + (hit.previousElementSibling.getAttribute('marker-end') || 'no-marker') : null; })()`);
try {
  await send('Page.navigate', { url: BASE + '/#/' });
  await waitFor(() => ev(`document.readyState === 'complete' && document.body.classList.contains('home')`), 'first load');
  await ev(`localStorage.setItem('planflow.theme', 'dark'); localStorage.removeItem('planflow.view.${board.id}')`);
  await send('Page.navigate', { url: 'about:blank' }); await sleep(200);
  await send('Page.navigate', { url: BASE + '/#/board/' + board.id });
  await waitFor(() => ev(`document.querySelectorAll('.node').length === 3`).catch(() => false), 'board open');
  await sleep(300);

  // 1. a new board is a tasks board, and looks the way it always did
  assert.equal(await mode(), 'tasks');
  assert.ok(await has(A.id, 'ready') && await has(B.id, 'blocked'), 'A ready, B blocked');
  assert.equal(await ev(`document.querySelector('#btnAdd').textContent`), '+ Task');
  assert.equal(await ev(`document.querySelector('#btnMode .mode-name').textContent`), 'Tasks');
  assert.equal(await ev(`getComputedStyle(document.querySelector('.node[data-id="${A.id}"] .check')).display`), 'flex', 'checkbox shown');
  assert.match(await edgeClass(A.id, B.id), /^edge pending \| url\(#arrow-pending\)$/);
  console.log('ok tasks board: ready / blocked, checkbox, arrow');

  // 2. Ideas: nothing is blocked, cards lean, links are threads without a head, the top bar speaks ideas
  await pick('ideas');
  assert.ok(await has(A.id, 'open') && await has(B.id, 'open') && !(await has(B.id, 'blocked')), 'nothing is blocked');
  assert.ok(await has(A.id, 'hub'), 'a card with a link going out is a pile');
  assert.equal(await ev(`document.querySelector('.node[data-id="${A.id}"] .badge').textContent`), '1 in this pile');
  assert.equal(await ev(`document.querySelector('#btnAdd').textContent`), '+ Idea');
  const lean = await ev(`parseFloat(document.querySelector('.node[data-id="${C.id}"]').style.getPropertyValue('--lean'))`);
  assert.ok(Math.abs(lean) >= 0.6 && Math.abs(lean) <= 1.6, `lean ${lean} is within 0.6..1.6°`);
  assert.notEqual(await ev(`getComputedStyle(document.querySelector('.node[data-id="${C.id}"]')).transform`), 'none', 'the card is turned');
  assert.match(await edgeClass(A.id, B.id), /^edge ideas \| no-marker$/);
  assert.match(await toast(), /Ideas board now.*Undo/s, 'the switch can be undone from the toast');
  assert.equal(await ev(`getComputedStyle(document.querySelector('.node[data-id="${B.id}"] .check')).visibility`), 'hidden', 'the tick hides until the card is hovered, selected or ticked');
  console.log(`ok ideas: nothing blocked, cards lean (${lean}°), dotted thread, quiet tick`);
  await shot('modes-ideas');

  // 3. a tick that nothing waits for (B was blocked a moment ago)
  await ev(`document.querySelector('.node[data-id="${B.id}"] .check').click()`);
  await waitFor(async () => (await server()).tasks.find((t) => t.id === B.id).status === 'done', 'B ticked on the server');
  assert.ok(await has(B.id, 'done'));
  assert.equal(await ev(`getComputedStyle(document.querySelector('.node[data-id="${B.id}"] .check')).visibility`), 'visible', 'a ticked card shows its tick');
  assert.equal(await ev(`document.querySelector('#progress .label').textContent`), '1 / 3 ticked');
  console.log('ok ideas: ticking a card that a task board would call blocked');
  await ev(`document.querySelector('.node[data-id="${B.id}"] .check').click()`);
  await waitFor(async () => (await server()).tasks.find((t) => t.id === B.id).status === 'todo', 'B unticked');

  // 4. Ctrl+Z switches back
  await key('z', { modifiers: 2, code: 'KeyZ', windowsVirtualKeyCode: 90 });
  await waitFor(async () => (await server()).board.mode === 'tasks' && (await mode()) === 'tasks', 'undo: back to tasks');
  assert.ok(await has(B.id, 'blocked'), 'B is blocked again');
  console.log('ok Ctrl+Z undoes a mode switch');

  // 5. Planning: levels instead of states, no checkbox, branches ending in a bud, the outline in the panel
  await pick('plan');
  assert.ok(await has(A.id, 'lv0') && await has(B.id, 'lv1') && await has(C.id, 'lvx'), 'top, one level down, loose');
  assert.equal(await ev(`getComputedStyle(document.querySelector('.node[data-id="${A.id}"] .check')).display`), 'none', 'no checkbox in an outline');
  assert.match(await edgeClass(A.id, B.id), /^edge plan \| url\(#bud\)$/);
  assert.equal(await ev(`document.querySelector('#btnAdd').textContent`), '+ Point');
  assert.deepEqual(await ev(`[...document.querySelectorAll('#panel ul.outline li')].map((li) => li.textContent)`), ['Alpha', 'Beta']);
  assert.match(await ev(`document.querySelector('#panel').textContent`), /Loose points \(1\)/);
  await ev(`window.__copied = null; navigator.clipboard.writeText = async (t) => { window.__copied = t; }; [...document.querySelectorAll('#panel button.link')].find((b) => b.textContent === 'Copy as text').click()`);
  await waitFor(() => ev(`window.__copied`), 'outline copied');
  assert.equal(await ev(`window.__copied`), `# ui-modes ${stamp}\n\n## Alpha\n- Beta\n\n## Loose points\n- Gamma\n`);
  assert.match(await toast(), /Copied 5 lines/);
  console.log('ok planning: levels, no checkbox, bud, outline in the panel, copy as text');
  await shot('modes-plan');

  // 6. Workflow: start and end, and an arrow may loop back
  await pick('flow');
  assert.ok(await has(A.id, 'start') && await has(B.id, 'end') && await has(C.id, 'step'), 'start, end, step');
  assert.match(await edgeClass(A.id, B.id), /^edge flow \| url\(#arrow-pending\)$/);
  const pb = await rect(`.node[data-id="${B.id}"] .port.bottom`), ra = await rect(`.node[data-id="${A.id}"]`);
  await drag(pb.cx, pb.cy, ra.cx, ra.cy + 14);
  await waitFor(async () => (await server()).deps.some((d) => d.from === B.id && d.to === A.id), 'B -> A (a loop) saved');
  assert.match(await toast(), /After "Beta" comes "Alpha"/);
  console.log('ok workflow: start / end, an arrow can loop back');

  // 7. a looping board cannot become a tasks board: it says which cards, and selects one of the links
  await ev(`document.querySelector('#btnMode').click()`);
  await ev(`document.querySelector('.menu.ctx .mode-item[data-mode="tasks"]').click()`);
  await waitFor(async () => /cannot have a loop/.test(await toast()), 'loop refusal toast');
  assert.match(await toast(), /Tasks cannot have a loop.*"(Alpha|Beta)" → "(Alpha|Beta)"/);
  assert.equal((await server()).board.mode, 'flow'); assert.equal(await mode(), 'flow');
  assert.equal(await ev(`document.querySelectorAll('#edgeLayer .edge.selected').length`), 1, 'one link of the loop is selected');
  assert.equal(await ev(`document.querySelector('#panel .badge').textContent`), 'Arrow');
  console.log('ok a loop keeps the board out of tasks mode, and the link to cut is selected');

  // 8. Arrange copes with the loop (no card is sent to NaN)
  await key('Escape'); await key('a', { code: 'KeyA', windowsVirtualKeyCode: 65 }); await sleep(700);
  const spots = await ev(`[...document.querySelectorAll('.node')].map((el) => [parseFloat(el.style.left), parseFloat(el.style.top)])`);
  assert.ok(spots.flat().every(Number.isFinite), 'every card has a real spot: ' + JSON.stringify(spots));
  assert.ok((await server()).tasks.every((t) => Number.isFinite(t.x) && Number.isFinite(t.y)));
  assert.doesNotMatch(await toast(), /bad position/);
  console.log('ok arrange works on a board with a loop');

  // 9. words on an arrow: double-click it, type; the card it leaves becomes a decision
  const mid = await ev(`(() => { const p = document.querySelector('#edgeLayer .edge-hit[data-from="${A.id}"][data-to="${B.id}"]'); const m = p.getPointAtLength(p.getTotalLength() / 2); const pt = m.matrixTransform(p.getScreenCTM()); return { x: pt.x, y: pt.y }; })()`);
  await click(mid.x, mid.y, 2);
  await waitFor(() => ev(`document.activeElement && document.activeElement.classList.contains('label-input')`), 'double-click focuses the label field');
  assert.equal((await server()).deps.some((d) => d.from === A.id && d.to === B.id), true, 'the double-click did not unlink');
  await send('Input.insertText', { text: 'Yes' });
  await waitFor(async () => (await server()).deps.find((d) => d.from === A.id && d.to === B.id).label === 'Yes', 'label saved');
  assert.equal(await ev(`document.querySelector('.edge-label').textContent`), 'Yes');
  assert.ok(await ev(`document.querySelector('.edge-label').classList.contains('yes')`), 'Yes is green');
  assert.ok(await has(A.id, 'decision'), 'a card with words on its arrow out is a decision');
  await ev(`[...document.querySelectorAll('#panel .chip')].find((c) => c.textContent === 'No').click()`);
  await waitFor(async () => (await server()).deps.find((d) => d.from === A.id && d.to === B.id).label === 'No', 'chip saved');
  assert.ok(await ev(`document.querySelector('.edge-label').classList.contains('no')`), 'No is red');
  console.log('ok double-click an arrow to write on it; Yes / No chips; the card becomes a decision');

  // 10. a card that asks a question is a decision too; the panel walks the flow step by step
  await call('PATCH', `/api/tasks/${C.id}`, { title: 'Is it Gamma' });
  await key('Escape');
  await ev(`document.dispatchEvent(new Event('visibilitychange'))`);
  await waitFor(() => has(C.id, 'decision'), 'the question card is a decision');
  const steps = await ev(`[...document.querySelectorAll('#panel ul.outline li')].map((li) => li.textContent)`);
  assert.equal(steps.length, 3, JSON.stringify(steps));
  // Alpha and Beta are a loop with no start, so the walk begins at whichever Arrange put top-left.
  assert.match(steps[0], /^1(Alpha|Beta)$/); assert.match(steps[1], /^2(No)?(Alpha|Beta)$/); assert.match(steps[2], /back to step 1: (Alpha|Beta)$/);
  assert.equal(steps.filter((s) => s.includes('No')).length, 1, 'the word on the arrow is shown once, where the walk follows it');
  assert.match(await ev(`document.querySelector('#panel').textContent`), /Not connected \(1\)/);
  console.log('ok a question is a decision; the panel numbers the steps and marks the way back');
  await shot('modes-flow');

  // 11. the home page says what kind of plan it is and sketches it that way
  await ev(`document.querySelector('.brand').click()`);
  await waitFor(() => ev(`document.body.classList.contains('home') && !!document.querySelector('.plan[data-id="${board.id}"]')`), 'home');
  const card = `.plan[data-id="${board.id}"]`;
  assert.equal(await ev(`document.querySelector('${card}').dataset.mode`), 'flow');
  assert.equal(await ev(`document.querySelector('${card} .thumb-mode').textContent`), 'Workflow');
  assert.equal(await ev(`document.querySelector('${card} .thumb-count').textContent`), '3 steps');
  assert.match(await ev(`document.querySelector('${card} .plan-meta').textContent`), /^3 steps · 2 decisions · /);
  assert.equal(await ev(`document.querySelectorAll('${card} .mini polygon.mn.decision').length`), 2, 'both decisions are six-sided in the sketch');
  assert.equal(await ev(`getComputedStyle(document.querySelector('${card} .plan-bar')).visibility`), 'hidden', 'no progress bar on a workflow');
  console.log('ok home card: kind, count, decisions, sketch');
  await shot('modes-home');

  // 12. a new plan starts with "what is it for?"
  await ev(`document.querySelector('#btnNewBoard').click()`);
  await waitFor(() => ev(`document.querySelectorAll('.menu.ctx .mode-item').length === 4`), 'what-for menu');
  assert.equal(await ev(`document.querySelector('.menu.ctx .menu-title').textContent`), 'What is the new plan for?');
  await ev(`document.querySelector('.menu.ctx .mode-item[data-mode="ideas"]').click()`);
  await waitFor(() => ev(`/^#\\/board\\/\\d+$/.test(location.hash) && !document.body.classList.contains('home')`), 'new board open');
  const fresh = (await call('GET', '/api/boards')).data.find((b) => b.name === NEW_NAME);
  assert.ok(fresh, 'the new plan exists'); assert.equal(fresh.mode, 'ideas');
  assert.equal(await mode(), 'ideas'); assert.equal(await ev(`document.querySelector('#btnAdd').textContent`), '+ Idea');
  console.log('ok + New plan asks what it is for and makes that kind');

  // 13. phone: the mode is in the ⋯ menu and at the top of the list, whose add button speaks the mode
  await send('Emulation.setDeviceMetricsOverride', { width: 390, height: 800, deviceScaleFactor: 2, mobile: true });
  await ev(`location.hash = '#/board/${board.id}'`);
  await waitFor(() => ev(`document.querySelectorAll('.node').length === 3`), 'board on the phone');
  assert.equal(await ev(`getComputedStyle(document.querySelector('#btnMode')).display`), 'none', 'no mode button in the narrow top bar');
  await ev(`document.querySelector('#btnList').click()`); await sleep(200);
  assert.equal(await ev(`document.querySelector('#panel .panel-head button.primary').textContent`), '+ Step');
  assert.match(await ev(`document.querySelector('#panel .mode-line').textContent`), /^Workflow/);
  await ev(`document.querySelector('#btnBoardMenu').click()`); await ev(`document.querySelector('#boardMenu [data-act=mode]').click()`);
  await waitFor(() => ev(`document.querySelectorAll('.menu.ctx .mode-item').length === 4`), 'mode menu from the board menu');
  assert.ok(await ev(`document.querySelector('.menu.ctx .mode-item[data-mode="flow"]').classList.contains('current')`));
  await shot('modes-phone');
  console.log('ok phone: mode in the ⋯ menu and the list');

  assert.deepEqual(pageErrors, [], 'no uncaught errors on the page');
  console.log(`UI MODE TESTS PASSED; screenshots ${S}/modes-ideas.png, modes-plan.png, modes-flow.png, modes-home.png, modes-phone.png`);
} catch (e) {
  console.error('FAILED:', e.message); if (pageErrors.length) console.error('page errors:', pageErrors);
  await shot('modes-failed').catch(() => {});
  process.exitCode = 1;
} finally { await cleanup(); }
