'use strict';

// 日本語の重なり音声評価で共用する、アノテーション変換・検証・集計。
// 推論ランタイムへ依存させず、データ整備と回帰テストの双方から利用する。

const autoTune = require('./autoTune');
const overlapTools = require('./overlap');

const SCHEMA_VERSION = 1;
const DEFAULT_MAX_CASE_DURATION = 10;

function parseClock(value) {
  const match = String(value || '').trim().match(/^(\d+):(\d{2}):(\d{2}(?:\.\d+)?)$/);
  if (!match) return null;
  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  const seconds = Number(match[3]);
  if (minutes >= 60 || seconds >= 60) return null;
  return hours * 3600 + minutes * 60 + seconds;
}

/** `[HH:MM:SS --> HH:MM:SS] 話者: 本文` 形式を読み込む。 */
function parseTimedTranscript(source) {
  const segments = [];
  const warnings = [];
  String(source || '').split(/\r?\n/).forEach((line, index) => {
    const value = line.trim();
    if (!value) return;
    const match = value.match(/^\[([^\]]+?)\s*-->\s*([^\]]+?)\]\s*(.+)$/);
    if (!match) {
      warnings.push(`行${index + 1}: 時刻形式を読み取れません`);
      return;
    }
    const start = parseClock(match[1]);
    const end = parseClock(match[2]);
    const body = match[3].trim();
    const speakerMatch = body.match(/^([^:：]{1,80})[:：]\s*(.+)$/);
    if (start == null || end == null || end <= start) {
      warnings.push(`行${index + 1}: 開始・終了時刻が不正です`);
      return;
    }
    if (!speakerMatch) {
      warnings.push(`行${index + 1}: 話者名が無いため重なり評価から除外します`);
      return;
    }
    const text = speakerMatch[2].trim();
    if (!autoTune.normalizeText(text)) {
      warnings.push(`行${index + 1}: 本文が空です`);
      return;
    }
    segments.push({
      id: `line-${index + 1}`,
      start,
      end,
      speaker: speakerMatch[1].trim(),
      text,
    });
  });
  return { segments, warnings };
}

function intersects(a, b) {
  return Math.min(Number(a.end), Number(b.end)) - Math.max(Number(a.start), Number(b.start)) > 0;
}

function roundTime(value) {
  return Math.round(Number(value) * 1000000) / 1000000;
}

/**
 * 時刻つき話者別発話から、同時発話を含む2話者の評価ケースを作る。
 * 本文は単語単位に時刻が付いていないため、重なりに接する発話全体を評価範囲にする。
 */
function buildCasesFromSegments(recordingId, segments, options = {}) {
  const maxDuration = Math.max(1,
    Number(options.maxCaseDuration) || DEFAULT_MAX_CASE_DURATION);
  const maxCases = Number.isFinite(Number(options.maxCases))
    ? Math.max(1, Math.floor(Number(options.maxCases))) : Infinity;
  const values = (Array.isArray(segments) ? segments : [])
    .filter((segment) => segment && Number(segment.end) > Number(segment.start)
      && String(segment.speaker || '').trim() && autoTune.normalizeText(segment.text))
    .map((segment, index) => ({
      id: segment.id || `segment-${index + 1}`,
      start: Number(segment.start),
      end: Number(segment.end),
      speaker: String(segment.speaker).trim(),
      text: String(segment.text).trim(),
    }))
    .sort((a, b) => a.start - b.start || a.end - b.end);
  const overlaps = overlapTools.detectOverlapIntervals(values);
  const cases = [];
  const skipped = [];
  const seen = new Set();

  for (const core of overlaps) {
    const active = values.filter((segment) => intersects(segment, core));
    const speakers = [...new Set(active.map((segment) => segment.speaker))];
    if (speakers.length !== 2) {
      skipped.push({ ...core, reason: 'not-exactly-two-speakers', speakers: speakers.length });
      continue;
    }
    const key = active.map((segment) => segment.id).sort().join('|');
    if (seen.has(key)) continue;
    seen.add(key);
    const start = Math.min(...active.map((segment) => segment.start));
    const end = Math.max(...active.map((segment) => segment.end));
    if (end - start > maxDuration + 1e-6) {
      skipped.push({ ...core, start, end, reason: 'case-too-long', duration: end - start });
      continue;
    }
    const references = speakers.map((speaker) => {
      const speakerSegments = active.filter((segment) => segment.speaker === speaker)
        .sort((a, b) => a.start - b.start || a.end - b.end);
      return {
        speaker,
        text: speakerSegments.map((segment) => segment.text).join(''),
        segments: speakerSegments.map((segment) => ({
          start: roundTime(segment.start),
          end: roundTime(segment.end),
          text: segment.text,
        })),
      };
    });
    cases.push({
      id: `${recordingId}-overlap-${String(cases.length + 1).padStart(3, '0')}`,
      start: roundTime(start),
      end: roundTime(end),
      overlapStart: roundTime(core.start),
      overlapEnd: roundTime(core.end),
      references,
      annotationGranularity: 'utterance',
    });
    if (cases.length >= maxCases) break;
  }
  return { cases, skipped, overlapIntervals: overlaps };
}

