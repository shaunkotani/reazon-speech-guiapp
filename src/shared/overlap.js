// 重なり音声に強い区間生成と、複数回認識した候補の統合。
// ネイティブ addon に依存しない純 JS とし、main / 検証スクリプトの双方から使う。

const DEFAULTS = {
  strictOverlap: 0.18,
  minTailDuration: 0.8,
  minDetectedOverlap: 0.08,
  minRepairSpan: 0.45,
  minBoundaryShift: 0.12,
  startOffsets: [0, 0.08, 0.16],
  endTrims: [0, 0.5, 0.75],
  minVariantDuration: 0.45,
};

const roundTime = (n) => Math.round(n * 1000000) / 1000000;

function intervalIntersection(a, b) {
  const start = Math.max(a.start, b.start);
  const end = Math.min(a.end, b.end);
  return end > start ? { start, end } : null;
}

/**
 * VAD の maxSpeechDuration は自然な無音位置を優先して上限を超えることがある。
 * アプリ側で上限を厳密に守り、境界の語落ちを避けるため少し重ねて分割する。
 */
function splitStrictSegments(segments, maxDuration, overlap = DEFAULTS.strictOverlap) {
  const max = Number.isFinite(maxDuration) ? Math.max(0.5, maxDuration) : 6;
  const ov = Math.max(0, Math.min(overlap, max / 3));
  const out = [];

  segments.forEach((seg, parentVadIndex) => {
    let start = Number(seg.start);
    const finalEnd = Number(seg.end);
    let partIndex = 0;
    if (!Number.isFinite(start) || !Number.isFinite(finalEnd) || finalEnd <= start) return;

    while (finalEnd - start > max + 1e-6) {
      let end = start + max;
      let nextStart = end - ov;
      // 上限をわずかに超えただけの区間で、末尾に極端に短い断片を作らない。
      // 短すぎる断片は ASR が空文字にしやすいため、直前側を少し短くする。
      if (finalEnd - nextStart < DEFAULTS.minTailDuration) {
        nextStart = finalEnd - DEFAULTS.minTailDuration;
        end = nextStart + ov;
      }
      out.push({
        start: roundTime(start), end: roundTime(end),
        parentVadIndex, partIndex: partIndex++,
      });
      start = nextStart;
    }
    if (finalEnd - start >= 0.05) {
      out.push({
        start: roundTime(start), end: roundTime(finalEnd),
        parentVadIndex, partIndex,
      });
    }
  });
  return out;
}

/** 異なる話者の区間が同時に有効な時間帯を抽出する。 */
function detectOverlapIntervals(speakerSegments, minDuration = DEFAULTS.minDetectedOverlap) {
  const raw = [];
  for (let i = 0; i < speakerSegments.length; i++) {
    const a = speakerSegments[i];
    for (let j = i + 1; j < speakerSegments.length; j++) {
      const b = speakerSegments[j];
      if (a.speaker === b.speaker) continue;
      const hit = intervalIntersection(a, b);
      if (hit && hit.end - hit.start >= minDuration) raw.push(hit);
    }
  }
  raw.sort((a, b) => a.start - b.start || a.end - b.end);

  const merged = [];
  for (const hit of raw) {
    const prev = merged[merged.length - 1];
    if (prev && hit.start <= prev.end + 0.02) prev.end = Math.max(prev.end, hit.end);
    else merged.push({ ...hit });
  }
  return merged;
}

function intersectsAny(seg, intervals) {
  return intervals.some((it) => Math.min(seg.end, it.end) - Math.max(seg.start, it.start) > 0);
}

/**
 * 通常 VAD 区間と、重なり箇所だけを話者境界で切り直した再認識候補を作る。
 * 戻り値の items はそのまま worker pool に渡せる start/end を持つ。
 */
function buildRecognitionItems(vadSegments, speakerSegments, opts = {}) {
  const cfg = { ...DEFAULTS, ...opts };
  const base = splitStrictSegments(vadSegments, cfg.maxDuration, cfg.strictOverlap);
  const overlaps = cfg.enabled ? detectOverlapIntervals(speakerSegments, cfg.minDetectedOverlap) : [];
  const items = [];
  let repairSeq = 0;
  let overlapGroupCount = 0;

  base.forEach((seg, groupIndex) => {
    const groupId = `g${groupIndex}`;
    const chainId = `v${seg.parentVadIndex}`;
    items.push({ ...seg, kind: 'base', groupId, chainId, variantId: 'base' });

    const groupOverlaps = overlaps.filter((it) => intervalIntersection(seg, it));
    if (!groupOverlaps.length) return;

    const tracks = speakerSegments.filter((track) =>
      intersectsAny(track, groupOverlaps) && intervalIntersection(seg, track));
    const seen = new Set();
    let repairsForGroup = 0;

    for (const track of tracks) {
      const span = intervalIntersection(seg, track);
      if (!span || span.end - span.start < cfg.minRepairSpan) continue;
      // 話者区間が VAD 区間とほぼ同じなら、再認識しても新しい情報は増えず、
      // 終端トリムで正常な末尾を落とすだけになる。境界が実際に変わる時だけ補正する。
      const boundaryShift = Math.max(span.start - seg.start, seg.end - span.end);
      if (boundaryShift < cfg.minBoundaryShift) continue;
      const key = `${track.speaker}:${span.start.toFixed(3)}:${span.end.toFixed(3)}`;
      if (seen.has(key)) continue;
      seen.add(key);

      const repairParts = splitStrictSegments([span], cfg.maxDuration, cfg.strictOverlap);
      for (const part of repairParts) {
        const repairId = `r${repairSeq++}`;
        const repairSpanDuration = part.end - part.start;
        let variantsForRepair = 0;
        for (const startOffset of cfg.startOffsets) {
          for (const endTrim of cfg.endTrims) {
            const start = part.start + startOffset;
            const end = part.end - endTrim;
            if (end - start < cfg.minVariantDuration) continue;
            items.push({
              start: roundTime(start), end: roundTime(end),
              kind: 'repair', groupId, chainId,
              repairId, variantId: `${startOffset}:${endTrim}`,
              speakerHint: track.speaker,
              repairSpanDuration,
            });
            variantsForRepair++;
          }
        }
        if (variantsForRepair) repairsForGroup++;
      }
    }
    if (repairsForGroup) overlapGroupCount++;
  });

  return { items, overlapIntervals: overlaps, overlapGroupCount };
}

