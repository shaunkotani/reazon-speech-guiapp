// ASR ワーカー（純 Node 環境で動かす子プロセス）。プールの 1 員として動く。
//
// Electron メインはネイティブ addon の外部バッファを拒否するため、推論は
// ELECTRON_RUN_AS_NODE=1 のこの子プロセスで実行する。
//
// 汎用 RPC: メインから {type:'request', rid, op, args} を受け、処理中は
// {type:'event', rid, ...} を送り、完了で {type:'response', rid, result} を返す。
const core = require('../core/asr');

let ctx = null;          // recognizer / VAD / denoiser / embedding / lazy diarizer
let pcmCache = null;     // { path, samples } 直近に読んだ PCM をキャッシュ

function init({ modelDir, vadPath, denoiserPath, embPath, segmentationPath, hotwordsFile, hotwordsScore, beamSearch }) {
  ctx = {
    // hotwordsFile があれば core 側で modified_beam_search + 辞書に切り替わる。
    // 辞書が無くても beamSearch=true なら高精度モード（beam search）で認識する。
    recognizer: core.createRecognizer(modelDir, { hotwordsFile: hotwordsFile || '', hotwordsScore, beamSearch: !!beamSearch }),
    vadPath,
    vad: core.createVad(vadPath),
    vadKey: JSON.stringify(core.normalizeVadOptions({})),
    denoiser: denoiserPath ? core.createDenoiser(denoiserPath) : null,
    embedder: embPath ? core.createEmbeddingExtractor(embPath) : null,
    embPath,
    segmentationPath,
    diarizer: null,
    diarizerKey: '',
  };
}

// VAD 設定はジョブごとに変わりうる。設定が変わった時だけ作り直す
// （silero_vad.onnx は数MBなので再生成は軽い。認識モデルには触らない）。
function vadFor(opts) {
  const key = JSON.stringify(core.normalizeVadOptions(opts));
  if (key !== ctx.vadKey) {
    ctx.vad = core.createVad(ctx.vadPath, opts || {});
    ctx.vadKey = key;
  }
  return ctx.vad;
}

function loadPcm(pcmPath) {
  if (pcmCache && pcmCache.path === pcmPath) return pcmCache.samples;
  const samples = core.readPcmRaw(pcmPath);
  pcmCache = { path: pcmPath, samples };
  return samples;
}

// pyannote は会話向けジョブでだけ使う。全プールで常時ロードするとメモリを
// 余分に消費するため、prepare を担当したワーカーに遅延生成する。
function diarizerFor(numSpeakers) {
  if (!ctx.segmentationPath || !ctx.embPath) return null;
  const n = Number.isInteger(numSpeakers) ? Math.min(4, Math.max(2, numSpeakers)) : 2;
  const key = String(n);
  if (!ctx.diarizer || ctx.diarizerKey !== key) {
    ctx.diarizer = core.createSpeakerDiarizer(ctx.segmentationPath, ctx.embPath, { numSpeakers: n });
    ctx.diarizerKey = key;
  }
  return ctx.diarizer;
}

