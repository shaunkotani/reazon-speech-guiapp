'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { fork } = require('child_process');
const electronExec = require('electron');
const core = require('../src/core/asr');
const modelManager = require('../src/main/modelManager');
const separationTools = require('../src/shared/separation');
const evaluation = require('../src/shared/separationEvaluation');
const { centroid, l2normalize, cosineDistance } = require('../src/shared/cluster');

const ROOT = path.join(__dirname, '..');
let requestSequence = 0;

function argsFrom(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const value = argv[i];
    if (!value.startsWith('--')) continue;
    const key = value.slice(2);
    const next = argv[i + 1];
    const parsed = !next || next.startsWith('--') ? true : next;
    if (key === 'manifest') {
      if (!Array.isArray(out.manifest)) out.manifest = [];
      out.manifest.push(parsed);
    } else out[key] = parsed;
    if (parsed !== true) i++;
  }
  return out;
}

function usage() {
  console.log([
    '現在の話者分離モデルを日本語の重なり音声で評価します。',
    '',
    '  npm run eval:separation -- --manifest <json> [--manifest <json> ...]',
    '      [--output evaluation/results/current-convtasnet.json]',
    '      [--models models] [--max-cases 10]',
    '      [--separation-model <onnx> --model-id <ID> --model-name <表示名>]',
    '',
    'JSON と同じ場所へ、本文を含まない Markdown 集計も出力します。',
  ].join('\n'));
}

function sha256File(filePath) {
  const hash = crypto.createHash('sha256');
  const fd = fs.openSync(filePath, 'r');
  const buffer = Buffer.allocUnsafe(1024 * 1024);
  try {
    for (;;) {
      const bytes = fs.readSync(fd, buffer, 0, buffer.length, null);
      if (!bytes) break;
      hash.update(buffer.subarray(0, bytes));
    }
  } finally {
    fs.closeSync(fd);
  }
  return hash.digest('hex');
}

function spawnWorker(script, init) {
  const proc = fork(path.join(ROOT, 'src', 'main', script), [], {
    execPath: electronExec,
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
    stdio: ['ignore', 'inherit', 'inherit', 'ipc'],
  });
  const worker = { proc, pending: new Map(), ready: null };
  worker.ready = new Promise((resolve, reject) => {
    function onMessage(message) {
      if (message.type === 'ready') { proc.off('message', onMessage); resolve(); }
      if (message.type === 'initError') {
        proc.off('message', onMessage);
        reject(new Error(message.message));
      }
    }
    proc.on('message', onMessage);
  });
  proc.on('message', (message) => {
    const request = worker.pending.get(message.rid);
    if (!request || message.type !== 'response') return;
    worker.pending.delete(message.rid);
    if (message.error) request.reject(new Error(message.error));
    else request.resolve(message.result);
  });
  proc.on('exit', (code, signal) => {
    const error = new Error(`ワーカーが終了しました (${code == null ? signal : code})`);
    for (const request of worker.pending.values()) request.reject(error);
    worker.pending.clear();
  });
  proc.send({ type: 'init', ...init });
  return worker;
}

function rpc(worker, op, args) {
  const rid = ++requestSequence;
  return new Promise((resolve, reject) => {
    worker.pending.set(rid, { resolve, reject });
    worker.proc.send({ type: 'request', rid, op, args });
  });
}

function meanEmbedding(segments) {
  const values = (Array.isArray(segments) ? segments : [])
    .map((segment) => segment.embedding)
    .filter((embedding) => Array.isArray(embedding) && embedding.length);
  return values.length ? Array.from(centroid(values)) : null;
}

function stemTexts(stems) {
  return [0, 1].map((stemIndex) => {
    const stem = stems.find((item) => item.stemIndex === stemIndex);
    return (stem && Array.isArray(stem.segments) ? stem.segments : [])
      .map((segment) => segment.text || '').join('');
  });
}

function formatPercent(value) {
  return Number.isFinite(value) ? `${(value * 100).toFixed(1)}%` : '-';
}

function formatNumber(value, digits = 2) {
  return Number.isFinite(value) ? Number(value).toFixed(digits) : '-';
}

