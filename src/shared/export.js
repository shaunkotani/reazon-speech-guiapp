// 文字起こし結果を各種フォーマットへ整形する純粋関数群（main/renderer 双方から利用可）。

function pad2(n) { return String(n).padStart(2, '0'); }
function pad3(n) { return String(n).padStart(3, '0'); }

/** 秒 -> "HH:MM:SS,mmm"（SRT） / sep を "." にすれば VTT 形式 */
function formatTime(sec, sep = ',') {
  const ms = Math.floor((sec % 1) * 1000);
  const total = Math.floor(sec);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  return `${pad2(h)}:${pad2(m)}:${pad2(s)}${sep}${pad3(ms)}`;
}

/** 秒 -> "HH:MM:SS"（プレーンテキストの時刻プレフィックス用、ミリ秒なし） */
function formatClock(sec) {
  const total = Math.floor(sec);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  return `${pad2(h)}:${pad2(m)}:${pad2(s)}`;
}

/** 区間の時刻プレフィックス "[HH:MM:SS --> HH:MM:SS] "。 */
function timePrefix(s) {
  return `[${formatClock(s.start)} --> ${formatClock(s.end)}] `;
}

/** 話者名を返す（名前指定があればそれ、無ければ 話者N、不明は 話者不明）。 */
function speakerName(spk, names) {
  if (spk == null) return '';
  if (spk < 0) return '話者不明';
  return (names && names[spk]) ? names[spk] : `話者${spk + 1}`;
}

/** 話者プレフィックス（"名前: "）。話者情報が無ければ空文字。 */
function speakerPrefix(s, names) {
  const n = speakerName(s.speaker, names);
  return n ? `${n}: ` : '';
}

function toPlainText(segments, names) {
  return segments.map((s) => timePrefix(s) + speakerPrefix(s, names) + s.text).join('\n');
}

function toSRT(segments, names) {
  return segments.map((s, i) =>
    `${i + 1}\n${formatTime(s.start, ',')} --> ${formatTime(s.end, ',')}\n${speakerPrefix(s, names)}${s.text}\n`
  ).join('\n');
}

function toVTT(segments, names) {
  const body = segments.map((s) =>
    `${formatTime(s.start, '.')} --> ${formatTime(s.end, '.')}\n${speakerPrefix(s, names)}${s.text}\n`
  ).join('\n');
  return `WEBVTT\n\n${body}`;
}

function toJSON(result) {
  return JSON.stringify(result, null, 2);
}

const EXPORTERS = {
  txt: { ext: 'txt', mime: 'text/plain', build: (r) => toPlainText(r.segments, r.speakerNames) },
  srt: { ext: 'srt', mime: 'application/x-subrip', build: (r) => toSRT(r.segments, r.speakerNames) },
  vtt: { ext: 'vtt', mime: 'text/vtt', build: (r) => toVTT(r.segments, r.speakerNames) },
  json: { ext: 'json', mime: 'application/json', build: (r) => toJSON(r) },
};

module.exports = { formatTime, formatClock, timePrefix, toPlainText, toSRT, toVTT, toJSON, EXPORTERS };
