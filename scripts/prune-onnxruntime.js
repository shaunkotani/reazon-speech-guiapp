'use strict';

// onnxruntime-node の npm パッケージには全 OS / CPU と DirectML 用の
// ネイティブバイナリが含まれる。CPU 推論しか使わない本アプリでは、パッケージ後に
// 対象 OS / CPU の CPU ランタイムだけを残してインストーラー肥大化を防ぐ。
const fs = require('fs');
const path = require('path');
const { Arch } = require('builder-util');

function assertInside(root, target) {
  const resolvedRoot = path.resolve(root);
  const resolvedTarget = path.resolve(target);
  if (resolvedTarget === resolvedRoot || !resolvedTarget.startsWith(`${resolvedRoot}${path.sep}`)) {
    throw new Error(`ONNX Runtime の削除対象が不正です: ${resolvedTarget}`);
  }
}

function removeInside(root, target) {
  assertInside(root, target);
  fs.rmSync(target, { recursive: true, force: true });
}

module.exports = async function pruneOnnxRuntime(context) {
  const platform = context.electronPlatformName || context.packager.platform.nodeName;
  const arch = Arch[context.arch];
  if (!arch || arch === 'universal') throw new Error(`未対応のビルドCPUです: ${context.arch}`);
  const binRoot = path.resolve(
    context.appOutDir,
    'resources', 'app.asar.unpacked', 'node_modules', 'onnxruntime-node', 'bin',
  );
  if (!fs.existsSync(binRoot)) return;
  const napiDirs = fs.readdirSync(binRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && /^napi-v\d+$/.test(entry.name));
  if (napiDirs.length !== 1) throw new Error('ONNX Runtime の N-API ディレクトリを特定できません');
  const root = path.join(binRoot, napiDirs[0].name);
  const selected = path.resolve(root, platform, arch);
  assertInside(root, selected);
  if (!fs.existsSync(selected)) {
    throw new Error(`対象の ONNX Runtime バイナリがありません: ${platform}/${arch}`);
  }

  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    const candidate = path.join(root, entry.name);
    if (entry.name !== platform) removeInside(root, candidate);
  }
  const platformDir = path.join(root, platform);
  for (const entry of fs.readdirSync(platformDir, { withFileTypes: true })) {
    const candidate = path.join(platformDir, entry.name);
    if (entry.name !== arch) removeInside(root, candidate);
  }

  // Windows の DirectML 関連 DLL は GPU EP 専用。専用ワーカーは CPU EP を明示する。
  if (platform === 'win32') {
    for (const filename of ['DirectML.dll', 'dxcompiler.dll', 'dxil.dll']) {
      removeInside(root, path.join(selected, filename));
    }
  }
};
