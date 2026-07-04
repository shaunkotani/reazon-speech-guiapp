# ReazonSpeech Transcribe（ローカル日本語文字起こしアプリ）

[ReazonSpeech](https://github.com/reazon-research/ReazonSpeech) の k2 モデルを
[sherpa-onnx](https://github.com/k2-fsa/sherpa-onnx) 経由で動かす、**完全ローカル・オフライン**の
日本語文字起こしデスクトップアプリです。Python のインストールは不要です。

文字起こし→モコシです。一応...。

- 音声/動画ファイルをドラッグ＆ドロップ → 文字起こし
- 取り込んだ**元音声のプレビュー再生**
- **ノイズ除去**（GTCRN）: 強度を なし/弱/中/強 から選択、**除去後のプレビュー再生**も可能
- VAD で発話区間に分割し、区間ごとのタイムスタンプを付与
- **高精度モード**: beam search 復号で認識精度を底上げ（処理速度はやや低下）。辞書とは独立に ON/OFF 可能
- **用語辞書（ホットワード）**: 固有名詞・専門用語を登録すると優先認識（内部で高精度モードを自動有効化）
- 進捗バーに**推定残り時間**を表示
- TXT / SRT / VTT / JSON でエクスポート
- 推論は CPU のみ・ネットワーク不要（モデル初回取得時のみ通信）

## 構成

| 層 | 採用技術 |
|---|---|
| デスクトップ | Electron + electron-builder |
| 推論 | sherpa-onnx-node（ネイティブ addon） |
| モデル | reazonspeech-k2-v2（Zipformer transducer, int8, 約150MB） |
| 音声デコード | ffmpeg-static（任意フォーマット → 16kHz mono） |
| 発話分割 | Silero VAD |
| ノイズ除去 | GTCRN（gtcrn_simple.onnx, 約0.5MB） |
| 音声プレビュー | app-media カスタムプロトコル経由で `<audio>` 再生 |

```
src/
  core/asr.js          推論パイプライン（ffmpeg → VAD → 認識）
  main/main.js         Electron メイン（ウィンドウ / IPC）
  main/preload.js      contextBridge
  main/modelManager.js モデルの所在解決・初回ダウンロード
  renderer/            UI（HTML/CSS/JS）
  shared/export.js     TXT/SRT/VTT/JSON 整形
scripts/test-pipeline.js  CLI 動作確認
```

## 開発

```bash
npm install
# dev 実行時はリポジトリ直下 ./models があればそれを使う
npm start          # アプリ起動
npm run test:cli samples/natural.wav   # CLI で文字起こし確認
```

### モデルの取得（開発時）

```bash
mkdir -p models/reazonspeech-k2-v2
# reazon-research/reazonspeech-k2-v2 から int8  onnx 3点 + tokens.txt を models/reazonspeech-k2-v2/ へ
# k2-fsa の silero_vad.onnx を models/ へ
```
アプリ起動時、`./models` が無ければ `userData/models` に初回ダウンロードします。

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

> 未署名のため、利用者は初回起動時に Windows SmartScreen の警告が出ます
> （「詳細情報」→「実行」で起動可）。コード署名を行う場合は
> [docs/CODE_SIGNING.md](docs/CODE_SIGNING.md) を参照（任意）。

> ネイティブ依存（sherpa-onnx-node のプラットフォーム別 .node）は各 OS 用バイナリが
> 必要なため、**配布ビルドは対象 OS 上（または CI のマトリクス）で実行**します。
> 未署名ビルドは macOS Gatekeeper / Windows SmartScreen の警告が出ます。

### FFmpeg（ライセンスクリーンな LGPL 同梱）

音声デコード用の FFmpeg は、配布物には **LGPL v3 ビルド**を `vendor/ffmpeg/<platform>-<arch>/` に置いて同梱します（`resolveFfmpegPath` がこれを最優先で使用）。`ffmpeg-static`（GPL）は開発時のフォールバックとしてのみ残し、**Windows 配布物からは除外**しています（`build.win.files` の `!node_modules/ffmpeg-static/ffmpeg.exe`）。

- Windows(x64): `vendor/ffmpeg/win32-x64/ffmpeg.exe`（BtbN の win64-lgpl 静的ビルド）を同梱済み。
- **macOS(arm64): 未配置。** 現状 mac ビルドは `ffmpeg-static`（GPL）にフォールバックします。配布前に LGPL の mac ビルドを `vendor/ffmpeg/darwin-arm64/ffmpeg` に置いてください（BtbN 等の LGPL ビルド）。

## ライセンス

- 本アプリのコードは **Apache-2.0**。ReazonSpeech モデル・sherpa-onnx も Apache-2.0。
- FFmpeg は **LGPL v3**（別プロセスで呼び出し・改変なし再配布）。ライセンス全文と帰属は `licenses/` に格納し、アプリ内の「ⓘ 情報」画面から表示できます（`licenses/NOTICE.txt` に一覧）。
- Electron/Chromium の全ライセンスはパッケージ同梱の `LICENSES.chromium.html`（情報画面から開ける）。
