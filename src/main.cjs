/**
 * LoworldUI-Desktop/src/main.cjs
 *
 * Windows / macOS 겸용 Electron 데스크톱 셸 메인 프로세스.
 * - `loworld-app://bundle/` 커스텀 스킴으로 `app/www/` 오프라인 번들을 서빙한다.
 * - `LoworldNativeBridge` 규격(IPC)을 통해 Supertonic 3 신경망 한국어 TTS를 구동한다.
 * - 앱 이름, 아이콘, 시작 파일은 `app/app.native.json`에서 읽는다.
 */

const fs = require('node:fs');
const path = require('node:path');
const { app, BrowserWindow, dialog, ipcMain, protocol, shell } = require('electron');
const { loadAppPackage } = require('./app-package.cjs');
const { SpeechRouter } = require('./speech/speech-router.cjs');
const { devUrlFrom, isSameOrigin } = require('./dev-url.cjs');

const SCHEME = 'loworld-app';
const HOST = 'bundle';
const PREPARE_TIMEOUT_MS = 6_000;

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.ogg': 'audio/ogg',
  '.txt': 'text/plain; charset=utf-8',
};

// 브라우저 표준 스킴 등록 (fetch, ES Modules, localStorage, Web Audio 완벽 지원)
protocol.registerSchemesAsPrivileged([
  {
    scheme: SCHEME,
    privileges: {
      standard: true,
      secure: true,
      supportFetchAPI: true,
      corsEnabled: true,
      stream: true,
    },
  },
]);

let mainWindow = null;
let appPackage = null;
let speechRouter = null;
let executionMode = 'LOCAL_ASSET';
/** 개발 모드의 주소(dev-url.cjs). 있으면 번들 대신 개발 서버를 띄운다 */
let devUrl = devUrlFrom(process.argv, process.env);
const DEV_RETRY_MS = 1_000;

function sendToRenderer(message) {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  mainWindow.webContents.send('loworld:message', message);
}

function sendEngines() {
  if (!speechRouter) return;
  sendToRenderer({
    type: 'speech.engines',
    data: speechRouter.enginesPayload(),
  });
}

function sendExecutionMode() {
  sendToRenderer({
    type: 'executionMode',
    data: { mode: executionMode },
  });
}

function currentActions() {
  const actions = [
    'capabilities',
    'getExecutionMode',
    'openModeSelector',
    'speech.engines',
    'speech.chooseEngine',
    'speech.speak',
    'speech.stop',
  ];
  if (speechRouter && speechRouter.canListen) {
    actions.push('speech.listen');
  }
  return actions;
}

function registerBundleProtocol(wwwDir, entryFile) {
  protocol.handle(SCHEME, (request) => {
    try {
      const url = new URL(request.url);
      let relPath = decodeURIComponent(url.pathname || '/').replace(/^\/+/, '');
      if (!relPath) relPath = entryFile;

      const resolvedRoot = path.resolve(wwwDir);
      let targetPath = path.resolve(resolvedRoot, relPath);

      // 디렉토리 탈출 방지
      if (!targetPath.startsWith(resolvedRoot)) {
        return new Response('Forbidden', { status: 403 });
      }

      if (fs.existsSync(targetPath) && fs.statSync(targetPath).isDirectory()) {
        targetPath = path.join(targetPath, 'index.html');
      }

      // SPA 라우팅 폴백: 확장자가 없는 경로가 파일로 없으면 entry(index.html) 반환
      if (!fs.existsSync(targetPath)) {
        if (!path.extname(targetPath)) {
          targetPath = path.join(resolvedRoot, entryFile);
        } else {
          return new Response('Not Found', { status: 404 });
        }
      }

      const ext = path.extname(targetPath).toLowerCase();
      const contentType = MIME_TYPES[ext] || 'application/octet-stream';
      const data = fs.readFileSync(targetPath);

      return new Response(data, {
        status: 200,
        headers: {
          'Content-Type': contentType,
          'Cache-Control': 'no-cache',
        },
      });
    } catch (err) {
      console.error('[LoworldUI-Desktop protocol] 요청 처리 오류:', err);
      return new Response('Internal Server Error', { status: 500 });
    }
  });
}

