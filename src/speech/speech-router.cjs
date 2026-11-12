/**
 * LoworldUI-Desktop/src/speech/speech-router.cjs
 *
 * 데스크톱 셸의 음성 라우터. LoworldUI-AOS의 SpeechRouter.kt와 동일한 계약을 구현한다.
 * - 기본값('auto')일 때 Supertonic 3 한국어 AI 목소리(아라, supertonic:0)를 1순위로 준비하고,
 *   모델이 없을 때만 시스템 기본 음성(system:default)으로 폴백한다.
 * - 문장 단위로 끊어(splitForSpeech) 비동기 합성 후 렌더러의 Web Audio 큐로 스트리밍하여
 *   첫 문장 지연을 최소화하고 정확한 문장 하이라이트(speech.range)를 전달한다.
 */

const fs = require('node:fs');
const path = require('node:path');
const {
  SUPERTONIC_VOICES,
  SYSTEM_VOICE_OPTION,
} = require('./supertonic-voices.cjs');
const { splitForSpeech } = require('./split-for-speech.cjs');
const { SherpaSupertonicEngine } = require('./sherpa-engine.cjs');

const AUTO = 'auto';

class SpeechRouter {
  /**
   * @param {object} options
   * @param {string} [options.prefsPath] 설정 저장 JSON 경로
   * @param {string} [options.modelDir] Supertonic 3 모델 폴더 경로
   */
  constructor(options = {}) {
    this.prefsPath = options.prefsPath || null;
    this.sherpa = new SherpaSupertonicEngine({ modelDir: options.modelDir });
    this.prefs = this._loadPrefs();

    this.selectedSpeak = this.prefs['speech-engine-speak'] || AUTO;
    this.selectedListen = this.prefs['speech-engine-listen'] || AUTO;

    this.sherpaReady = false;
    this.activeSpeak = null;
    this.canSpeak = true;
    this.canListen = false;

    /** 현재 진행 중인 발화 상태 */
    this.currentSession = null;
    this.sessionSeq = 0;
    /**
     * 미리 합성해 둔 다음 글의 첫 문장. { key, promise }. 웹이 다음에 읽을 글(next)을 함께 보내면 지금 글을 다 합성한 뒤
     * 그 첫 문장을 만들어 둔다. 글 사이에서 합성을 기다리며 조용히 끊기지 않게(2026-11-12)
     */
    this.prefetched = null;
  }

  _loadPrefs() {
    if (!this.prefsPath) return {};
    try {
      if (fs.existsSync(this.prefsPath)) {
        return JSON.parse(fs.readFileSync(this.prefsPath, 'utf-8')) || {};
      }
    } catch {
      // 무시
    }
    return {};
  }

  _savePref(key, value) {
    this.prefs[key] = value;
    if (!this.prefsPath) return;
    try {
      fs.mkdirSync(path.dirname(this.prefsPath), { recursive: true });
      fs.writeFileSync(this.prefsPath, JSON.stringify(this.prefs, null, 2) + '\n', 'utf-8');
    } catch {
      // 무시
    }
  }

  getSpeakOptions() {
    return [...SUPERTONIC_VOICES, SYSTEM_VOICE_OPTION];
  }

  async prepare() {
    if (this.sherpa.isModelPresent()) {
      this.sherpaReady = await this.sherpa.prepare();
    } else {
      this.sherpaReady = false;
    }
    this._resolveActiveSpeak();
    return this.sherpaReady;
  }

  _resolveActiveSpeak() {
    const selected = this.selectedSpeak || AUTO;
    if (selected === SYSTEM_VOICE_OPTION.id) {
      this.activeSpeak = SYSTEM_VOICE_OPTION.id;
      this.canSpeak = true;
      return;
    }

    const matchedSupertonic = SUPERTONIC_VOICES.find((v) => v.id === selected);
    if (matchedSupertonic && this.sherpaReady) {
      this.activeSpeak = matchedSupertonic.id;
      this.canSpeak = true;
      return;
    }

    if (this.sherpaReady) {
      this.activeSpeak = SUPERTONIC_VOICES[0].id; // supertonic:0 (아라)
      this.canSpeak = true;
      return;
    }

    this.activeSpeak = SYSTEM_VOICE_OPTION.id;
    this.canSpeak = true;
  }

  enginesPayload() {
    return {
      speak: {
        selected: this.selectedSpeak,
        active: this.activeSpeak,
        options: this.getSpeakOptions().map((opt) => ({
          id: opt.id,
          label: opt.label,
          ...(opt.section ? { group: opt.section } : {}),
        })),
      },
      listen: {
        selected: this.selectedListen,
        active: null,
        options: [],
      },
    };
  }

  async choose(kind, id) {
    if (kind === 'speak') {
      const normalized = id || AUTO;
      this.selectedSpeak = normalized;
      this._savePref('speech-engine-speak', normalized);
      // 읽던 글은 끝내지 않는다. 끝내면 웹이 다음 토막으로 넘어가 읽던 곳을 건너뛴다(사용자의 지적, 2026-11-12).
      // 소리만 끊고, 새 목소리가 준비되면 같은 글을 처음부터 다시 읽는다
      const interrupted = this._interrupt();
      this.prefetched = null;
      if (normalized.startsWith('supertonic:') || normalized === AUTO) {
        if (!this.sherpaReady && this.sherpa.isModelPresent()) {
          this.sherpaReady = await this.sherpa.prepare();
        }
      }
      this._resolveActiveSpeak();
      if (interrupted && !this.currentSession) void this.speak(interrupted.req, interrupted.callbacks);
    } else if (kind === 'listen') {
      const normalized = id || AUTO;
      this.selectedListen = normalized;
      this._savePref('speech-engine-listen', normalized);
    }
    return this.enginesPayload();
  }

