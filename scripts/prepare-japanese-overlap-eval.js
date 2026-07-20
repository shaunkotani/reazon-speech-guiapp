'use strict';

const fs = require('fs');
const path = require('path');
const evaluation = require('../src/shared/separationEvaluation');

function argsFrom(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const value = argv[i];
    if (!value.startsWith('--')) continue;
    const key = value.slice(2);
    const next = argv[i + 1];
    if (!next || next.startsWith('--')) out[key] = true;
    else { out[key] = next; i++; }
  }
  return out;
}

function safeId(value) {
  return String(value || 'recording')
    .normalize('NFKC')
    .replace(/[^\p{L}\p{N}_-]+/gu, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80) || 'recording';
}

function usage() {
  console.log([
    '日本語・重なり音声評価マニフェストを時刻つき話者別文字起こしから作成します。',
    '',
    '必須:',
    '  --audio <音声> --transcript <txt> --output <json>',
    '',
    '任意:',
    '  --name <データセット名>          既定: Japanese overlap local evaluation',
    '  --recording-id <ID>              既定: 音声ファイル名',
    '  --license <権利条件>             既定: local-evaluation-only',
    '  --consent <同意状態>             既定: unverified',
    '  --annotation-status <状態>        provisional / reviewed / gold',
    '  --max-cases <件数>',
    '  --max-case-duration <秒>          既定: 10',
  ].join('\n'));
}

function main() {
  const args = argsFrom(process.argv.slice(2));
  if (args.help) { usage(); return; }
  if (!args.audio || !args.transcript || !args.output) {
    usage();
    throw new Error('--audio、--transcript、--output は必須です');
  }
  const audioPath = path.resolve(args.audio);
  const transcriptPath = path.resolve(args.transcript);
  const outputPath = path.resolve(args.output);
  if (!fs.existsSync(audioPath)) throw new Error(`音声がありません: ${audioPath}`);
  if (!fs.existsSync(transcriptPath)) throw new Error(`文字起こしがありません: ${transcriptPath}`);
  const parsed = evaluation.parseTimedTranscript(fs.readFileSync(transcriptPath, 'utf8'));
  const recordingId = safeId(args['recording-id'] || path.parse(audioPath).name);
  const built = evaluation.buildCasesFromSegments(recordingId, parsed.segments, {
    maxCases: args['max-cases'],
    maxCaseDuration: args['max-case-duration'],
  });
  const manifest = {
    schemaVersion: evaluation.SCHEMA_VERSION,
    dataset: {
      name: String(args.name || 'Japanese overlap local evaluation'),
      language: 'ja-JP',
      license: String(args.license || 'local-evaluation-only'),
      consent: String(args.consent || 'unverified'),
      annotationStatus: String(args['annotation-status'] || 'provisional'),
      purpose: 'speech-separation-evaluation',
    },
    recordings: [{
      id: recordingId,
      audio: path.relative(path.dirname(outputPath), audioPath).replace(/\\/g, '/'),
      sourceTranscript: path.relative(path.dirname(outputPath), transcriptPath).replace(/\\/g, '/'),
      cases: built.cases,
    }],
    preparation: {
      generatedAt: new Date().toISOString(),
      parser: 'timed-speaker-transcript-v1',
      sourceSegments: parsed.segments.length,
      detectedOverlapIntervals: built.overlapIntervals.length,
      generatedCases: built.cases.length,
      skipped: built.skipped,
      warnings: parsed.warnings,
    },
  };
  const validation = evaluation.validateManifest(manifest);
  if (validation.errors.length) throw new Error(validation.errors.join('\n'));
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, `${JSON.stringify(manifest, null, 2)}\n`);
  console.log(JSON.stringify({
    output: outputPath,
    cases: built.cases.length,
    skipped: built.skipped.length,
    parseWarnings: parsed.warnings.length,
    validationWarnings: validation.warnings,
  }, null, 2));
}

try { main(); }
catch (error) {
  console.error(error.message || String(error));
  process.exitCode = 1;
}
