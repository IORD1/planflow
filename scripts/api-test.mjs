// API test: link sides, trash/restore, covers, the archive, board modes and link labels.
// Run against a LOCAL server on a throwaway database:
//   PLANFLOW_URL=http://localhost:8093 node scripts/api-test.mjs
import assert from 'node:assert/strict';
const B = process.env.PLANFLOW_URL || 'http://localhost:8093';
async function call(method, path, body) {
  const res = await fetch(B + path, { method, headers: body ? { 'content-type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined });
  const data = res.status === 204 ? null : await res.json().catch(() => null);
  return { status: res.status, data };
}
const board = (await call('POST', '/api/boards', { name: 'sides-test' })).data;
const mk = async (title, x, y) => (await call('POST', `/api/boards/${board.id}/tasks`, { title, x, y })).data;
const A = await mk('A', 0, 0), Bt = await mk('B', 300, 0), C = await mk('C', 0, 300);
let r = await call('POST', `/api/boards/${board.id}/deps`, { from: A.id, to: Bt.id });
assert.equal(r.status, 201); assert.deepEqual(r.data, { from: A.id, to: Bt.id, from_side: 'right', to_side: 'left', label: null }); console.log('ok default sides right→left');
r = await call('POST', `/api/boards/${board.id}/deps`, { from: A.id, to: C.id, from_side: 'bottom', to_side: 'top' });
assert.equal(r.status, 201); assert.deepEqual(r.data, { from: A.id, to: C.id, from_side: 'bottom', to_side: 'top', label: null }); console.log('ok explicit sides bottom→top');
r = await call('POST', `/api/boards/${board.id}/deps`, { from: Bt.id, to: C.id, from_side: 'diagonal' });
assert.equal(r.status, 400); assert.match(r.data.error, /left, right, top or bottom/); console.log('ok bad side rejected:', r.data.error);
r = await call('POST', `/api/boards/${board.id}/deps`, { from: Bt.id, to: C.id, to_side: 42 });
assert.equal(r.status, 400); console.log('ok non-string side rejected');
r = await call('GET', `/api/boards/${board.id}`);
const deps = r.data.deps.sort((p, q) => p.to - q.to);
assert.deepEqual(deps, [{ from: A.id, to: Bt.id, from_side: 'right', to_side: 'left', label: null }, { from: A.id, to: C.id, from_side: 'bottom', to_side: 'top', label: null }]); console.log('ok GET board returns sides');
r = await call('PATCH', `/api/deps/${A.id}/${C.id}`, { to_side: 'right' });
assert.equal(r.status, 200); assert.deepEqual(r.data, { from: A.id, to: C.id, from_side: 'bottom', to_side: 'right', label: null }); console.log('ok PATCH one side keeps the other');
r = await call('PATCH', `/api/deps/${A.id}/${C.id}`, { from_side: 'left', to_side: 'bottom' });
assert.deepEqual(r.data, { from: A.id, to: C.id, from_side: 'left', to_side: 'bottom', label: null }); console.log('ok PATCH both sides');
r = await call('PATCH', `/api/deps/${A.id}/${C.id}`, { from_side: 'up' }); assert.equal(r.status, 400); console.log('ok PATCH bad side 400');
r = await call('PATCH', `/api/deps/${Bt.id}/${C.id}`, { from_side: 'top' }); assert.equal(r.status, 404); console.log('ok PATCH missing link 404');
r = await call('POST', `/api/boards/${board.id}/deps`, { from: A.id, to: Bt.id, from_side: 'top' });
assert.equal(r.status, 200); assert.deepEqual(r.data, { from: A.id, to: Bt.id, from_side: 'right', to_side: 'left', label: null, existed: true }); console.log('ok re-adding keeps stored sides, existed:true');
r = await call('POST', `/api/boards/${board.id}/deps`, { from: Bt.id, to: A.id, from_side: 'left', to_side: 'right' }); assert.equal(r.status, 409); console.log('ok cycle still refused');
r = await call('GET', `/api/boards/${board.id}`); assert.equal(r.data.deps.length, 2);
await call('DELETE', `/api/deps/${A.id}/${C.id}`);
r = await call('GET', `/api/boards/${board.id}`); assert.equal(r.data.deps.length, 1); console.log('ok delete link');

// --- trash and restore (DELETE is soft; POST /restore undoes it)
{
  const T = await mk('T middle', 150, 150), A2 = await mk('A2', 0, 600), B2 = await mk('B2', 300, 600);
  await call('POST', `/api/boards/${board.id}/deps`, { from: A2.id, to: T.id, from_side: 'bottom', to_side: 'top' });
  await call('POST', `/api/boards/${board.id}/deps`, { from: T.id, to: B2.id });
  let before = (await call('GET', `/api/boards/${board.id}`)).data;
  const depCount = before.deps.length, taskCount = before.tasks.length;
  r = await call('DELETE', `/api/tasks/${T.id}`); assert.equal(r.status, 204);
  let after = (await call('GET', `/api/boards/${board.id}`)).data;
  assert.equal(after.tasks.length, taskCount - 1); assert.ok(!after.tasks.some((t) => t.id === T.id));
  assert.equal(after.deps.length, depCount - 2, 'links of a deleted task are hidden'); console.log('ok delete hides the task and its links');
  r = await call('GET', `/api/boards`); assert.equal(r.data.find((b) => b.id === board.id).total, taskCount - 1); console.log('ok board counts skip the trash');
  r = await call('PATCH', `/api/tasks/${T.id}`, { title: 'x' }); assert.equal(r.status, 404); console.log('ok a deleted task is 404 for PATCH');
  r = await call('POST', `/api/boards/${board.id}/deps`, { from: A2.id, to: T.id }); assert.equal(r.status, 404); console.log('ok cannot link to a deleted task');
  r = await call('POST', `/api/tasks/${T.id}/restore`); assert.equal(r.status, 200);
  assert.equal(r.data.task.id, T.id); assert.equal(r.data.task.title, 'T middle');
  assert.deepEqual(r.data.deps.map((d) => [d.from, d.to]).sort(), [[A2.id, T.id], [T.id, B2.id]].sort(), 'restore brings the links back');
  after = (await call('GET', `/api/boards/${board.id}`)).data;
  assert.equal(after.tasks.length, taskCount); assert.equal(after.deps.length, depCount); console.log('ok restore puts task and links back');
  r = await call('POST', `/api/tasks/${T.id}/restore`); assert.equal(r.status, 404); console.log('ok restoring twice is 404');
  // a loop made possible while T was in the trash: B2 -> A2 is fine without T, so on restore T -> B2 is dropped
  await call('DELETE', `/api/tasks/${T.id}`);
  r = await call('POST', `/api/boards/${board.id}/deps`, { from: B2.id, to: A2.id }); assert.equal(r.status, 201, 'B2->A2 allowed while T is deleted');
  r = await call('POST', `/api/tasks/${T.id}/restore`); assert.equal(r.status, 200);
  assert.equal(r.data.deps.length, 1, 'one of the two links had to go (whichever the server met second)');
  after = (await call('GET', `/api/boards/${board.id}`)).data;
  const has = (f, t) => after.deps.some((d) => d.from === f && d.to === t);
  assert.ok(has(B2.id, A2.id) && (has(A2.id, T.id) !== has(T.id, B2.id)), 'no loop: B2->A2 stays and only one link of T survives');
  console.log('ok restore drops a link that would make a loop');
}

// --- covers: a pasted picture, or a link with a fetched preview
{
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');
  const P = await mk('Picture', 700, 0);
  const raw = async (path, body, type) => { const res = await fetch(B + path, { method: 'POST', headers: { 'content-type': type }, body }); return { status: res.status, data: await res.json().catch(() => null) }; };
  r = await raw(`/api/tasks/${P.id}/cover?name=tiny`, png, 'image/png');
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.deepEqual({ ...r.data.cover, v: 0 }, { kind: 'image', url: null, title: 'tiny', description: null, site: null, image: true, width: 1, height: 1, v: 0 }); console.log('ok image cover stored, size read from the PNG header');
  const v1 = r.data.cover.v;
  let res = await fetch(`${B}/api/tasks/${P.id}/cover-image?v=${v1}`);
  assert.equal(res.status, 200); assert.equal(res.headers.get('content-type'), 'image/png'); assert.match(res.headers.get('cache-control'), /immutable/);
  assert.ok(Buffer.from(await res.arrayBuffer()).equals(png)); console.log('ok cover-image serves the bytes back');
  r = await raw(`/api/tasks/${P.id}/cover`, Buffer.from('not an image'), 'image/png'); assert.equal(r.status, 400); console.log('ok garbage with an image content type is refused:', r.data.error);
  r = await call('GET', `/api/boards/${board.id}`); assert.equal(r.data.tasks.find((t) => t.id === P.id).cover.kind, 'image'); console.log('ok GET board carries cover metadata');
  // link to this very server: index.html has <title>Planflow</title>
  const L = await mk('placeholder', 700, 200);
  r = await call('POST', `/api/tasks/${L.id}/cover`, { url: B + '/', rename: true });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal(r.data.cover.kind, 'link'); assert.equal(r.data.cover.title, 'Planflow'); assert.equal(r.data.cover.url, B + '/');
  assert.equal(r.data.cover.image, false); assert.equal(r.data.title, 'Planflow', 'rename:true takes the page title'); console.log('ok link cover fetched the page title and renamed the task');
  // a link straight to a picture becomes an image cover
  r = await call('POST', `/api/tasks/${L.id}/cover`, { url: `${B}/api/tasks/${P.id}/cover-image?v=${v1}` });
  assert.equal(r.data.cover.kind, 'image'); assert.equal(r.data.cover.width, 1); assert.equal(r.data.title, 'Planflow', 'no rename without rename:true'); console.log('ok a link to an image becomes an image cover');
  // unreachable page: still a bare link cover
  r = await call('POST', `/api/tasks/${L.id}/cover`, { url: 'http://127.0.0.1:9/nothing' });
  assert.equal(r.status, 200); assert.deepEqual([r.data.cover.kind, r.data.cover.title, r.data.cover.site, r.data.cover.image], ['link', null, '127.0.0.1', false]); console.log('ok unreachable link still gives a bare link cover');
  r = await call('POST', `/api/tasks/${L.id}/cover`, { url: 'ftp://x' }); assert.equal(r.status, 400);
  r = await call('POST', `/api/tasks/${L.id}/cover`, { url: 'nope' }); assert.equal(r.status, 400);
  r = await call('POST', `/api/tasks/${L.id}/cover`, {}); assert.equal(r.status, 400); console.log('ok bad links are 400');
  r = await call('DELETE', `/api/tasks/${L.id}/cover`); assert.equal(r.status, 200); assert.equal(r.data.cover, null);
  res = await fetch(`${B}/api/tasks/${L.id}/cover-image`); assert.equal(res.status, 404); console.log('ok cover removed');
  // the cover survives delete + restore
  await call('DELETE', `/api/tasks/${P.id}`); r = await call('POST', `/api/tasks/${P.id}/restore`);
  assert.equal(r.data.task.cover.kind, 'image'); console.log('ok cover survives trash and restore');
}

await call('DELETE', `/api/boards/${board.id}`);

// --- archive (PATCH {archived}) and the home page's overview
{
  const b2 = (await call('POST', '/api/boards', { name: 'archive-test' })).data;
  assert.equal(b2.archived_at, null);
  const t1 = (await call('POST', `/api/boards/${b2.id}/tasks`, { title: 'one', x: 0, y: 0 })).data;
  const t2 = (await call('POST', `/api/boards/${b2.id}/tasks`, { title: 'two', x: 300, y: 0 })).data;
  await call('POST', `/api/boards/${b2.id}/deps`, { from: t1.id, to: t2.id });
  let o = (await call('GET', '/api/overview')).data.boards.find((x) => x.id === b2.id);
  assert.equal(o.total, 2); assert.equal(o.tasks.length, 2); assert.deepEqual(o.deps, [{ from: t1.id, to: t2.id, from_side: 'right', to_side: 'left', label: null }]); assert.equal(o.tasks[0].title, 'one');
  assert.equal(o.tasks[0].cover, false); assert.ok(o.updated_at); console.log('ok overview lists tasks, links, counts');
  r = await call('PATCH', `/api/boards/${b2.id}`, { archived: 'yes' }); assert.equal(r.status, 400); console.log('ok archived must be boolean');
  r = await call('PATCH', `/api/boards/${b2.id}`, { archived: true }); assert.equal(r.status, 200); assert.ok(r.data.archived_at); assert.equal(r.data.total, 2); console.log('ok archive sets archived_at');
  const stamp = r.data.archived_at;
  r = await call('PATCH', `/api/boards/${b2.id}`, { archived: true }); assert.equal(r.data.archived_at, stamp); console.log('ok archiving again keeps the date');
  assert.ok((await call('GET', '/api/boards')).data.find((x) => x.id === b2.id).archived_at); console.log('ok GET boards shows archived_at');
  r = await call('PATCH', `/api/boards/${b2.id}`, { home_x: 120, home_y: 'top' }); assert.equal(r.status, 400); console.log('ok home spot must be two numbers');
  r = await call('PATCH', `/api/boards/${b2.id}`, { home_x: 120, home_y: 340 }); assert.equal(r.data.home_x, 120); assert.equal(r.data.home_y, 340); console.log('ok home spot saved');
  r = await call('PATCH', `/api/boards/${b2.id}`, { home_x: null, home_y: null }); assert.equal(r.data.home_x, null); console.log('ok home spot cleared');
  r = await call('PATCH', `/api/boards/${b2.id}`, { name: 'archive-test-2', archived: false }); assert.equal(r.data.archived_at, null); assert.equal(r.data.name, 'archive-test-2'); console.log('ok unarchive + rename in one PATCH');
  await call('DELETE', `/api/tasks/${t2.id}`);
  o = (await call('GET', '/api/overview')).data.boards.find((x) => x.id === b2.id);
  assert.equal(o.tasks.length, 1); assert.equal(o.deps.length, 0); console.log('ok overview hides trashed tasks and their links');
  await call('DELETE', `/api/boards/${b2.id}`);
  assert.equal((await call('GET', '/api/overview')).data.boards.some((x) => x.id === b2.id), false); console.log('ok deleted board gone from overview');
}

// --- modes: what a board is for (tasks, ideas, plan, flow), and the words on an arrow
{
  const made = [];
  const mkBoard = async (body) => { const x = await call('POST', '/api/boards', body); if (x.status === 201) made.push(x.data.id); return x; };
  r = await mkBoard({ name: 'mode-default' }); assert.equal(r.data.mode, 'tasks'); console.log('ok a new board is a tasks board unless told otherwise');
  r = await mkBoard({ name: 'mode-bad', mode: 'kanban' }); assert.equal(r.status, 400); assert.match(r.data.error, /tasks, ideas, plan or flow/); console.log('ok unknown mode refused:', r.data.error);
  const flow = (await mkBoard({ name: 'mode-flow', mode: 'flow' })).data; assert.equal(flow.mode, 'flow');
  assert.equal((await call('GET', `/api/boards/${flow.id}`)).data.board.mode, 'flow');
  assert.equal((await call('GET', '/api/boards')).data.find((x) => x.id === flow.id).mode, 'flow');
  assert.equal((await call('GET', '/api/overview')).data.boards.find((x) => x.id === flow.id).mode, 'flow'); console.log('ok the mode is on the board, the board list and the overview');
  const card = async (title, x) => (await call('POST', `/api/boards/${flow.id}/tasks`, { title, x, y: 0 })).data;
  const S = await card('Pay', 0), Q = await card('Did it go through?', 300), R = await card('Try again', 600);
  const link = (body) => call('POST', `/api/boards/${flow.id}/deps`, body);

  // labels
  r = await link({ from: S.id, to: Q.id }); assert.equal(r.data.label, null);
  r = await link({ from: Q.id, to: R.id, label: '  No,   again ' }); assert.equal(r.status, 201); assert.equal(r.data.label, 'No, again'); console.log('ok a link can be made with a label (trimmed, spaces squeezed)');
  r = await link({ from: R.id, to: S.id, label: 'x'.repeat(41) }); assert.equal(r.status, 400); assert.match(r.data.error, /too long/);
  r = await link({ from: R.id, to: S.id, label: 7 }); assert.equal(r.status, 400); console.log('ok a label must be a string of at most 40 characters');
  r = await call('PATCH', `/api/deps/${S.id}/${Q.id}`, { label: 'then' }); assert.deepEqual(r.data, { from: S.id, to: Q.id, from_side: 'right', to_side: 'left', label: 'then' });
  r = await call('PATCH', `/api/deps/${S.id}/${Q.id}`, { to_side: 'top' }); assert.equal(r.data.label, 'then'); assert.equal(r.data.to_side, 'top'); console.log('ok PATCH label keeps the sides, PATCH a side keeps the label');
  r = await call('PATCH', `/api/deps/${S.id}/${Q.id}`, { label: '   ' }); assert.equal(r.data.label, null);
  await call('PATCH', `/api/deps/${S.id}/${Q.id}`, { label: 'then' });
  r = await call('PATCH', `/api/deps/${S.id}/${Q.id}`, { label: null }); assert.equal(r.data.label, null); console.log('ok an empty label or null takes the words off');
  assert.equal((await call('GET', `/api/boards/${flow.id}`)).data.deps.find((d) => d.from === Q.id).label, 'No, again'); console.log('ok GET board returns the labels');

  // loops: fine in a workflow and in a pile of ideas, never in tasks or an outline
  r = await link({ from: R.id, to: Q.id, label: 'retry' }); assert.equal(r.status, 201); console.log('ok a workflow may loop back');
  r = await call('PATCH', `/api/boards/${flow.id}`, { mode: 'nope' }); assert.equal(r.status, 400);
  r = await call('PATCH', `/api/boards/${flow.id}`, { mode: 'tasks', name: 'renamed-too-early' });
  assert.equal(r.status, 409); assert.match(r.data.error, /Tasks cannot have a loop/); assert.match(r.data.error, /Did it go through\?/); assert.match(r.data.error, /Try again/);
  assert.equal(r.data.loop[0], r.data.loop.at(-1)); assert.deepEqual([...new Set(r.data.loop)].sort(), [Q.id, R.id].sort());
  r = (await call('GET', `/api/boards/${flow.id}`)).data.board; assert.equal(r.mode, 'flow'); assert.equal(r.name, 'mode-flow'); console.log('ok a looping board cannot become a tasks board; nothing was saved, and the answer names the loop');
  r = await call('PATCH', `/api/boards/${flow.id}`, { mode: 'plan' }); assert.equal(r.status, 409); assert.match(r.data.error, /Planning cannot have a loop/); console.log('ok ...nor an outline');
  r = await call('PATCH', `/api/boards/${flow.id}`, { mode: 'ideas' }); assert.equal(r.status, 200); assert.equal(r.data.mode, 'ideas'); assert.equal(r.data.total, 3); console.log('ok workflow -> ideas keeps the loop');
  // ideas: a tick is not blocked by anything
  r = await call('PATCH', `/api/tasks/${Q.id}`, { status: 'done' }); assert.equal(r.status, 200); assert.equal(r.data.status, 'done'); console.log('ok on an ideas board a card can be ticked whatever links into it');
  await call('PATCH', `/api/tasks/${Q.id}`, { status: 'todo' });
  // a deleted card comes back with all its links on a board that may loop
  await call('DELETE', `/api/tasks/${Q.id}`);
  r = await call('POST', `/api/tasks/${Q.id}/restore`); assert.equal(r.data.deps.length, 3); assert.equal(r.data.deps.find((d) => d.from === R.id).label, 'retry'); console.log('ok restore keeps every link (and its label) where loops are allowed');
  // without the loop the board can be an outline, then a to-do board, and the rules of each apply at once
  await call('DELETE', `/api/deps/${R.id}/${Q.id}`);
  r = await call('PATCH', `/api/boards/${flow.id}`, { mode: 'plan' }); assert.equal(r.data.mode, 'plan');
  r = await link({ from: R.id, to: S.id }); assert.equal(r.status, 409); console.log('ok an outline refuses a loop');
  r = await call('PATCH', `/api/tasks/${R.id}`, { status: 'done' }); assert.equal(r.status, 200); await call('PATCH', `/api/tasks/${R.id}`, { status: 'todo' }); console.log('ok nothing is blocked in an outline either');
  r = await call('PATCH', `/api/boards/${flow.id}`, { mode: 'tasks' }); assert.equal(r.data.mode, 'tasks');
  r = await call('PATCH', `/api/tasks/${R.id}`, { status: 'done' }); assert.equal(r.status, 409); assert.match(r.data.error, /blocked by 1/);
  r = await call('PATCH', `/api/tasks/${R.id}`, { status: 'done', force: true }); assert.equal(r.status, 200);
  r = await link({ from: R.id, to: S.id }); assert.equal(r.status, 409); console.log('ok switched to tasks: blockers and the no-loop rule are back');
  assert.equal((await call('GET', `/api/boards/${flow.id}`)).data.deps.find((d) => d.from === Q.id).label, 'No, again'); console.log('ok labels survive every mode switch');
  for (const id of made) await call('DELETE', `/api/boards/${id}`);
}
console.log('API TESTS PASSED');
