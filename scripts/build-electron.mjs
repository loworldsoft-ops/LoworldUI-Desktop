#!/usr/bin/env node
/**
 * LoworldUI-Desktop/scripts/build-electron.mjs
 *
 * app/app.native.json에서 앱 이름·패키지 ID·버전을 읽어
 * electron-builder로 macOS(.dmg, .zip) 및 Windows(.exe NSIS 설치파일, .exe 포터블) 패키지를 생성한다.
 * LoworldUI-AOS의 app/build.gradle.kts와 동일한 셸 철학을 따른다.
 */

import { execFileSync, execSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const appDir = join(root, 'app');
const nativeJsonPath = join(appDir, 'app.native.json');

let pkgMeta = {};
if (existsSync(nativeJsonPath)) {
  try {
    pkgMeta = JSON.parse(readFileSync(nativeJsonPath, 'utf-8')) || {};
  } catch {
    pkgMeta = {};
  }
}

const appId = pkgMeta.androidPackageId || pkgMeta.iosBundleId || 'com.loworld.shell.desktop';
const appSlug = pkgMeta.appId || 'loworld-shell';
const productName = pkgMeta.appName || 'Loworld Shell';
const version = pkgMeta.version && pkgMeta.version !== '0.0.0' ? pkgMeta.version : '0.4.1';

// 512x512 이상 아이콘 보정 (electron-builder는 macOS/Windows 아이콘으로 최소 512x512 PNG를 요구함)
const rawIconPath = join(appDir, 'icon.png');
const buildResDir = join(root, 'build-resources');
mkdirSync(buildResDir, { recursive: true });
const icon512Path = join(buildResDir, 'icon.png');

if (existsSync(rawIconPath)) {
  try {
    execSync(`sips -z 512 512 "${rawIconPath}" --out "${icon512Path}"`, { stdio: 'ignore' });
  } catch {
    // sips가 없는 환경(Windows/Linux)에서는 원본 복사
    writeFileSync(icon512Path, readFileSync(rawIconPath));
  }
}

const hasIcon = existsSync(icon512Path);

const builderConfig = {
  appId,
  productName,
  executableName: appSlug,
  copyright: 'Copyright © 2026 Loworld',
  directories: {
    output: join(root, 'dist-electron', appSlug),
    buildResources: buildResDir,
  },
  files: [
    'src/**/*',
    'app/app.native.json',
    'app/icon.png',
    'app/www/**/*',
    'package.json',
    'node_modules/sherpa-onnx-node/**/*',
    'node_modules/sherpa-onnx-darwin-arm64/**/*',
    'node_modules/sherpa-onnx-darwin-x64/**/*',
    'node_modules/sherpa-onnx-win-x64/**/*',
  ],
  asar: true,
  asarUnpack: [
    '**/node_modules/sherpa-onnx-node/**',
    '**/node_modules/sherpa-onnx-darwin-arm64/**',
    '**/node_modules/sherpa-onnx-darwin-x64/**',
    '**/node_modules/sherpa-onnx-win-x64/**',
  ],
  extraResources: [
    {
      from: 'app/models/tts',
      to: 'models/tts',
      filter: ['**/*'],
    },
  ],
  mac: {
    category: 'public.app-category.books',
    ...(hasIcon ? { icon: icon512Path } : {}),
    target: [
      { target: 'dmg', arch: ['arm64', 'x64'] },
      { target: 'zip', arch: ['arm64', 'x64'] },
    ],
    identity: null,
  },
  win: {
    ...(hasIcon ? { icon: icon512Path } : {}),
    signAndEditExecutable: false,
    target: [
      { target: 'nsis', arch: ['x64'] },
      { target: 'portable', arch: ['x64'] },
    ],
  },
  nsis: {
    oneClick: false,
    allowToChangeInstallationDirectory: true,
    createDesktopShortcut: true,
    createStartMenuShortcut: true,
    shortcutName: productName,
    artifactName: `${appSlug}-setup-\${version}-\${arch}.\${ext}`,
  },
  portable: {
    artifactName: `${appSlug}-portable-\${version}-\${arch}.\${ext}`,
  },
  dmg: {
    artifactName: `${appSlug}-\${version}-mac-\${arch}.\${ext}`,
  },
};

const configPath = join(buildResDir, 'electron-builder.generated.json');
writeFileSync(configPath, JSON.stringify(builderConfig, null, 2) + '\n', 'utf-8');

const extraArgs = process.argv.slice(2);
const builderBin = join(
  root,
  'node_modules',
  '.bin',
  process.platform === 'win32' ? 'electron-builder.cmd' : 'electron-builder',
);

console.log(`\n📦 [LoworldUI-Desktop] Electron 패키징 시작: ${productName} (${appId} v${version})`);
console.log(`   옵션: ${extraArgs.join(' ') || '--dir'}`);

execFileSync(
  builderBin,
  ['--config', configPath, `--config.extraMetadata.version=${version}`, ...(extraArgs.length ? extraArgs : ['--dir'])],
  {
    cwd: root,
    stdio: 'inherit',
    env: {
      ...process.env,
      CSC_IDENTITY_AUTO_DISCOVERY: 'false',
    },
  },
);
