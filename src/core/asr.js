// ReazonSpeech ローカル文字起こしのコア処理
// - ffmpeg で任意の音声/動画を 16kHz mono float32 PCM に正規化
// - Silero VAD で発話区間に分割
// - 区間ごとに sherpa-onnx (reazonspeech-k2-v2) で認識し、開始/終了時刻つきセグメントを返す
//
// ネイティブ addon (`sherpa-onnx-node` + プラットフォーム別 .node) を使用する。
const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');
const sherpa = require('sherpa-onnx-node');
const { clusterEmbeddings, DIARIZE_THRESHOLD } = require('../shared/cluster');

const SAMPLE_RATE = 16000;

// asar 内パスは実行できないため、展開済み(app.asar.unpacked)を指すよう補正する
function unpackedPath(p) {
  return p.replace('app.asar' + path.sep, 'app.asar.unpacked' + path.sep)
          .replace('app.asar/', 'app.asar.unpacked/');
}

/**
 * 同梱の ffmpeg バイナリのパス。無ければ null。
 * 配布物にはライセンス上クリーンな LGPL ビルドを置く。
 * - パッケージ後: extraResources により resources/ffmpeg/<platform>-<arch>/
 * - 開発時: リポジトリ直下 vendor/ffmpeg/<platform>-<arch>/
 */
function bundledFfmpegPath() {
  const bin = process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg';
  const rel = path.join('ffmpeg', `${process.platform}-${process.arch}`, bin);
  const candidates = [
    process.resourcesPath ? path.join(process.resourcesPath, rel) : null, // パッケージ後
    path.join(__dirname, '..', '..', 'vendor', rel),                       // 開発時
  ].filter(Boolean);
  return candidates.find((p) => { try { return fs.existsSync(p); } catch (_) { return false; } }) || null;
}

/**
 * ffmpeg のパスを解決する。
 * 1) 同梱の LGPL ビルド（配布時はこれ） 2) 開発時フォールバックの ffmpeg-static
 * （GPL。配布物には含めない） 3) system の `ffmpeg`。
 */
function resolveFfmpegPath() {
  const bundled = bundledFfmpegPath();
  if (bundled) return bundled;
  try {
    const p = require('ffmpeg-static');
    if (p) return unpackedPath(p);
  } catch (_) { /* ignore */ }
  return 'ffmpeg';
}

/**
 * 任意の音声/動画ファイルを 16kHz mono の Float32Array にデコードする。
 * @param {string} filePath
 * @param {object} [opts] { maxSeconds?: number } 指定時は先頭からその秒数だけ取り出す
 * @returns {Promise<Float32Array>}
 */