function registerIpcHandlers() {
  ipcMain.on('loworld:playback-finished', (_event, utteranceId) => {
    if (speechRouter && utteranceId) {
      speechRouter.notifyPlaybackFinished(String(utteranceId));
    }
  });

  ipcMain.on('loworld:post', async (_event, rawJson) => {
    let payload;
    try {
      payload = JSON.parse(rawJson);
    } catch {
      return;
    }
    if (!payload || typeof payload.action !== 'string') return;

    const action = payload.action;
    switch (action) {
      case 'capabilities': {
        sendToRenderer({
          type: 'capabilities',
          data: {
            platform: 'desktop',
            os: process.platform,
            actions: currentActions(),
          },
        });
        break;
      }

      case 'getExecutionMode': {
        sendExecutionMode();
        break;
      }

      case 'openModeSelector': {
        if (!mainWindow || mainWindow.isDestroyed()) break;
        const buttons = ['내장 에셋 (오프라인)'];
        if (appPackage.remoteUrl) {
          buttons.push('원격 웹 (온라인)');
        }
        buttons.push('취소');
        const cancelId = buttons.length - 1;
        const result = await dialog.showMessageBox(mainWindow, {
          type: 'question',
          title: '실행 방식 선택',
          message: '앱 실행 방식을 선택하세요.',
          buttons,
          defaultId: executionMode === 'REMOTE_WEB' && appPackage.remoteUrl ? 1 : 0,
          cancelId,
        });
        if (result.response !== cancelId) {
          const nextMode = result.response === 1 && appPackage.remoteUrl ? 'REMOTE_WEB' : 'LOCAL_ASSET';
          if (nextMode !== executionMode) {
            executionMode = nextMode;
            loadCurrentAppUrl();
          }
        }
        break;
      }

      case 'speech.speak': {
        const id = String(payload.id || '');
        const text = String(payload.text || '');
        const rate = Number(payload.rate) > 0 ? Number(payload.rate) : 1.0;

        await speechRouter.speak(
          { id, text, rate },
          {
            onAudioChunk(chunk) {
              if (!mainWindow || mainWindow.isDestroyed()) return;
              mainWindow.webContents.send('loworld:audio-chunk', chunk);
            },
            onCancelAudio(utteranceId) {
              if (!mainWindow || mainWindow.isDestroyed()) return;
              mainWindow.webContents.send('loworld:audio-stop', utteranceId);
            },
            onSystemSpeak(sysPayload) {
              if (!mainWindow || mainWindow.isDestroyed()) return;
              mainWindow.webContents.send('loworld:system-speak', sysPayload);
            },
            onSpoken(spokenId) {
              sendToRenderer({
                type: 'speech.spoken',
                data: { id: spokenId },
              });
            },
          },
        );
        break;
      }

      case 'speech.stop': {
        speechRouter.stop((utteranceId) => {
          if (!mainWindow || mainWindow.isDestroyed()) return;
          mainWindow.webContents.send('loworld:audio-stop', utteranceId);
        });
        break;
      }

      case 'speech.listen': {
        const id = String(payload.id || '');
        sendToRenderer({
          type: 'speech.heard',
          data: { id, text: '' },
        });
        break;
      }

      case 'speech.engines': {
        sendEngines();
        break;
      }

      case 'speech.chooseEngine': {
        const kind = String(payload.kind || 'speak');
        const id = String(payload.id || 'auto');
        await speechRouter.choose(kind, id);
        sendEngines();
        break;
      }

      default:
        break;
    }
  });
}

function localAppUrl() {
  return `${SCHEME}://${HOST}/${appPackage.entry}`;
}

function loadCurrentAppUrl() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  if (devUrl) {
    mainWindow.loadURL(devUrl);
    return;
  }
  const targetUrl =
    executionMode === 'REMOTE_WEB' && appPackage.remoteUrl
      ? appPackage.remoteUrl
      : localAppUrl();
  mainWindow.loadURL(targetUrl);
}

function createWindow() {
  const isLandscape = appPackage.orientation === 'landscape';
  const iconPath = path.join(appPackage.appDir, 'icon.png');

  mainWindow = new BrowserWindow({
    title: devUrl ? `${appPackage.appName} (개발)` : appPackage.appName,
    width: isLandscape ? 1280 : 1080,
    height: isLandscape ? 820 : 860,
    minWidth: 420,
    minHeight: 680,
    backgroundColor: '#12100e',
    autoHideMenuBar: true,
    ...(fs.existsSync(iconPath) ? { icon: iconPath } : {}),
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      autoplayPolicy: 'no-user-gesture-required',
    },
  });

  // 외부 링크는 시스템 기본 브라우저로 위임
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (!url.startsWith(`${SCHEME}://`) && !(devUrl && isSameOrigin(devUrl, url))) {
      shell.openExternal(url).catch(() => {});
      return { action: 'deny' };
    }
    return { action: 'allow' };
  });

  // 개발 서버가 아직 뜨지 않았거나 다시 켜지는 중이면 붙을 때까지 다시 읽는다
  mainWindow.webContents.on('did-fail-load', (_event, _code, _desc, failedUrl, isMainFrame) => {
    if (!devUrl || !isMainFrame || !isSameOrigin(devUrl, failedUrl)) return;
    setTimeout(() => {
      if (mainWindow && !mainWindow.isDestroyed()) mainWindow.loadURL(failedUrl);
    }, DEV_RETRY_MS);
  });

  mainWindow.webContents.on('did-finish-load', () => {
    sendExecutionMode();
    sendEngines();
  });

  mainWindow.on('closed', () => {
    if (speechRouter) {
      speechRouter.stop();
    }
    mainWindow = null;
  });
}

