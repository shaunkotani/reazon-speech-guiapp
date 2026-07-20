// 話者別音声分離の区間設計・品質判定・既存結果との統合。
// ONNX Runtime に依存しない純 JS とし、main と単体テストから共用する。

const DEFAULTS = Object.freeze({
  context: 1.0,
  mergeGap: 0.35,
  maxWindowDuration: 10,
  minOverlapDuration: 0.12,
  maxStemCorrelation: 0.97,
  minSourceShare: 0.008,
  maxStemTextSimilarity: 0.88,
  duplicateTextSimilarity: 0.68,
  minEmbeddingDistance: 0.08,
  minTranscriptChars: 2,
  minBaselineAnchorSimilarity: 0.45,
});

const roundTime = (value) => Math.round(value * 1000000) / 1000000;

function intersectionSeconds(a, b) {
  return Math.max(0, Math.min(Number(a.end) || 0, Number(b.end) || 0)
    - Math.max(Number(a.start) || 0, Number(b.start) || 0));
}

function normalizeIntervals(intervals, duration, minDuration) {
  const total = Math.max(0, Number(duration) || 0);
  return (Array.isArray(intervals) ? intervals : [])
    .map((item) => ({
      start: Math.max(0, Math.min(total, Number(item && item.start) || 0)),
      end: Math.max(0, Math.min(total, Number(item && item.end) || 0)),
    }))
    .filter((item) => item.end - item.start >= minDuration)
    .sort((a, b) => a.start - b.start || a.end - b.end);
}

/** 重なり区間を、前後文脈を持つ最大10秒の分離窓へまとめる。 */
function buildSeparationWindows(overlapIntervals, duration, opts = {}) {
  const cfg = { ...DEFAULTS, ...opts };
  const total = Math.max(0, Number(duration) || 0);
  const intervals = normalizeIntervals(overlapIntervals, total, cfg.minOverlapDuration);
  if (!intervals.length) return [];

  const groups = [];
  for (const interval of intervals) {
    const previous = groups[groups.length - 1];
    if (previous && interval.start <= previous.end + cfg.mergeGap) {
      previous.end = Math.max(previous.end, interval.end);
      previous.intervals.push(interval);
    } else {
      groups.push({ start: interval.start, end: interval.end, intervals: [interval] });
    }
  }

  const context = Math.max(0, Number(cfg.context) || 0);
  const maxDuration = Math.max(2, Number(cfg.maxWindowDuration) || DEFAULTS.maxWindowDuration);
  const maxCore = Math.max(0.5, maxDuration - context * 2);
  const windows = [];
  for (const group of groups) {
    let coreStart = group.start;
    while (coreStart < group.end - 1e-6) {
      const coreEnd = Math.min(group.end, coreStart + maxCore);
      const core = { start: coreStart, end: coreEnd };
      const covered = group.intervals
        .map((item) => ({ start: Math.max(item.start, coreStart), end: Math.min(item.end, coreEnd) }))
        .filter((item) => item.end - item.start >= cfg.minOverlapDuration);
      if (covered.length) {
        const start = Math.max(0, coreStart - context);
        const end = Math.min(total, coreEnd + context);
        windows.push({
          index: windows.length,
          start: roundTime(start),
          end: roundTime(end),
          overlapStart: roundTime(coreStart),
          overlapEnd: roundTime(coreEnd),
          intervals: covered.map((item) => ({
            start: roundTime(item.start), end: roundTime(item.end),
          })),
        });
      }
      coreStart = coreEnd;
    }
  }
  return windows;
}

function normalizeText(value) {
  return String(value || '')
    .normalize('NFKC')
    .toLocaleLowerCase('ja-JP')
    .replace(/[\s\p{P}\p{Z}]+/gu, '');
}

