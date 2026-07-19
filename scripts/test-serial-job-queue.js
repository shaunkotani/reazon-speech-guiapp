const assert = require('assert');
const SerialJobQueue = require('../src/main/serialJobQueue');

const deferred = () => {
  let resolve;
  const promise = new Promise((r) => { resolve = r; });
  return { promise, resolve };
};

(async () => {
  const queue = new SerialJobQueue();
  const firstGate = deferred();
  const order = [];
  const positions = new Map();
  const onPosition = (id) => (p) => positions.set(id, p);

  const first = queue.enqueue({
    id: 1, onPosition: onPosition(1),
    run: async () => { order.push('start-1'); await firstGate.promise; order.push('end-1'); return 'one'; },
  });
  const second = queue.enqueue({
    id: 2, onPosition: onPosition(2),
    run: async () => { order.push('start-2'); order.push('end-2'); return 'two'; },
  });
  const third = queue.enqueue({
    id: 3, onPosition: onPosition(3),
    run: async () => { order.push('start-3'); return 'three'; },
  });

  await Promise.resolve();
  assert.deepStrictEqual(positions.get(2), { position: 2, total: 3 });
  assert.deepStrictEqual(positions.get(3), { position: 3, total: 3 });
  assert.strictEqual(queue.activeId, 1);
  assert.strictEqual(queue.size, 3);

  assert.strictEqual(queue.cancelQueued(3), true);
  await assert.rejects(third, /中止/);
  assert.deepStrictEqual(positions.get(2), { position: 2, total: 2 });

  firstGate.resolve();
  assert.strictEqual(await first, 'one');
  assert.strictEqual(await second, 'two');
  assert.deepStrictEqual(order, ['start-1', 'end-1', 'start-2', 'end-2']);
  assert.strictEqual(queue.size, 0);
  assert.strictEqual(queue.activeId, null);
  console.log('serial job queue tests: OK');
})().catch((e) => { console.error(e); process.exit(1); });
