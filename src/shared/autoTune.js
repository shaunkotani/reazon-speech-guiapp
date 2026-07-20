(function initAutoTune(root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.AutoTune = api;
}(typeof globalThis !== 'undefined' ? globalThis : this, () => {
  'use strict';

  const MIN_REFERENCE_CHARS = 30;

  const PRESETS = Object.freeze({
    standard: {
      maxSpeechDuration: 6, minSilenceDuration: 0.2,
      minSpeechDuration: 0.15, threshold: 0.5, overlapAware: false,
    },
    conversation: {
      maxSpeechDuration: 3, minSilenceDuration: 0.1,
      minSpeechDuration: 0.2, threshold: 0.7, overlapAware: true,
    },
    interview: {
      maxSpeechDuration: 3, minSilenceDuration: 0.1,
      minSpeechDuration: 0.15, threshold: 0.2, overlapAware: true,
    },
    lecture: {
      maxSpeechDuration: 8, minSilenceDuration: 0.35,
      minSpeechDuration: 0.15, threshold: 0.45, overlapAware: false,
    },
  });

  function clamp(value, min, max, fallback) {
    const number = Number(value);
    return Number.isFinite(number) ? Math.min(max, Math.max(min, number)) : fallback;
  }

  // ASR の句読点・改行方法は候補間で揺れるため、校正では本文の文字だけを比べる。
  // 長音符や英数字は認識内容なので残す。
  function normalizeText(value) {
    return String(value || '')
      .normalize('NFKC')
      .toLocaleLowerCase('ja-JP')
      .replace(/[\s\p{P}\p{Z}]+/gu, '');
  }

  function normalizeReferenceRows(rows) {
    const values = Array.isArray(rows) ? rows : [];
    return values.filter((row) => !row || row.confirmed !== false).map((row, index) => ({
      speaker: String((row && row.speaker) || 'speaker-1').slice(0, 40),
      speakerName: String((row && row.speakerName) || '').trim().slice(0, 40),
      text: String((row && row.text) || '').trim(),
      normalizedText: normalizeText(row && row.text),
      start: row && row.start != null && Number.isFinite(Number(row.start))
        ? Math.max(0, Number(row.start)) : null,
      end: row && row.end != null && Number.isFinite(Number(row.end))
        ? Math.max(0, Number(row.end)) : null,
      confirmed: true,
      operation: String(row && (row.operation || row.kind) || 'replace') === 'insert'
        ? 'insert' : 'replace',
      sourceStart: row && row.sourceStart != null && Number.isFinite(Number(row.sourceStart))
        ? Math.max(0, Number(row.sourceStart)) : null,
      sourceEnd: row && row.sourceEnd != null && Number.isFinite(Number(row.sourceEnd))
        ? Math.max(0, Number(row.sourceEnd)) : null,
      order: index,
    })).filter((row) => row.normalizedText);
  }

  function referenceText(rows) {
    return normalizeReferenceRows(rows).map((row) => row.normalizedText).join('');
  }

  // 文字単位の編集操作数を返す。削除（発話の抜け）は scoreText で重く扱う。
  function editStats(reference, hypothesis) {
    const ref = Array.from(normalizeText(reference));
    const hyp = Array.from(normalizeText(hypothesis));
    const matrix = Array.from({ length: ref.length + 1 }, () => new Uint32Array(hyp.length + 1));
    for (let i = 0; i <= ref.length; i++) matrix[i][0] = i;
    for (let j = 0; j <= hyp.length; j++) matrix[0][j] = j;
    for (let i = 1; i <= ref.length; i++) {
      for (let j = 1; j <= hyp.length; j++) {
        const substitution = matrix[i - 1][j - 1] + (ref[i - 1] === hyp[j - 1] ? 0 : 1);
        matrix[i][j] = Math.min(substitution, matrix[i - 1][j] + 1, matrix[i][j - 1] + 1);
      }
    }

    let i = ref.length;
    let j = hyp.length;
    let matches = 0;
    let substitutions = 0;
    let deletions = 0;
    let insertions = 0;
    while (i > 0 || j > 0) {
      if (i > 0 && j > 0 && ref[i - 1] === hyp[j - 1]
        && matrix[i][j] === matrix[i - 1][j - 1]) {
        matches++; i--; j--; continue;
      }
      if (i > 0 && j > 0 && matrix[i][j] === matrix[i - 1][j - 1] + 1) {
        substitutions++; i--; j--; continue;
      }
      if (i > 0 && matrix[i][j] === matrix[i - 1][j] + 1) {
        deletions++; i--; continue;
      }
      insertions++; j--;
    }
    return {
      referenceLength: ref.length,
      hypothesisLength: hyp.length,
      matches, substitutions, deletions, insertions,
      distance: matrix[ref.length][hyp.length],
    };
  }

  function scoreText(reference, hypothesis) {
    const stats = editStats(reference, hypothesis);
    const denominator = Math.max(1, stats.referenceLength);
    const weightedErrors = stats.substitutions + stats.deletions * 1.35 + stats.insertions;
    return {
      ...stats,
      weightedErrors,
      errorRate: weightedErrors / denominator,
      accuracy: Math.max(0, 1 - weightedErrors / denominator),
      exactRecall: stats.matches / denominator,
      coverage: Math.max(0, (stats.referenceLength - stats.deletions) / denominator),
      lengthRatio: stats.hypothesisLength / denominator,
    };
  }

  function normalizeVad(vad = {}, fallback = PRESETS.standard) {
    return {
      maxSpeechDuration: clamp(vad.maxSpeechDuration, 3, 20, fallback.maxSpeechDuration),
      minSilenceDuration: clamp(vad.minSilenceDuration, 0.05, 1, fallback.minSilenceDuration),
      minSpeechDuration: clamp(vad.minSpeechDuration, 0.05, 0.5, fallback.minSpeechDuration),
      threshold: clamp(vad.threshold, 0.1, 0.9, fallback.threshold),
      overlapAware: vad.overlapAware === true,
      overlapSpeakers: Math.round(clamp(vad.overlapSpeakers, 2, 4, 2)),
    };
  }

  function normalizeOptions(options = {}) {
    return {
      denoiseStrength: clamp(options.denoiseStrength, 0, 1, 0),
      vad: normalizeVad(options.vad || {}),
    };
  }

  function candidateKey(options) {
    const value = normalizeOptions(options);
    return JSON.stringify({
      denoiseStrength: value.denoiseStrength,
      maxSpeechDuration: value.vad.maxSpeechDuration,
      minSilenceDuration: value.vad.minSilenceDuration,
      minSpeechDuration: value.vad.minSpeechDuration,
      threshold: value.vad.threshold,
      overlapAware: value.vad.overlapAware,
      overlapSpeakers: value.vad.overlapSpeakers,
    });
  }

  function optionDistance(options, seedOptions) {
    const value = normalizeOptions(options);
    const seed = normalizeOptions(seedOptions);
    const vad = value.vad;
    const base = seed.vad;
    return Math.abs(value.denoiseStrength - seed.denoiseStrength)
      + Math.abs(vad.maxSpeechDuration - base.maxSpeechDuration) / 17
      + Math.abs(vad.minSilenceDuration - base.minSilenceDuration) / 0.95
      + Math.abs(vad.minSpeechDuration - base.minSpeechDuration) / 0.45
      + Math.abs(vad.threshold - base.threshold) / 0.8
      + (vad.overlapAware === base.overlapAware ? 0 : 0.5)
      + Math.abs(vad.overlapSpeakers - base.overlapSpeakers) * 0.1;
  }

  function buildCoarseCandidates(current = {}, { speakerCount = 1 } = {}) {
    const speakers = Math.round(clamp(speakerCount, 1, 4, 1));
    const denoiseValues = [0, 0.8];
    const currentNormalized = normalizeOptions(current);
    if (speakers < 2) currentNormalized.vad.overlapAware = false;
    currentNormalized.vad.overlapSpeakers = Math.max(2, speakers);
    if (!denoiseValues.includes(currentNormalized.denoiseStrength)) {
      denoiseValues.push(currentNormalized.denoiseStrength);
    }
    const out = [];
    const seen = new Set();
    const add = (label, options) => {
      const normalized = normalizeOptions(options);
      if (speakers < 2) normalized.vad.overlapAware = false;
      normalized.vad.overlapSpeakers = Math.max(2, speakers);
      const key = candidateKey(normalized);
      if (seen.has(key)) return;
      seen.add(key);
      out.push({
        id: `coarse-${out.length + 1}`,
        label,
        options: normalized,
        seedDistance: optionDistance(normalized, currentNormalized),
      });
    };

    add('現在の設定', currentNormalized);
    for (const [name, preset] of Object.entries(PRESETS)) {
      for (const denoiseStrength of denoiseValues) {
        add(`${name}-${denoiseStrength}`, {
          denoiseStrength,
          vad: {
            ...preset,
            overlapAware: speakers >= 2 && preset.overlapAware,
            overlapSpeakers: Math.max(2, speakers),
          },
        });
      }
    }
    return out.slice(0, 12);
  }

  function buildRefinementCandidates(best, existing = []) {
    if (!best || !best.options) return [];
    const base = normalizeOptions(best.options);
    const seed = existing.length ? normalizeOptions(existing[0].options || existing[0]) : base;
    const seen = new Set((Array.isArray(existing) ? existing : []).map((item) => candidateKey(item.options || item)));
    const variations = [
      ['発話判定を緩める', { threshold: base.vad.threshold - 0.15 }],
      ['発話判定を厳しくする', { threshold: base.vad.threshold + 0.15 }],
      ['区間を短くする', { maxSpeechDuration: base.vad.maxSpeechDuration - 1 }],
      ['区間を長くする', { maxSpeechDuration: base.vad.maxSpeechDuration + 2 }],
    ];
    const out = [];
    for (const [label, patch] of variations) {
      const options = normalizeOptions({
        denoiseStrength: base.denoiseStrength,
        vad: { ...base.vad, ...patch },
      });
      const key = candidateKey(options);
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({
        id: `refine-${out.length + 1}`, label, options,
        seedDistance: optionDistance(options, seed),
      });
    }
    return out;
  }

  function processingCost(candidate) {
    const options = normalizeOptions(candidate.options || candidate);
    return (options.vad.overlapAware ? 2 : 0) + options.denoiseStrength;
  }

  function selectBestCandidate(candidates) {
    const values = (Array.isArray(candidates) ? candidates : []).filter((item) => item && item.metrics);
    if (!values.length) return null;
    return values.slice().sort((a, b) => {
      const scoreA = Number.isFinite(a.rankScore) ? a.rankScore : a.metrics.accuracy;
      const scoreB = Number.isFinite(b.rankScore) ? b.rankScore : b.metrics.accuracy;
      if (Math.abs(scoreB - scoreA) > 0.005) return scoreB - scoreA;
      const deletionA = a.metrics.deletions / Math.max(1, a.metrics.referenceLength);
      const deletionB = b.metrics.deletions / Math.max(1, b.metrics.referenceLength);
      if (Math.abs(deletionA - deletionB) > 1e-9) return deletionA - deletionB;
      const seedA = Number.isFinite(a.seedDistance) ? a.seedDistance : 0;
      const seedB = Number.isFinite(b.seedDistance) ? b.seedDistance : 0;
      if (Math.abs(seedA - seedB) > 1e-9) return seedA - seedB;
      return processingCost(a) - processingCost(b);
    })[0];
  }

  function confidenceFor(best, candidates) {
    if (!best || !best.metrics) return 'low';
    const ordered = (Array.isArray(candidates) ? candidates : [])
      .filter((item) => item && item.metrics)
      .map((item) => Number.isFinite(item.rankScore) ? item.rankScore : item.metrics.accuracy)
      .sort((a, b) => b - a);
    const margin = ordered.length > 1 ? ordered[0] - ordered[1] : 0;
    if (best.metrics.accuracy >= 0.8 && margin >= 0.03) return 'high';
    if (best.metrics.accuracy >= 0.55) return 'medium';
    return 'low';
  }

  return {
    MIN_REFERENCE_CHARS,
    PRESETS,
    normalizeText,
    normalizeReferenceRows,
    referenceText,
    editStats,
    scoreText,
    normalizeVad,
    normalizeOptions,
    candidateKey,
    optionDistance,
    buildCoarseCandidates,
    buildRefinementCandidates,
    selectBestCandidate,
    confidenceFor,
  };
}));
