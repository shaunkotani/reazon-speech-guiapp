# HANDOFF — モコシ（ReazonSpeech ローカル文字起こしアプリ）

> 新しいセッションでは、まず本書と `README.md` を読むこと。
> 本書は **2026-07-19 / v1.6.0（リアルタイム文字起こし追加）** の実装を基準に更新している。
> `release/` は gitignore 対象で古い成果物も残るため、実装状態の判断には `package.json` とソースを使うこと。

## 1. 現在地

- アプリ名は **モコシ**。ReazonSpeech k2-v2 を sherpa-onnx で動かす、日本語文字起こし用 Electron デスクトップアプリ。
- 認識・VAD・ノイズ除去・話者埋め込みは CPU 上でローカル実行し、Python は不要。
- 通信が発生するのは、主にモデル初回取得と GitHub Releases の更新確認時。モデル取得後の文字起こし自体はオフラインで動く。
- ソースの現行バージョンは **v1.5.0**（`package.json` と tag `v1.5.0`）。
- 対象ビルド:
  - Windows x64: NSIS `.exe`。タグ `v*` の push で `.github/workflows/release.yml` が GitHub Releases へ発行する。
  - macOS Apple Silicon: arm64 `.dmg` のローカルビルド。
- Microsoft Store（AppX/MSIX）移行は方針として決定済みだが、**まだ未実装**。現行コードと CI は NSIS + GitHub Releases のまま。詳細は `docs/MICROSOFT_STORE.md`。
- ライセンス: アプリ本体は Apache-2.0。アプリ内の「ⓘ 情報」から主要ライセンスと NOTICE を表示できる。

### バージョン別の主な実装

| バージョン | 主な変更 |
|---|---|
| v1.1.0 | TXT・コピーへ時刻プレフィックスを追加 |
| v1.2.0 | データ初期化・NSIS 完全アンインストール |
| v1.3.0 | GitHub Releases 経由の自動アップデート |
| v1.4.0 | VAD 設定、結果音声・区間再生、設定を変えて再実行 |
| v1.5.0 | 重なり音声の再解析、名前付き VAD プリセット |
| v1.6.0 | リアルタイム文字起こし（マイク） |

## 2. 技術構成

| 層 | 現行実装 |
|---|---|
| デスクトップ | Electron 42.5.1 / electron-builder 26.15.3 / 素の HTML・CSS・JS |
| 自動更新 | electron-updater 6.8.9 + GitHub Releases |
| 推論 | sherpa-onnx-node 1.13.3、CPU、子プロセスのワーカープール |
| ASR | reazonspeech-k2-v2、Zipformer Transducer、int8 ONNX 3ファイル + `tokens.txt` |
| 音声デコード | 同梱 LGPL FFmpegを優先。無ければ ffmpeg-static、最後に PATH 上の `ffmpeg` |
| 発話分割 | Silero VAD。アプリ側でも最大区間長を厳密に適用 |
| 重なり補正 | pyannote segmentation + WeSpeaker + 複数時間窓の再認識 |
| ノイズ除去 | GTCRN（`gtcrn_simple.onnx`）、原音とのブレンドで強度調整 |
| リアルタイム | Silero VAD ストリーミング + 既存オフライン認識器を専用ワーカーで逐次実行 |
| 話者タグ付け | WeSpeaker ResNet34 埋め込み + 手本への最近傍割当 |
| 音声再生 | IPC で読み込んだ Blob URL が基本。`app-media://` はフォールバック・生成クリップ用 |

### 処理プロセス

1. renderer がファイルとジョブ単位の設定を IPC で main に渡す。
2. main が `CPU コア数 - 1`、最大4個の Node 子プロセスを作る。
3. 先頭ワーカーが FFmpeg デコード、必要なら原音の重なり検出、ノイズ除去、Silero VAD を行い、16 kHz mono float32 PCM を一時ファイルへ保存する。
4. `shared/overlap.js` が VAD 区間を最大長以内へ分割し、重なり補正が有効なら再認識候補を追加する。
5. main が認識区間をラウンドロビンで全ワーカーへ配り、ASR を並列実行する。
6. 重なり区間は複数候補の編集距離による合意度で採用結果を決め、通常区間と時刻順に統合する。
7. 話者タグ付けをユーザーが開始したときだけ、同じ区間列の WeSpeaker 埋め込みを遅延計算する。