function decodeToPcm(filePath, opts = {}) {
  return new Promise((resolve, reject) => {
    const ffmpeg = resolveFfmpegPath();
    const args = ['-nostdin'];
    if (opts.startSeconds && opts.startSeconds > 0) {
      args.push('-ss', String(opts.startSeconds)); // 入力シーク（高速）。区間切り出し用
    }
    args.push('-i', filePath);
    if (opts.maxSeconds && opts.maxSeconds > 0) {
      args.push('-t', String(opts.maxSeconds)); // N 秒だけ
    }
    args.push(
      '-ar', String(SAMPLE_RATE),
      '-ac', '1',
      '-f', 'f32le',
      '-acodec', 'pcm_f32le',
      '-',
    );
    const proc = spawn(ffmpeg, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    const chunks = [];
    let stderr = '';
    proc.stdout.on('data', (c) => chunks.push(c));
    proc.stderr.on('data', (c) => { stderr += c.toString(); });
    proc.on('error', reject);
    proc.on('close', (code) => {
      if (code !== 0) {
        return reject(new Error(`ffmpeg exited with code ${code}\n${stderr.slice(-2000)}`));
      }
      const buf = Buffer.concat(chunks);
      // little-endian float32。Buffer が 4byte 境界に揃うようにコピーする。
      const usable = buf.length - (buf.length % 4);
      const samples = new Float32Array(usable / 4);
      for (let i = 0; i < samples.length; i++) {
        samples[i] = buf.readFloatLE(i * 4);
      }
      resolve(samples);
    });
  });
}

/**
 * オフライン認識器を生成する。
 *
 * ホットワード辞書を渡すと復号を modified_beam_search に切り替える
 * （hotwords は beam search でしか効かない）。tokens.txt は日本語文字が
 * そのまま 1 トークンの「文字ベース」モデルなので modelingUnit='cjkchar' を
 * 指定し、hotwords ファイルの各語を文字単位に分割してマッチさせる。
 *
 * @param {string} modelDir reazonspeech-k2-v2 モデルのディレクトリ
 * @param {object} [opts]
 * @param {number} [opts.numThreads=2]
 * @param {string} [opts.hotwordsFile] 1行1語のホットワード辞書パス（空/不在なら無効）
 * @param {number} [opts.hotwordsScore=2.0] ホットワードの加点（大きいほど強制力↑・誤挿入リスク↑）
 * @param {number} [opts.maxActivePaths=4] beam search の探索幅
 * @param {boolean} [opts.beamSearch=false] 辞書が無くても modified_beam_search を使う（高精度モード・やや低速）
 */
function createRecognizer(modelDir, { numThreads = 2, hotwordsFile = '', hotwordsScore = 2.0, maxActivePaths = 4, beamSearch = false } = {}) {
  const useHotwords = !!hotwordsFile && fs.existsSync(hotwordsFile) && fs.statSync(hotwordsFile).size > 0;
  // 辞書は beam search 必須なので、辞書があれば高精度モードは強制 ON になる
  const useBeam = useHotwords || beamSearch;
  const modelConfig = {
    transducer: {
      encoder: path.join(modelDir, 'encoder-epoch-99-avg-1.int8.onnx'),
      decoder: path.join(modelDir, 'decoder-epoch-99-avg-1.int8.onnx'),
      joiner: path.join(modelDir, 'joiner-epoch-99-avg-1.int8.onnx'),
    },
    tokens: path.join(modelDir, 'tokens.txt'),
    numThreads,
    provider: 'cpu',
    debug: 0,
    modelType: 'transducer',
  };
  if (useHotwords) modelConfig.modelingUnit = 'cjkchar';
  return new sherpa.OfflineRecognizer({
    featConfig: { sampleRate: SAMPLE_RATE, featureDim: 80 },
    modelConfig,
    decodingMethod: useBeam ? 'modified_beam_search' : 'greedy_search',
    maxActivePaths,
    hotwordsFile: useHotwords ? hotwordsFile : '',
    hotwordsScore: useHotwords ? hotwordsScore : 0,
  });
}

/**
 * ノイズ除去器（GTCRN）を生成する。
 * @param {string} modelPath gtcrn_simple.onnx のパス
 */
function createDenoiser(modelPath, { numThreads = 1 } = {}) {
  return new sherpa.OfflineSpeechDenoiser({
    model: {
      gtcrn: { model: modelPath },
      numThreads,
      provider: 'cpu',
      debug: 0,
    },
  });
}

/**
 * PCM にノイズ除去をかける。strength(0..1) で原音とブレンドして除去強度を調整する。
 * 0 なら原音そのまま、1 なら完全除去。
 * @returns {Float32Array}
 */
function denoisePcm(denoiser, samples, strength) {
  if (!denoiser || !strength || strength <= 0) return samples;
  const a = Math.min(1, strength);
  // enableExternalBuffer=false: Electron では外部バッファ不可
  const out = denoiser.run({ samples, sampleRate: SAMPLE_RATE, enableExternalBuffer: false });
  const den = out.samples;
  if (a >= 1) return den;
  // 長さ差に備えて短い方に合わせてブレンド
  const n = Math.min(den.length, samples.length);
  const mixed = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    mixed[i] = (1 - a) * samples[i] + a * den[i];
  }
  return mixed;
}

/** PCM を WAV ファイルへ書き出す（プレビュー用）。 */
function writePcmToWav(samples, outPath) {
  sherpa.writeWave(outPath, { samples, sampleRate: SAMPLE_RATE });
  return outPath;
}

// ワーカー間で復号済み PCM を共有するための raw float32 入出力。
// sherpa.readWave は Electron で外部バッファを返して使えないため、自前で読み書きする。
function writePcmRaw(samples, outPath) {
  fs.writeFileSync(outPath, Buffer.from(samples.buffer, samples.byteOffset, samples.byteLength));
  return outPath;
}

function readPcmRaw(p) {
  const buf = fs.readFileSync(p);
  const n = Math.floor(buf.length / 4);
  const out = new Float32Array(n); // 通常 ArrayBuffer（外部バッファ回避）
  for (let i = 0; i < n; i++) out[i] = buf.readFloatLE(i * 4);
  return out;
}

/**
 * raw float32 PCM ファイルを 16bit PCM WAV へ変換する（リアルタイム録音の保存用）。
 * 録音は長時間になり得るため、全体をメモリへ載せずチャンク単位で変換する。
 */
