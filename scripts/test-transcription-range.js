const assert = require('assert');
const rangeTools = require('../src/shared/transcriptionRange');

const atStart = rangeTools.buildDecodeWindow({ startSeconds: 0, durationSeconds: 60 });
assert.deepStrictEqual(atStart, {
  startSeconds: 0,
  durationSeconds: 60,
  contextSeconds: 1.5,
  decodeStartSeconds: 0,
  decodeDurationSeconds: 61.5,
  selectionStartSeconds: 0,
  selectionEndSeconds: 60,
});

const middle = rangeTools.buildDecodeWindow({ startSeconds: 120, durationSeconds: 60 });
assert.strictEqual(middle.decodeStartSeconds, 118.5);
assert.strictEqual(middle.decodeDurationSeconds, 63);
assert.strictEqual(middle.selectionStartSeconds, 1.5);
assert.strictEqual(middle.selectionEndSeconds, 61.5);

assert.deepStrictEqual(
  rangeTools.normalizeTrialRange({ startSeconds: -5, durationSeconds: 999, contextSeconds: 9 }),
  { startSeconds: 0, durationSeconds: 180, contextSeconds: 3 },
);
assert.strictEqual(rangeTools.normalizeTrialRange({ durationSeconds: 1 }).durationSeconds, 10);

const selected = rangeTools.selectSegments([
  { start: 0, end: 1, text: 'outside-before' },
  { start: 1, end: 2, text: 'touching-start' },
  { start: 1.8, end: 3, text: 'crossing-start' },
  { start: 3, end: 4, text: 'inside' },
  { start: 5, end: 6, text: 'touching-end' },
], 2, 5);
assert.deepStrictEqual(selected.map((s) => s.text), ['crossing-start', 'inside']);

assert.deepStrictEqual(
  rangeTools.offsetSegments([{ start: 1.5, end: 3, text: 'hello' }], 118.5),
  [{ start: 120, end: 121.5, text: 'hello' }],
);

console.log('transcription range tests: OK');