ワーカー間で大きな `Float32Array` を IPC 転送せず、raw PCM 一時ファイルを共有している。話者埋め込みだけは `Array.from()` でプレーン配列化して返す。

## 3. ディレクトリと責務

```text
src/
  core/asr.js
    FFmpegデコード、認識器/VAD/GTCRN/WeSpeaker/pyannote生成、PCM・WAV I/O
  main/main.js
    BrowserWindow、IPC、ワーカープール、文字起こし統括、設定、更新、メンテナンス
  main/asrWorker.js
    子プロセスRPC。prepare/processBatch/decodePcm/embedBatch/preview/clip
  main/modelManager.js
    モデル所在解決、完全性確認、初回ダウンロード
  main/mediaProtocol.js
    app-media:// の単純ストリーム配信。シーク用途には使わない
  main/preload.js
    contextBridge の `window.api.*`
  renderer/
    index.html / renderer.js / styles.css。バンドラなし
    recorder-worklet.js はリアルタイム用 AudioWorklet（100msごとのPCMチャンク送出）
  shared/export.js
    TXT/SRT/VTT/JSON、同一話者区間の統合
  shared/cluster.js
    凝集クラスタリング、手本ベース割当、話者不明判定
  shared/overlap.js
    厳密な区間分割、重なり検出、再認識候補生成、合意選択
  shared/autoTune.js
    修正文の正規化、削除を重くした文字誤り評価、粗探索・局所探索候補生成
  shared/corrections.js
    確定修正行の時刻補間、重複時刻の保持、追加/置換別の行単位マージ、試行・全体認識結果への反映
  shared/transcriptionRange.js
    試し文字起こしの範囲正規化、前後文脈、対象区間選択、絶対時刻補正
  shared/unsavedState.js
    未保存状態・終了確認要否・ネイティブ確認ダイアログ文面の純JS判定

scripts/
  test-pipeline.js             単一プロセスのCLI文字起こし
  test-pool.js                 並列ASR + 埋め込み + クラスタリング
  test-enroll.js               遅延埋め込み + 手本割当
  test-hotwords.js             greedy と辞書付きbeamの比較
  test-overlap.js              重なり補正の純JS回帰
  test-realtime.js             擬似ストリーム投入の遅延実測（core直接・調査用）
  test-realtime-worker.js      本番asrWorkerをforkするリアルタイム経路の回帰
  test-renderer-playback.js    renderer実駆動の画面回帰（認識はスタブ）
  test-transcription-range.js  試し文字起こしの範囲・境界・時刻補正の純JS回帰
  test-transcription-range-worker.js 実モデルの範囲デコード回帰（モデルがある環境向け）
  test-auto-tune.js            修正文による自動調整の採点・候補選択の純JS回帰
  test-corrections.js          確定修正の時刻補間・範囲置換・重複更新の純JS回帰
  test-auto-tune-worker.js     実モデルのPCM再利用・GTCRN/VAD候補生成回帰
  test-auto-tune-e2e.js        実モデル・main IPC・rendererを通す修正・自動調整E2E
  test-unsaved-state.js        未保存状態・終了確認内容の純JS回帰
  test-media-seek.js           app-media再生の調査用ハーネス
  fetch-ffmpeg.js              Windows/Linux用LGPL FFmpegの取得

models/       開発用モデル。gitignore。全モデルが揃っている場合だけ優先使用
samples/      ローカル検証音声。gitignore
vendor/       配布用LGPL FFmpeg。実行ファイルはgitignore
release/      ビルド成果物。gitignore。古い成果物を実装の根拠にしない
licenses/     アプリ内で表示するライセンス全文とNOTICE
docs/         Microsoft Store計画、旧Azure署名手順
```

## 4. 実装済み機能

### 4.1 取り込み・認識