function markdownReport(report) {
  const summary = report.summary;
  const provisional = report.datasets.some((dataset) => !['gold', 'reviewed']
    .includes(String(dataset.annotationStatus || '').toLowerCase()));
  const lines = [
    '# 日本語・重なり音声分離 評価結果',
    '',
    `- 実行日時: ${report.generatedAt}`,
    `- 分離モデル: ${report.model.name} (${report.model.id})`,
    `- 評価ケース: ${summary.cases}件 / ${formatNumber(summary.audioSeconds, 1)}秒`,
    `- 参照文字: ${summary.referenceChars}文字`,
    `- アノテーション: ${provisional ? '暫定（方向性の判断のみ）' : 'reviewed / gold'}`,
    '',
    '## 集計',
    '',
    '| 指標 | 結果 |',
    '|---|---:|',
    `| 混合音声 cpCER | ${formatPercent(summary.mixtureCer)} |`,
    `| 分離後 PIT-CER | ${formatPercent(summary.separatedPitCer)} |`,
    `| CER改善（正なら改善） | ${formatPercent(summary.cerDelta)} |`,
    `| 分離前 文字カバレッジ | ${formatPercent(summary.baselineCoverage.recall)} |`,
    `| 品質ゲート後 文字カバレッジ | ${formatPercent(summary.applicationCoverage.recall)} |`,
    `| 回収できた一致文字 | ${summary.recoveredMatchedChars} |`,
    `| 新たに増えた不一致文字 | ${summary.newUnmatchedChars} |`,
    `| 追加文字の一致率 | ${formatPercent(summary.recoveryPrecision)} |`,
    `| 品質ゲート採用 | ${summary.gateAccepted}/${summary.cases} (${formatPercent(summary.gateAcceptanceRate)}) |`,
    `| 分離処理 RTF | ${formatNumber(summary.separationRtf, 3)} |`,
    '',
    'RTF 1.0 は、音声10秒の分離に10秒かかることを表します。cpCER は混合音声を話者参照の連結順入替で、PIT-CER は分離出力と話者参照の割当入替で比較しています。',
    '',
    '## データセット別',
    '',
    '| データセット | ケース | 混合cpCER | 分離PIT-CER | CER改善 | 追加文字一致率 |',
    '|---|---:|---:|---:|---:|---:|',
  ];
  report.byDataset.forEach((entry) => {
    lines.push(`| ${entry.dataset} | ${entry.summary.cases} | ${formatPercent(entry.summary.mixtureCer)} | ${formatPercent(entry.summary.separatedPitCer)} | ${formatPercent(entry.summary.cerDelta)} | ${formatPercent(entry.summary.recoveryPrecision)} |`);
  });
  if (report.cleanReferenceSummary && report.cleanReferenceSummary.cases) {
    const clean = report.cleanReferenceSummary;
    lines.push(
      '',
      '## 合成元の単独音声ASRを正解とした分離劣化',
      '',
      `単独音声で認識できた本文を疑似正解にするため、人手文字起こし誤差を含まず、${clean.cases}ケースで分離処理による劣化だけを比較します。`,
      '',
      '| 指標 | 結果 |',
      '|---|---:|',
      `| 混合音声 cpCER | ${formatPercent(clean.mixtureCer)} |`,
      `| 分離後 PIT-CER | ${formatPercent(clean.separatedPitCer)} |`,
      `| CER改善（正なら改善） | ${formatPercent(clean.cerDelta)} |`,
      `| 追加文字の一致率 | ${formatPercent(clean.recoveryPrecision)} |`,
      `| 対象外（単独ASRが空） | ${report.cleanReferenceSkipped} |`,
    );
    if (report.bySyntheticCondition.length) {
      lines.push(
        '',
        '| SNR | 重なり率 | ケース | 混合cpCER | 分離PIT-CER | CER改善 |',
        '|---:|---:|---:|---:|---:|---:|',
      );
      report.bySyntheticCondition.forEach((entry) => {
        lines.push(`| ${entry.snrDb}dB | ${formatPercent(entry.overlapRatio)} | ${entry.summary.cases} | ${formatPercent(entry.summary.mixtureCer)} | ${formatPercent(entry.summary.separatedPitCer)} | ${formatPercent(entry.summary.cerDelta)} |`);
      });
    }
  }
  lines.push(
    '',
    '## ケース別',
    '',
    '| ケース | 秒 | 混合cpCER | 分離PIT-CER | ゲート | 分離RTF |',
    '|---|---:|---:|---:|---|---:|',
  );
  report.cases.forEach((item) => {
    lines.push(`| ${item.id} | ${formatNumber(item.durationSeconds, 1)} | ${formatPercent(item.mixture.cer)} | ${formatPercent(item.separated.cer)} | ${item.gate.accepted ? `採用 (${item.gate.additions})` : item.gate.reason} | ${formatNumber((item.timing.separationMs / 1000) / item.durationSeconds, 3)} |`);
  });
  lines.push('', '## 注意', '');
  if (provisional) lines.push('- 暫定文字起こしは語単位の時刻境界を持たないため、数値はモデル候補の比較と閾値調整にのみ使い、リリース可否の最終根拠にはしません。');
  lines.push('- 文字カバレッジは同時発話の順序に影響されない文字多重集合の補助指標で、CERの代替ではありません。');
  lines.push('- JSON 詳細には参照文と仮説文を含むため、外部共有前にデータ利用条件を確認してください。');
  return `${lines.join('\n')}\n`;
}

