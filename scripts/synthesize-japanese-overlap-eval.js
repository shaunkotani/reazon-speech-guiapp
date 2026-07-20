'use strict';

const fs = require('fs');
const path = require('path');
const core = require('../src/core/asr');
const evaluation = require('../src/shared/separationEvaluation');
const synthetic = require('../src/shared/syntheticOverlap');

function argsFrom(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const value = argv[i];
    if (!value.startsWith('--')) continue;
    const equals = value.indexOf('=');
    if (equals > 2) {
      out[value.slice(2, equals)] = value.slice(equals + 1);
      continue;
    }
    const key = value.slice(2);
    const next = argv[i + 1];
    if (!next || next.startsWith('--')) out[key] = true;
    else { out[key] = next; i++; }
  }
  return out;
}

function listOfNumbers(value, fallback) {
  if (value == null || value === true) return fallback;
  const values = String(value).split(',').map(Number).filter(Number.isFinite);
  return values.length ? values : fallback;
}

function usage() {
  console.log([
    '非重なりの日本語発話を組み合わせ、条件制御した2話者重なり評価セットを作ります。',
    '',
    '必須:',
    '  --audio <音声> --transcript <話者別txt> --output-dir <ディレクトリ>',
    '',
    '任意:',
    '  --count <件数>                 既定: 48',
    '  --seed <整数>                  既定: 20260720',
    '  --snr <-6,0,6>                 話者Aを基準にしたdB',
    '  --overlap-ratios <.25,.5,.75,1>',
    '  --license <利用条件>           既定: local-evaluation-only',
    '  --consent <同意状態>           既定: inherited-unverified',
    '',
    '出力先が空でない場合は中断します。音声・manifestはローカル評価専用です。',
  ].join('\n'));
}

function ensureEmptyOutput(directory) {
  if (!fs.existsSync(directory)) {
    fs.mkdirSync(directory, { recursive: true });
    return;
  }
  if (fs.readdirSync(directory).length) throw new Error(`出力先が空ではありません: ${directory}`);
}

function relativeTo(baseFile, target) {
  return path.relative(path.dirname(baseFile), target).replace(/\\/g, '/');
}