- 音声・動画ファイルのドラッグ＆ドロップ、複数選択。
- 対応ダイアログ拡張子: wav/mp3/m4a/aac/flac/ogg/opus/mp4/mov/mkv/webm/avi。
- ファイルごとに独立したジョブカードを作成する。
- 元音声の全体プレビュー。
- 取込後のカードは音声プレイヤー、状態、主操作だけを表示する。「文字起こし」から1つの大型ワークスペースを開き、「音声に合う設定 → 仕上がりをテスト → 全体を文字起こし」の3工程を同じ画面内で進める。インタビュー／会議／電話・通話／講演・一人語りを主選択とし、迷った場合の「通常」と保存済みプリセットを使う「カスタム」も選べる。いずれかの明示選択は必須で、「カスタム」は保存済み設定を選ぶまで後工程を開始できない。
- 「仕上がりをテスト」はワークスペース内の工程2へ切り替わり、開始位置と30秒/60秒/120秒を指定して同じパイプラインで試し文字起こしできる。既定は冒頭60秒。指定範囲だけの音声プレイヤーも表示し、範囲変更時に再生成する。設定調整・発話修正も同じワークスペース内で行い、確認後は全体実行を主操作に切り替える。
- 全体文字起こし中にワークスペースを閉じても処理を継続し、進捗パネルをカードへ戻す。「進捗を見る」で同じ工程3へ復帰できる。完了時はワークスペースを自動で閉じず、完了内容を確認してから結果カードへ戻る。
- 再文字起こしでは最後に成功した結果を処理中も保持し、新しい結果が成功した時だけ差し替える。失敗・中止時は前回結果と設定を保持する。
- 自動調整は独立したシチュエーションではなく、各シチュエーションの「仕上がりをテスト」結果から選ぶ追加工程。「文字起こしを修正して精度を上げる」で仮結果を波形付きの話者別タイムラインへ変換する。発話ブロックの移動・左右リサイズ、開始/終了秒の直接入力、欠落発話の追加、最大4話者のレイヤー、境界違いの遅延再認識候補に対応する。異なる話者のブロックを同じ時刻へ重ねると、ユーザー指定の重なり区間として候補生成へ渡す。句読点を除いて30文字以上の「確定」発話を必要とし、未確定発話は採点へ含めない。
- 精度向上の実行中は、仕上がりテスト内の通常進捗とは分離した全画面オーバーレイを表示する。背面モーダルを `inert` にし、進行中は「中止」、失敗時は「修正画面に戻る」だけを主操作にする。完了後の主操作は「この設定で全体を文字起こし」と「閉じる」に絞り、再修正・詳しい設定・確定修正の解除は閉じた「その他の操作」へまとめる。失敗して修正画面へ戻っても入力済みの修正文は保持する。
- 自動探索は、修正文に対する文字誤りを評価し、特に削除（発話の抜け）を1.35倍で扱う。選択中のシチュエーションの現在値と組み込みプリセットを原音/GTCRN候補で粗探索し、最良候補の threshold / maxSpeech 周辺を追加探索する。同点では現在値に近い候補を優先し、その後にノイズ除去・重なり解析が軽い候補を選ぶ。
- 自動調整用の指定範囲は一度だけFFmpegデコードする。GTCRNも完全除去を一度だけ計算してブレンド比別PCMを作り、同一PCM・同一時刻のASR結果は候補間で再利用する。適用後も元のシチュエーション選択を維持し、変更値は既存の詳細設定へ「自動調整」バッジ付きで反映する。その後の手動調整・保存も可能。
- 自動調整に成功した「確定」発話はジョブ内の確定修正として保持する。候補採点は確定した時間窓と重なる生ASR結果だけを対象にし、本文精度を主、ユーザー指定境界との一致を副指標として選ぶ。既存発話の修正は元区間と最も近い認識結果1件だけを置換し、欠落発話の追加は同時刻の既存発話を削除しない。未確定発話は再テスト・全体認識の新しい結果を採用する。最終結果、コピー、TXT/SRT/VTT/JSON、話者分離へ同じ修正文と話者名を引き継ぎ、「修正済み」バッジを表示する。ユーザーが確認付きの「この範囲の修正を解除」を実行した場合だけ生ASRへ戻す。
- 試行範囲の前後1.5秒を文脈として読み込み、表示結果は元ファイルの絶対時刻へ戻す。試行後にVAD・ノイズ除去・高精度・辞書設定が変わると再試行警告を出す。
- ノイズ除去は「なし」が既定。弱 0.5 / 中 0.8 / 強 1.0 を選べ、除去後の先頭10秒も試聴可能。
- 並列認識、工程別進捗、推定残り時間、中止。
- ファイル文字起こしは `transcribe:status` で preparing / decoding / overlap / denoising /
  vad / recognizing / finalizing を通知する。増分を取得できない前処理は不定進捗表示、認識中は
  完了区間の音声秒数を作業量としてETAを平滑化する。長時間更新がない場合は警告へ切り替える。
