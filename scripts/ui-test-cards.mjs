// Headless-Chrome UI test for card interactions: middle-click then type a title, two-click
// delete with undo, pasted images and links as covers. (CDP over WebSocket, needs google-chrome.)
// Run against a LOCAL server on a throwaway database: PLANFLOW_URL=http://localhost:8093 node scripts/ui-test-cards.mjs
import { spawn } from 'node:child_process';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
const S = process.env.SCRATCH || os.tmpdir();
const BASE = process.env.PLANFLOW_URL || 'http://localhost:8093', PORT = 9224;
const CHROME = process.env.CHROME || '/usr/bin/google-chrome';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function call(method, path, body) {
  const res = await fetch(BASE + path, { method, headers: body ? { 'content-type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined });
  return { status: res.status, data: res.status === 204 ? null : await res.json().catch(() => null) };
}
// --- board fixture: two cards
const board = (await call('POST', '/api/boards', { name: 'ui-cards ' + Date.now() })).data;
const mk = async (title, x, y) => (await call('POST', `/api/boards/${board.id}/tasks`, { title, x, y })).data;
const A = await mk('A first', 100, 100), B = await mk('B second', 520, 100);
await call('POST', `/api/boards/${board.id}/deps`, { from: A.id, to: B.id });
// --- chrome
fs.rmSync(`${S}/planflow-chrome-profile-cards`, { recursive: true, force: true });
const chrome = spawn(CHROME, ['--headless=new', `--remote-debugging-port=${PORT}`, '--window-size=1400,900', '--no-first-run', '--no-default-browser-check', '--disable-gpu', `--user-data-dir=${S}/planflow-chrome-profile-cards`, 'about:blank'], { stdio: 'ignore' });
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
const key = async (k, code, vk, extra = {}) => {
  await send('Input.dispatchKeyEvent', { type: 'keyDown', key: k, code, windowsVirtualKeyCode: vk, ...extra });
  await send('Input.dispatchKeyEvent', { type: 'keyUp', key: k, code, windowsVirtualKeyCode: vk, ...extra });
};
async function typeText(text) { for (const ch of text) { await send('Input.dispatchKeyEvent', { type: 'keyDown', key: ch, text: ch, unmodifiedText: ch }); await send('Input.dispatchKeyEvent', { type: 'keyUp', key: ch }); } }
async function shot(name) { const r = await send('Page.captureScreenshot', { format: 'png' }); fs.writeFileSync(`${S}/${name}.png`, Buffer.from(r.data, 'base64')); }
async function waitFor(fn, label, ms = 8000) {
  const t0 = Date.now();
  for (;;) { const v = await fn(); if (v) return v; if (Date.now() - t0 > ms) throw new Error('timeout waiting for ' + label); await sleep(150); }
}
const boardData = async () => (await call('GET', `/api/boards/${board.id}`)).data;
const loaded = (n) => waitFor(() => ev(`document.querySelectorAll('.node').length === ${n}`), `board to show ${n} cards`);
const rect = (id) => ev(`(() => { const r = document.querySelector('.node[data-id="${id}"]').getBoundingClientRect(); return { l: r.left, t: r.top, r: r.right, b: r.bottom, cx: (r.left + r.right) / 2, cy: (r.top + r.bottom) / 2 }; })()`);
const active = () => ev(`(() => { const a = document.activeElement; return a ? { tag: a.tagName, cls: a.className, editable: a.isContentEditable, node: a.closest('.node')?.dataset.id || null, text: a.textContent } : null; })()`);
try {
  await send('Page.navigate', { url: BASE + '/' });
  await waitFor(() => ev(`document.readyState === 'complete' && !!document.querySelector('#boardSelect option')`), 'first load');
  await ev(`localStorage.setItem('planflow.board', ${board.id}); localStorage.removeItem('planflow.view.${board.id}')`);
  await send('Page.navigate', { url: BASE + '/' }); await loaded(2); await sleep(300);

  // 1. middle-click on empty canvas: a card appears and the caret is in its title; typing names it
  {
    const rb = await rect(B.id);
    const x = rb.cx, y = rb.b + 160;
    await mouse('mouseMoved', x, y);
    await mouse('mousePressed', x, y, { button: 'middle', clickCount: 1, buttons: 4 });
    await mouse('mouseReleased', x, y, { button: 'middle', clickCount: 1 });
    await loaded(3);
    const a = await waitFor(async () => { const a = await active(); return a && a.editable ? a : null; }, 'caret in the new card');
    assert.equal(a.cls, 'title', 'the card title is being edited');
    assert.ok(a.node, 'the editor is inside a card');
    const newId = +a.node;
    await typeText('Buy milk');
    await key('Enter', 'Enter', 13, { text: '\r' });
    await waitFor(async () => (await boardData()).tasks.find((t) => t.id === newId)?.title === 'Buy milk', 'typed title to save');
    assert.equal(await ev(`document.querySelector('.node[data-id="${newId}"] .title').textContent`), 'Buy milk');
    assert.equal(await ev(`document.querySelector('.node[data-id="${newId}"] .title').hasAttribute('contenteditable')`), false, 'Enter ends the edit');
    assert.equal(await ev(`document.querySelector('#panel .title-input').value`), 'Buy milk', 'panel input follows');
    console.log('ok middle-click adds a card with the caret in its title; typing + Enter names it');

    // keys typed before the server answers are kept: press N then type at once
    await key('Escape', 'Escape', 27); await sleep(50);
    await ev(`document.activeElement && document.activeElement.blur()`);
    await key('n', 'KeyN', 78); await typeText('Fast');
    await loaded(4);
    await waitFor(async () => { const a = await active(); return a && a.editable && a.text === 'Fast'; }, 'type-ahead title in the editor');
    await typeText('er'); await key('Enter', 'Enter', 13, { text: '\r' });
    await waitFor(async () => (await boardData()).tasks.some((t) => t.title === 'Faster'), 'type-ahead title saved');
    console.log('ok keys typed while the card is being created become its title');
  }

  // 2. delete needs two clicks on the panel button; the toast's Undo brings the task back
  {
    const before = (await boardData()).tasks.length;
    const ra = await rect(A.id);
    await mouse('mouseMoved', ra.cx, ra.cy); await mouse('mousePressed', ra.cx, ra.cy, { button: 'left', clickCount: 1, buttons: 1 }); await mouse('mouseReleased', ra.cx, ra.cy, { button: 'left', clickCount: 1 });
    await waitFor(() => ev(`!!document.querySelector('#panel button.delete')`), 'task panel');
    await ev(`document.querySelector('#panel button.delete').click()`);
    assert.equal(await ev(`document.querySelector('#panel button.delete').textContent`), 'Really?', 'first click arms');
    assert.equal(await ev(`document.querySelector('#panel button.delete').classList.contains('armed')`), true);
    await sleep(300);
    assert.equal((await boardData()).tasks.length, before, 'nothing deleted after one click');
    await ev(`document.querySelector('#panel button.delete').click()`);
    await waitFor(async () => (await boardData()).tasks.length === before - 1, 'delete to land');
    assert.equal(await ev(`!!document.querySelector('.node[data-id="${A.id}"]')`), false, 'card gone');
    assert.equal((await boardData()).deps.length, 0, 'its link is hidden too');
    assert.match(await ev(`document.querySelector('#toast').textContent`), /Deleted "A first"/);
    await ev(`document.querySelector('#toast .toast-action').click()`);
    await waitFor(() => ev(`!!document.querySelector('.node[data-id="${A.id}"]')`), 'undo to restore the card');
    assert.equal((await boardData()).tasks.length, before); assert.equal((await boardData()).deps.length, 1, 'link is back');
    console.log('ok panel delete: Delete -> Really? -> gone; Undo in the toast restores it with its link');

    // the Delete key: first press arms, second deletes, Ctrl+Z undoes
    await ev(`document.activeElement && document.activeElement.blur()`);
    const rb = await rect(B.id);
    await mouse('mouseMoved', rb.cx, rb.cy); await mouse('mousePressed', rb.cx, rb.cy, { button: 'left', clickCount: 1, buttons: 1 }); await mouse('mouseReleased', rb.cx, rb.cy, { button: 'left', clickCount: 1 });
    await waitFor(() => ev(`document.querySelector('.node[data-id="${B.id}"]').classList.contains('selected')`), 'B selected');
    await key('Delete', 'Delete', 46); await sleep(200);
    assert.equal(await ev(`document.querySelector('#panel button.delete').textContent`), 'Really?', 'Delete key arms the button');
    assert.equal(await ev(`!!document.querySelector('.node[data-id="${B.id}"]')`), true, 'still there after one press');
    await key('Delete', 'Delete', 46);
    await waitFor(() => ev(`!document.querySelector('.node[data-id="${B.id}"]')`), 'second press deletes');
    await key('z', 'KeyZ', 90, { modifiers: 2 });
    await waitFor(() => ev(`!!document.querySelector('.node[data-id="${B.id}"]')`), 'Ctrl+Z restores');
    console.log('ok Delete key twice removes the task, Ctrl+Z brings it back');
  }

  // 3. paste an image with a card selected: it becomes that card's cover
  {
    const png = 'iVBORw0KGgoAAAANSUhEUgAAAAoAAAAFCAYAAAB8ZH1oAAAAFklEQVR42mP8z8Dwn4EIwDiqkL4KAQAJMQkGa+aHkgAAAABJRU5ErkJggg==';   // 10x5
    await ev(`(async () => { const bytes = Uint8Array.from(atob('${png}'), (c) => c.charCodeAt(0));
      const file = new File([bytes], 'image.png', { type: 'image/png' });
      const dt = new DataTransfer(); dt.items.add(file);
      document.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true })); })()`);
    await waitFor(() => ev(`!!document.querySelector('.node[data-id="${B.id}"] .cover.image img')`), 'image cover on the selected card');
    const t = await waitFor(async () => { const t = (await boardData()).tasks.find((t) => t.id === B.id); return t.cover ? t : null; }, 'cover saved');
    assert.equal(t.cover.kind, 'image'); assert.equal(t.cover.width, 10); assert.equal(t.cover.height, 5);
    assert.equal(await ev(`document.querySelector('.node[data-id="${B.id}"] .cover img').style.aspectRatio`), '10 / 5');
    assert.ok(await ev(`document.querySelector('.node[data-id="${B.id}"]').offsetHeight`) > 60, 'card grew for its cover');
    console.log('ok pasted image becomes the cover of the selected card');
  }

  // 4. paste a link with nothing selected: a new card with a link preview, titled after the page
  {
    await key('Escape', 'Escape', 27); await sleep(100);
    assert.equal(await ev(`document.querySelectorAll('.node.selected').length`), 0, 'nothing selected');
    const n = (await boardData()).tasks.length;
    await ev(`(() => { const dt = new DataTransfer(); dt.setData('text/plain', '${BASE}/');
      document.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true })); })()`);
    const t = await waitFor(async () => { const ts = (await boardData()).tasks; return ts.length === n + 1 ? ts.find((t) => t.cover && t.cover.kind === 'link') : null; }, 'new card with a link cover');
    assert.equal(t.title, 'Planflow', 'card named after the page title'); assert.equal(t.cover.url, BASE + '/');
    await waitFor(() => ev(`document.querySelector('.node[data-id="${t.id}"] .cover.link .lt')?.textContent === 'Planflow'`), 'preview drawn on the card');
    assert.equal(await ev(`document.querySelector('.node[data-id="${t.id}"] .cover.link .ls').textContent`), '↗ localhost');
    console.log('ok pasted link makes a new card with the page title and a preview');
    // plain text with nothing selected: a new card named by the first line, rest in notes
    await key('Escape', 'Escape', 27); await sleep(100);
    await ev(`(() => { const dt = new DataTransfer(); dt.setData('text/plain', 'Call the plumber\\nabout the kitchen tap');
      document.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true })); })()`);
    const p = await waitFor(async () => (await boardData()).tasks.find((t) => t.title === 'Call the plumber'), 'card from pasted text');
    assert.equal(p.notes, 'about the kitchen tap');
    console.log('ok pasted text makes a new card (first line title, rest notes)');
  }

  // 5. double-click a card renames it in place
  {
    const rb = await rect(B.id);
    const ty = await ev(`(() => { const t = document.querySelector('.node[data-id="${B.id}"] .title').getBoundingClientRect(); return (t.top + t.bottom) / 2; })()`);
    for (const n of [1, 2]) { await mouse('mousePressed', rb.cx, ty, { button: 'left', clickCount: n, buttons: 1 }); await mouse('mouseReleased', rb.cx, ty, { button: 'left', clickCount: n }); }
    const a = await waitFor(async () => { const a = await active(); return a && a.editable && +a.node === B.id ? a : null; }, 'inline editor after double-click');
    assert.equal(a.text, 'B second', 'existing title is in the editor');
    // the whole title is selected, so typing replaces it (like renaming a file)
    await typeText('B renamed'); await key('Enter', 'Enter', 13, { text: '\r' });
    await waitFor(async () => (await boardData()).tasks.find((t) => t.id === B.id).title === 'B renamed', 'rename saved');
    console.log('ok double-click renames a card in place');
  }
  await shot('cards');
  console.log('UI CARD TESTS PASSED; screenshot', `${S}/cards.png`);
} catch (e) {
  await shot('cards-fail').catch(() => {});
  console.error('FAILED:', e.message);
  process.exitCode = 1;
} finally { await cleanup(); }
