'use strict';

const separationEvaluation = require('./separationEvaluation');

const SAMPLE_RATE = 16000;

function intersects(a, b, guard = 0) {
  return Math.min(Number(a.end) + guard, Number(b.end) + guard)
    - Math.max(Number(a.start) - guard, Number(b.start) - guard) > 0;
}

/** 異なる話者の発話と接していない、合成元に使える単独発話を選ぶ。 */
function selectCleanSegments(segments, options = {}) {
  const minDuration = Math.max(0.3, Number(options.minDuration) || 0.8);
  const maxDuration = Math.max(minDuration, Number(options.maxDuration) || 6);
  const minChars = Math.max(1, Math.floor(Number(options.minChars) || 3));
  const requestedTrim = Number(options.guardSeconds);
  const trim = Math.max(0, Number.isFinite(requestedTrim) ? requestedTrim : 0.12);
  const values = (Array.isArray(segments) ? segments : []).filter((segment) => segment
    && Number(segment.end) > Number(segment.start)
    && String(segment.speaker || '').trim());
  return values.filter((segment) => {
    const duration = Number(segment.end) - Number(segment.start) - trim * 2;
    if (duration < minDuration || duration > maxDuration) return false;
    const chars = Array.from(String(segment.text || '').normalize('NFKC')
      .replace(/[\s\p{P}\p{Z}]+/gu, '')).length;
    if (chars < minChars) return false;
    return !values.some((other) => other !== segment
      && String(other.speaker) !== String(segment.speaker)
      && intersects(segment, other));
  }).map((segment, index) => ({
    id: String(segment.id || `source-${index + 1}`),
    speaker: String(segment.speaker).trim(),
    start: Number(segment.start) + trim,
    end: Number(segment.end) - trim,
    text: String(segment.text || '').trim(),
  }));
}

function seededRandom(seed) {
  let state = (Number(seed) || 1) >>> 0;
  return () => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    return (state >>> 0) / 4294967296;
  };
}

/** 話者・元発話の異なる組を、SNRと重なり率の条件が均等になるよう決める。 */
function buildMixPlans(segments, count, options = {}) {
  const groups = new Map();
  for (const segment of (Array.isArray(segments) ? segments : [])) {
    if (!groups.has(segment.speaker)) groups.set(segment.speaker, []);
    groups.get(segment.speaker).push(segment);
  }
  const speakers = [...groups.keys()].filter((speaker) => groups.get(speaker).length);
  if (speakers.length < 2) throw new Error('合成には2話者以上の単独発話が必要です');
  const total = Math.max(1, Math.floor(Number(count) || 24));
  const snrValues = (Array.isArray(options.snrDb) && options.snrDb.length
    ? options.snrDb : [-6, 0, 6]).map(Number).filter(Number.isFinite);
  const overlapValues = (Array.isArray(options.overlapRatios) && options.overlapRatios.length
    ? options.overlapRatios : [0.25, 0.5, 0.75, 1])
    .map(Number).filter(Number.isFinite).map((value) => Math.min(1, Math.max(0.1, value)));
  const random = seededRandom(options.seed);
  const plans = [];
  const used = new Set();
  let attempts = 0;
  while (plans.length < total && attempts < total * 100) {
    attempts++;
    const speakerAIndex = Math.floor(random() * speakers.length);
    let speakerBIndex = Math.floor(random() * (speakers.length - 1));
    if (speakerBIndex >= speakerAIndex) speakerBIndex++;
    const speakerA = speakers[speakerAIndex];
    const speakerB = speakers[speakerBIndex];
    const sourceA = groups.get(speakerA)[Math.floor(random() * groups.get(speakerA).length)];
    const sourceB = groups.get(speakerB)[Math.floor(random() * groups.get(speakerB).length)];
    const pairKey = [sourceA.id, sourceB.id].sort().join('|');
    if (used.has(pairKey)) continue;
    used.add(pairKey);
    const index = plans.length;
    plans.push({
      index,
      sourceA,
      sourceB,
      snrDb: snrValues[index % snrValues.length],
      overlapRatio: overlapValues[Math.floor(index / snrValues.length) % overlapValues.length],
      lead: index % 2 === 0 ? 'a' : 'b',
    });
  }
  if (plans.length < total) throw new Error(`重複しない発話組を${total}件作れませんでした (${plans.length}件)`);
  return plans;
}