- 複数ファイルは `SerialJobQueue` でファイル単位に直列実行する。1ファイル内では最大4ワーカーを
  従来どおり並列利用する。待機ジョブへ queued と全体内の位置を通知し、待機中の中止は実行中
  ワーカーを終了させない。
- `processBatch` の区間完了イベントは idx / text / workSec を含む。画面には通常（base）区間だけを
  暫定表示し、重なり補正候補は完了時の合意処理まで表示しない。
- ファイル処理中は `BrowserWindow.setProgressBar()` でタスクバーへ進捗を反映し、ウィンドウが
  非アクティブの時に完了するとOS通知を出す。通知クリックでウィンドウを復元・フォーカスする。
- 失敗時はコード・発生工程・利用者向け説明・技術情報を分離し、再試行可能な場合は同じ設定で
  やり直せる。中止はエラー表示にしない。
- 中止は実行中のネイティブ呼び出しを細粒度で止める方式ではなく、ワーカープールを終了して確実に止める。
- 文字起こし結果、リアルタイム録音、用語辞書、名前付きカスタム設定の未保存状態を renderer が集約し、main へ件数だけ通知する。結果はTXT/SRT/VTT/JSONのいずれかの保存成功で保存済みになり、コピーだけでは解除しない。保存後に話者名・タグ・まとめ設定を変えた場合は再び未保存になる。
- ウィンドウ終了時に未保存内容があればネイティブ確認ダイアログを表示する。「次回から確認しない」は `settings.json` の `confirmOnCloseWithUnsaved` に保存し、右上の「設定」モーダルから再度有効にできる。処理中・録音中は設定にかかわらず確認する。

### 4.2 認識設定

- **高精度モード**: 辞書がなくても `modified_beam_search` を使う。既定 OFF。
- **用語辞書**: 1行1語。score 0.5〜5.0、既定 2.0。ONかつ1語以上なら beam search を自動的に使う。
- ReazonSpeech k2-v2 は文字トークンモデルなので、辞書使用時は `modelingUnit: 'cjkchar'`。BPE vocab は不要。
- 高精度モードと辞書設定は全ジョブ共通で `settings.json` / `hotwords.txt` に保存する。
- 設定変更時は `destroyPool()` し、次の文字起こしで認識器を作り直す。

### 4.3 発話区切り（VAD）

認識モデルは短い発話向けで、長い音声を1区間のまま渡すと出力が数文字へ潰れることがある。VAD 設定は単なる微調整ではなく、認識結果を大きく左右する。

| 組み込みプリセット | threshold | minSilence | minSpeech | maxSpeech | 重なり再解析 |
|---|---:|---:|---:|---:|---|
| 標準 | 0.50 | 0.20秒 | 0.15秒 | 6秒 | OFF |
| 会話・電話 | 0.70 | 0.10秒 | 0.20秒 | 3秒 | ON、既定2人 |
| インタビュー | 0.20 | 0.10秒 | 0.15秒 | 3秒 | ON、既定2人 |
| 講演・朗読 | 0.45 | 0.35秒 | 0.15秒 | 8秒 | OFF |

- 4スライダーと重なり設定をジョブ単位で変更できる。
- 調整値は名前付きカスタムプリセットとして最大20件保存・更新・削除できる。
- カスタムプリセット名は最大40文字。保存先は `settings.json` の `vadPresets`。
- `core.normalizeVadOptions()` と main 側の正規化により、UI 外から来た値も範囲内へ丸める。
- Silero VAD の `maxSpeechDuration` は実際には上限を超える場合があるため、`splitStrictSegments()` が必ず上限内に再分割する。境界の語落ち防止に 0.18秒重ねる。
- 各認識区間にはさらに前後0.3秒の無音を付け、RNN-T の区間先頭の語落ちを抑える。

組み込みプリセットの数値は `src/core/asr.js` と `src/renderer/renderer.js` に重複定義されている。変更時は必ず両方を同期すること。重なり再解析の既定値と画面注記は renderer 側だけにある。

### 4.4 重なり音声の再解析（v1.5.0）