function convertPcmFileToWav(pcmPath, wavPath) {
  const n = Math.floor(fs.statSync(pcmPath).size / 4);
  const dataBytes = n * 2;
  const header = Buffer.alloc(44);
  header.write('RIFF', 0);
  header.writeUInt32LE(36 + dataBytes, 4);
  header.write('WAVE', 8);
  header.write('fmt ', 12);
  header.writeUInt32LE(16, 16);              // fmt チャンク長
  header.writeUInt16LE(1, 20);               // PCM
  header.writeUInt16LE(1, 22);               // mono
  header.writeUInt32LE(SAMPLE_RATE, 24);
  header.writeUInt32LE(SAMPLE_RATE * 2, 28); // byte rate
  header.writeUInt16LE(2, 32);               // block align
  header.writeUInt16LE(16, 34);              // bits per sample
  header.write('data', 36);
  header.writeUInt32LE(dataBytes, 40);

  const inFd = fs.openSync(pcmPath, 'r');
  const outFd = fs.openSync(wavPath, 'w');
  try {
    fs.writeSync(outFd, header);
    const inBuf = Buffer.alloc(1 << 20);
    for (;;) {
      const read = fs.readSync(inFd, inBuf, 0, inBuf.length, null);
      if (read <= 0) break;
      const m = Math.floor(read / 4);
      const outBuf = Buffer.alloc(m * 2);
      for (let i = 0; i < m; i++) {
        const v = Math.max(-1, Math.min(1, inBuf.readFloatLE(i * 4)));
        outBuf.writeInt16LE(Math.round(v * 32767), i * 2);
      }
      fs.writeSync(outFd, outBuf);
    }
  } finally {
    fs.closeSync(inFd);
    fs.closeSync(outFd);
  }
  return wavPath;
}

// ==== 話者分離（VAD 区間ごとの埋め込み + 自前クラスタリング） ====
// クラスタリング本体は ../shared/cluster.js（純 JS）に分離。

/**
 * 話者埋め込み抽出器を生成する。
 * @param {string} embPath 話者埋め込み .onnx（wespeaker 等）
 */
function createEmbeddingExtractor(embPath, { numThreads = 1 } = {}) {
  return new sherpa.SpeakerEmbeddingExtractor({
    model: embPath, numThreads, provider: 'cpu', debug: 0,
  });
}

/**
 * pyannote の話者セグメンテーションと埋め込みを組み合わせた話者区間検出器。
 * 重なった話者は同じ時刻を共有する複数区間として返るため、VAD の補助に使える。
 */
function createSpeakerDiarizer(segmentationPath, embeddingPath, {
  numSpeakers = 2, numThreads = 1, threshold = 0.5,
} = {}) {
  const clusters = Number.isInteger(numSpeakers) && numSpeakers >= 2 ? numSpeakers : -1;
  return new sherpa.OfflineSpeakerDiarization({
    segmentation: {
      pyannote: { model: segmentationPath },
      numThreads, provider: 'cpu', debug: 0,
    },
    embedding: {
      model: embeddingPath,
      numThreads, provider: 'cpu', debug: 0,
    },
    clustering: { numClusters: clusters, threshold },
    // 短い相槌と短い重畳を落とさず、結合判断は後段の純 JS で行う。
    minDurationOn: 0,
    minDurationOff: 0,
  });
}

/**
 * 1 区間分のサンプルから話者埋め込みベクトルを抽出する。
 * @returns {Float32Array}
 */
function extractEmbedding(extractor, samples) {
  const stream = extractor.createStream();
  stream.acceptWaveform({ sampleRate: SAMPLE_RATE, samples });
  stream.inputFinished();
  // enableExternalBuffer=false: Electron では外部バッファ不可
  return extractor.compute(stream, false);
}

// ==== VAD（発話区間検出）の設定 ====
//
// 認識モデル reazonspeech-k2-v2 は短い発話で学習された RNN-T のため、長い区間を
// そのまま渡すと出力が数トークンに潰れて中身がほぼ失われる。つまり VAD が区間を
// 切れるかどうかが認識結果を直接左右する。相槌が重なる電話・会議の音声では
// 無音がほとんど発生せず、区切りが入らないまま上限まで伸びてしまうため、
// 用途に応じて調整できるようにしている。
const DEFAULT_VAD = {
  threshold: 0.5,          // 発話と判定する確信度。低いほど小声も拾うがノイズも拾う
  minSilenceDuration: 0.2,  // この長さの無音で区間を区切る。短いほど細かく割れる
  minSpeechDuration: 0.15,  // これより短い音は発話とみなさない（クリック音などの除去）
  maxSpeechDuration: 6,     // 無音が来なくてもこの秒数で強制的に区切る
};