function centerAndRms(values) {
  const out = Float32Array.from(values || []);
  if (!out.length) return { values: out, rms: 0 };
  let mean = 0;
  for (const value of out) mean += value;
  mean /= out.length;
  let energy = 0;
  for (let i = 0; i < out.length; i++) {
    out[i] -= mean;
    energy += out[i] * out[i];
  }
  return { values: out, rms: Math.sqrt(energy / out.length) };
}

function scaleInto(source, target, offset, gain) {
  for (let i = 0; i < source.length; i++) target[offset + i] = source[i] * gain;
}

/** 2つの16kHz PCMを指定SNR・重なり率で合成し、正解stemも同時に返す。 */
function mixSources(sourceA, sourceB, options = {}) {
  const a = centerAndRms(sourceA);
  const b = centerAndRms(sourceB);
  if (a.values.length < SAMPLE_RATE / 4 || b.values.length < SAMPLE_RATE / 4
    || a.rms < 1e-6 || b.rms < 1e-6) throw new Error('合成元音声が短いか無音です');
  const targetRms = Math.max(0.01, Math.min(0.3, Number(options.targetRms) || 0.1));
  const snrDb = Number.isFinite(Number(options.snrDb)) ? Number(options.snrDb) : 0;
  const gainA = targetRms / a.rms;
  const gainB = (targetRms * Math.pow(10, -snrDb / 20)) / b.rms;
  const ratio = Math.min(1, Math.max(0.1, Number(options.overlapRatio) || 0.5));
  const lead = options.lead === 'b' ? 'b' : 'a';
  const leadLength = lead === 'a' ? a.values.length : b.values.length;
  const overlapSamples = Math.max(1, Math.round(Math.min(a.values.length, b.values.length) * ratio));
  const offset = Math.max(0, leadLength - overlapSamples);
  const startA = lead === 'a' ? 0 : offset;
  const startB = lead === 'b' ? 0 : offset;
  const length = Math.max(startA + a.values.length, startB + b.values.length);
  const stemA = new Float32Array(length);
  const stemB = new Float32Array(length);
  scaleInto(a.values, stemA, startA, gainA);
  scaleInto(b.values, stemB, startB, gainB);
  const mixture = new Float32Array(length);
  let peak = 0;
  for (let i = 0; i < length; i++) {
    mixture[i] = stemA[i] + stemB[i];
    peak = Math.max(peak, Math.abs(mixture[i]));
  }
  if (peak > 0.98) {
    const scale = 0.98 / peak;
    for (let i = 0; i < length; i++) {
      mixture[i] *= scale;
      stemA[i] *= scale;
      stemB[i] *= scale;
    }
  }
  return {
    mixture,
    stems: [stemA, stemB],
    starts: [startA / SAMPLE_RATE, startB / SAMPLE_RATE],
    ends: [(startA + a.values.length) / SAMPLE_RATE, (startB + b.values.length) / SAMPLE_RATE],
    overlapStart: Math.max(startA, startB) / SAMPLE_RATE,
    overlapEnd: Math.min(startA + a.values.length, startB + b.values.length) / SAMPLE_RATE,
    duration: length / SAMPLE_RATE,
    snrDb,
    overlapRatio: overlapSamples / Math.min(a.values.length, b.values.length),
    lead,
  };
}

module.exports = {
  SAMPLE_RATE,
  selectCleanSegments,
  seededRandom,
  buildMixPlans,
  mixSources,
};