- 「会話・電話」で既定 ON。想定話者数を2〜4人から指定する。
- pyannote + WeSpeaker の diarizer は重なり再解析を使う最初のジョブでだけ遅延生成する。
- 重なり検出はノイズ除去前の原音、通常 ASR はノイズ除去後の PCM を使う。
- 異なる話者区間が0.08秒以上重なった箇所を検出する。
- 話者境界が VAD 境界から0.12秒以上変わり、0.45秒以上ある区間だけ補正候補にする。
- 各候補は開始を 0 / 0.08 / 0.16秒ずらし、終了を 0 / 0.5 / 0.75秒短くして認識する。
- 空でない実在候補同士の編集距離から合意度最大の候補を選ぶ。合意が弱い場合は通常 VAD の結果を維持する。
- 補正採用区間は結果画面に「重なり補正」バッジを付ける。重なり解析だけ失敗した場合も通常の文字起こしは継続する。
- `samples/twospeaksample.mp3` では、従来「ありがとうございます」だった 2.47〜5.21秒付近から「どうしようどうしよう」を復元した実績がある。

### 4.5 結果・再生・やり直し

- タイムスタンプ付き区間一覧と、入力ファイル全体のプレイヤーを表示する。
- 各区間の ▶ は全体プレイヤーを開始時刻へシークし、終了時刻で停止する。
- Chromium が入力形式を直接再生できない場合は、FFmpeg で区間 WAV を生成する方式へ自動フォールバックする。
- 「設定を変えてやり直す」で、同じファイルを前回のノイズ除去・VAD 値を保ったまま設定画面へ戻せる。再実行前なら前の結果へ戻れる。
- 失敗・中止時も設定画面へ戻り、条件を変えて再試行できる。
- ジョブ作成時に結果側イベントハンドラを一度だけ登録している。`onJobDone()` で登録すると、再実行のたびに書き出し等が多重実行されるので避けること。

### 4.6 話者タグ付け

- 通常の文字起こしでは話者埋め込みを計算しない。
- 結果後に「話者でタグ付け」を押すと、全区間の埋め込みを並列計算し、タグ付け UI を開く。
- 各区間を「未割当 / 話者N / 新しい話者」へ手動割当でき、話者名も編集できる。
- 確かな区間を手本として「手本で話者識別」を実行すると、残りを話者重心への最近傍で割り当てる。
- コサイン距離が `UNKNOWN_THRESHOLD = 0.75` を超える区間は `話者不明`（speaker `-1`）。
- 埋め込みキャッシュは main 内に最大10ジョブ保持する。
- `clusterEmbeddings()` は CLI・旧フロー用に残るが、GUI の標準フローは手本ベース割当。

### 4.7 コピー・書き出し

- TXT / SRT / VTT / JSON とクリップボードコピー。
- TXT とコピーは各行が `[HH:MM:SS --> HH:MM:SS] 話者名: 本文` 形式。話者タグ前は話者名なし。
- SRT/VTT/JSON はミリ秒を含む時刻情報を持つ。
- 「同じ話者をまとめる」は、連続する同一話者の区間をコピーと全書き出し形式で統合する。画面上の元区間は維持する。
- 未割当と `話者不明` は、別人の可能性があるため統合しない。
- 統合ロジックは renderer と `shared/export.js` に重複しているため、規則変更時は双方を同期すること。

### 4.8 リアルタイム文字起こし（v1.6.0）

マイク音声をローカルで逐次認識する。方式は「Silero VAD ストリーミング + 既存
オフライン認識器」で、発話が区切れるごとに確定文を追記する（文字単位の逐次表示ではない）。
実測遅延は発話終了から約 0.3〜1 秒、認識負荷は実時間の 3% 程度（int8 / greedy）。

画面上部の**モード選択**（既定「ファイルから文字起こし」）で切り替える。ローカルモードは
ドロップゾーン、リアルタイムモードは中央の録音開始ボタンとマイク・シチュエーションの選択を表示する。
録音中・仕上げ中はモード切替を無効化する。

- 経路: renderer の `getUserMedia` + 16kHz `AudioContext` + AudioWorklet が
  100ms（1600 サンプル）の Float32Array を `rt:feed` で main へ送り、main が
  リアルタイム専用ワーカーへ転送する。16kHz 指定で Chromium がリサンプルするため
  FFmpeg は使わない。
