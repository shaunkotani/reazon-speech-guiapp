# ReazonSpeech Transcribe（ローカル日本語文字起こしアプリ）

[ReazonSpeech](https://github.com/reazon-research/ReazonSpeech) の k2 モデルを
[sherpa-onnx](https://github.com/k2-fsa/sherpa-onnx) 経由で動かす、**完全ローカル・オフライン**の
日本語文字起こしデスクトップアプリです。Python のインストールは不要です。

文字起こし→モコシです。一応...。

- 音声/動画ファイルをドラッグ＆ドロップ → 文字起こし
- 複数ファイルは待機順を表示し、1ファイルずつ安定して処理
- 取り込んだ**元音声のプレビュー再生**
- **ノイズ除去**（GTCRN）: 既定は「なし」。弱/中/強を選び、**除去後のプレビュー再生**も可能
- VAD で発話区間に分割し、区間ごとのタイムスタンプを付与。用途別プリセットに加え、調整した設定を名前付きで保存可能
- 音声のシチュエーションを選び、全体実行前に任意の開始位置から30秒・60秒・120秒だけ**仕上がりをテスト**可能
- **文字起こしを修正して精度を上げる**: シチュエーション別の仕上がりテスト後に、波形付きの話者別タイムラインで発話を修正すると、現在設定を基準にVAD・GTCRN・重なり再解析を自動比較。発話ブロックは移動・左右リサイズでき、開始/終了秒の直接入力、境界違いの再認識候補、欠落発話の追加、話者レイヤーでの重なり表現に対応する。「確定」した発話だけを採点と固定修正に使い、未確定部分は以後の再テスト・全体文字起こしで更新できる
- **重なり音声の再解析**: pyannote で同時発話をチャンク並列検出し、問題区間だけ話者境界と段階的な複数時間窓で再認識。同じ原音・範囲・話者数の再試行は解析結果を再利用
- **話者別音声分離（実験）**: 検出した重なり区間だけを16kHz・2話者のONNXモデルで分離。各出力をVAD・ASR・WeSpeakerへ通し、原音結果と一致する幹発話、声紋差、出力相関を満たした場合だけ新しい発話を追加。失敗・低品質時は従来の重なり補正へ自動復帰
- **高精度モード**: beam search 復号で認識精度を底上げ（処理速度はやや低下）。辞書とは独立に ON/OFF 可能
- **用語辞書（ホットワード）**: 固有名詞・専門用語を登録すると優先認識（内部で高精度モードを自動有効化）
- **工程別の進捗表示**（モデル準備・音声解析・認識・結果整理）と、処理音声量から求めた**推定残り時間**
- 処理中も認識できた文章を**暫定表示**し、完了時はOS通知・タスクバー進捗で案内
- TXT / SRT / VTT / JSON でエクスポート（TXT/コピーは各行に `[HH:MM:SS --> HH:MM:SS]` の時刻付き）
- **自動アップデート**（GitHub Releases 経由・起動時に確認しバナー通知 → DL → 再起動で更新）
- **メンテナンス**（アプリデータの初期化 / 完全アンインストール）を「ⓘ 情報」画面から実行
- 推論は CPU のみ・ネットワーク不要（モデル初回取得時・更新確認時のみ通信）

## 構成

| 層 | 採用技術 |
|---|---|
| デスクトップ | Electron + electron-builder |
| 推論 | sherpa-onnx-node（ネイティブ addon） |
| 話者別音声分離 | onnxruntime-node + Conv-TasNet 16kHz（任意ダウンロード） |
| モデル | reazonspeech-k2-v2（Zipformer transducer, int8, 約150MB） |
| 音声デコード | ffmpeg-static（任意フォーマット → 16kHz mono） |
| 発話分割 | Silero VAD + pyannote segmentation（会話の重なり補正） |
| ノイズ除去 | GTCRN（gtcrn_simple.onnx, 約0.5MB） |
| 音声プレビュー | IPCで読み込んだBlob URLを `<audio>` で再生 |

```
src/
  core/asr.js          推論パイプライン（ffmpeg → VAD → 認識）
  main/main.js         Electron メイン（ウィンドウ / IPC）
  main/preload.js      contextBridge
  main/modelManager.js モデルの所在解決・初回ダウンロード
  main/separatorWorker.js ONNX話者分離専用プロセス
  renderer/            UI（HTML/CSS/JS）
  shared/export.js     TXT/SRT/VTT/JSON 整形
  shared/overlap.js    重なり区間の候補生成・合意選択・統合
  shared/separation.js 分離窓・品質ゲート・既存結果との統合
  shared/autoTune.js   修正文の正規化・文字誤り評価・自動調整候補の生成
  shared/corrections.js 確定修正の時刻補間・重複範囲更新・認識結果への反映
  shared/unsavedState.js 終了時の未保存状態・確認内容の共通判定
scripts/test-pipeline.js  CLI 動作確認
```

## 開発

```bash
npm install
# dev 実行時はリポジトリ直下 ./models があればそれを使う
npm start          # アプリ起動
npm run test:cli samples/natural.wav   # CLI で文字起こし確認
npm run test:overlap                    # 重なり補正の純JS回帰テスト
npm run test:overlap-worker             # 実モデルで重なり解析の並列・段階認識を確認
npm run test:separation                 # 分離窓・品質ゲート・統合の純JS回帰テスト
npm run test:separation-worker          # 実モデルで重なり検出→2話者分離→ASRを確認
npm run test:separation-evaluation      # 日本語評価マニフェスト・PIT-CER集計の回帰テスト
npm run test:synthetic-overlap          # SNR・重なり率を制御した音声合成の純JS回帰テスト
npm run eval:separation:prepare -- --audio <音声> --transcript <話者別txt> --output <json>
npm run eval:separation:synthesize -- --audio <音声> --transcript <話者別txt> --output-dir <dir>
npm run eval:separation -- --manifest <json> --output <結果json>
npm run test:progress                   # 工程・ETA・エラー分類の純JS回帰テスト
npm run test:queue                      # 複数ファイル待機キューの純JS回帰テスト
npm run test:range                      # 試し文字起こしの範囲・時刻補正テスト
npm run test:auto-tune                  # 修正文による自動調整の採点・候補選択テスト
npm run test:corrections                # 確定修正の保持・時刻補間・結果置換テスト
npm run test:unsaved                    # 未保存状態・終了確認内容の純JS回帰テスト
npm run test:range-worker               # 実モデルで短区間デコードを確認（モデルがある開発環境向け）
npm run test:auto-tune-worker           # 実モデルで自動調整用PCM/VAD候補生成を確認
npm run test:auto-tune-e2e              # 実モデル・実画面で修正確定から全体再認識まで通し確認
npm run test:renderer                   # プリセット保存・音声再生の画面回帰テスト
```

### モデルの取得（開発時）

```bash
mkdir -p models/reazonspeech-k2-v2
# reazon-research/reazonspeech-k2-v2 から int8  onnx 3点 + tokens.txt を models/reazonspeech-k2-v2/ へ
# k2-fsa の silero_vad.onnx を models/ へ
```
アプリ起動時、`./models` が無ければ `userData/models` に初回ダウンロードします。
話者別音声分離モデル（約20MB）は通常モデルと分け、画面で機能を初めて有効にした時だけ
`userData/models/speech-separation` へダウンロードします。

日本語の重なり音声に対する精度測定は [evaluation/README.md](evaluation/README.md)、
現行モデルの暫定測定値は [docs/SEPARATION_EVALUATION.md](docs/SEPARATION_EVALUATION.md) を参照してください。
混合音声cpCER、話者入替を許容した分離後PIT-CER、文字起こし漏れ・誤追加、分離RTFを
同じマニフェストから再現できます。音声・参照文・詳細結果はローカル保存のみです。

## パッケージング

```bash
npm run dist:mac          # macOS(arm64) .dmg  ※ mac 上で実行
npm run dist:win          # Windows(x64) .exe  未署名
```

> `dist:win` の前に `scripts/fetch-ffmpeg.js` が自動実行され、LGPL 版 ffmpeg を
> `vendor/ffmpeg/` に取得します（既にあればスキップ）。手動なら `npm run fetch:ffmpeg`。

## 配布（GitHub Releases）

ビルドした `release/モコシ Setup x.y.z.exe` を GitHub Releases に置いて配布します。

- **手動**: `npm run dist:win` → 生成された `.exe` を Release にアップロード。
- **自動(CI)**: タグ `v*` を push すると [.github/workflows/release.yml](.github/workflows/release.yml)
  が Windows でビルドし、Release に添付します（`package.json` の `build.publish` で GitHub 指定）。

> 現在の未署名 `.exe` は、利用者の初回起動時に Windows SmartScreen の警告が出ます
> （「詳細情報」→「実行」で起動可）。
>
> **配布方針（2026-07 更新）**: Windows は **Microsoft Store（AppX/MSIX）配布へ移行予定**です。
> Store 経由なら Microsoft が自動署名し、警告なし・自動更新（Store 管理）になります。
> 計画・手順・既存機能（自動更新/アンインストール）への影響は
> [docs/MICROSOFT_STORE.md](docs/MICROSOFT_STORE.md) を参照。
> 旧 Azure Trusted Signing による自前署名（[docs/CODE_SIGNING.md](docs/CODE_SIGNING.md)）は**非推奨**です。

> ネイティブ依存（sherpa-onnx-node のプラットフォーム別 .node）は各 OS 用バイナリが
> 必要なため、**配布ビルドは対象 OS 上（または CI のマトリクス）で実行**します。
> 未署名ビルドは macOS Gatekeeper / Windows SmartScreen の警告が出ます。

### FFmpeg（ライセンスクリーンな LGPL 同梱）

音声デコード用の FFmpeg は、配布物には **LGPL v3 ビルド**を `vendor/ffmpeg/<platform>-<arch>/` に置いて同梱します（`resolveFfmpegPath` がこれを最優先で使用）。`ffmpeg-static`（GPL）は開発時のフォールバックとしてのみ残し、**Windows 配布物からは除外**しています（`build.win.files` の `!node_modules/ffmpeg-static/ffmpeg.exe`）。

- Windows(x64): `vendor/ffmpeg/win32-x64/ffmpeg.exe`（BtbN の win64-lgpl 静的ビルド）を同梱済み。
- **macOS(arm64): 未配置。** 現状 mac ビルドは `ffmpeg-static`（GPL）にフォールバックします。配布前に LGPL の mac ビルドを `vendor/ffmpeg/darwin-arm64/ffmpeg` に置いてください（BtbN 等の LGPL ビルド）。

## ライセンス

- 本アプリのコードは **Apache-2.0**。ReazonSpeech モデル・sherpa-onnx も Apache-2.0。
- 任意取得の Conv-TasNet 音声分離モデルは **CC-BY-SA-4.0**。ONNX Runtime は **MIT**。
- FFmpeg は **LGPL v3**（別プロセスで呼び出し・改変なし再配布）。ライセンス全文と帰属は `licenses/` に格納し、アプリ内の「ⓘ 情報」画面から表示できます（`licenses/NOTICE.txt` に一覧）。
- Electron/Chromium の全ライセンスはパッケージ同梱の `LICENSES.chromium.html`（情報画面から開ける）。