function levenshtein(a, b) {
  const aa = Array.from(a);
  const bb = Array.from(b);
  if (!aa.length) return bb.length;
  if (!bb.length) return aa.length;
  let previous = Array.from({ length: bb.length + 1 }, (_, index) => index);
  for (let i = 1; i <= aa.length; i++) {
    const current = [i];
    for (let j = 1; j <= bb.length; j++) {
      current[j] = Math.min(
        current[j - 1] + 1,
        previous[j] + 1,
        previous[j - 1] + (aa[i - 1] === bb[j - 1] ? 0 : 1),
      );
    }
    previous = current;
  }
  return previous[bb.length];
}

function textSimilarity(a, b) {
  const aa = normalizeText(a);
  const bb = normalizeText(b);
  if (!aa || !bb) return 0;
  if (aa.includes(bb) || bb.includes(aa)) {
    return Math.min(aa.length, bb.length) / Math.max(aa.length, bb.length);
  }
  return 1 - levenshtein(aa, bb) / Math.max(aa.length, bb.length);
}

function combinedText(segments) {
  return (Array.isArray(segments) ? segments : []).map((item) => item.text || '').join('');
}

function baselineAnchorSimilarity(a, b) {
  const aa = normalizeText(a);
  const bb = normalizeText(b);
  if (!aa || !bb) return 0;
  const shorter = aa.length <= bb.length ? aa : bb;
  const longer = aa.length > bb.length ? aa : bb;
  if (shorter.length >= 4 && longer.includes(shorter)) return 1;
  return textSimilarity(aa, bb);
}

/**
 * 1つの分離窓について、ASRへ追加する「既存結果に無い発話」だけを選ぶ。
 * 原音の認識結果は削除しないため、分離アーティファクトがあっても従来結果を保持できる。
 */
function selectSeparatedAdditions({ window, stems, metrics, baselineSegments }, opts = {}) {
  const cfg = { ...DEFAULTS, ...opts };
  const reject = (reason) => ({ accepted: false, reason, additions: [] });
  const values = Array.isArray(stems) ? stems : [];
  if (values.length !== 2) return reject('invalid-stem-count');
  if (!metrics || !Array.isArray(metrics.sourceShares) || metrics.sourceShares.length !== 2) {
    return reject('missing-metrics');
  }
  if (metrics.sourceShares.some((share) => !Number.isFinite(share) || share < cfg.minSourceShare)) {
    return reject('silent-stem');
  }
  if (Number.isFinite(metrics.stemCorrelation)
    && Math.abs(metrics.stemCorrelation) > cfg.maxStemCorrelation) {
    return reject('correlated-stems');
  }

  const stemTexts = values.map((stem) => combinedText(stem.segments));
  if (!stemTexts[0] || !stemTexts[1]) return reject('missing-stem-transcript');
  if (textSimilarity(stemTexts[0], stemTexts[1]) >= cfg.maxStemTextSimilarity) {
    return reject('duplicate-stem-transcript');
  }
  if (!Number.isFinite(metrics.embeddingDistance)) return reject('missing-speaker-embedding');
  if (metrics.embeddingDistance < cfg.minEmbeddingDistance) {
    return reject('same-speaker-embedding');
  }

  const baseline = (Array.isArray(baselineSegments) ? baselineSegments : [])
    .filter((segment) => intersectionSeconds(segment, window) > 0);
  if (!baseline.length) return reject('missing-baseline-anchor');
  const anchorScore = Math.max(0, ...values.map((stem) => Math.max(0,
    ...(stem.segments || []).flatMap((segment) => baseline.map((existing) =>
      baselineAnchorSimilarity(segment.text, existing.text))),
  )));
  if (anchorScore < cfg.minBaselineAnchorSimilarity) return reject('unanchored-transcript');
  const additions = [];
  for (const stem of values) {
    for (const segment of (Array.isArray(stem.segments) ? stem.segments : [])) {
      const text = normalizeText(segment.text);
      if (Array.from(text).length < cfg.minTranscriptChars || intersectionSeconds(segment, {
        start: window.overlapStart, end: window.overlapEnd,
      }) <= 0) continue;
      const duplicate = baseline.concat(additions).some((existing) =>
        intersectionSeconds(existing, segment) > 0.03
        && baselineAnchorSimilarity(existing.text, segment.text) >= cfg.duplicateTextSimilarity);
      if (duplicate) continue;
      additions.push({
        ...segment,
        overlapSeparated: true,
        separationWindow: window.index,
        separationTrack: stem.stemIndex,
        separationSpeakerHint: stem.speakerHint == null ? null : stem.speakerHint,
        separationConfidence: stem.confidence == null ? null : stem.confidence,
      });
    }
  }
  return additions.length
    ? { accepted: true, reason: 'novel-transcript', additions }
    : reject('no-novel-transcript');
}