  /** 지금 읽기의 소리만 끊고 완료는 알리지 않는다. 다시 읽을 요청과 콜백을 돌려준다 */
  _interrupt() {
    const prev = this.currentSession;
    if (!prev) return null;
    this.currentSession = null;
    prev.cancelled = true;
    prev.callbacks.onCancelAudio(prev.utteranceId);
    return { req: prev.req, callbacks: prev.callbacks };
  }

  /** 합성 한 번. 미리 만들어 둔 것이 같은 글이면 그것을 쓴다 */
  _synthesize(text, sid, rate) {
    const key = `${sid}|${rate}|${text}`;
    const cached = this.prefetched;
    if (cached && cached.key === key) {
      this.prefetched = null;
      return cached.promise;
    }
    return this.sherpa.synthesizePiece(text, sid, rate);
  }

  _prefetch(text, sid, rate) {
    const first = splitForSpeech(text)[0];
    if (!first) return;
    const key = `${sid}|${rate}|${first.text}`;
    if (this.prefetched && this.prefetched.key === key) return;
    const promise = this.sherpa.synthesizePiece(first.text, sid, rate).catch(() => null);
    this.prefetched = { key, promise };
  }

  /**
   * 현재 발화를 즉시 중단하고 대기 중인 spoken 응답을 정리한다.
   * @param {(utteranceId: string) => void} [onCancelAudio]
   */
  stop(onCancelAudio) {
    if (!this.currentSession) return;
    const prev = this.currentSession;
    this.currentSession = null;
    prev.cancelled = true;
    if (typeof onCancelAudio === 'function') {
      onCancelAudio(prev.utteranceId);
    }
    prev.finishOnce();
  }

  /**
   * 텍스트를 합성하여 렌더러 오디오 큐로 스트리밍한다.
   * @param {object} req
   * @param {string} req.id 웹이 보낸 발화 id
   * @param {string} req.text 읽을 원문
   * @param {number} [req.rate=1.0] 배속
   * @param {object} callbacks
   * @param {(chunk: object) => void} callbacks.onAudioChunk 합성된 PCM 조각 전송
   * @param {(utteranceId: string) => void} callbacks.onCancelAudio 렌더러 오디오 즉시 정지
   * @param {(payload: { id: string, text: string, rate: number }) => void} callbacks.onSystemSpeak 시스템 음성 폴백
   * @param {(utteranceId: string) => void} callbacks.onSpoken 발화 완료 통지
   */
  async speak(req, callbacks) {
    const utteranceId = String(req.id || '');
    const text = String(req.text || '');
    const rate = Number.isFinite(req.rate) && req.rate > 0 ? Number(req.rate) : 1.0;

    // 이전 발화가 남아 있으면 먼저 종료 처리한다.
    this.stop(callbacks.onCancelAudio);

    if (!text.trim()) {
      callbacks.onSpoken(utteranceId);
      return;
    }

    let finished = false;
    const finishOnce = () => {
      if (finished) return;
      finished = true;
      if (this.currentSession && this.currentSession.sessionId === sessionId) {
        this.currentSession = null;
      }
      callbacks.onSpoken(utteranceId);
    };

    const sessionId = ++this.sessionSeq;
    const session = {
      sessionId,
      utteranceId,
      cancelled: false,
      finishOnce,
      req,
      callbacks,
    };
    this.currentSession = session;

    if (!this.activeSpeak) {
      await this.prepare();
    }

    // 시스템 음성 폴백이 선택되었거나 Supertonic 준비가 안 된 경우
    if (!this.activeSpeak || !this.activeSpeak.startsWith('supertonic:')) {
      callbacks.onSystemSpeak({ id: utteranceId, text, rate });
      return;
    }

    const sid = Number.parseInt(this.activeSpeak.split(':')[1] || '0', 10) || 0;
    const pieces = splitForSpeech(text);
    if (pieces.length === 0) {
      finishOnce();
      return;
    }

    for (let i = 0; i < pieces.length; i++) {
      if (session.cancelled) return;
      const piece = pieces[i];
      try {
        const audio = i === 0 ? await this._synthesize(piece.text, sid, rate) : await this.sherpa.synthesizePiece(piece.text, sid, rate);
        if (session.cancelled) return;

        if (!audio || !audio.samples || audio.samples.length === 0) {
          if (i === pieces.length - 1) {
            callbacks.onAudioChunk({
              utteranceId,
              pieceIndex: i,
              isLast: true,
              start: piece.start,
              end: piece.end,
              sampleRate: 44100,
              samples: new Float32Array(0),
            });
          }
          continue;
        }

        callbacks.onAudioChunk({
          utteranceId,
          pieceIndex: i,
          isLast: i === pieces.length - 1,
          start: piece.start,
          end: piece.end,
          sampleRate: audio.sampleRate || 44100,
          samples: audio.samples,
        });
      } catch (err) {
        console.error('[SpeechRouter] 문장 합성 오류:', err);
        if (i === pieces.length - 1 && !session.cancelled) {
          finishOnce();
        }
      }
    }
    // 이 글의 문장을 다 만들었다. 재생이 끝나기 전에 다음 글의 첫 문장을 만들어 둔다
    if (!session.cancelled && req.next) this._prefetch(String(req.next), sid, rate);
  }

  /**
   * 렌더러에서 특정 발화의 마지막 조각 재생이 끝났을 때 호출한다.
   */
  notifyPlaybackFinished(utteranceId) {
    if (this.currentSession && this.currentSession.utteranceId === utteranceId) {
      this.currentSession.finishOnce();
    }
  }
}

module.exports = {
  SpeechRouter,
  AUTO,
};