// ---- 各オペレーション ----
const OPS = {
  // 原音で重なり検出 → ノイズ除去 → 共有 PCM 保存 → VAD/話者区間境界を返す
  async prepare({ filePath, denoiseStrength, outPath, vad, overlap }) {
    const rawSamples = await core.decodeToPcm(filePath);
    let speakerSegments = [];
    let overlapError = '';
    if (overlap && overlap.enabled) {
      try {
        const diarizer = diarizerFor(overlap.numSpeakers);
        if (diarizer) {
          speakerSegments = diarizer.process(rawSamples).map((s) => ({
            start: s.start, end: s.end, speaker: s.speaker,
          }));
        } else overlapError = '重なり検出モデルが見つかりません';
      } catch (e) {
        // 重なり補正だけを諦め、通常 VAD の文字起こしは継続する。
        overlapError = e.message || String(e);
      }
    }

    let samples = rawSamples;
    if (ctx.denoiser && denoiseStrength > 0) {
      samples = core.denoisePcm(ctx.denoiser, samples, denoiseStrength);
    }
    const duration = samples.length / core.SAMPLE_RATE;
    core.writePcmRaw(samples, outPath); // 共有用 raw float32
    const segs = core.collectVadSegments(samples, vadFor(vad));
    return {
      pcmPath: outPath,
      duration,
      segments: segs.map((s) => ({ start: s.start, end: s.end })),
      speakerSegments,
      overlapError,
    };
  },

  // 割り当てられた区間を認識（＋必要なら埋め込み抽出）。区間ごとに進捗イベント。
  async processBatch({ pcmPath, items, wantEmbedding }, emit) {
    const samples = loadPcm(pcmPath);
    const sr = core.SAMPLE_RATE;
    const out = [];
    for (const it of items) {
      const a = Math.max(0, Math.round(it.start * sr));
      const b = Math.min(samples.length, Math.round(it.end * sr));
      const slice = samples.subarray(a, b);
      const r = await core.recognizeSegment(ctx.recognizer, slice);
      const text = (r.text || '').trim();
      const entry = { idx: it.idx, text };
      if (text && wantEmbedding && ctx.embedder) {
        // Electron プロセス間は外部バッファ不可のためプレーン配列で渡す
        entry.embedding = Array.from(core.extractEmbedding(ctx.embedder, slice));
      }
      out.push(entry);
      emit({ kind: 'seg', n: 1 });
    }
    return out;
  },

  // プレビュー WAV 生成（先頭 maxSeconds 秒、必要ならノイズ除去）
  async preview({ filePath, outPath, denoiseStrength, maxSeconds }) {
    return core.renderPreviewWav(filePath, ctx, outPath, {
      denoiseStrength: denoiseStrength || 0,
      maxSeconds: maxSeconds || 0,
    });
  },

  // 話者タグ付け用: デコード(+ノイズ除去)して共有 PCM を書き出す（VAD はしない）
  async decodePcm({ filePath, denoiseStrength, outPath }) {
    let samples = await core.decodeToPcm(filePath);
    if (ctx.denoiser && denoiseStrength > 0) {
      samples = core.denoisePcm(ctx.denoiser, samples, denoiseStrength);
    }
    core.writePcmRaw(samples, outPath);
    return { pcmPath: outPath, duration: samples.length / core.SAMPLE_RATE };
  },

  // 指定区間の話者埋め込みのみを並列抽出（区間ごとに進捗イベント）
  async embedBatch({ pcmPath, items }, emit) {
    const samples = loadPcm(pcmPath);
    const sr = core.SAMPLE_RATE;
    const out = [];
    for (const it of items) {
      const a = Math.max(0, Math.round(it.start * sr));
      const b = Math.min(samples.length, Math.round(it.end * sr));
      const emb = core.extractEmbedding(ctx.embedder, samples.subarray(a, b));
      out.push({ idx: it.idx, embedding: Array.from(emb) }); // プレーン配列で渡す
      emit({ kind: 'emb', n: 1 });
    }
    return out;
  },

  // 区間の音声クリップを WAV で書き出す（試聴用）
  async clip({ filePath, start, end, outPath }) {
    const samples = await core.decodeToPcm(filePath, { startSeconds: start, maxSeconds: Math.max(0.05, end - start) });
    core.writePcmToWav(samples, outPath);
    return { wavPath: outPath };
  },
};

process.on('message', async (msg) => {
  if (msg.type === 'init') {
    try { init(msg); process.send({ type: 'ready' }); }
    catch (e) { process.send({ type: 'initError', message: e.message || String(e) }); }
    return;
  }
  if (msg.type === 'request') {
    const { rid, op, args } = msg;
    const emit = (payload) => process.send({ type: 'event', rid, payload });
    try {
      const fn = OPS[op];
      if (!fn) throw new Error(`unknown op: ${op}`);
      const result = await fn(args, emit);
      process.send({ type: 'response', rid, result });
    } catch (e) {
      process.send({ type: 'response', rid, error: e.message || String(e) });
    }
  }
});