function validateManifest(manifest) {
  const errors = [];
  const warnings = [];
  if (!manifest || typeof manifest !== 'object') return { errors: ['manifest がオブジェクトではありません'], warnings };
  if (manifest.schemaVersion !== SCHEMA_VERSION) {
    errors.push(`schemaVersion は ${SCHEMA_VERSION} である必要があります`);
  }
  if (!manifest.dataset || typeof manifest.dataset !== 'object') errors.push('dataset がありません');
  else {
    if (!String(manifest.dataset.name || '').trim()) errors.push('dataset.name がありません');
    if (!/^ja(?:-|$)/i.test(String(manifest.dataset.language || ''))) {
      warnings.push('dataset.language が日本語ではありません');
    }
    if (!String(manifest.dataset.license || '').trim()) warnings.push('dataset.license が未記入です');
    if (!String(manifest.dataset.consent || '').trim()) warnings.push('dataset.consent が未記入です');
    if (!['gold', 'reviewed'].includes(String(manifest.dataset.annotationStatus || '').toLowerCase())) {
      warnings.push('アノテーションは暫定扱いです。モデル選定の最終判断には reviewed/gold データが必要です');
    }
  }
  const recordings = Array.isArray(manifest.recordings) ? manifest.recordings : [];
  if (!recordings.length) errors.push('recordings が空です');
  const recordingIds = new Set();
  const caseIds = new Set();
  for (const recording of recordings) {
    const recordingId = String(recording && recording.id || '').trim();
    if (!recordingId) errors.push('recording.id がありません');
    else if (recordingIds.has(recordingId)) errors.push(`recording.id が重複しています: ${recordingId}`);
    else recordingIds.add(recordingId);
    if (!String(recording && recording.audio || '').trim()) errors.push(`${recordingId || 'recording'}: audio がありません`);
    const cases = Array.isArray(recording && recording.cases) ? recording.cases : [];
    if (!cases.length) warnings.push(`${recordingId || 'recording'}: 評価ケースがありません`);
    for (const item of cases) {
      const prefix = `${recordingId}/${String(item && item.id || 'case')}`;
      if (!item || !String(item.id || '').trim()) errors.push(`${prefix}: id がありません`);
      else if (caseIds.has(item.id)) errors.push(`${prefix}: case id が重複しています`);
      else caseIds.add(item.id);
      const start = Number(item && item.start);
      const end = Number(item && item.end);
      const overlapStart = Number(item && item.overlapStart);
      const overlapEnd = Number(item && item.overlapEnd);
      if (![start, end, overlapStart, overlapEnd].every(Number.isFinite)
        || end <= start || overlapEnd <= overlapStart
        || overlapStart < start || overlapEnd > end) {
        errors.push(`${prefix}: 評価・重なり時刻が不正です`);
      }
      const refs = Array.isArray(item && item.references) ? item.references : [];
      const speakers = new Set(refs.map((ref) => String(ref && ref.speaker || '').trim()).filter(Boolean));
      if (refs.length !== 2 || speakers.size !== 2) errors.push(`${prefix}: 異なる2話者の references が必要です`);
      refs.forEach((ref) => {
        if (!autoTune.normalizeText(ref && ref.text)) errors.push(`${prefix}: 空の参照文字列があります`);
      });
    }
  }
  return { errors, warnings };
}

function permutations(values) {
  if (values.length <= 1) return [values.slice()];
  const out = [];
  values.forEach((value, index) => {
    const rest = values.slice(0, index).concat(values.slice(index + 1));
    permutations(rest).forEach((tail) => out.push([value, ...tail]));
  });
  return out;
}

/** 話者ラベルの入れ替わりを許容した、話者別文字誤り率。 */
function permutationInvariantCer(referenceTexts, hypothesisTexts) {
  const references = (Array.isArray(referenceTexts) ? referenceTexts : []).map(autoTune.normalizeText);
  const hypotheses = (Array.isArray(hypothesisTexts) ? hypothesisTexts : []).map(autoTune.normalizeText);
  while (hypotheses.length < references.length) hypotheses.push('');
  let best = null;
  for (const order of permutations(hypotheses.map((_, index) => index))) {
    const rows = references.map((reference, index) => {
      const hypothesisIndex = order[index];
      return {
        referenceIndex: index,
        hypothesisIndex,
        ...autoTune.editStats(reference, hypotheses[hypothesisIndex]),
      };
    });
    const distance = rows.reduce((sum, row) => sum + row.distance, 0);
    if (!best || distance < best.distance) best = { distance, assignment: order.slice(), rows };
  }
  const referenceLength = references.reduce((sum, text) => sum + Array.from(text).length, 0);
  return { ...best, referenceLength, cer: best.distance / Math.max(1, referenceLength) };
}

