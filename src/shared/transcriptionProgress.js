(function initTranscriptionProgress(root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.TranscriptionProgress = api;
}(typeof globalThis !== 'undefined' ? globalThis : this, () => {
  'use strict';

  const PHASES = Object.freeze({
    queued: { label: '開始を待機', active: '開始を待っています…', slowMs: Number.POSITIVE_INFINITY },
    preparing: { label: '認識エンジンを準備', active: '認識エンジンを準備中…', slowMs: 60000 },
    decoding: { label: '音声を読み込み・変換', active: '音声を読み込み・変換中…', slowMs: 60000 },
    overlap: { label: '重なり音声を解析', active: '重なり音声を解析中…', slowMs: 90000 },
    denoising: { label: 'ノイズを除去', active: 'ノイズを除去中…', slowMs: 60000 },
    vad: { label: '発話区間を検出', active: '発話区間を検出中…', slowMs: 45000 },
    recognizing: { label: '音声を文字に変換', active: '音声を文字に変換中…', slowMs: 45000 },
    finalizing: { label: '結果を整理', active: '結果を整理中…', slowMs: 20000 },
  });

  function configuredPhases(opts = {}) {
    const vad = opts.vad || {};
    return [
      'queued',
      'preparing',
      'decoding',
      ...(Number(opts.denoiseStrength) > 0 ? ['denoising'] : []),
      'vad',
      ...(vad.overlapAware === true ? ['overlap'] : []),
      'recognizing',
      'finalizing',
    ];
  }

  function phaseMeta(phase) {
    return PHASES[phase] || { label: '処理', active: '処理中…', slowMs: 60000 };
  }

  function formatElapsed(seconds) {
    const value = Math.max(0, Math.floor(Number(seconds) || 0));
    const h = Math.floor(value / 3600);
    const m = Math.floor((value % 3600) / 60);
    const s = value % 60;
    const p = (n) => String(n).padStart(2, '0');
    return h > 0 ? `${h}:${p(m)}:${p(s)}` : `${p(m)}:${p(s)}`;
  }

  function formatEta(seconds) {
    const value = Math.max(1, Number(seconds) || 1);
    if (value < 10) return '約10秒未満';
    if (value < 60) return `約${Math.ceil(value / 5) * 5}秒`;
    if (value < 300) {
      const rounded = Math.ceil(value / 10) * 10;
      const m = Math.floor(rounded / 60);
      const s = rounded % 60;
      return s ? `約${m}分${s}秒` : `約${m}分`;
    }
    return `約${Math.ceil(value / 60)}分`;
  }

  function createEtaState() {
    return { phaseStartedAt: 0, smoothedRemaining: null };
  }

  function etaProgress(status) {
    const workDone = Number(status.completedWorkSec);
    const workTotal = Number(status.totalWorkSec);
    if (Number.isFinite(workTotal) && workTotal > 0
      && Number.isFinite(workDone) && workDone > 0) {
      return { done: Math.max(0, workDone), total: workTotal };
    }

    // 古いワーカーや一部の進捗通知には処理済み音声秒数が含まれないため、
    // 区間数、最後に比率の順でフォールバックする。
    const completed = Number(status.completed);
    const total = Number(status.total);
    if (Number.isFinite(total) && total > 0
      && Number.isFinite(completed) && completed > 0) {
      return { done: Math.max(0, completed), total };
    }
    const ratio = Number(status.ratio);
    if (Number.isFinite(ratio) && ratio > 0) {
      return { done: Math.min(1, ratio), total: 1 };
    }
    return { done: 0, total: Math.max(0, workTotal) || Math.max(0, total) || 0 };
  }

  // 認識区間の「件数」ではなく、完了した音声秒数を使う。表示開始を遅らせ、
  // 残り秒数を平滑化することで、並列ワーカー由来の急な上下を抑える。
  function updateEta(state, status, now = Date.now()) {
    if (!state || !status) return '';
    if (status.phase === 'queued') return '開始後に残り時間を計算';
    if (status.phase === 'finalizing') return 'まもなく完了';
    if (status.phase === 'overlap' && status.skippingOverlap) {
      state.phaseStartedAt = 0;
      state.smoothedRemaining = null;
      return '通常の文字起こしへ切り替え中';
    }
    if (!['overlap', 'recognizing'].includes(status.phase)) {
      state.phaseStartedAt = 0;
      state.smoothedRemaining = null;
      return '残り時間を計算中';
    }

    if (!state.phaseStartedAt) state.phaseStartedAt = now;
    const { done, total } = etaProgress(status);
    const elapsed = Math.max(0, (now - state.phaseStartedAt) / 1000);
    if (total <= 0 || done <= 0 || elapsed < 1) {
      return '残り時間を計算中';
    }
    if (done >= total) return 'まもなく完了';

    const rate = done / elapsed;
    if (!isFinite(rate) || rate <= 0) return '残り時間を計算中';
    const rawRemaining = (total - done) / rate;
    state.smoothedRemaining = state.smoothedRemaining == null
      ? rawRemaining
      : state.smoothedRemaining * 0.72 + rawRemaining * 0.28;
    return `残り ${formatEta(state.smoothedRemaining)}`;
  }

  function slowThresholdMs(phase, totalAudioSec = 0) {
    const base = phaseMeta(phase).slowMs;
    if (!['overlap', 'denoising', 'vad'].includes(phase)) return base;
    // 長い音声の前処理では更新間隔も長くなる。最大5分まで音声長に応じて猶予を持たせる。
    const durationAllowance = Math.min(300000, Math.max(0, Number(totalAudioSec) || 0) * 150);
    return Math.max(base, durationAllowance);
  }

  function describeError(error, phase, cancelled = false) {
    const technical = String((error && error.message) || error || '不明なエラー');
    if (cancelled || /中止|cancel/i.test(technical)) {
      return {
        code: 'CANCELLED', cancelled: true, retryable: true,
        title: '文字起こしを中止しました',
        message: '設定はそのまま残っています。必要であればもう一度開始できます。',
        technical,
      };
    }
    if (/リアルタイム文字起こし.+実行中|ファイルの文字起こし中は開始できません/i.test(technical)) {
      return {
        code: 'TRANSCRIBE_BUSY', retryable: true,
        title: '別の文字起こしを実行中です',
        message: '実行中の文字起こしを完了または停止してから、もう一度お試しください。',
        technical,
      };
    }
    if (/モデルが未取得|model.+(not found|missing)|認識モデル/i.test(technical)) {
      return {
        code: 'MODEL_UNAVAILABLE', retryable: true,
        title: '認識エンジンを準備できませんでした',
        message: '認識モデルが見つからないか、読み込みに失敗しました。モデルの取得状態を確認して、もう一度お試しください。',
        technical,
      };
    }
    if (/ENOSPC|no space|disk full|空き容量/i.test(technical)) {
      return {
        code: 'NO_DISK_SPACE', retryable: true,
        title: '作業用の空き容量が不足しています',
        message: 'ディスクの空き容量を増やしてから、もう一度お試しください。',
        technical,
      };
    }
    if (/ENOENT|EACCES|EPERM|permission denied|access denied|ファイル.+見つかりません/i.test(technical)) {
      return {
        code: 'FILE_UNAVAILABLE', retryable: false,
        title: '音声ファイルを開けませんでした',
        message: 'ファイルが移動・削除されていないか、読み取り権限があるかを確認してください。',
        technical,
      };
    }
    if (/ENOMEM|out of memory|allocation failed|メモリ/i.test(technical)) {
      return {
        code: 'OUT_OF_MEMORY', retryable: true,
        title: '処理に必要なメモリを確保できませんでした',
        message: 'ほかのアプリを閉じるか、短い音声で分けてからもう一度お試しください。',
        technical,
      };
    }
    if (/ワーカーが終了|worker.+(exit|ended|closed)|broken pipe|EPIPE/i.test(technical)) {
      return {
        code: 'WORKER_STOPPED', retryable: true,
        title: '文字起こし処理が予期せず停止しました',
        message: '認識エンジンを再起動してやり直せます。繰り返す場合は、技術情報を確認してください。',
        technical,
      };
    }
    if (/ffmpeg|invalid data|unsupported|decode|demux|音声.+(読|変換)|形式/i.test(technical)) {
      return {
        code: 'AUDIO_DECODE_FAILED', retryable: false,
        title: '音声を読み込めませんでした',
        message: '未対応の形式か、ファイルが破損している可能性があります。別の音声ファイルでもお試しください。',
        technical,
      };
    }
    const label = phaseMeta(phase).label;
    return {
      code: 'TRANSCRIBE_FAILED', retryable: true,
      title: `${label}工程で処理を続けられませんでした`,
      message: '設定を変えずに再試行できます。繰り返す場合は、下の技術情報を確認してください。',
      technical,
    };
  }

  return {
    PHASES,
    configuredPhases,
    phaseMeta,
    formatElapsed,
    formatEta,
    createEtaState,
    updateEta,
    slowThresholdMs,
    describeError,
  };
}));
