# GitHub Release 手順メモ

このリポジトリでは、`v*` 形式のGitタグをGitHubへpushすると、GitHub Actionsの
`Release (Windows)` がWindowsインストーラーをビルドし、GitHub Releaseへ添付する。

作業ディレクトリは以下を前提とする。

```powershell
cd D:\DWork\ReazonSpeech\ReazonSpeech
```

## 1. 公開する変更を確認する

最初に現在のブランチと未コミット差分を確認する。

```powershell
git status -sb
git diff --stat
git diff --check
```

- 通常は `main` ブランチからリリースする。
- 意図しないファイルが含まれていたら、そのまま `git add -A` しない。
- `git diff --check` の `LF will be replaced by CRLF` は改行コードの警告であり、エラーではない。
- 内容不明の変更を削除・上書きせず、公開対象か確認する。

## 2. 新しいバージョン番号を決める

現在のバージョンと既存タグを確認する。

```powershell
node -p "require('./package.json').version"
git tag --sort=-version:refname | Select-Object -First 10
```

バージョン番号は原則として次のように決める。

- 不具合修正のみ: `1.6.0` → `1.6.1`
- 後方互換性のある機能追加: `1.6.0` → `1.7.0`
- 大きな互換性変更: `1.6.0` → `2.0.0`

以下の `1.7.0` は例なので、実際に公開する番号へ置き換える。

```powershell
npm version 1.7.0 --no-git-tag-version
```

このコマンドは `package.json` と `package-lock.json` のバージョンを更新する。
`--no-git-tag-version` を外すと意図せずコミットやタグを作るため、必ず付ける。

更新結果を確認する。

```powershell
node -p "require('./package.json').version"
git diff -- package.json package-lock.json
```

## 3. テストする

現在用意されている回帰テストを実行する。

```powershell
npm run test:renderer
npm run test:overlap
npm run test:realtime
npm run test:cli -- samples\natural.wav
```

すべて成功してから次へ進む。失敗したテストがある状態ではタグを作らない。

必要に応じてアプリも起動し、今回変更した機能を手動確認する。

```powershell
npm start
```

## 4. コミットして `main` をpushする

公開対象のファイルだけをステージする。作業ツリー全体が今回のリリース対象だと確認できた場合は、
次のようにまとめてステージできる。

```powershell
git add -A
git status
```

`git status` の `Changes to be committed` を必ず確認してからコミットする。
以下のバージョン番号と説明は実際の内容に置き換える。

```powershell
git commit -m "リリース内容の短い説明（v1.7.0）"
git push origin main
```

push後、ローカルとGitHubの `main` が同じコミットか確認する。

```powershell
git fetch origin
git status -sb
git rev-parse HEAD
git rev-parse origin/main
```

最後の2つが同じ値ならよい。

## 5. リリースタグを作ってpushする

`package.json` のバージョンが `1.7.0` なら、タグは `v1.7.0` にする。

```powershell
git tag -a v1.7.0 -m "v1.7.0"
git show --no-patch v1.7.0
git push origin v1.7.0
```

重要事項:

- 必ず `main` のコミットをpushしてからタグをpushする。
- `package.json` の番号とタグの番号を一致させる。
- 一度公開したタグは使い回さない。修正が必要なら `v1.7.1` のように新しい番号を使う。

## 6. GitHub ActionsとReleaseを確認する

タグをpushすると、次のページで `Release (Windows)` が自動起動する。

- Actions: https://github.com/shaunkotani/reazon-speech-guiapp/actions
- Releases: https://github.com/shaunkotani/reazon-speech-guiapp/releases

確認項目:

1. `Release (Windows)` が成功している。
2. 対象バージョンのGitHub Releaseが作成されている。
3. WindowsインストーラーがReleaseのAssetsへ添付されている。
4. `latest.yml` など、自動アップデートに必要なファイルも添付されている。
5. 必要ならGitHub上でリリースノートを追記する。

配布前にインストーラーをダウンロードし、可能なら別環境で起動確認する。
現在のWindowsインストーラーは未署名のため、SmartScreen警告が表示される場合がある。

## 7. Actionsが失敗した場合

GitHubのActions画面で失敗したステップのログを確認する。

- 一時的な通信障害なら `Re-run failed jobs` を実行する。
- コードや設定の問題なら、修正コミットを `main` へpushする。
- すでに公開したタグを上書きせず、修正版はパッチ番号を上げて新しいタグで公開する。

例: `v1.7.0` の修正が必要なら `1.7.1` に更新し、コミット後に `v1.7.1` をpushする。

## 最短チェックリスト

```text
[ ] git status / diffで公開範囲を確認
[ ] package.jsonとpackage-lock.jsonのバージョンを更新
[ ] 全テスト成功
[ ] 公開対象だけをコミット
[ ] mainをpush
[ ] vX.Y.Zタグを作成してpush
[ ] GitHub Actions成功
[ ] Releaseとインストーラーを確認
[ ] 必要ならリリースノートを編集
```
