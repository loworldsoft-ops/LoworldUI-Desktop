/**
 * LoworldUI-Desktop/src/speech/sherpa-engine.cjs
 *
 * Sherpa-ONNX (Supertonic 3 int8) 온디바이스 신경망 TTS 런타임.
 * macOS (arm64 / x64) 및 Windows (x64) 양쪽에서 네이티브 N-API 애드온을 로드하고,
 * 비동기 워커 스레드(generateAsync)에서 한국어 음성을 합성한다.
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { MODEL_FILES } = require('./supertonic-voices.cjs');

/**
 * Windows에서 app.asar.unpacked 내부의 sherpa-onnx-win-x64/sherpa-onnx.node를 로드할 때
 * 같은 폴더의 onnxruntime.dll, sherpa-onnx-c-api.dll을 찾을 수 있도록 PATH를 보강한다.
 */
function ensureNativeLibraryPath() {
  const platform = os.platform() === 'win32' ? 'win' : os.platform();
  const arch = os.arch();
  const pkgName = `sherpa-onnx-${platform}-${arch}`;

  const candidates = [
    path.resolve(__dirname, '..', '..', 'node_modules', pkgName),
    process.resourcesPath
      ? path.join(process.resourcesPath, 'app.asar.unpacked', 'node_modules', pkgName)
      : null,
    process.resourcesPath
      ? path.join(process.resourcesPath, 'node_modules', pkgName)
      : null,
  ].filter(Boolean);

  for (const dir of candidates) {
    if (fs.existsSync(path.join(dir, 'sherpa-onnx.node'))) {
      if (os.platform() === 'win32') {
        const currentPath = process.env.PATH || '';
        if (!currentPath.includes(dir)) {
          process.env.PATH = `${dir};${currentPath}`;
        }
      } else if (os.platform() === 'darwin') {
        const currentDyld = process.env.DYLD_LIBRARY_PATH || '';
        if (!currentDyld.includes(dir)) {
          process.env.DYLD_LIBRARY_PATH = currentDyld ? `${dir}:${currentDyld}` : dir;
        }
      }
      return dir;
    }
  }
  return null;
}

/**
 * Supertonic 3 모델 디렉토리를 탐색한다.
 * 1순위: 패키징된 Electron extraResources (`process.resourcesPath/models/tts`)
 * 2순위: 셸 내부 `LoworldUI-Desktop/app/models/tts`
 * 3순위: 워크스페이스 캐시 `dist/cache/sherpa-onnx-supertonic-3-tts-int8-2026-05-11`
 */
function resolveModelDir(customDir) {
  const candidates = [
    customDir,
    process.resourcesPath ? path.join(process.resourcesPath, 'models', 'tts') : null,
    process.resourcesPath ? path.join(process.resourcesPath, 'app.asar.unpacked', 'app', 'models', 'tts') : null,
    path.resolve(__dirname, '..', '..', 'app', 'models', 'tts'),
    path.resolve(__dirname, '..', '..', '..', 'dist', 'cache', 'sherpa-onnx-supertonic-3-tts-int8-2026-05-11'),
  ].filter(Boolean);

  for (const dir of candidates) {
    if (MODEL_FILES.every((f) => fs.existsSync(path.join(dir, f)))) {
      return dir;
    }
  }
  return null;
}

class SherpaSupertonicEngine {
  constructor(options = {}) {
    this.customModelDir = options.modelDir || null;
    this.tts = null;
    this.preparingPromise = null;
    this.failed = false;
    this.modelDir = null;
  }

  isModelPresent() {
    return resolveModelDir(this.customModelDir) !== null;
  }

  async prepare() {
    if (this.tts) return true;
    if (this.failed) return false;
    if (this.preparingPromise) return this.preparingPromise;

    this.preparingPromise = (async () => {
      try {
        const modelDir = resolveModelDir(this.customModelDir);
        if (!modelDir) {
          console.warn('[SherpaSupertonicEngine] Supertonic 3 모델 파일을 찾을 수 없습니다.');
          this.failed = true;
          return false;
        }
        this.modelDir = modelDir;

        ensureNativeLibraryPath();
        const sherpa = require('sherpa-onnx-node');
        const OfflineTts = sherpa.OfflineTts || (sherpa.default && sherpa.default.OfflineTts);
        if (!OfflineTts) {
          throw new Error('sherpa-onnx-node에서 OfflineTts 생성자를 찾을 수 없습니다.');
        }

        const cpuCount = os.cpus()?.length || 2;
        const numThreads = Math.max(1, Math.min(4, Math.floor(cpuCount / 2)));

        const config = {
          model: {
            supertonic: {
              durationPredictor: path.join(modelDir, 'duration_predictor.int8.onnx'),
              textEncoder: path.join(modelDir, 'text_encoder.int8.onnx'),
              vectorEstimator: path.join(modelDir, 'vector_estimator.int8.onnx'),
              vocoder: path.join(modelDir, 'vocoder.int8.onnx'),
              ttsJson: path.join(modelDir, 'tts.json'),
              unicodeIndexer: path.join(modelDir, 'unicode_indexer.bin'),
              voiceStyle: path.join(modelDir, 'voice.bin'),
            },
            numThreads,
            debug: 0,
            provider: 'cpu',
          },
          maxNumSentences: 1,
        };

        if (typeof OfflineTts.createAsync === 'function') {
          this.tts = await OfflineTts.createAsync(config);
        } else {
          this.tts = new OfflineTts(config);
        }

        return true;
      } catch (err) {
        console.error('[SherpaSupertonicEngine] 초기화 실패:', err);
        this.failed = true;
        return false;
      } finally {
        this.preparingPromise = null;
      }
    })();

    return this.preparingPromise;
  }

  /**
   * 한 문장 조각을 Supertonic 3로 합성한다.
   * @param {string} text
   * @param {number} sid 화자 번호 (0, 1, 2, 5, 6)
   * @param {number} rate 재생 배속 (0.25 ~ 4.0)
   * @returns {Promise<{ samples: Float32Array, sampleRate: number } | null>}
   */
  async synthesizePiece(text, sid = 0, rate = 1.0) {
    const ok = await this.prepare();
    if (!ok || !this.tts) return null;

    const clampedSpeed = Math.max(0.25, Math.min(4.0, Number.isFinite(rate) && rate > 0 ? rate : 1.0));
    const request = {
      text,
      sid,
      speed: clampedSpeed,
      enableExternalBuffer: false,
      generationConfig: {
        sid,
        speed: clampedSpeed,
        numSteps: 8,
        extra: { lang: 'ko' },
      },
    };

    if (typeof this.tts.generateAsync === 'function') {
      return await this.tts.generateAsync(request);
    }
    return this.tts.generate(request);
  }
}

module.exports = {
  SherpaSupertonicEngine,
  resolveModelDir,
  ensureNativeLibraryPath,
};