- 専用ワーカーはバッチのプールと独立した 1 プロセス（認識器 + VAD のみの軽量構成）。
  Float32Array を渡すため **fork の `serialization: 'advanced'`** を使う（プールは従来どおり JSON）。
- `core.RealtimeSegmenter` が `collectVadSegments()` のストリーミング版。確定区間は
  バッチと同じ `splitStrictSegments()` で上限内に分割してから認識する。
  空テキストの区間は結果に含めない（バッチとの意図的な差異）。
- 録音 PCM は一時ファイルへ逐次追記（メモリに全保持しない）。停止時に 16bit WAV 化して
  **通常のジョブカードへ合流**する。再生・書き出し・話者タグ付け・
  「設定を変えてやり直す」（= 録音 WAV をバッチパイプラインで再解析。ノイズ除去・
  重なり再解析はここで適用）がそのまま使える。
- 録音 WAV は一時領域にあるため、結果ツールバーの「録音を保存」で任意の場所へ複製できる。
- 排他制御: **録音セッション実行中**はファイル文字起こし不可、逆も不可
  （`activeBatchJobs` / `rtSessionActive`）。準備済みのアイドルワーカーは排他の対象にしない。
- ワーカーは**リアルタイムモード進入時に `rt:prepare` で事前起動**し（録音開始を即時にするため）、
  録音セッションを跨いで保持する。モード離脱時は `rt:release` で解放してメモリを返す。
  辞書保存・高精度切替・モデル再取得・データ初期化・renderer 再読込・終了時にも破棄し
  （`destroyRtWorker()` を `destroyPool()` と対で呼ぶ）、実行中セッションは `rt:error` で
  renderer に通知される。
- シチュエーションプリセット（組み込み4種 + 保存済みカスタム）を流用する。重なり再解析は
  オフライン処理のためリアルタイムでは常に無効。
- マイク許可: Electron は permission handler 未設定のため media 要求は自動許可される。
  Windows は OS のマイクプライバシー設定に依存。macOS ビルド時は
  `NSMicrophoneUsageDescription` と entitlements の追加が必要（未対応）。

### 4.9 モデル・更新・メンテナンス

- 必須モデルが足りなければ画面上部から一括取得する。開発時の `./models` は全ファイルが揃っている場合だけ優先する。
- 自動更新はパッケージ済みアプリだけ有効。起動1.5秒後に確認し、更新ありならバナー表示、ユーザー操作でダウンロード、再起動して適用する。
- `autoDownload = false` / `autoInstallOnAppQuit = true`。
- About からGitHubリポジトリを開き、手動更新確認、データ容量確認、データ初期化、完全アンインストールを実行できる。
- 右上の「設定」から終了時の未保存確認を切り替えられる。変更は即時保存し、設定画面自体に保存ボタンは置かない。
- データ初期化前はワーカーを止め、ONNX ファイルロックを解放する。
- 完全アンインストールは Windows の NSIS インストール時だけ有効。`Uninstall *.exe` が無い dev / zip / macOS / AppX ではボタンを無効化する。

## 5. 保存先とモデル

表示名を変えても既存データを引き継げるよう、userData は `app.getPath('appData')/reazonspeech` に固定している。

| パス | 内容 |
|---|---|
| `userData/models/` | 初回取得した全モデル |
| `userData/hotwords.txt` | 1行1語の用語辞書 |
| `userData/settings.json` | 辞書ON/OFF・score、高精度モード、VADプリセット、終了確認設定 |
| `os.tmpdir()/reazonspeech-preview/` | preview WAV、clip WAV、共有PCM、リアルタイム録音WAV。終了時・初期化時に削除 |

必須モデル:

- `reazonspeech-k2-v2/{encoder,decoder,joiner}-epoch-99-avg-1.int8.onnx`
- `reazonspeech-k2-v2/tokens.txt`
- `silero_vad.onnx`
- `gtcrn_simple.onnx`
- `wespeaker_en_voxceleb_resnet34_LM.onnx`
- `pyannote-segmentation.onnx`

URL は `src/main/modelManager.js` を正とする。Hugging Face のリダイレクト先は相対 URL の場合があるため、`new URL(location, currentUrl)` で解決している。

## 6. 重要な実装上の注意

