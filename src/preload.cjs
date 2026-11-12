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
/** 예약해 둔 소리. 멈추면 모두 끊는다 */
let scheduled = [];
/** 읽는 자리(speech.range)를 소리가 시작하는 때에 보내려고 건 타이머 */
let rangeTimers = [];
/** 다음 조각이 시작할 시각(AudioContext 시간). 앞 조각이 끝나는 때다 */
let nextStartAt = 0;
/** 마지막 조각을 받았다. 예약한 소리가 다 끝나면 완료를 알린다 */
let lastReceived = false;

/** 문장 사이의 쉼(초). 안드로이드 셸(0.25초)보다 조금 짧게 둔다. 쉼이 없으면 문장이 붙어 숨 가쁘게 들린다 */
const SENTENCE_GAP_S = 0.15;
/** 처음 조각을 바로 시작하지 않고 조금 뒤에 예약한다. 지금 시각에 걸면 앞머리가 잘린다 */
const START_LEAD_S = 0.03;

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
  currentUtteranceId = null;
  lastReceived = false;
  nextStartAt = 0;
  for (const timer of rangeTimers) clearTimeout(timer);
  rangeTimers = [];
  for (const source of scheduled) {
    try {
      source.onended = null;
      source.stop();
      source.disconnect();
    } catch {
      // 이미 정지됨
    }
  }
  scheduled = [];
  if (typeof window !== 'undefined' && 'speechSynthesis' in window) {
    try {
      window.speechSynthesis.cancel();
    } catch {
      // 무시
    }
  }
}

function finishUtterance(id) {
  if (currentUtteranceId !== id) return;
  currentUtteranceId = null;
  lastReceived = false;
  nextStartAt = 0;
  ipcRenderer.send('loworld:playback-finished', id);
}

/**
 * 조각을 받는 대로 앞 조각이 끝나는 시각에 맞춰 예약한다(2026-11-12).
 * 전에는 앞 조각의 onended를 받은 뒤에야 다음 조각을 시작해, 그 사이 수십 ms가 비어 문장 사이가 덜컥거렸다.
 * 다음 조각이 아직 합성 중이면 도착하는 즉시 시작한다.
 */
function scheduleChunk(chunk) {
  const id = chunk.utteranceId;
  if (chunk.isLast) lastReceived = true;

  if (chunk.samples && chunk.samples.length > 0) {
    try {
      const sampleRate = chunk.sampleRate || 44100;
      const ctx = getAudioContext(sampleRate);
      const floatSamples =
        chunk.samples instanceof Float32Array ? chunk.samples : new Float32Array(chunk.samples.buffer || chunk.samples);
      const audioBuffer = ctx.createBuffer(1, floatSamples.length, sampleRate);
      audioBuffer.copyToChannel(floatSamples, 0);

      const source = ctx.createBufferSource();
      source.buffer = audioBuffer;
      source.connect(ctx.destination);

      const now = ctx.currentTime;
      const startAt = Math.max(now + START_LEAD_S, nextStartAt > 0 ? nextStartAt + SENTENCE_GAP_S : 0);
      nextStartAt = startAt + audioBuffer.duration;

      // 이 문장이 들리기 시작할 때 웹에 읽는 자리를 알린다
      const timer = setTimeout(() => {
        rangeTimers = rangeTimers.filter((t) => t !== timer);
        if (currentUtteranceId !== id) return;
        sendToMainWorld({ type: 'speech.range', data: { id, start: chunk.start, end: chunk.end } });
      }, Math.max(0, (startAt - now) * 1000));
      rangeTimers.push(timer);

      source.onended = () => {
        scheduled = scheduled.filter((item) => item !== source);
        if (currentUtteranceId === id && lastReceived && scheduled.length === 0) finishUtterance(id);
      };
      scheduled.push(source);
      source.start(startAt);
      return;
    } catch (err) {
      console.error('[LoworldUI-Desktop preload] 오디오 재생 오류:', err);
    }
  }

  // 빈 조각(또는 재생 실패)이 마지막이면, 앞에 예약한 소리가 없을 때 바로 끝낸다. 있으면 그 소리의 onended가 끝낸다
  if (lastReceived && scheduled.length === 0) finishUtterance(id);
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
  scheduleChunk(chunk);
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
