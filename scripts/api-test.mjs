// API test for link sides. Run against a LOCAL server on a throwaway database:
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
await call('DELETE', `/api/boards/${board.id}`);
console.log('API TESTS PASSED');