### sherpa-onnx と Electron の外部バッファ

- npm パッケージは `sherpa-onnx` ではなく **`sherpa-onnx-node`** と OS 別 optional dependency を使う。
- Electron 系プロセスでは native addon の外部バッファを使えない。以下の指定を消さないこと。
  - VAD: `vad.front(false)`
  - 話者埋め込み: `extractor.compute(stream, false)`
  - GTCRN: `enableExternalBuffer: false`
- `sherpa.readWave()` は使わず、FFmpeg と自前 raw float32 I/O を使う。
- 重い推論は main/renderer で行わず、`ELECTRON_RUN_AS_NODE=1` の子プロセスへ置く。

### 音声再生

- `protocol.handle` の `app-media:` は、Range 対応を試してもシーク時に `MEDIA_ERR_NETWORK` / `PIPELINE_ERROR_READ` になった。
- プレビューと結果プレイヤーは `media:read` で全内容を renderer へ渡し、Blob URL にする。CSP の `media-src` に `blob:` が必要。
- `media:read` は1GB上限。超過・読込失敗時は `app-media:` へフォールバックするが、シークは不安定になり得る。
- 結果音声自体を Chromium が扱えない場合は全体プレイヤーを隠し、区間 WAV 生成へ切り替える。
- Electron の隠しウィンドウを使うテストは、例外時のゾンビ化を防ぐ watchdog を必ず残す。

### FFmpeg とパッケージング

- 解決順は `vendor/ffmpeg/<platform>-<arch>/` または packaged `resources/ffmpeg/...` → ffmpeg-static → system `ffmpeg`。
- Windows x64 は `npm run dist:win` の pre script で BtbN の LGPL ビルドを取得する。`ffmpeg.exe` はリポジトリへコミットしない。
- Windows 配布物では `node_modules/ffmpeg-static/ffmpeg.exe` を除外し、`extraResources` の LGPL 版を使う。
- macOS arm64 の LGPL バイナリは未配置。現状は ffmpeg-static の GPL フォールバックになるため、外部配布前に `vendor/ffmpeg/darwin-arm64/ffmpeg` を用意する。
- native addon と ffmpeg-static は asar 内から直接実行できないため `asarUnpack` 対象。packaged path の `app.asar` は `app.asar.unpacked` へ置き換える。

### プールと設定変更

- プールサイズは最大4。各ワーカーが ASR・VAD・GTCRN・WeSpeaker を持つので、数を増やすとメモリ使用量も増える。
- pyannote diarizer は `prepare` 担当ワーカーにだけ遅延生成する。
- 辞書・高精度モード・モデル・データ初期化など、認識器やモデルの再読込が必要な操作では `destroyPool()` を呼ぶ。
  これらの操作ではリアルタイム専用ワーカーも古い設定のままになるため、必ず `destroyRtWorker()` を対で呼ぶこと。
- VAD 設定だけの変更は `vadFor()` が VAD を作り直し、ASR モデルは再ロードしない。

## 7. 開発・検証・ビルド

```powershell
npm ci
npm start

# モデル不要の回帰
npm run test:overlap
npm run test:progress
npm run test:queue
npm run test:renderer

# ./models と samples が必要
npm run test:realtime
npm run test:cli -- samples/natural.wav
node scripts/test-pool.js samples/twospeaksample.mp3 2
node scripts/test-enroll.js
node scripts/test-hotwords.js samples/natural.wav "文字起こし,議事録" 3.0

# 配布ビルド
npm run fetch:ffmpeg
npm run dist:win
npm run dist:mac
```

検証の意味:

- `test:overlap`: 厳密分割、重なり検出、補正候補、合意選択の純JS回帰。
- `test:progress`: 工程構成、音声秒数ベースETA、遅延閾値、エラー分類の純JS回帰。
- `test:queue`: ファイル単位の直列実行、待機位置更新、待機ジョブ中止の純JS回帰。
- `test:renderer`: 元音声 Blob 再生、標準値、カスタムプリセット保存、会話プリセット、待機順・暫定結果・進捗・遅延・失敗表示、文字起こしオプション、全体・区間再生、やり直しをスタブ付きで実駆動する。
- `test:realtime`: 本番 asrWorker を advanced serialization で fork し、100ms チャンク投入 → 確定区間イベント → 録音 WAV 生成までのリアルタイム経路を回帰する。
- `scripts/test-realtime.js`: core 直接の擬似ストリームで遅延（VAD確定+認識）を実測する調査用。
- `test:cli` / pool / enroll / hotwords: native addon とローカルモデルを使うため、環境依存で時間がかかる。