function levenshtein(a, b) {
  if (a === b) return 0;
  if (!a.length) return b.length;
  if (!b.length) return a.length;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) {
      cur[j] = Math.min(
        cur[j - 1] + 1,
        prev[j] + 1,
        prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
    }
    prev = cur;
  }
  return prev[b.length];
}

function similarity(a, b) {
  return 1 - levenshtein(a, b) / Math.max(1, a.length, b.length);
}

/** 編集距離の合計が最小（他候補との一致が最大）になる候補を選ぶ。 */
function selectConsensus(candidates) {
  const usable = candidates
    .map((c) => ({ ...c, text: String(c.text || '').trim() }))
    .filter((c) => c.text);
  if (!usable.length) return null;

  let best = null;
  for (let i = 0; i < usable.length; i++) {
    const c = usable[i];
    let score = 0;
    let exact = 0;
    for (const other of usable) {
      score += similarity(c.text, other.text);
      if (c.text === other.text) exact++;
    }
    const ranked = { ...c, consensus: score / usable.length, exactVotes: exact };
    if (!best
      || ranked.consensus > best.consensus + 1e-9
      || (Math.abs(ranked.consensus - best.consensus) <= 1e-9 && ranked.exactVotes > best.exactVotes)
      || (Math.abs(ranked.consensus - best.consensus) <= 1e-9
        && ranked.exactVotes === best.exactVotes && ranked.text.length > best.text.length)) {
      best = ranked;
    }
  }
  return best;
}

function trimRepeatedPrefix(previous, current) {
  const max = Math.min(previous.length, current.length, 24);
  for (let n = max; n >= 2; n--) {
    if (previous.slice(-n) === current.slice(0, n)) return current.slice(n);
  }
  return current;
}

/** worker の認識結果を通常区間へ戻し、重なり区間だけ合意候補へ置換する。 */
function finalizeRecognition(recognizedItems, opts = {}) {
  const cfg = { minConsensus: 0.34, minRelativeSpan: 0.45, ...opts };
  const groups = new Map();
  for (const item of recognizedItems) {
    if (!groups.has(item.groupId)) groups.set(item.groupId, []);
    groups.get(item.groupId).push(item);
  }

  const chosen = [];
  let recoveredGroups = 0;
  for (const entries of groups.values()) {
    const base = entries.find((x) => x.kind === 'base');
    const repairGroups = new Map();
    for (const entry of entries.filter((x) => x.kind === 'repair')) {
      if (!repairGroups.has(entry.repairId)) repairGroups.set(entry.repairId, []);
      repairGroups.get(entry.repairId).push(entry);
    }
    const repairs = [...repairGroups.values()].map(selectConsensus).filter(Boolean);
    const coverageBySpeaker = new Map();
    for (const r of repairs) {
      const key = r.speakerHint == null ? `repair:${r.repairId}` : `speaker:${r.speakerHint}`;
      coverageBySpeaker.set(key, (coverageBySpeaker.get(key) || 0)
        + (r.repairSpanDuration || (r.end - r.start)));
      r._coverageKey = key;
    }
    const maxCoverage = Math.max(0, ...coverageBySpeaker.values());
    const accepted = repairs.filter((r) => {
      const span = r.repairSpanDuration || (r.end - r.start);
      return r.consensus >= cfg.minConsensus
        && span >= DEFAULTS.minRepairSpan
        && (repairs.length === 1
          || coverageBySpeaker.get(r._coverageKey) >= maxCoverage * cfg.minRelativeSpan);
    });

    if (accepted.length) {
      recoveredGroups++;
      accepted.sort((a, b) => a.start - b.start || a.end - b.end);
      for (const r of accepted) {
        chosen.push({
          start: r.start, end: r.end, text: r.text,
          chainId: r.chainId, speakerHint: r.speakerHint,
          overlapRecovered: true,
        });
      }
    } else if (base && String(base.text || '').trim()) {
      chosen.push({
        start: base.start, end: base.end, text: String(base.text).trim(),
        chainId: base.chainId,
      });
    }
  }

  chosen.sort((a, b) => a.start - b.start || a.end - b.end);
  const out = [];
  for (const item of chosen) {
    const prev = out[out.length - 1];
    let text = item.text;
    const sameTrack = prev && (
      (prev.speakerHint == null && item.speakerHint == null)
      || (prev.speakerHint != null && prev.speakerHint === item.speakerHint)
    );
    if (prev && sameTrack && prev.chainId === item.chainId && item.start < prev.end) {
      text = trimRepeatedPrefix(prev.text, text);
    }
    if (!text) continue;
    out.push({ ...item, text });
  }

  return {
    segments: out.map(({ chainId, speakerHint, ...s }) => s),
    recoveredGroups,
  };
}

module.exports = {
  DEFAULTS,
  splitStrictSegments,
  detectOverlapIntervals,
  buildRecognitionItems,
  levenshtein,
  selectConsensus,
  finalizeRecognition,
};
