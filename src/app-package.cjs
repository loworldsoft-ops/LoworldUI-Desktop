/**
 * LoworldUI-Desktop/src/app-package.cjs
 *
 * 이 셸에 넣은 앱의 정보(app.native.json)를 읽는다.
 * 셸의 코드에는 특정 앱 이름이나 원격 주소가 고정되어 있지 않다.
 */

const fs = require('node:fs');
const path = require('node:path');

function resolveAppDir() {
  const candidates = [
    path.resolve(__dirname, '..', 'app'),
    process.resourcesPath ? path.join(process.resourcesPath, 'app', 'app') : null,
    process.resourcesPath ? path.join(process.resourcesPath, 'app.asar', 'app') : null,
  ].filter(Boolean);

  for (const dir of candidates) {
    if (fs.existsSync(path.join(dir, 'app.native.json')) || fs.existsSync(path.join(dir, 'www'))) {
      return dir;
    }
  }
  return path.resolve(__dirname, '..', 'app');
}

function loadAppPackage(customAppDir) {
  const appDir = customAppDir || resolveAppDir();
  const filePath = path.join(appDir, 'app.native.json');
  let json = {};
  try {
    if (fs.existsSync(filePath)) {
      json = JSON.parse(fs.readFileSync(filePath, 'utf-8')) || {};
    }
  } catch {
    json = {};
  }

  const remoteUrlRaw = typeof json.remoteUrl === 'string' ? json.remoteUrl.trim() : '';
  return {
    appId: json.appId || 'loworld-shell',
    appName: json.appName || 'Loworld Shell',
    entry: json.entry || 'index.html',
    version: json.version && json.version !== '0.0.0' ? json.version : '0.4.1',
    orientation: json.orientation || 'unspecified',
    remoteUrl: remoteUrlRaw.startsWith('https://') ? remoteUrlRaw : null,
    appDir,
    wwwDir: path.join(appDir, 'www'),
  };
}

module.exports = {
  resolveAppDir,
  loadAppPackage,
};
