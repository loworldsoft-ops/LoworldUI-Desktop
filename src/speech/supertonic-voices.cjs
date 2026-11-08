/**
 * LoworldUI-Desktop/src/speech/supertonic-voices.cjs
 *
 * Supertonic 3 (sherpa-onnx-supertonic-3-tts-int8-2026-05-11) 한국어 목소리 카탈로그.
 * LoworldUI-AOS의 SherpaSpeech.kt 및 AndroidSpeech.kt와 동일한 ID·이름·섹션을 유지한다.
 */

const SECTION_AI = 'AI 목소리';
const SECTION_SYSTEM = '시스템 목소리';

const SUPERTONIC_PREPARE_TIMEOUT_MS = 12_000;

/**
 * Supertonic 3의 10개 화자(0~4 여성 F1~F5, 5~9 남성 M1~M5) 중
 * 한국어 낭독 자연스러움과 톤 구분이 검증된 5종.
 */
const SUPERTONIC_VOICES = [
  { sid: 0, id: 'supertonic:0', label: '아라 (차분한 여성)', section: SECTION_AI, group: 'supertonic' },
  { sid: 1, id: 'supertonic:1', label: '하늘 (밝은 여성)', section: SECTION_AI, group: 'supertonic' },
  { sid: 2, id: 'supertonic:2', label: '다인 (부드러운 여성)', section: SECTION_AI, group: 'supertonic' },
  { sid: 5, id: 'supertonic:5', label: '민준 (차분한 남성)', section: SECTION_AI, group: 'supertonic' },
  { sid: 6, id: 'supertonic:6', label: '태오 (중후한 남성)', section: SECTION_AI, group: 'supertonic' },
];

const SYSTEM_VOICE_OPTION = {
  id: 'system:default',
  label: '기본 시스템 음성',
  section: SECTION_SYSTEM,
  group: 'system',
};

const MODEL_FILES = [
  'duration_predictor.int8.onnx',
  'text_encoder.int8.onnx',
  'vector_estimator.int8.onnx',
  'vocoder.int8.onnx',
  'tts.json',
  'unicode_indexer.bin',
  'voice.bin',
];

module.exports = {
  SECTION_AI,
  SECTION_SYSTEM,
  SUPERTONIC_PREPARE_TIMEOUT_MS,
  SUPERTONIC_VOICES,
  SYSTEM_VOICE_OPTION,
  MODEL_FILES,
};
