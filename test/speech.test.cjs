const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { splitForSpeech } = require('../src/speech/split-for-speech.cjs');
const { SUPERTONIC_VOICES, SYSTEM_VOICE_OPTION } = require('../src/speech/supertonic-voices.cjs');
const { SherpaSupertonicEngine } = require('../src/speech/sherpa-engine.cjs');
const { SpeechRouter } = require('../src/speech/speech-router.cjs');

test('splitForSpeech splits Korean prose by sentence boundaries and preserves exact [start, end) ranges', () => {
  const sample =
    '천마신교의 교주 백천이 눈을 떴다. 육십 년 세월이 꿈결처럼 흘렀구나! 과연 이번 생에는 사패련의 야욕을 꺾을 수 있을 것인가? ' +
    '그는 천천히 자리에서 일어나 창밖의 달빛을 응시했다. 단전 깊은 곳에서 맑은 내공이 소용돌이치며 깨어나기 시작했다.';

  const pieces = splitForSpeech(sample, 80);
  assert.ok(pieces.length >= 3, '문장 단위로 3조각 이상 나뉘어야 한다');

  for (const piece of pieces) {
    assert.ok(piece.text.length <= 80, `각 조각 길이는 80 이하여야 한다: ${piece.text.length}`);
    assert.equal(sample.slice(piece.start, piece.end), piece.text, '원문 [start, end) 슬라이스와 일치해야 한다');
  }
});

test('SpeechRouter exposes 5 Supertonic Korean voices and persists voice selection', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'loworld-desktop-test-'));
  const prefsPath = path.join(tmpDir, 'prefs.json');

  try {
    const router = new SpeechRouter({ prefsPath });
    const initial = router.enginesPayload();

    assert.equal(initial.speak.selected, 'auto');
    assert.equal(initial.speak.options.length, SUPERTONIC_VOICES.length + 1);
    assert.deepEqual(
      initial.speak.options.slice(0, 5).map((o) => o.id),
      ['supertonic:0', 'supertonic:1', 'supertonic:2', 'supertonic:5', 'supertonic:6'],
    );
    assert.equal(initial.speak.options[0].group, 'AI 목소리');
    assert.equal(initial.speak.options[5].id, SYSTEM_VOICE_OPTION.id);
    assert.equal(initial.speak.options[5].group, '시스템 목소리');

    const ready = await router.prepare();
    if (ready) {
      assert.equal(router.activeSpeak, 'supertonic:0');
      const updated = await router.choose('speak', 'supertonic:5');
      assert.equal(updated.speak.selected, 'supertonic:5');
      assert.equal(updated.speak.active, 'supertonic:5');

      const savedPrefs = JSON.parse(fs.readFileSync(prefsPath, 'utf-8'));
      assert.equal(savedPrefs['speech-engine-speak'], 'supertonic:5');
    }
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('SherpaSupertonicEngine synthesizes Korean speech with Supertonic 3 at 44100Hz', async () => {
  const engine = new SherpaSupertonicEngine();
  assert.equal(engine.isModelPresent(), true, 'Supertonic 3 모델 파일이 존재해야 한다');

  const prepared = await engine.prepare();
  assert.equal(prepared, true, 'SherpaSupertonicEngine이 정상 초기화되어야 한다');

  const audio = await engine.synthesizePiece('천마의 귀환을 환영하오.', 5, 1.0);
  assert.ok(audio, '합성 결과가 반환되어야 한다');
  assert.equal(audio.sampleRate, 44100, 'Supertonic 3 샘플레이트는 44100Hz여야 한다');
  assert.ok(audio.samples instanceof Float32Array, 'samples는 Float32Array여야 한다');
  assert.ok(audio.samples.length > 10000, `충분한 길이의 오디오 샘플이 생성되어야 한다 (실제: ${audio.samples.length})`);
});