/** 単一の混合音声仮説を、参照話者の連結順序を入れ替えて比較する。 */
function concatenatedPermutationCer(referenceTexts, hypothesisText) {
  const references = (Array.isArray(referenceTexts) ? referenceTexts : []).map(autoTune.normalizeText);
  const hypothesis = autoTune.normalizeText(hypothesisText);
  let best = null;
  for (const order of permutations(references.map((_, index) => index))) {
    const reference = order.map((index) => references[index]).join('');
    const stats = autoTune.editStats(reference, hypothesis);
    if (!best || stats.distance < best.distance) best = { ...stats, order };
  }
  return { ...best, cer: best.distance / Math.max(1, best.referenceLength) };
}

/**
 * 語順が定まらない同時発話について、文字の多重集合で漏れと余計な文字を数える。
 * CER の代替ではなく、アプリの「回収 / 誤追加」変化を見る補助指標。
 */
function characterCoverage(referenceTexts, hypothesisTexts) {
  const chars = (values) => Array.from((Array.isArray(values) ? values : [values])
    .map(autoTune.normalizeText).join(''));
  const ref = chars(referenceTexts);
  const hyp = chars(hypothesisTexts);
  const counts = (values) => values.reduce((map, value) => {
    map.set(value, (map.get(value) || 0) + 1);
    return map;
  }, new Map());
  const refCounts = counts(ref);
  const hypCounts = counts(hyp);
  let matched = 0;
  for (const [char, count] of refCounts) matched += Math.min(count, hypCounts.get(char) || 0);
  const omissions = ref.length - matched;
  const additions = hyp.length - matched;
  const precision = matched / Math.max(1, hyp.length);
  const recall = matched / Math.max(1, ref.length);
  return {
    referenceChars: ref.length,
    hypothesisChars: hyp.length,
    matched,
    omissions,
    additions,
    precision,
    recall,
    f1: precision + recall > 0 ? (2 * precision * recall) / (precision + recall) : 0,
  };
}

function sumCoverage(rows) {
  const totals = rows.reduce((out, row) => {
    ['referenceChars', 'hypothesisChars', 'matched', 'omissions', 'additions']
      .forEach((key) => { out[key] += Number(row && row[key]) || 0; });
    return out;
  }, { referenceChars: 0, hypothesisChars: 0, matched: 0, omissions: 0, additions: 0 });
  totals.precision = totals.matched / Math.max(1, totals.hypothesisChars);
  totals.recall = totals.matched / Math.max(1, totals.referenceChars);
  totals.f1 = totals.precision + totals.recall > 0
    ? (2 * totals.precision * totals.recall) / (totals.precision + totals.recall) : 0;
  return totals;
}

function summarizeCaseResults(cases) {
  const values = Array.isArray(cases) ? cases : [];
  const totals = values.reduce((out, item) => {
    out.referenceChars += Number(item.separated && item.separated.referenceLength) || 0;
    out.mixtureErrors += Number(item.mixture && item.mixture.distance) || 0;
    out.separatedErrors += Number(item.separated && item.separated.distance) || 0;
    out.audioSeconds += Number(item.durationSeconds) || 0;
    out.separationMs += Number(item.timing && item.timing.separationMs) || 0;
    out.asrMs += Number(item.timing && item.timing.asrMs) || 0;
    if (item.gate && item.gate.accepted) out.gateAccepted += 1;
    return out;
  }, {
    referenceChars: 0, mixtureErrors: 0, separatedErrors: 0,
    audioSeconds: 0, separationMs: 0, asrMs: 0, gateAccepted: 0,
  });
  const baselineCoverage = sumCoverage(values.map((item) => item.baselineCoverage));
  const applicationCoverage = sumCoverage(values.map((item) => item.applicationCoverage));
  const recoveredMatchedChars = applicationCoverage.matched - baselineCoverage.matched;
  const addedHypothesisChars = applicationCoverage.hypothesisChars - baselineCoverage.hypothesisChars;
  return {
    cases: values.length,
    referenceChars: totals.referenceChars,
    mixtureCer: totals.mixtureErrors / Math.max(1, totals.referenceChars),
    separatedPitCer: totals.separatedErrors / Math.max(1, totals.referenceChars),
    cerDelta: (totals.mixtureErrors - totals.separatedErrors) / Math.max(1, totals.referenceChars),
    baselineCoverage,
    applicationCoverage,
    recoveredMatchedChars,
    newUnmatchedChars: applicationCoverage.additions - baselineCoverage.additions,
    addedHypothesisChars,
    recoveryPrecision: recoveredMatchedChars / Math.max(1, addedHypothesisChars),
    gateAccepted: totals.gateAccepted,
    gateAcceptanceRate: totals.gateAccepted / Math.max(1, values.length),
    audioSeconds: totals.audioSeconds,
    separationSeconds: totals.separationMs / 1000,
    separationRtf: (totals.separationMs / 1000) / Math.max(0.001, totals.audioSeconds),
    asrSeconds: totals.asrMs / 1000,
  };
}

module.exports = {
  SCHEMA_VERSION,
  DEFAULT_MAX_CASE_DURATION,
  parseClock,
  parseTimedTranscript,
  buildCasesFromSegments,
  validateManifest,
  permutationInvariantCer,
  concatenatedPermutationCer,
  characterCoverage,
  summarizeCaseResults,
};