// 개발 모드에서는 창을 하나만 둔다. 작업할 때마다 다시 실행하면 새 창을 열지 않고
// 떠 있는 창이 넘겨받은 주소를 다시 읽고 앞으로 나온다.
let secondInstance = false;
if (devUrl && !process.argv.includes('--smoke-test')) {
  if (!app.requestSingleInstanceLock()) {
    secondInstance = true;
    app.quit();
  } else {
    app.on('second-instance', (_event, argv) => {
      devUrl = devUrlFrom(argv, {}) || devUrl;
      if (!mainWindow || mainWindow.isDestroyed()) return;
      loadCurrentAppUrl();
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.show();
      mainWindow.focus();
    });
  }
}

app.whenReady().then(async () => {
  if (secondInstance) return;
  appPackage = loadAppPackage();
  app.setName(appPackage.appName);

  const prefsPath = path.join(app.getPath('userData'), 'loworld-shell-prefs.json');
  speechRouter = new SpeechRouter({ prefsPath });

  registerBundleProtocol(appPackage.wwwDir, appPackage.entry);
  registerIpcHandlers();
  createWindow();

  // MainActivity.kt와 동일하게 음성 엔진 준비 후 웹 앱을 로드하되,
  // 최대 PREPARE_TIMEOUT_MS 안에 안 끝나면 먼저 웹을 띄우고 완료 시 sendEngines()를 보낸다.
  let loaded = false;
  const loadOnce = () => {
    if (!loaded) {
      loaded = true;
      loadCurrentAppUrl();
    }
  };

  const timer = setTimeout(loadOnce, PREPARE_TIMEOUT_MS);
  speechRouter.prepare().then(() => {
    clearTimeout(timer);
    if (!loaded) {
      loadOnce();
    } else {
      sendEngines();
    }
  });

  // --smoke-test 플래그로 실행된 경우: 엔진 준비 및 브리지 + 실제 Supertonic 3 재생 파이프라인 검증 후 종료
  if (process.argv.includes('--smoke-test')) {
    mainWindow.webContents.once('did-finish-load', async () => {
      try {
        await speechRouter.prepare();
        const check = await mainWindow.webContents.executeJavaScript(`
          new Promise((resolve, reject) => {
            const events = [];
            const prev = window.onLoworldNativeMessage;
            window.onLoworldNativeMessage = (msg) => {
              if (prev) prev(msg);
              events.push(msg.type);
              if (msg.type === 'speech.spoken' && msg.data?.id === 'smoke-utt-1') {
                resolve({
                  title: document.title,
                  hasEngines: window.loworldNative?.hasAction('speech.engines') === true,
                  hasSpeak: window.loworldNative?.hasAction('speech.speak') === true,
                  events,
                });
              }
            };
            window.loworldNative.postMessage(JSON.stringify({ action: 'speech.engines' }));
            window.loworldNative.postMessage(JSON.stringify({
              action: 'speech.speak',
              id: 'smoke-utt-1',
              text: '천마의 귀환을 환영하오.',
              rate: 1.5,
            }));
            setTimeout(() => reject(new Error('TTS smoke test timeout: ' + JSON.stringify(events))), 12000);
          })
        `);
        console.log('[smoke-test] E2E 브리지 및 Supertonic 3 재생 검증 통과:', JSON.stringify({
          ...check,
          activeVoice: speechRouter.activeSpeak,
          sherpaReady: speechRouter.sherpaReady,
        }));
        setTimeout(() => app.quit(), 200);
      } catch (err) {
        console.error('[smoke-test] 오류:', err);
        app.exit(1);
      }
    });
  }

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
      loadCurrentAppUrl();
    }
  });
});

app.on('window-all-closed', () => {
  if (speechRouter) {
    speechRouter.stop();
  }
  if (process.platform !== 'darwin' || process.argv.includes('--smoke-test')) {
    app.quit();
  }
});