function loadManifests(manifestPaths) {
  const recordings = [];
  const datasets = [];
  const warnings = [];
  for (const rawPath of manifestPaths) {
    const manifestPath = path.resolve(String(rawPath));
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    const validation = evaluation.validateManifest(manifest);
    if (validation.errors.length) {
      throw new Error(`${manifestPath}\n${validation.errors.join('\n')}`);
    }
    warnings.push(...validation.warnings.map((warning) => `${path.basename(manifestPath)}: ${warning}`));
    datasets.push({
      name: manifest.dataset.name,
      language: manifest.dataset.language,
      license: manifest.dataset.license,
      consent: manifest.dataset.consent,
      annotationStatus: manifest.dataset.annotationStatus,
      manifest: manifestPath,
    });
    manifest.recordings.forEach((recording) => recordings.push({
      ...recording,
      manifestPath,
      audioPath: path.resolve(path.dirname(manifestPath), recording.audio),
      dataset: manifest.dataset.name,
    }));
  }
  return { recordings, datasets, warnings };
}

async function evaluateCase({ recording, item, caseIndex, tempDir, separator, asr }) {
  if (!fs.existsSync(recording.audioPath)) throw new Error(`音声がありません: ${recording.audioPath}`);
  const duration = Number(item.end) - Number(item.start);
  const decodeStarted = Date.now();
  const samples = await core.decodeToPcm(recording.audioPath, {
    startSeconds: Number(item.start),
    maxSeconds: duration,
  });
  const actualDuration = samples.length / core.SAMPLE_RATE;
  const pcmPath = path.join(tempDir, `case-${caseIndex}.pcm`);
  core.writePcmRaw(samples, pcmPath);
  const window = {
    index: caseIndex,
    start: 0,
    end: actualDuration,
    overlapStart: Math.max(0, Number(item.overlapStart) - Number(item.start)),
    overlapEnd: Math.min(actualDuration, Number(item.overlapEnd) - Number(item.start)),
  };

  const separationStarted = Date.now();
  const separatedValues = await rpc(separator, 'separateBatch', {
    pcmPath,
    outputDir: tempDir,
    windows: [window],
  });
  const separationMs = Date.now() - separationStarted;
  const separated = separatedValues[0];
  const files = separated.files.map((file) => ({
    windowIndex: caseIndex,
    stemIndex: file.stemIndex,
    pcmPath: file.pcmPath,
    windowStart: 0,
  }));

  const asrStarted = Date.now();
  const baselineRows = await rpc(asr, 'processBatch', {
    pcmPath,
    wantEmbedding: false,
    items: [{ idx: caseIndex, start: 0, end: actualDuration }],
  });
  const baselineText = String(baselineRows[0] && baselineRows[0].text || '');
  const mixtureCoreRows = await rpc(asr, 'processSeparatedBatch', {
    items: [{
      windowIndex: caseIndex,
      stemIndex: 0,
      pcmPath,
      windowStart: 0,
      overlapStart: window.overlapStart,
      overlapEnd: window.overlapEnd,
    }],
    vad: { threshold: 0.5, minSilenceDuration: 0.15, minSpeechDuration: 0.1, maxSpeechDuration: 4 },
  });
  const mixtureCoreText = stemTexts(mixtureCoreRows)[0];
  const fullStems = await rpc(asr, 'processSeparatedBatch', {
    items: files.map((file) => ({
      ...file,
      overlapStart: 0,
      overlapEnd: actualDuration,
    })),
    vad: { threshold: 0.5, minSilenceDuration: 0.15, minSpeechDuration: 0.1, maxSpeechDuration: 4 },
  });
  const coreStems = await rpc(asr, 'processSeparatedBatch', {
    items: files.map((file) => ({
      ...file,
      overlapStart: window.overlapStart,
      overlapEnd: window.overlapEnd,
    })),
    vad: { threshold: 0.5, minSilenceDuration: 0.15, minSpeechDuration: 0.1, maxSpeechDuration: 4 },
  });
  const asrMs = Date.now() - asrStarted;

  let cleanReferenceTexts = null;
  let cleanReferenceAsrMs = 0;
  if (item.references.every((reference) => String(reference.cleanAudio || '').trim())) {
    const cleanStarted = Date.now();
    cleanReferenceTexts = [];
    for (let referenceIndex = 0; referenceIndex < item.references.length; referenceIndex++) {
      const reference = item.references[referenceIndex];
      const cleanAudioPath = path.resolve(path.dirname(recording.manifestPath), reference.cleanAudio);
      if (!fs.existsSync(cleanAudioPath)) throw new Error(`合成元stemがありません: ${cleanAudioPath}`);
      const cleanSamples = await core.decodeToPcm(cleanAudioPath);
      const cleanPcmPath = path.join(tempDir, `case-${caseIndex}-clean-${referenceIndex}.pcm`);
      core.writePcmRaw(cleanSamples, cleanPcmPath);
      const cleanRows = await rpc(asr, 'processSeparatedBatch', {
        items: [{
          windowIndex: caseIndex,
          stemIndex: referenceIndex,
          pcmPath: cleanPcmPath,
          windowStart: 0,
          overlapStart: window.overlapStart,
          overlapEnd: Math.min(window.overlapEnd, cleanSamples.length / core.SAMPLE_RATE),
        }],
        vad: { threshold: 0.5, minSilenceDuration: 0.15, minSpeechDuration: 0.1, maxSpeechDuration: 4 },
      });
      cleanReferenceTexts.push(stemTexts(cleanRows)[referenceIndex]);
    }
    cleanReferenceAsrMs = Date.now() - cleanStarted;
  }

  const referenceTexts = item.references.map((reference) => reference.text);
  const separatedTexts = stemTexts(fullStems);
  const separatedCoreTexts = stemTexts(coreStems);
  const mixtureMetric = evaluation.concatenatedPermutationCer(referenceTexts, baselineText);
  const separatedMetric = evaluation.permutationInvariantCer(referenceTexts, separatedTexts);
  const gateStems = [0, 1].map((stemIndex) => {
    const stem = coreStems.find((value) => value.stemIndex === stemIndex) || { segments: [] };
    return { stemIndex, segments: stem.segments || [], embedding: meanEmbedding(stem.segments) };
  });
  const gateMetrics = { ...separated.metrics };
  if (gateStems[0].embedding && gateStems[1].embedding) {
    gateMetrics.embeddingDistance = cosineDistance(
      l2normalize(gateStems[0].embedding), l2normalize(gateStems[1].embedding),
    );
  }
  const gate = separationTools.selectSeparatedAdditions({
    window,
    stems: gateStems,
    metrics: gateMetrics,
    baselineSegments: [{ start: 0, end: actualDuration, text: baselineText }],
  });
  const applicationTexts = [baselineText, ...gate.additions.map((segment) => segment.text)];
  let cleanReference = null;
  if (cleanReferenceTexts) {
    const available = cleanReferenceTexts.every((text) => separationTools.normalizeText(text));
    cleanReference = {
      available,
      texts: cleanReferenceTexts,
      reason: available ? '' : 'empty-clean-source-asr',
    };
    if (available) {
      const coreApplicationTexts = [mixtureCoreText, ...gate.additions.map((segment) => segment.text)];
      cleanReference.mixture = evaluation.concatenatedPermutationCer(cleanReferenceTexts, mixtureCoreText);
      cleanReference.separated = evaluation.permutationInvariantCer(cleanReferenceTexts, separatedCoreTexts);
      cleanReference.baselineCoverage = evaluation.characterCoverage(cleanReferenceTexts, [mixtureCoreText]);
      cleanReference.applicationCoverage = evaluation.characterCoverage(cleanReferenceTexts, coreApplicationTexts);
    }
  }
  return {
    id: item.id,
    recordingId: recording.id,
    dataset: recording.dataset,
    annotationGranularity: item.annotationGranularity || 'unknown',
    synthetic: recording.synthetic || null,
    sourceStart: item.start,
    sourceEnd: item.end,
    overlapStart: item.overlapStart,
    overlapEnd: item.overlapEnd,
    durationSeconds: actualDuration,
    references: item.references.map((reference) => ({
      speaker: reference.speaker,
      text: reference.text,
      cleanAudio: reference.cleanAudio || null,
    })),
    hypotheses: {
      mixture: baselineText,
      mixtureCore: mixtureCoreText,
      separated: separatedTexts,
      separatedCore: separatedCoreTexts,
      applicationAdditions: gate.additions.map((segment) => segment.text),
    },
    mixture: mixtureMetric,
    separated: separatedMetric,
    baselineCoverage: evaluation.characterCoverage(referenceTexts, [baselineText]),
    applicationCoverage: evaluation.characterCoverage(referenceTexts, applicationTexts),
    cleanReference,
    gate: {
      accepted: gate.accepted,
      reason: gate.reason,
      additions: gate.additions.length,
      sourceShares: gateMetrics.sourceShares,
      stemCorrelation: gateMetrics.stemCorrelation,
      embeddingDistance: gateMetrics.embeddingDistance == null ? null : gateMetrics.embeddingDistance,
    },
    timing: {
      decodeMs: Date.now() - decodeStarted - separationMs - asrMs,
      separationMs,
      asrMs,
      cleanReferenceAsrMs,
      totalMs: Date.now() - decodeStarted,
    },
  };
}

