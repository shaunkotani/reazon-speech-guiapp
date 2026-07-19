'use strict';

const DEFAULT_TRIAL_DURATION_SECONDS = 60;
const MIN_TRIAL_DURATION_SECONDS = 10;
const MAX_TRIAL_DURATION_SECONDS = 180;
const DEFAULT_CONTEXT_SECONDS = 1.5;

function finiteNumber(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function normalizeTrialRange(value = {}) {
  const startSeconds = Math.max(0, finiteNumber(value.startSeconds, 0));
  const durationSeconds = Math.min(
    MAX_TRIAL_DURATION_SECONDS,
    Math.max(MIN_TRIAL_DURATION_SECONDS, finiteNumber(value.durationSeconds, DEFAULT_TRIAL_DURATION_SECONDS)),
  );
  const contextSeconds = Math.min(3, Math.max(0, finiteNumber(value.contextSeconds, DEFAULT_CONTEXT_SECONDS)));
  return { startSeconds, durationSeconds, contextSeconds };
}

// 指定範囲の端で発話を切らないよう、デコード範囲には前後の文脈を含める。
// selectionStart/End は、切り出した PCM 内で利用者が指定した範囲を表す。
function buildDecodeWindow(value) {
  const range = normalizeTrialRange(value);
  const decodeStartSeconds = Math.max(0, range.startSeconds - range.contextSeconds);
  const selectionStartSeconds = range.startSeconds - decodeStartSeconds;
  return {
    ...range,
    decodeStartSeconds,
    decodeDurationSeconds: selectionStartSeconds + range.durationSeconds + range.contextSeconds,
    selectionStartSeconds,
    selectionEndSeconds: selectionStartSeconds + range.durationSeconds,
  };
}

function overlapsSelection(segment, startSeconds, endSeconds) {
  if (!segment) return false;
  const start = finiteNumber(segment.start, 0);
  const end = finiteNumber(segment.end, start);
  return end > startSeconds && start < endSeconds;
}

function selectSegments(segments, startSeconds, endSeconds) {
  const values = Array.isArray(segments) ? segments : [];
  return values.filter((segment) => overlapsSelection(segment, startSeconds, endSeconds));
}

function offsetSegments(segments, offsetSeconds) {
  const offset = finiteNumber(offsetSeconds, 0);
  return (Array.isArray(segments) ? segments : []).map((segment) => ({
    ...segment,
    start: Math.max(0, finiteNumber(segment.start, 0) + offset),
    end: Math.max(0, finiteNumber(segment.end, 0) + offset),
  }));
}

module.exports = {
  DEFAULT_TRIAL_DURATION_SECONDS,
  MIN_TRIAL_DURATION_SECONDS,
  MAX_TRIAL_DURATION_SECONDS,
  DEFAULT_CONTEXT_SECONDS,
  normalizeTrialRange,
  buildDecodeWindow,
  overlapsSelection,
  selectSegments,
  offsetSegments,
};
