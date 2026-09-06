// API test: link sides, trash/restore, covers. Run against a LOCAL server on a throwaway database:
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
assert.equal(r.status, 201); assert.deepEqual(r.data, { from: A.id, to: Bt.id, from_side: 'right', to_side: 'left' }); console.log('ok default sides right→left');
r = await call('POST', `/api/boards/${board.id}/deps`, { from: A.id, to: C.id, from_side: 'bottom', to_side: 'top' });
assert.equal(r.status, 201); assert.deepEqual(r.data, { from: A.id, to: C.id, from_side: 'bottom', to_side: 'top' }); console.log('ok explicit sides bottom→top');
r = await call('POST', `/api/boards/${board.id}/deps`, { from: Bt.id, to: C.id, from_side: 'diagonal' });
assert.equal(r.status, 400); assert.match(r.data.error, /left, right, top or bottom/); console.log('ok bad side rejected:', r.data.error);
r = await call('POST', `/api/boards/${board.id}/deps`, { from: Bt.id, to: C.id, to_side: 42 });
assert.equal(r.status, 400); console.log('ok non-string side rejected');
r = await call('GET', `/api/boards/${board.id}`);
const deps = r.data.deps.sort((p, q) => p.to - q.to);
assert.deepEqual(deps, [{ from: A.id, to: Bt.id, from_side: 'right', to_side: 'left' }, { from: A.id, to: C.id, from_side: 'bottom', to_side: 'top' }]); console.log('ok GET board returns sides');
r = await call('PATCH', `/api/deps/${A.id}/${C.id}`, { to_side: 'right' });
assert.equal(r.status, 200); assert.deepEqual(r.data, { from: A.id, to: C.id, from_side: 'bottom', to_side: 'right' }); console.log('ok PATCH one side keeps the other');
r = await call('PATCH', `/api/deps/${A.id}/${C.id}`, { from_side: 'left', to_side: 'bottom' });
assert.deepEqual(r.data, { from: A.id, to: C.id, from_side: 'left', to_side: 'bottom' }); console.log('ok PATCH both sides');
r = await call('PATCH', `/api/deps/${A.id}/${C.id}`, { from_side: 'up' }); assert.equal(r.status, 400); console.log('ok PATCH bad side 400');
r = await call('PATCH', `/api/deps/${Bt.id}/${C.id}`, { from_side: 'top' }); assert.equal(r.status, 404); console.log('ok PATCH missing link 404');
r = await call('POST', `/api/boards/${board.id}/deps`, { from: A.id, to: Bt.id, from_side: 'top' });
assert.equal(r.status, 200); assert.deepEqual(r.data, { from: A.id, to: Bt.id, from_side: 'right', to_side: 'left', existed: true }); console.log('ok re-adding keeps stored sides, existed:true');
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
console.log('API TESTS PASSED');