function mapCleanReferenceResults(results) {
  return results.filter((item) => item.cleanReference && item.cleanReference.available)
    .map((item) => ({
      ...item,
      mixture: item.cleanReference.mixture,
      separated: item.cleanReference.separated,
      baselineCoverage: item.cleanReference.baselineCoverage,
      applicationCoverage: item.cleanReference.applicationCoverage,
    }));
}

async function main() {
  const args = argsFrom(process.argv.slice(2));
  if (args.help) { usage(); return; }
  if (!Array.isArray(args.manifest) || !args.manifest.length) {
    usage();
    throw new Error('--manifest は1つ以上必要です');
  }
  const outputPath = path.resolve(String(args.output
    || path.join(ROOT, 'evaluation', 'results', 'current-convtasnet.json')));
  const modelsRoot = path.resolve(String(args.models || path.join(ROOT, 'models')));
  const modelPaths = modelManager.pathsFor(modelsRoot);
  const defaultSeparationModelPath = modelManager.separationPathsFor(modelsRoot).modelPath;
  const separationModelPath = path.resolve(String(args['separation-model'] || defaultSeparationModelPath));
  const required = [modelPaths.modelDir, modelPaths.vadPath, modelPaths.embPath, separationModelPath];
  required.forEach((target) => {
    if (!fs.existsSync(target)) throw new Error(`評価用モデルがありません: ${target}`);
  });
  const usingDefaultModel = separationModelPath === path.resolve(defaultSeparationModelPath);
  const modelInfo = usingDefaultModel ? modelManager.SEPARATION_MODEL : {
    id: String(args['model-id'] || path.parse(separationModelPath).name),
    name: String(args['model-name'] || path.basename(separationModelPath)),
    filename: path.basename(separationModelPath),
    bytes: fs.statSync(separationModelPath).size,
    sha256: sha256File(separationModelPath),
    license: String(args['model-license'] || 'unverified'),
    sourceUrl: String(args['model-source'] || ''),
    sampleRate: 16000,
    speakers: 2,
    contract: '[1,T] -> [1,2,T]',
  };
  const loaded = loadManifests(args.manifest);
  const caseLimit = Number.isFinite(Number(args['max-cases']))
    ? Math.max(1, Math.floor(Number(args['max-cases']))) : Infinity;
  const caseQueue = loaded.recordings.flatMap((recording) =>
    recording.cases.map((item) => ({ recording, item }))).slice(0, caseLimit);
  if (!caseQueue.length) throw new Error('評価ケースがありません');

  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'reazonspeech-separation-eval-'));
  const separator = spawnWorker('separatorWorker.js', { modelPath: separationModelPath });
  const asr = spawnWorker('asrWorker.js', {
    ...modelPaths,
    denoiserPath: fs.existsSync(modelPaths.denoiserPath) ? modelPaths.denoiserPath : '',
  });
  const results = [];
  try {
    await Promise.all([separator.ready, asr.ready]);
    for (let index = 0; index < caseQueue.length; index++) {
      const entry = caseQueue[index];
      process.stdout.write(`[${index + 1}/${caseQueue.length}] ${entry.item.id} ... `);
      const result = await evaluateCase({
        ...entry,
        caseIndex: index,
        tempDir,
        separator,
        asr,
      });
      results.push(result);
      console.log(`混合 ${formatPercent(result.mixture.cer)} / 分離 ${formatPercent(result.separated.cer)} / ${result.timing.separationMs}ms`);
    }
  } finally {
    separator.proc.kill();
    asr.proc.kill();
    fs.rmSync(tempDir, { recursive: true, force: true });
  }

  const report = {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    model: modelInfo,
    asr: { id: 'reazonspeech-k2-v2-int8', decoding: 'greedy_search' },
    datasets: loaded.datasets,
    environment: {
      platform: process.platform,
      arch: process.arch,
      cpu: os.cpus()[0] ? os.cpus()[0].model : 'unknown',
      logicalCpus: os.cpus().length,
      node: process.versions.node,
      electron: process.versions.electron || require('electron/package.json').version,
      onnxruntimeNode: require('onnxruntime-node/package.json').version,
      sherpaOnnxNode: require('sherpa-onnx-node/package.json').version,
    },
    warnings: loaded.warnings,
    summary: evaluation.summarizeCaseResults(results),
    byDataset: [...new Set(results.map((item) => item.dataset))].map((dataset) => ({
      dataset,
      summary: evaluation.summarizeCaseResults(results.filter((item) => item.dataset === dataset)),
    })),
    cleanReferenceSummary: null,
    cleanReferenceSkipped: results.filter((item) => item.cleanReference
      && !item.cleanReference.available).length,
    bySyntheticCondition: [],
    cases: results,
  };
  const cleanResults = mapCleanReferenceResults(results);
  if (cleanResults.length) {
    report.cleanReferenceSummary = evaluation.summarizeCaseResults(cleanResults);
    const conditionKeys = [...new Set(cleanResults.filter((item) => item.synthetic)
      .map((item) => `${item.synthetic.snrDb}:${Number(item.synthetic.overlapRatio).toFixed(3)}`))];
    report.bySyntheticCondition = conditionKeys.map((key) => {
      const [snrDb, overlapRatio] = key.split(':').map(Number);
      const conditionResults = cleanResults.filter((item) => item.synthetic
        && Number(item.synthetic.snrDb) === snrDb
        && Number(item.synthetic.overlapRatio).toFixed(3) === overlapRatio.toFixed(3));
      return { snrDb, overlapRatio, summary: evaluation.summarizeCaseResults(conditionResults) };
    }).sort((a, b) => a.overlapRatio - b.overlapRatio || a.snrDb - b.snrDb);
  }
  const markdownPath = outputPath.replace(/\.json$/i, '') + '.md';
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, `${JSON.stringify(report, null, 2)}\n`);
  fs.writeFileSync(markdownPath, markdownReport(report));
  console.log(JSON.stringify({
    output: outputPath,
    report: markdownPath,
    warnings: report.warnings,
    summary: report.summary,
  }, null, 2));
}

main().catch((error) => {
  console.error(error.stack || error.message || String(error));
  process.exit(1);
});
