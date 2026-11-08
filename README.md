# Loworld Desktop 셸 (LoworldUI-Desktop)

웹 앱 하나를 넣어 **Windows (`.exe` 설치형 / 포터블)** 및 **macOS (`.dmg` / `.app`)** 데스크톱 앱으로 내는 Electron 셸이다.
어느 앱이든 같은 코드로 띄우며, 셸 코드에는 특정 앱의 고정된 이름이나 원격 주소가 없다.

안드로이드 셸(`LoworldUI-AOS`), iOS 셸(`LoworldUI-iOS`)과 **100% 동일한 `window.loworldNative` 단일 통로 규격**을 제공하므로 웹 앱(`@loworld/common`의 `NativeSpeechAdapter`, `NativeSpeechEngineAdapter`)을 한 줄도 수정하지 않고 그대로 구동한다.

---

## 1. 핵심 설계 및 아키텍처

1. **오프라인 번들 스킴 (`loworld-app://bundle/`)**
   - `scripts/apply-package.sh`로 주입된 `app/www/` 정적 번들을 브라우저 표준 권한(`standard`, `secure`, `supportFetchAPI`, `corsEnabled`, `stream`)이 부여된 `loworld-app://bundle/` 출처로 서빙한다.
   - `<base href="/">`, `/assets/...`, `/content/wuxia/...` 경로와 `localStorage`가 인터넷 연결 없이 100% 동작한다.

2. **Supertonic 3 온디바이스 신경망 한국어 TTS (`sherpa-onnx-node` 1.13.8)**
   - 클라우드 API 호출 없이 기기 내 CPU(ONNX Runtime int8)로 동작하는 **Supertonic 3 (`sherpa-onnx-supertonic-3-tts-int8-2026-05-11`)** 모델을 내장한다.
   - 한국어 낭독 자연스러움이 검증된 5종의 AI 성우 목소리를 기본 제공한다:
     - `supertonic:0` — **아라 (차분한 여성)** *(자동 기본값)*
     - `supertonic:1` — **하늘 (밝은 여성)**
     - `supertonic:2` — **다인 (부드러운 여성)**
     - `supertonic:5` — **민준 (차분한 남성)**
     - `supertonic:6` — **태오 (중후한 남성)**
   - **문장 단위 파이프라인 스트리밍 (`splitForSpeech` + Web Audio 큐)**:
     - 긴 본문을 문장 끝(`. ! ? 。 ！ ？ … \n`, 최대 120자) 단위로 분할해 백그라운드 워커 스레드(`generateAsync`)에서 합성하고, 렌더러의 `AudioContext` 큐로 즉시 스트리밍한다.
     - 각 문장 조각이 재생되는 즉시 원문 글자 위치(`speech.range` `{ id, start, end }`)를 웹 앱에 알려 실시간 문장 하이라이트가 정확히 동기화된다.

3. **크로스 플랫폼 네이티브 바이너리 자동 확보 (`scripts/ensure-binaries.mjs`)**
   - `npm install` 시 `sherpa-onnx-darwin-arm64`, `sherpa-onnx-darwin-x64`, `sherpa-onnx-win-x64` 네이티브 바이너리를 모두 확보하여 macOS에서도 Windows용 `.exe` 설치 파일을 바로 빌드할 수 있다.

---

## 2. 사용 및 빌드 방법

워크스페이스 루트에서 한 줄로 실행할 수 있다:

```bash
# 천마회귀 데스크톱 앱(macOS + Windows) 한 번에 빌드 -> dist/desktop/
npm run build:desktop -- cheonma-1

# macOS(.dmg)만 빌드 / Windows(.exe)만 빌드
npm run build:desktop:mac -- cheonma-1
npm run build:desktop:win -- cheonma-1

# 작업 중: 번들 대신 개발 서버를 띄운다. 고치면 창에 바로 반영된다(워크스페이스 루트에서)
npm run desktop:list           # 앱마다 명령, 이름, 버전, 포트
npm run desktop:overview       # 쇼케이스(OS 화면, 4310)
npm run desktop:story-reader   # 앱 하나를 단독으로(앱마다 정해진 포트, 창과 저장 공간도 앱마다 따로)

# 묶어 둔 번들(app/www)로 띄우기. 최신이 아니다(다시 묶어야 바뀐다)
npm run desktop:bundle
```

개발 모드는 `--dev-url=<주소>` 인자(또는 `LOWORLD_DEV_URL`)로 켠다(`src/dev-url.cjs`). 이 기기 안의 주소(localhost)만 받는다.
개발 모드에서는 창이 하나만 뜬다. 다시 실행하면 떠 있는 창이 새 주소를 읽고 앞으로 나온다. 개발 서버가 다시 켜지는 동안에는 붙을 때까지 1초마다 다시 읽는다.

또는 `LoworldUI-Desktop` 폴더에서 직접 단계별로 실행할 수 있다:

```bash
# 1. Supertonic 3 모델 준비 및 소설 패키지 생성 (워크스페이스 루트)
node scripts/ensure-tts-model.mjs
node scripts/package-novel.mjs cheonma-1

# 2. 데스크톱 셸에 패키지 주입
cd LoworldUI-Desktop
./scripts/apply-package.sh ../dist/package/novel-cheonma

# 3. 단위 시험 (Supertonic 3 실제 한국어 음성 합성 포함)
npm test

# 4. 개발 실행 또는 설치 파일 패키징
npm start            # 데스크톱 앱 즉시 실행
npm run dist:mac     # macOS .dmg / .zip 생성
npm run dist:win     # Windows .exe (NSIS 설치형 + Portable) 생성
```

---

## 3. 코드 구조

| 파일 | 역할 |
|---|---|
| `src/main.cjs` | Electron 메인 프로세스. `loworld-app://bundle/` 스킴 서빙, 창 관리, `loworld:post` 브리지 처리 |
| `src/preload.cjs` | `window.loworldNative` 노출 (`hasAction`, `postMessage`) 및 Web Audio API 실시간 문장 스트리밍 재생기 |
| `src/app-package.cjs` | `app/app.native.json` 파싱 (`appId`, `appName`, `version`, `remoteUrl`) |
| `src/speech/supertonic-voices.cjs` | Supertonic 3 한국어 AI 성우 5종 및 시스템 음성 옵션 정의 |
| `src/speech/split-for-speech.cjs` | 문장 단위 분할 및 원문 `[start, end)` 오프셋 계산 (`SherpaSpeech.kt`와 동일) |
| `src/speech/sherpa-engine.cjs` | `sherpa-onnx-node` (`OfflineTts`) 초기화 및 한국어 비동기 음성 합성(`generateAsync`) |
| `src/speech/speech-router.cjs` | 음성 엔진 선택·기억(`loworld-shell-prefs.json`) 및 문장 스트리밍 세션 제어 |
| `scripts/apply-package.sh` | `www.zip`, `app.native.json`, `icon.png`를 `app/` 아래에 주입 |
| `scripts/ensure-binaries.mjs` | macOS(`arm64`/`x64`) 및 Windows(`x64`)용 `sherpa-onnx` 네이티브 바이너리 확보 |
| `scripts/build-electron.mjs` | `app.native.json` 메타데이터 기반 `electron-builder` 설정 생성 및 패키징 |