// 用途別プリセット。samples/ の会話・独話音声を、認識結果まで通して比較した値。
// conversation / interview は重なりのある会話を積極的に分割し、
// lecture は語中分割を抑える。
const VAD_PRESETS = {
  standard:     { threshold: 0.5,  minSilenceDuration: 0.2,  minSpeechDuration: 0.15, maxSpeechDuration: 6 },
  conversation: { threshold: 0.7,  minSilenceDuration: 0.1,  minSpeechDuration: 0.2,  maxSpeechDuration: 3 },
  interview:    { threshold: 0.2,  minSilenceDuration: 0.1,  minSpeechDuration: 0.15, maxSpeechDuration: 3 },
  lecture:      { threshold: 0.45, minSilenceDuration: 0.35, minSpeechDuration: 0.15, maxSpeechDuration: 8 },
};

// UI や IPC から来た値を安全な範囲に丸める。未指定の項目は標準値で埋める。
function normalizeVadOptions(opts) {
  const clamp = (v, lo, hi, dflt) =>
    (typeof v === 'number' && isFinite(v)) ? Math.min(hi, Math.max(lo, v)) : dflt;
  const base = (opts && typeof opts.preset === 'string' && VAD_PRESETS[opts.preset])
    ? VAD_PRESETS[opts.preset]
    : DEFAULT_VAD;
  const o = opts || {};
  return {
    threshold:          clamp(o.threshold,          0.1,  0.9, base.threshold),
    minSilenceDuration: clamp(o.minSilenceDuration, 0.05, 2.0, base.minSilenceDuration),
    minSpeechDuration:  clamp(o.minSpeechDuration,  0.05, 1.0, base.minSpeechDuration),
    maxSpeechDuration:  clamp(o.maxSpeechDuration,  2,    30,  base.maxSpeechDuration),
  };
}

/**
 * VAD を生成する。
 * @param {string} vadModelPath silero_vad.onnx のパス
 * @param {object} [opts] DEFAULT_VAD の各項目を上書きできる。
 *   `preset` に VAD_PRESETS のキーを渡すと、その値を土台にする。
 */
function createVad(vadModelPath, opts = {}) {
  const { numThreads = 1, bufferSizeInSeconds = 60 } = opts;
  return new sherpa.Vad({
    sileroVad: {
      model: vadModelPath,
      ...normalizeVadOptions(opts),
      windowSize: 512,
    },
    sampleRate: SAMPLE_RATE,
    numThreads,
    provider: 'cpu',
    debug: 0,
  }, bufferSizeInSeconds);
}

// RNNT は区間先頭に無音が無いと最初の語を取りこぼすことがあるため、
// 各区間の前後に短い無音を付与してウォームアップさせる。
const PAD_SEC = 0.3;

function padSamples(samples) {
  const pad = Math.round(PAD_SEC * SAMPLE_RATE);
  const out = new Float32Array(pad + samples.length + pad);
  out.set(samples, pad);
  return out;
}

/**
 * 1つの発話区間を認識する（非同期・イベントループを塞がない）。
 */
async function recognizeSegment(recognizer, samples) {
  const stream = recognizer.createStream();
  stream.acceptWaveform({ sampleRate: SAMPLE_RATE, samples: padSamples(samples) });
  const r = await recognizer.decodeAsync(stream);
  return r;
}

/**
 * PCM を VAD で発話区間に分割し、各区間のサンプルを返す。
 * @returns {Array<{start:number,end:number,samples:Float32Array}>}
 */
function collectVadSegments(samples, vad) {
  vad.reset();
  const segs = [];
  const window = 512;
  const drain = () => {
    while (!vad.isEmpty()) {
      const seg = vad.front(false); // 外部バッファ不可
      vad.pop();
      segs.push({
        start: seg.start / SAMPLE_RATE,
        end: (seg.start + seg.samples.length) / SAMPLE_RATE,
        samples: seg.samples,
      });
    }
  };
  for (let i = 0; i < samples.length; i += window) {
    vad.acceptWaveform(samples.subarray(i, i + window));
    drain();
  }
  vad.flush();
  drain();
  return segs;
}

/**
 * リアルタイム用: PCM チャンクを逐次受け取り、確定した発話区間を返す。
 * collectVadSegments のストリーミング版。同じ front(false)/pop 方式で、
 * 時刻は feed 開始からの絶対秒。チャンク長は任意（内部で 512 サンプル窓に揃える）。
 */
class RealtimeSegmenter {
  constructor(vad) {
    this.vad = vad;
    vad.reset();
    this.win = new Float32Array(512);
    this.winFill = 0;
  }