/** 分離で回収した発話を、時刻・本文の重複を抑えて既存結果へ加える。 */
function mergeSeparatedSegments(baseSegments, additions, opts = {}) {
  const cfg = { ...DEFAULTS, ...opts };
  const out = (Array.isArray(baseSegments) ? baseSegments : []).map((segment) => ({ ...segment }));
  for (const addition of (Array.isArray(additions) ? additions : [])) {
    const duplicate = out.some((existing) => intersectionSeconds(existing, addition) > 0.03
      && baselineAnchorSimilarity(existing.text, addition.text) >= cfg.duplicateTextSimilarity);
    if (!duplicate) out.push({ ...addition });
  }
  return out.sort((a, b) => a.start - b.start || a.end - b.end
    || Number(!!a.overlapSeparated) - Number(!!b.overlapSeparated));
}

/**
 * pyannote の話者トラックから、重なりを含まない声紋用アンカーを選ぶ。
 * 戻り値は既存 embedBatch にそのまま渡せる。
 */
function buildSpeakerAnchorItems(windows, speakerSegments, overlapIntervals, opts = {}) {
  const radius = Math.max(1, Number(opts.radius) || 6);
  const minDuration = Math.max(0.25, Number(opts.minDuration) || 0.6);
  const maxDuration = Math.max(minDuration, Number(opts.maxDuration) || 3);
  const overlaps = Array.isArray(overlapIntervals) ? overlapIntervals : [];
  const items = [];
  for (const window of (Array.isArray(windows) ? windows : [])) {
    const core = { start: window.overlapStart, end: window.overlapEnd };
    const active = [...new Set((speakerSegments || [])
      .filter((track) => intersectionSeconds(track, core) > 0)
      .map((track) => String(track.speaker)))];
    for (const speaker of active) {
      const candidates = [];
      for (const track of (speakerSegments || [])) {
        if (String(track.speaker) !== speaker) continue;
        if (track.end < window.start - radius || track.start > window.end + radius) continue;
        let pieces = [{ start: Number(track.start), end: Number(track.end) }];
        for (const overlap of overlaps) {
          const next = [];
          for (const piece of pieces) {
            if (intersectionSeconds(piece, overlap) <= 0) { next.push(piece); continue; }
            if (overlap.start - piece.start >= minDuration) {
              next.push({ start: piece.start, end: overlap.start });
            }
            if (piece.end - overlap.end >= minDuration) {
              next.push({ start: overlap.end, end: piece.end });
            }
          }
          pieces = next;
        }
        candidates.push(...pieces.filter((piece) => piece.end - piece.start >= minDuration));
      }
      candidates.sort((a, b) => {
        const da = Math.min(Math.abs(a.end - window.start), Math.abs(a.start - window.end));
        const db = Math.min(Math.abs(b.end - window.start), Math.abs(b.start - window.end));
        return da - db || (b.end - b.start) - (a.end - a.start);
      });
      candidates.slice(0, 2).forEach((candidate) => {
        const duration = Math.min(maxDuration, candidate.end - candidate.start);
        items.push({
          idx: items.length,
          windowIndex: window.index,
          speaker,
          start: roundTime(candidate.start),
          end: roundTime(candidate.start + duration),
        });
      });
    }
  }
  return items;
}

module.exports = {
  DEFAULTS,
  intersectionSeconds,
  buildSeparationWindows,
  normalizeText,
  textSimilarity,
  selectSeparatedAdditions,
  mergeSeparatedSegments,
  buildSpeakerAnchorItems,
};
