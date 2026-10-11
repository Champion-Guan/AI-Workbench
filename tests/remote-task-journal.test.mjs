import test from 'node:test';
import assert from 'node:assert/strict';
import { createActivityFixture } from './helpers/frontend-activity.mjs';
import { journalFixture } from './helpers/remote-task-journal.mjs';

const hash = 'a'.repeat(64);
test('lost create response survives cold realm and cannot be retired by unrelated known task', () => {
  const first = createActivityFixture(), f = journalFixture(first.registry);
  const request = f.journal.begin(); assert.match(request, /^[a-f0-9]{64}$/);
  assert.equal(first.registry.snapshot().canvas, 1);
  const cold = createActivityFixture(), restored = journalFixture(cold.registry, { rows: f.rows }); restored.journal.restore();
  assert.equal(cold.registry.snapshot().canvas, 1); assert.equal(restored.journal.terminal(hash), true);
  assert.equal(cold.registry.snapshot().canvas, 1); assert.equal(f.rows.size, 1);
  assert.deepEqual([...f.rows.values()], ['{"format":1,"taskKey":null}']);
});
test('confirmed terminal removes only matching account/task rows and cold observers converge', () => {
  const r = createActivityFixture().registry, f = journalFixture(r);
  const one = f.journal.begin(), two = f.journal.begin(); f.journal.bind(one, hash); f.journal.bind(two, 'b'.repeat(64));
  const cold = createActivityFixture().registry, other = journalFixture(cold, { rows: f.rows }); other.journal.restore();
  assert.equal(cold.snapshot().canvas, 2); f.journal.terminal(hash); other.journal.restore();
  assert.equal(r.snapshot().canvas, 1); assert.equal(cold.snapshot().canvas, 1);
  other.journal.terminal('b'.repeat(64)); f.journal.restore(); assert.equal(r.snapshot().canvas, 0);
});
test('separate intent keys preserve two-page requests without shared array lost updates', () => {
  const r = createActivityFixture().registry, rows = new Map(), one = journalFixture(r, { rows }), two = journalFixture(r, { rows });
  const first = one.journal.begin(); one.journal.bind(first, hash);
  // Independent deterministic fixture uses same first UUID; collisions block
  // rather than overwrite another page's evidence.
  assert.throws(() => two.journal.begin(), /安全记录/); assert.equal(rows.size, 1); assert.match([...rows.values()][0], new RegExp(hash));
});
test('storage quota/unavailability blocks dispatch and never overwrites business keys', () => {
  const r = createActivityFixture().registry, rows = new Map([['canvas', 'original business data']]);
  const f = journalFixture(r, { rows }); const normal = f.storage.setItem;
  f.storage.setItem = () => { throw Error('quota'); };
  assert.throws(() => f.journal.begin(), /安全记录/); assert.equal(rows.get('canvas'), 'original business data'); assert.equal(r.snapshot().canvas, 1);
  f.storage.setItem = normal;
  assert.throws(() => f.journal.begin(), /安全记录/, 'unknown storage failure does not disappear on a later unrelated write');
});
test('failed bind, damaged records and capacity retain bounded blockers without deleting evidence', () => {
  const r = createActivityFixture().registry, f = journalFixture(r, { maximum: 1 });
  const id = f.journal.begin(); assert.throws(() => f.journal.begin(), /安全记录/); assert.equal(f.rows.size, 1);
  f.journal.bind(id, hash); const key = [...f.rows.keys()][0]; f.rows.set(key, '{broken');
  assert.equal(f.journal.terminal(hash), false); assert.equal(f.rows.get(key), '{broken');
  for (let i = 0; i < 20; i++) f.journal.restore(); assert.equal(r.snapshot().canvas, 2, 'one row blocker and one permanent uncertainty blocker');
});
test('failed removal retains active row until explicit successful terminal retry', () => {
  const r = createActivityFixture().registry, f = journalFixture(r), id = f.journal.begin(); f.journal.bind(id, hash);
  const remove = f.storage.removeItem; f.storage.removeItem = () => { throw Error('storage unavailable'); };
  assert.equal(f.journal.terminal(hash), false); assert.equal(f.rows.size, 1); assert.equal(r.snapshot().canvas, 2);
  f.storage.removeItem = remove; assert.equal(f.journal.terminal(hash), true); assert.equal(f.rows.size, 0);
  assert.equal(r.snapshot().canvas, 1, 'storage uncertainty requires separate reconciliation; known terminal alone cannot erase it');
});
