#!/usr/bin/env node
/**
 * LoworldUI-Desktop/scripts/ensure-binaries.mjs
 *
 * Ensures that sherpa-onnx native addon packages for both macOS (arm64, x64)
 * and Windows (x64) exist in node_modules so electron-builder can package
 * both macOS (.dmg/.app) and Windows (.exe) installers on any host OS.
 */

import { execSync } from 'node:child_process';
import { existsSync, mkdirSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const nodeModules = join(root, 'node_modules');
const VERSION = '1.13.8';

const TARGET_PACKAGES = [
  { name: 'sherpa-onnx-darwin-arm64', marker: 'sherpa-onnx.node' },
  { name: 'sherpa-onnx-darwin-x64', marker: 'sherpa-onnx.node' },
  { name: 'sherpa-onnx-win-x64', marker: 'sherpa-onnx.node' },
];

mkdirSync(nodeModules, { recursive: true });

for (const pkg of TARGET_PACKAGES) {
  const pkgDir = join(nodeModules, pkg.name);
  if (existsSync(join(pkgDir, pkg.marker))) {
    continue;
  }

  console.log(`[ensure-binaries] ${pkg.name}@${VERSION} 다운로드 및 배치 중...`);
  const tarballUrl = `https://registry.npmjs.org/${pkg.name}/-/${pkg.name}-${VERSION}.tgz`;
  rmSync(pkgDir, { recursive: true, force: true });
  mkdirSync(pkgDir, { recursive: true });

  try {
    execSync(`curl -fsSL "${tarballUrl}" | tar -xzf - --strip-components=1 -C "${pkgDir}"`, {
      stdio: 'inherit',
    });
    console.log(`[ensure-binaries] ${pkg.name}@${VERSION} 준비 완료.`);
  } catch (err) {
    console.warn(`[ensure-binaries] ${pkg.name} 다운로드 실패 (해당 OS 타겟 빌드 시 필요): ${err.message}`);
  }
}
