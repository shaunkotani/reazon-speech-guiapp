(function initCorrections(root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.TranscriptCorrections = api;
}(typeof globalThis !== 'undefined' ? globalThis : this, () => {
  'use strict';

  function finite(value, fallback = null) {
    const number = Number(value);
    return Number.isFinite(number) ? number : fallback;
  }

  function clamp(value, min, max) {
    return Math.max(min, Math.min(max, value));
  }

  function normalizedRange(range = {}, fallbackDuration = 0) {
    const start = Math.max(0, finite(range.startSeconds, finite(range.start, 0)));
    let end = finite(range.endSeconds, finite(range.end, null));
    if (end == null) {
      const duration = finite(
        range.actualDurationSeconds,
        finite(range.durationSeconds, finite(range.requestedDurationSeconds, fallbackDuration)),
      );
      end = start + Math.max(0, duration || 0);
    }
    if (!(end > start)) end = start + Math.max(0.1, finite(fallbackDuration, 0.1));
    return { start, end };
  }

  function validRowTime(row) {
    const start = finite(row && row.start, null);
    const end = finite(row && row.end, null);
    return start != null && end != null && end > start ? { start, end } : null;
  }

  function textWeight(text) {
    return Math.max(1, Array.from(String(text || '').replace(/\s/g, '')).length);
  }

  // 時刻のない追加発言だけを前後の確定時刻から補間する。ユーザーが明示した
  // 時刻は、別話者との重なりや発話順の入れ替わりも含め、そのまま保持する。
  function resolveRowTimes(rows, start, end) {
    const source = rows.map((row) => ({ ...row, _time: validRowTime(row) }));
    const out = source.map((row) => {
      if (!row._time) return null;
      const rowStart = clamp(row._time.start, start, Math.max(start, end - 0.001));
      return {
        ...row,
        start: rowStart,
        end: clamp(row._time.end, Math.min(end, rowStart + 0.001), end),
      };
    });

    let index = 0;
    while (index < source.length) {
      if (out[index]) { index++; continue; }
      const groupStartIndex = index;
      while (index < source.length && !out[index]) index++;
      const groupEndIndex = index;
      const previous = groupStartIndex > 0 ? out[groupStartIndex - 1] : null;
      const next = groupEndIndex < out.length ? out[groupEndIndex] : null;
      let groupStart = previous ? previous.end : start;
      let groupEnd = next ? next.start : end;
      // 明示区間同士が重なっていて隙間が無い場合は、テスト範囲の残りへ
      // 最小区間を置く。UI では時刻指定を促すが、旧データも失わない。
      if (!(groupEnd > groupStart)) {
        groupStart = clamp(groupStart, start, Math.max(start, end - 0.001));
        groupEnd = Math.min(end, groupStart + 0.001 * (groupEndIndex - groupStartIndex));
      }
      const group = source.slice(groupStartIndex, groupEndIndex);
      const weights = group.map((row) => textWeight(row.text));
      const totalWeight = weights.reduce((sum, value) => sum + value, 0);
      const available = Math.max(0.001 * group.length, groupEnd - groupStart);
      let position = groupStart;
      group.forEach((row, offset) => {
        const isLast = offset === group.length - 1;
        const duration = available * weights[offset] / totalWeight;
        const rowEnd = isLast ? groupEnd : Math.min(groupEnd, position + duration);
        out[groupStartIndex + offset] = {
          ...row,
          start: position,
          end: Math.max(position + 0.001, rowEnd),
        };
        position = Math.max(position + 0.001, rowEnd);
      });
    }
    return out.map(({ _time, ...row }) => row);
  }

  function createCorrectionBlock({ id, range, rows, replaceEntireRange = false } = {}) {
    const sourceRange = normalizedRange(range || {});
    const normalizedRows = (Array.isArray(rows) ? rows : []).map((row, order) => {
      const speakerId = row && row.speakerId != null ? row.speakerId : (row && row.speaker);
      const sourceTime = validRowTime({
        start: row && row.sourceStart,
        end: row && row.sourceEnd,
      });
      const operation = String(row && (row.operation || row.kind) || 'replace') === 'insert'
        ? 'insert' : 'replace';
      return {
        text: String(row && row.text || '').trim(),
        speakerId: String(speakerId == null ? '' : speakerId),
        speakerName: String(row && row.speakerName || '').trim(),
        start: finite(row && row.start, null),
        end: finite(row && row.end, null),
        sourceStart: sourceTime ? sourceTime.start : null,
        sourceEnd: sourceTime ? sourceTime.end : null,
        operation,
        confirmed: row && row.confirmed !== false,
        order,
      };
    }).filter((row) => row.text && row.confirmed);
    if (!normalizedRows.length) return null;

    const timedRows = normalizedRows.map(validRowTime).filter(Boolean);
    const sourceTimes = normalizedRows.map((row) => validRowTime({
      start: row.sourceStart, end: row.sourceEnd,
    })).filter(Boolean);
    let start = replaceEntireRange ? sourceRange.start : Math.min(
      ...timedRows.concat(sourceTimes).map((time) => time.start),
    );
    let end = replaceEntireRange ? sourceRange.end : Math.max(
      ...timedRows.concat(sourceTimes).map((time) => time.end),
    );
    if (!replaceEntireRange && !validRowTime(normalizedRows[0])) start = sourceRange.start;
    if (!replaceEntireRange && !validRowTime(normalizedRows[normalizedRows.length - 1])) end = sourceRange.end;
    if (!Number.isFinite(start) || !Number.isFinite(end) || !(end > start)) ({ start, end } = sourceRange);
    const blockId = String(id || `correction-${Date.now()}`);
    const resolvedRows = resolveRowTimes(normalizedRows, start, end).map((row) => ({
      ...row,
      correctionSpeakerKey: `${blockId}:${row.speakerId || 'speaker'}`,
    }));
    return {
      id: blockId,
      start,
      end,
      sourceStart: sourceRange.start,
      sourceEnd: sourceRange.end,
      replaceEntireRange: replaceEntireRange === true,
      rows: resolvedRows,
    };
  }

  function overlaps(startA, endA, startB, endB) {
    return endA > startB && startA < endB;
  }

  function upsertCorrectionBlock(blocks, block) {
    const existing = Array.isArray(blocks) ? blocks : [];
    if (!block) return existing.slice();
    const blockStart = finite(block.sourceStart, block.start);
    const blockEnd = finite(block.sourceEnd, block.end);
    return existing
      .filter((item) => {
        if (!item || item.id === block.id) return false;
        const itemStart = finite(item.sourceStart, item.start);
        const itemEnd = finite(item.sourceEnd, item.end);
        return !overlaps(itemStart, itemEnd, blockStart, blockEnd);
      })
      .concat(block)
      .sort((a, b) => a.start - b.start || a.end - b.end);
  }

  function resultRange(result) {
    if (result && result.range) return normalizedRange(result.range, result.duration);
    return normalizedRange({ startSeconds: 0, durationSeconds: result && result.duration }, result && result.duration);
  }

  function applyCorrections(result, blocks) {
    const source = result || {};
    // 再適用時の二重挿入を防ぐため、確定行はいったん外し、保持中の block から再構築する。
    let segments = (Array.isArray(source.segments) ? source.segments : [])
      .filter((segment) => !segment.lockedCorrection)
      .map((segment) => ({ ...segment }));
    const visible = resultRange(source);
    const applied = [];
    const orderedBlocks = (Array.isArray(blocks) ? blocks : [])
      .filter((block) => block && overlaps(block.start, block.end, visible.start, visible.end))
      .slice()
      .sort((a, b) => a.start - b.start || a.end - b.end);

    for (const block of orderedBlocks) {
      if (block.replaceEntireRange === true) {
        segments = segments.filter((segment) => {
          const start = finite(segment.start, 0);
          const end = finite(segment.end, start + 0.001);
          return !overlaps(start, Math.max(start + 0.001, end), block.start, block.end);
        });
      } else {
        // 行単位の修正は、元区間と最もよく重なる認識結果を1件だけ置き換える。
        // 「追加」行は何も削除しないため、同時発話を別レイヤーとして保持できる。
        const removeIndexes = new Set();
        for (const row of block.rows || []) {
          if (row.operation === 'insert') continue;
          const sourceTime = validRowTime({
            start: row.sourceStart != null ? row.sourceStart : row.start,
            end: row.sourceEnd != null ? row.sourceEnd : row.end,
          });
          if (!sourceTime) continue;
          let bestIndex = -1;
          let bestOverlap = 0;
          let bestDistance = Infinity;
          segments.forEach((segment, index) => {
            if (removeIndexes.has(index)) return;
            const segmentTime = validRowTime(segment);
            if (!segmentTime) return;
            const hit = Math.max(0, Math.min(segmentTime.end, sourceTime.end)
              - Math.max(segmentTime.start, sourceTime.start));
            const distance = Math.abs(
              (segmentTime.start + segmentTime.end) / 2 - (sourceTime.start + sourceTime.end) / 2,
            );
            if (hit > bestOverlap + 1e-9 || (Math.abs(hit - bestOverlap) <= 1e-9 && distance < bestDistance)) {
              bestIndex = index;
              bestOverlap = hit;
              bestDistance = distance;
            }
          });
          if (bestIndex >= 0 && bestOverlap > 0) {
            const selected = [bestIndex];
            removeIndexes.add(bestIndex);
            // 再認識で1発話が複数の連続区間へ分かれた場合は、その断片も置換する。
            // 選択済み区間と時間的に重なる候補は同時発話の可能性があるため残す。
            segments.forEach((segment, index) => {
              if (removeIndexes.has(index)) return;
              const segmentTime = validRowTime(segment);
              if (!segmentTime) return;
              const midpoint = (segmentTime.start + segmentTime.end) / 2;
              const hit = Math.max(0, Math.min(segmentTime.end, sourceTime.end)
                - Math.max(segmentTime.start, sourceTime.start));
              if (hit < 0.05 || midpoint < sourceTime.start || midpoint > sourceTime.end) return;
              const crossesSelected = selected.some((selectedIndex) => {
                const selectedTime = validRowTime(segments[selectedIndex]);
                if (!selectedTime) return false;
                const shared = Math.min(segmentTime.end, selectedTime.end)
                  - Math.max(segmentTime.start, selectedTime.start);
                const shorter = Math.min(segmentTime.end - segmentTime.start,
                  selectedTime.end - selectedTime.start);
                return shared > 0.05 && shared / Math.max(0.001, shorter) >= 0.35;
              });
              if (!crossesSelected) {
                selected.push(index);
                removeIndexes.add(index);
              }
            });
          }
        }
        segments = segments.filter((_segment, index) => !removeIndexes.has(index));
      }
      block.rows.forEach((row) => {
        if (!overlaps(row.start, row.end, visible.start, visible.end)) return;
        segments.push({
          start: row.start,
          end: row.end,
          text: row.text,
          lockedCorrection: true,
          correctionId: block.id,
          correctionOrder: row.order,
          correctionSpeakerId: row.speakerId,
          correctionSpeakerName: row.speakerName,
          correctionSpeakerKey: row.correctionSpeakerKey,
          correctionOperation: row.operation || 'replace',
          correctionSourceStart: row.sourceStart,
          correctionSourceEnd: row.sourceEnd,
        });
      });
      applied.push(block.id);
    }

    segments.sort((a, b) => {
      const time = finite(a.start, 0) - finite(b.start, 0);
      if (Math.abs(time) > 1e-9) return time;
      if (a.correctionId && a.correctionId === b.correctionId) {
        return finite(a.correctionOrder, 0) - finite(b.correctionOrder, 0);
      }
      return a.lockedCorrection ? -1 : (b.lockedCorrection ? 1 : 0);
    });
    return {
      ...source,
      segments,
      text: segments.map((segment) => segment.text).join('\n'),
      appliedCorrectionIds: [...new Set(applied)],
    };
  }

  return {
    normalizedRange,
    createCorrectionBlock,
    upsertCorrectionBlock,
    applyCorrections,
    overlaps,
  };
}));