`samples/twospeaksample.mp3` は19秒の実録2人電話で、VAD・重なり補正・話者処理の標準 fixture。無音が少なく相槌が重なるため、長区間が数文字へ潰れる問題を再現できる。`natural.wav` は1話者の辞書・通常認識確認に使う。

### リリース

- `package.json` の `build.publish` は `shaunkotani/reazon-speech-guiapp` の GitHub provider。
- タグ `v*` を pushすると Windows CI が `npm run dist:win -- --publish always` を実行する。
- electron-updater が必要とする `latest.yml` も publish 時に生成・添付される。
- updater を GitHub Releases で使うにはリポジトリと Release asset をクライアントから取得可能にする必要がある。
- 旧 Azure Trusted Signing 用の `electron-builder.signed.js`、`dist:win:signed`、`docs/CODE_SIGNING.md` は非推奨のまま残置している。

## 8. 未完了・次の作業

### 優先度高

1. **Microsoft Store 対応**
   - Partner Center で Identity を取得するまで appx 設定値は確定できない。
   - `package.json` へ appx target と `dist:win:store` を追加する。
   - `updaterEnabled()` を `app.isPackaged && !process.windowsStore` に変更し、Store ビルドでは更新 UI を Store 案内へ切り替える。
   - AppX 上の ffmpeg、native addon、子プロセス、モデル取得、userData を sideload 実機で確認する。
2. **配布ライセンスの仕上げ**
   - macOS arm64 用 LGPL FFmpeg を配置して現行 v1.5.0 を実機ビルドする。
   - GTCRN と WeSpeaker/VoxCeleb モデルの再配布条件を最終確認する。
   - macOS の Developer ID 署名・notarize は未対応。
3. **リリース経路の通し確認**
   - 用語辞書を実 GUI で保存→文字起こしまで確認する。現状は CLI 検証済みで、renderer 回帰には辞書認識を含めていない。
   - 旧バージョンから最新版への更新検知、download、`quitAndInstall` を配布環境で確認する。
4. **リアルタイム文字起こしの実マイク確認**
   - ワーカー経路は `test:realtime` で回帰済みだが、実マイクでの GUI 通し
     （デバイス選択・レベルメーター・ライブ追記・停止→結果合流・録音保存・再解析）は
     実機での確認が必要。

### リアルタイムの拡張候補（Phase 2・未着手）

- 発話中の仮表示（認識中バッファの定期再認識、またはストリーミング Zipformer モデルの導入）。
- システム音声（ループバック）の取り込み。Electron の `setDisplayMediaRequestHandler` +
  `audio: 'loopback'` が Windows で使え、オンライン会議の相手音声を拾える。
- リアルタイムノイズ除去（GTCRN はストリーミング設計のため原理的に可能）。
- macOS のマイク許可（`NSMicrophoneUsageDescription` / entitlements）。

### 精度改善候補（未着手）

- fp32 版 k2 モデルを選べる高精度モード。現行「高精度モード」は int8 + beam search であり、fp32 切替ではない。
- FFmpeg の loudnorm / dynaudnorm による音量正規化。
- NeMo 619M モデルを sherpa-onnx で利用できるかの調査。
- hotwordsScore 既定値 2.0 の実音声での調整。

## 9. 既知の制約

- CPU 推論のみ。長尺、beam search、重なり再解析、話者埋め込みは処理時間とメモリを増やす。
- 話者タグ付けは完全自動ではなく、信頼できる区間をユーザーが手本指定する設計。
- 重なり補正の想定話者数は2〜4人で、pyannote の結果が常に正しいとは限らない。補正候補の合意が弱ければ通常結果へ戻す。
- `media:read` は音声・動画全体をメモリへ載せる。1GB超は直接URLへフォールバックするため、全体再生・シークに制約が出る場合がある。
- Microsoft Store 版は未実装。現行 `updaterEnabled()` は `app.isPackaged` だけを見ているので、AppX target を追加する前に必ず Store 分岐を入れる。
