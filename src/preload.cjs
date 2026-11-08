/**
 * LoworldUI-Desktop/src/preload.cjs
 *
 * 웹 앱(@loworld/common)이 기대하는 `window.loworldNative` 통로를 노출하고,
 * 메인 프로세스의 Supertonic 3가 합성한 Float32 PCM 오디오 조각을
 * Web Audio API로 끊김 없이 재생하며 문장 하이라이트(speech.range)와 완료(speech.spoken)를 전달한다.
 */

const { contextBridge, ipcRenderer, webFrame } = require('electron');

const SUPPORTED_ACTIONS = new Set([
  'capabilities',
  'getExecutionMode',
  'openModeSelector',
  'speech.engines',
  'speech.chooseEngine',
  'speech.speak',
  'speech.stop',
]);

/**
 * 메인 월드(Angular 앱)의 `window.onLoworldNativeMessage`로 메시지를 전달한다.
 * LoworldUI-AOS의 LoworldNativeBridge.kt send()와 100% 동일한 방식이다.
 */
function sendToMainWorld(message) {
  const payload = JSON.stringify(message);
  webFrame
    .executeJavaScript(`window.onLoworldNativeMessage && window.onLoworldNativeMessage(${payload});`)
    .catch(() => {});
}

// ============================================================================
// Web Audio API 스트리밍 재생 큐 (Supertonic 3 문장 단위 실시간 재생)
// ============================================================================
let audioCtx = null;
let currentUtteranceId = null;
let chunkQueue = [];
let activeSource = null;
let isPlayingChunk = false;

function getAudioContext(sampleRate) {
  if (!audioCtx || audioCtx.state === 'closed') {
    const Ctor = window.AudioContext || window.webkitAudioContext;
    audioCtx = new Ctor(sampleRate ? { sampleRate } : undefined);
  }
  if (audioCtx.state === 'suspended') {
    audioCtx.resume().catch(() => {});
  }
  return audioCtx;
}

function stopAudioPlayback(targetUtteranceId) {
  if (targetUtteranceId && currentUtteranceId && targetUtteranceId !== currentUtteranceId) {
    return;
  }
  chunkQueue = [];
  isPlayingChunk = false;
  currentUtteranceId = null;
  if (activeSource) {
    try {
      activeSource.onended = null;
      activeSource.stop();
      activeSource.disconnect();
    } catch {
      // 이미 정지됨
    }
    activeSource = null;
  }
  if (typeof window !== 'undefined' && 'speechSynthesis' in window) {
    try {
      window.speechSynthesis.cancel();
    } catch {
      // 무시
    }
  }
}

function playNextChunk() {
  if (isPlayingChunk || chunkQueue.length === 0) return;

  const chunk = chunkQueue.shift();
  if (!chunk || chunk.utteranceId !== currentUtteranceId) {
    playNextChunk();
    return;
  }

  // 빈 샘플인 경우(합성 결과 없음) 마지막 조각이면 완료만 알린다.
  if (!chunk.samples || chunk.samples.length === 0) {
    if (chunk.isLast) {
      const doneId = chunk.utteranceId;
      currentUtteranceId = null;
      ipcRenderer.send('loworld:playback-finished', doneId);
    } else {
      playNextChunk();
    }
    return;
  }

  try {
    isPlayingChunk = true;
    const sampleRate = chunk.sampleRate || 44100;
    const ctx = getAudioContext(sampleRate);
    const floatSamples =
      chunk.samples instanceof Float32Array
        ? chunk.samples
        : new Float32Array(chunk.samples.buffer || chunk.samples);

    const audioBuffer = ctx.createBuffer(1, floatSamples.length, sampleRate);
    audioBuffer.copyToChannel(floatSamples, 0);

    const source = ctx.createBufferSource();
    source.buffer = audioBuffer;
    source.connect(ctx.destination);
    activeSource = source;

    // 문장 조각 재생 시작과 동시에 웹 앱에 읽는 범위(speech.range) 전달
    sendToMainWorld({
      type: 'speech.range',
      data: {
        id: chunk.utteranceId,
        start: chunk.start,
        end: chunk.end,
      },
    });

    source.onended = () => {
      if (activeSource === source) {
        activeSource = null;
      }
      isPlayingChunk = false;
      if (chunk.utteranceId !== currentUtteranceId) {
        return;
      }
      if (chunk.isLast && chunkQueue.length === 0) {
        const doneId = chunk.utteranceId;
        currentUtteranceId = null;
        ipcRenderer.send('loworld:playback-finished', doneId);
      } else {
        playNextChunk();
      }
    };

    source.start(0);
  } catch (err) {
    console.error('[LoworldUI-Desktop preload] 오디오 재생 오류:', err);
    isPlayingChunk = false;
    if (chunk.isLast) {
      const doneId = chunk.utteranceId;
      currentUtteranceId = null;
      ipcRenderer.send('loworld:playback-finished', doneId);
    } else {
      playNextChunk();
    }
  }
}

// ============================================================================
// 시스템 음성 폴백 (Web Speech API)
// ============================================================================
function speakWithSystemVoice({ id, text, rate }) {
  stopAudioPlayback();
  currentUtteranceId = id;

  if (typeof window === 'undefined' || !('speechSynthesis' in window) || !text) {
    currentUtteranceId = null;
    ipcRenderer.send('loworld:playback-finished', id);
    return;
  }

  const synth = window.speechSynthesis;
  synth.cancel();

  const utterance = new SpeechSynthesisUtterance(text);
  utterance.lang = 'ko-KR';
  utterance.rate = Number.isFinite(rate) && rate > 0 ? rate : 1.0;

  const voices = synth.getVoices();
  const koVoice = voices.find((v) => v.lang && v.lang.toLowerCase().startsWith('ko'));
  if (koVoice) utterance.voice = koVoice;

  utterance.onboundary = (e) => {
    if (currentUtteranceId !== id) return;
    const start = e.charIndex || 0;
    let end = start + (e.charLength || 0);
    if (end <= start) {
      const nextSpace = text.indexOf(' ', start);
      end = nextSpace === -1 ? text.length : nextSpace;
    }
    sendToMainWorld({
      type: 'speech.range',
      data: { id, start, end },
    });
  };

  const finish = () => {
    if (currentUtteranceId === id) {
      currentUtteranceId = null;
      ipcRenderer.send('loworld:playback-finished', id);
    }
  };
  utterance.onend = finish;
  utterance.onerror = finish;
  synth.speak(utterance);
}

// ============================================================================
// IPC 리스너 등록
// ============================================================================
ipcRenderer.on('loworld:message', (_event, message) => {
  sendToMainWorld(message);
});

ipcRenderer.on('loworld:audio-chunk', (_event, chunk) => {
  if (!chunk || !chunk.utteranceId) return;
  if (currentUtteranceId !== chunk.utteranceId) {
    stopAudioPlayback();
    currentUtteranceId = chunk.utteranceId;
  }
  chunkQueue.push(chunk);
  playNextChunk();
});

ipcRenderer.on('loworld:audio-stop', (_event, utteranceId) => {
  stopAudioPlayback(utteranceId);
});

ipcRenderer.on('loworld:system-speak', (_event, payload) => {
  speakWithSystemVoice(payload);
});

// ============================================================================
// window.loworldNative 노출 (동기 hasAction + 비동기 postMessage)
// ============================================================================
contextBridge.exposeInMainWorld('loworldNative', {
  hasAction(action) {
    return typeof action === 'string' && SUPPORTED_ACTIONS.has(action);
  },
  postMessage(json) {
    if (typeof json !== 'string') return;
    ipcRenderer.send('loworld:post', json);
  },
});