async function main() {
  const args = argsFrom(process.argv.slice(2));
  if (args.help) { usage(); return; }
  if (!args.audio || !args.transcript || !args['output-dir']) {
    usage();
    throw new Error('--audio、--transcript、--output-dir は必須です');
  }
  const audioPath = path.resolve(String(args.audio));
  const transcriptPath = path.resolve(String(args.transcript));
  const outputDir = path.resolve(String(args['output-dir']));
  if (!fs.existsSync(audioPath)) throw new Error(`音声がありません: ${audioPath}`);
  if (!fs.existsSync(transcriptPath)) throw new Error(`文字起こしがありません: ${transcriptPath}`);
  const manifestPath = path.join(outputDir, 'manifest.json');
  const parsed = evaluation.parseTimedTranscript(fs.readFileSync(transcriptPath, 'utf8'));
  const clean = synthetic.selectCleanSegments(parsed.segments, {
    minDuration: Number(args['min-duration']) || 0.8,
    maxDuration: Number(args['max-duration']) || 6,
    minChars: Number(args['min-chars']) || 3,
    guardSeconds: Number(args.guard) || 0.12,
  });
  const count = Math.max(1, Math.floor(Number(args.count) || 48));
  const seed = Math.floor(Number(args.seed) || 20260720);
  const plans = synthetic.buildMixPlans(clean, count, {
    seed,
    snrDb: listOfNumbers(args.snr, [-6, 0, 6]),
    overlapRatios: listOfNumbers(args['overlap-ratios'], [0.25, 0.5, 0.75, 1]),
  });
  ensureEmptyOutput(outputDir);
  const audioDir = path.join(outputDir, 'audio');
  fs.mkdirSync(audioDir, { recursive: true });
  const decoded = new Map();
  async function samplesFor(source) {
    if (!decoded.has(source.id)) {
      decoded.set(source.id, await core.decodeToPcm(audioPath, {
        startSeconds: source.start,
        maxSeconds: source.end - source.start,
      }));
    }
    return decoded.get(source.id);
  }

  const recordings = [];
  for (let index = 0; index < plans.length; index++) {
    const plan = plans[index];
    process.stdout.write(`[${index + 1}/${plans.length}] ${plan.sourceA.id} + ${plan.sourceB.id} ... `);
    const mixed = synthetic.mixSources(
      await samplesFor(plan.sourceA),
      await samplesFor(plan.sourceB),
      plan,
    );
    const caseId = `synthetic-overlap-${String(index + 1).padStart(3, '0')}`;
    const mixPath = path.join(audioDir, `${caseId}-mix.wav`);
    const stemPaths = [
      path.join(audioDir, `${caseId}-stem-a.wav`),
      path.join(audioDir, `${caseId}-stem-b.wav`),
    ];
    core.writePcmToWav(mixed.mixture, mixPath);
    core.writePcmToWav(mixed.stems[0], stemPaths[0]);
    core.writePcmToWav(mixed.stems[1], stemPaths[1]);
    const sources = [plan.sourceA, plan.sourceB];
    recordings.push({
      id: caseId,
      audio: relativeTo(manifestPath, mixPath),
      synthetic: {
        snrDb: mixed.snrDb,
        overlapRatio: mixed.overlapRatio,
        lead: mixed.lead,
        sources: sources.map((source) => ({
          id: source.id,
          speaker: source.speaker,
          start: source.start,
          end: source.end,
        })),
      },
      cases: [{
        id: caseId,
        start: 0,
        end: mixed.duration,
        overlapStart: mixed.overlapStart,
        overlapEnd: mixed.overlapEnd,
        annotationGranularity: 'utterance',
        references: sources.map((source, stemIndex) => ({
          speaker: source.speaker,
          text: source.text,
          start: mixed.starts[stemIndex],
          end: mixed.ends[stemIndex],
          cleanAudio: relativeTo(manifestPath, stemPaths[stemIndex]),
          source: {
            audio: relativeTo(manifestPath, audioPath),
            start: source.start,
            end: source.end,
          },
        })),
      }],
    });
    console.log(`${mixed.duration.toFixed(2)}秒 / overlap ${(mixed.overlapRatio * 100).toFixed(0)}% / SNR ${mixed.snrDb}dB`);
  }

  const manifest = {
    schemaVersion: evaluation.SCHEMA_VERSION,
    dataset: {
      name: String(args.name || 'Japanese controlled synthetic overlap'),
      language: 'ja-JP',
      license: String(args.license || 'local-evaluation-only'),
      consent: String(args.consent || 'inherited-unverified'),
      annotationStatus: 'provisional',
      purpose: 'speech-separation-evaluation',
      referenceType: 'annotation-and-clean-source-asr',
    },
    recordings,
    synthesis: {
      generatedAt: new Date().toISOString(),
      sourceAudio: relativeTo(manifestPath, audioPath),
      sourceTranscript: relativeTo(manifestPath, transcriptPath),
      sourceSegments: parsed.segments.length,
      eligibleCleanSegments: clean.length,
      cases: recordings.length,
      seed,
      snrDb: [...new Set(plans.map((plan) => plan.snrDb))],
      overlapRatios: [...new Set(plans.map((plan) => plan.overlapRatio))],
      parseWarnings: parsed.warnings,
    },
  };
  const validation = evaluation.validateManifest(manifest);
  if (validation.errors.length) throw new Error(validation.errors.join('\n'));
  fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  console.log(JSON.stringify({
    manifest: manifestPath,
    cases: recordings.length,
    eligibleCleanSegments: clean.length,
    speakers: [...new Set(clean.map((segment) => segment.speaker))],
    warnings: validation.warnings,
  }, null, 2));
}

main().catch((error) => {
  console.error(error.stack || error.message || String(error));
  process.exit(1);
});
