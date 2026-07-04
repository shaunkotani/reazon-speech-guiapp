// Windows リリースビルド用の electron-builder 設定（Azure Trusted Signing で署名）。
//
// 使い方:  npm run dist:win:signed   （Windows 実機 / CI で実行）
//
// package.json の "build" をそのまま継承し、win.azureSignOptions だけを足す。
// 通常の `npm run dist:win` は未署名のまま（ローカル検証用）で残す。
//
// 必要な環境変数
//   ── Microsoft Entra 認証（機密。CI の Secrets で渡す。コミットしない） ──
//   AZURE_TENANT_ID        アプリ登録（サービスプリンシパル）のテナントID
//   AZURE_CLIENT_ID        アプリ登録のクライアントID
//   AZURE_CLIENT_SECRET    アプリ登録のクライアントシークレット
//   ── Trusted Signing アカウント情報（機密ではない） ──
//   AZURE_TS_ENDPOINT      例: https://weu.codesigning.azure.net/（アカウント作成リージョンのURI）
//   AZURE_TS_ACCOUNT       Code Signing アカウント名
//   AZURE_TS_PROFILE       証明書プロファイル名
//   AZURE_TS_PUBLISHER     証明書の発行先(Subject)と一致する表示名
//
// 事前準備（詳細は docs/CODE_SIGNING.md）:
//   - Azure で Trusted Signing アカウント＋証明書プロファイルを作成し、本人/組織の
//     アイデンティティ検証を完了しておく。
//   - サービスプリンシパルに「Trusted Signing Certificate Profile Signer」ロールを付与。
//   - 署名を実行する Windows に Windows SDK の signtool.exe があること。

const base = require('./package.json').build;

const required = {
  AZURE_TS_ENDPOINT: process.env.AZURE_TS_ENDPOINT,
  AZURE_TS_ACCOUNT: process.env.AZURE_TS_ACCOUNT,
  AZURE_TS_PROFILE: process.env.AZURE_TS_PROFILE,
  AZURE_TS_PUBLISHER: process.env.AZURE_TS_PUBLISHER,
};
const missing = Object.entries(required).filter(([, v]) => !v).map(([k]) => k);
if (missing.length) {
  throw new Error(
    `Azure Trusted Signing 用の環境変数が未設定です: ${missing.join(', ')}\n` +
    '認証用の AZURE_TENANT_ID / AZURE_CLIENT_ID / AZURE_CLIENT_SECRET も併せて設定してください。\n' +
    '設定手順は docs/CODE_SIGNING.md を参照。',
  );
}

module.exports = {
  ...base,
  win: {
    ...base.win,
    azureSignOptions: {
      endpoint: required.AZURE_TS_ENDPOINT,
      codeSigningAccountName: required.AZURE_TS_ACCOUNT,
      certificateProfileName: required.AZURE_TS_PROFILE,
      publisherName: required.AZURE_TS_PUBLISHER,
      // fileDigest / timestampDigest / timestampRfc3161 は既定(SHA256 / Azure タイムスタンプ)を使用
    },
  },
};
