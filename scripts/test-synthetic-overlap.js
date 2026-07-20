'use strict';

const assert = require('assert');
const synthetic = require('../src/shared/syntheticOverlap');

const clean = synthetic.selectCleanSegments([
  { id: 'a1', speaker: 'a', start: 0, end: 1, text: 'こんにちは' },
  { id: 'b1', speaker: 'b', start: 2, end: 3, text: 'お願いします' },
  { id: 'a2', speaker: 'a', start: 4, end: 6, text: '重なります' },
  { id: 'b2', speaker: 'b', start: 5, end: 7, text: '同時発話です' },
  { id: 'a3', speaker: 'a', start: 8, end: 9, text: '短すぎない' },
  { id: 'b3', speaker: 'b', start: 10, end: 11, text: '別の発話' },
], { guardSeconds: 0.1 });
assert.deepStrictEqual(clean.map((item) => item.id), ['a1', 'b1', 'a3', 'b3']);

const sources = [];
for (let i = 0; i < 6; i++) {
  sources.push({ id: `a${i}`, speaker: 'a', start: i, end: i + 1, text: `発話a${i}` });
  sources.push({ id: `b${i}`, speaker: 'b', start: i + 20, end: i + 21, text: `発話b${i}` });
}
const plansA = synthetic.buildMixPlans(sources, 8, { seed: 42 });
const plansB = synthetic.buildMixPlans(sources, 8, { seed: 42 });
assert.deepStrictEqual(plansA.map((plan) => [plan.sourceA.id, plan.sourceB.id]),
  plansB.map((plan) => [plan.sourceA.id, plan.sourceB.id]));
assert(plansA.every((plan) => plan.sourceA.speaker !== plan.sourceB.speaker));
assert.deepStrictEqual(plansA.slice(0, 3).map((plan) => plan.snrDb), [-6, 0, 6]);

const samples = synthetic.SAMPLE_RATE;
const sourceA = Float32Array.from({ length: samples * 2 }, (_, i) => Math.sin(i / 13) * 0.2);
const sourceB = Float32Array.from({ length: samples }, (_, i) => Math.sin(i / 19) * 0.15);
const mixed = synthetic.mixSources(sourceA, sourceB, {
  snrDb: 0, overlapRatio: 0.5, lead: 'a', targetRms: 0.1,
});
assert(Math.abs(mixed.overlapRatio - 0.5) < 1 / samples);
assert.strictEqual(mixed.overlapStart, 1.5);
assert.strictEqual(mixed.overlapEnd, 2);
assert.strictEqual(mixed.duration, 2.5);
let peak = 0;
for (let i = 0; i < mixed.mixture.length; i++) {
  assert(Math.abs(mixed.mixture[i] - mixed.stems[0][i] - mixed.stems[1][i]) < 1e-6);
  peak = Math.max(peak, Math.abs(mixed.mixture[i]));
}
assert(peak <= 0.980001);

console.log('synthetic overlap tests: OK');