  _drain(out) {
    while (!this.vad.isEmpty()) {
      const seg = this.vad.front(false); // 外部バッファ不可
      this.vad.pop();
      out.push({
        start: seg.start / SAMPLE_RATE,
        end: (seg.start + seg.samples.length) / SAMPLE_RATE,
        samples: seg.samples,
      });
    }
  }

  /** @param {Float32Array} chunk @returns 確定した発話区間の配列 */
  feed(chunk) {
    const out = [];
    let i = 0;
    while (i < chunk.length) {
      const n = Math.min(512 - this.winFill, chunk.length - i);
      this.win.set(chunk.subarray(i, i + n), this.winFill);
      this.winFill += n;
      i += n;
      if (this.winFill === 512) {
        // acceptWaveform は内部バッファへコピーするため win の再利用は安全
        this.vad.acceptWaveform(this.win);
        this.winFill = 0;
        this._drain(out);
      }
    }
    return out;
  }

  /** 残りを流し切り、末尾の区間を確定させる（録音停止時に一度だけ呼ぶ）。 */
  flush() {
    const out = [];
    if (this.winFill > 0) {
      this.vad.acceptWaveform(this.win.subarray(0, this.winFill));
      this.winFill = 0;
    }
    this.vad.flush();
    this._drain(out);
    return out;
  }
}

/**
 * ファイルを VAD で分割しつつ文字起こしする（単一ワーカー版）。
 * 並列版はメインプロセスのワーカープールが担う。話者分離は埋め込み+クラスタリング。
 */
async function transcribeFile(filePath, ctx, opts = {}) {
  const { recognizer, vad, denoiser, embedder } = ctx;
  const onProgress = opts.onProgress || (() => {});
  let samples = await decodeToPcm(filePath);
  if (denoiser && opts.denoiseStrength > 0) {
    samples = denoisePcm(denoiser, samples, opts.denoiseStrength);
  }
  const duration = samples.length / SAMPLE_RATE;

  const vadSegs = collectVadSegments(samples, vad);
  const segments = [];
  const embeddings = [];
  for (let i = 0; i < vadSegs.length; i++) {
    const seg = vadSegs[i];
    const r = await recognizeSegment(recognizer, seg.samples);
    const text = (r.text || '').trim();
    if (!text) continue;
    const entry = { start: seg.start, end: seg.end, text };
    if (opts.diarize && embedder) {
      embeddings.push(extractEmbedding(embedder, seg.samples));
      entry._emb = embeddings.length - 1;
    }
    segments.push(entry);
    onProgress(Math.min(0.99, (i + 1) / vadSegs.length));
  }
  onProgress(1);

  let diarized = false;
  let speakerCount = 0;
  if (opts.diarize && embedder && embeddings.length) {
    const labels = clusterEmbeddings(embeddings, { numSpeakers: opts.numSpeakers || 0 });
    for (const s of segments) { s.speaker = labels[s._emb]; delete s._emb; }
    diarized = true;
    speakerCount = new Set(labels).size;
  } else {
    for (const s of segments) delete s._emb;
  }

  return {
    segments,
    text: segments.map((s) => s.text).join('\n'),
    duration, diarized, speakerCount,
  };
}

/**
 * ファイルをデコード（必要ならノイズ除去）して WAV へ書き出す（プレビュー用）。
 * @returns {Promise<{wavPath:string, duration:number}>}
 */
async function renderPreviewWav(filePath, ctx, outPath, { denoiseStrength = 0, maxSeconds = 0 } = {}) {
  let samples = await decodeToPcm(filePath, { maxSeconds });
  if (ctx.denoiser && denoiseStrength > 0) {
    samples = denoisePcm(ctx.denoiser, samples, denoiseStrength);
  }
  writePcmToWav(samples, outPath);
  return { wavPath: outPath, duration: samples.length / SAMPLE_RATE };
}

module.exports = {
  SAMPLE_RATE,
  DEFAULT_VAD,
  VAD_PRESETS,
  normalizeVadOptions,
  resolveFfmpegPath,
  decodeToPcm,
  createRecognizer,
  createVad,
  createDenoiser,
  createEmbeddingExtractor,
  createSpeakerDiarizer,
  extractEmbedding,
  clusterEmbeddings,
  collectVadSegments,
  RealtimeSegmenter,
  recognizeSegment,
  writePcmRaw,
  readPcmRaw,
  convertPcmFileToWav,
  denoisePcm,
  writePcmToWav,
  renderPreviewWav,
  transcribeFile,
};
