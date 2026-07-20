'use strict';

const assert = require('assert');
const evaluation = require('../src/shared/separationEvaluation');

const parsed = evaluation.parseTimedTranscript([
  '[00:00:00 --> 00:00:02] 話者A: こんにちは',
  '[00:00:01 --> 00:00:03] 話者B： はい',
  '[00:00:04 --> 00:00:05] 話者A: ではまた',
  '[壊れた行]',
  '[00:00:06 --> 00:00:07] 話者なし',
].join('\n'));
assert.strictEqual(parsed.segments.length, 3);
assert.strictEqual(parsed.warnings.length, 2);

const built = evaluation.buildCasesFromSegments('fixture', parsed.segments);
assert.strictEqual(built.cases.length, 1);
assert.strictEqual(built.cases[0].start, 0);
assert.strictEqual(built.cases[0].end, 3);
assert.strictEqual(built.cases[0].overlapStart, 1);
assert.strictEqual(built.cases[0].overlapEnd, 2);
assert.deepStrictEqual(built.cases[0].references.map((row) => row.speaker), ['話者A', '話者B']);

const manifest = {
  schemaVersion: evaluation.SCHEMA_VERSION,
  dataset: {
    name: 'fixture', language: 'ja-JP', license: 'test', consent: 'test', annotationStatus: 'gold',
  },
  recordings: [{ id: 'fixture', audio: 'fixture.wav', cases: built.cases }],
};
assert.deepStrictEqual(evaluation.validateManifest(manifest), { errors: [], warnings: [] });

const pit = evaluation.permutationInvariantCer(['あいう', 'かき'], ['かき', 'あいえ']);
assert.deepStrictEqual(pit.assignment, [1, 0]);
assert.strictEqual(pit.distance, 1);
assert.strictEqual(pit.referenceLength, 5);
assert.strictEqual(pit.cer, 0.2);

const mixture = evaluation.concatenatedPermutationCer(['あいう', 'かき'], 'かきあいう');
assert.strictEqual(mixture.distance, 0);
assert.strictEqual(mixture.cer, 0);

const coverage = evaluation.characterCoverage(['あいう', 'かき'], ['あいうか']);
assert.deepStrictEqual({
  referenceChars: coverage.referenceChars,
  hypothesisChars: coverage.hypothesisChars,
  matched: coverage.matched,
  omissions: coverage.omissions,
  additions: coverage.additions,
}, { referenceChars: 5, hypothesisChars: 4, matched: 4, omissions: 1, additions: 0 });

const summary = evaluation.summarizeCaseResults([{
  durationSeconds: 2,
  mixture: { distance: 3 },
  separated: { distance: 1, referenceLength: 5 },
  baselineCoverage: evaluation.characterCoverage(['あいう', 'かき'], ['あい']),
  applicationCoverage: evaluation.characterCoverage(['あいう', 'かき'], ['あいうか']),
  gate: { accepted: true },
  timing: { separationMs: 1000, asrMs: 500 },
}]);
assert.strictEqual(summary.mixtureCer, 0.6);
assert.strictEqual(summary.separatedPitCer, 0.2);
assert.strictEqual(summary.cerDelta, 0.4);
assert.strictEqual(summary.recoveredMatchedChars, 2);
assert.strictEqual(summary.addedHypothesisChars, 2);
assert.strictEqual(summary.recoveryPrecision, 1);
assert.strictEqual(summary.separationRtf, 0.5);

console.log('separation evaluation tests: OK');
