'use strict';

/**
 * 음높이를 두고 빠르기만 바꾼다(WSOLA). AI 목소리를 빠르게 읽을 때 쓴다.
 *
 * Supertonic에 빠르기(speed)를 넘기면 길이를 줄이려고 음절을 뭉개거나 빼먹어서 1.5배·2배에서 문장 끝이 잘려 들렸다
 * (안드로이드에서 먼저 드러났다, 2026-11-16. 같은 문장의 음절 같은 소리 덩어리가 1배 25개, 2배 10개).
 * 그래서 모델은 1배로 만들고 여기서 당긴다. 안드로이드는 AudioTrack의 PlaybackParams가 하는 일을,
 * 데스크톱의 Web Audio(AudioBufferSourceNode)는 빠르기를 올리면 음높이도 올라가므로 직접 한다.
 *
 * 짧은 창을 겹쳐 붙이되, 붙일 때마다 앞 창이 자연스럽게 이어지는 자리를 근처에서 찾아(상관이 가장 큰 곳) 붙인다.
 * 그래서 말소리의 주기가 끊기지 않는다.
 */

/** 창의 길이(초). 말소리의 음높이 주기 몇 개가 들어갈 만큼 */
const WINDOW_S = 0.03;
/** 이음 자리를 찾는 범위. 창의 1/4 */
const TOLERANCE_RATIO = 0.25;
/** 상관을 셀 때 건너뛰는 간격. 다 세면 문장 하나에 수백 ms가 걸린다 */
const CORRELATION_STEP = 4;

/**
 * @param {Float32Array} input 모노 PCM
 * @param {number} sampleRate
 * @param {number} rate 1보다 크면 빨라진다(길이가 1/rate)
 * @returns {Float32Array}
 */
function timeStretch(input, sampleRate, rate) {
  if (!input || input.length === 0 || !Number.isFinite(rate) || Math.abs(rate - 1) < 1e-3) return input;
  const n = Math.max(64, Math.round(sampleRate * WINDOW_S) & ~1);
  const hs = n / 2; // 내는 쪽의 간격
  const ha = hs * rate; // 읽는 쪽의 간격
  const tol = Math.round(n * TOLERANCE_RATIO);
  if (input.length < n * 2) return input;

  const window = new Float32Array(n);
  for (let i = 0; i < n; i++) window[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / n);

  const outLength = Math.floor(input.length / rate);
  const output = new Float32Array(outLength + n);
  const weight = new Float32Array(outLength + n);
  const last = input.length - n;

  let prev = 0; // 앞 창을 읽은 자리
  for (let k = 0; ; k++) {
    const outPos = k * hs;
    if (outPos >= outLength) break;
    const target = Math.round(k * ha);
    let pos = Math.min(target, last);
    if (k > 0) {
      // 앞 창이 그대로 이어졌다면 읽었을 소리(prev + hs)와 가장 닮은 자리를 target 근처에서 찾는다
      const natural = prev + hs;
      if (natural + n <= input.length) {
        let best = -Infinity;
        const lo = Math.max(0, target - tol);
        const hi = Math.min(last, target + tol);
        for (let p = lo; p <= hi; p++) {
          let sum = 0;
          for (let i = 0; i < n; i += CORRELATION_STEP) sum += input[p + i] * input[natural + i];
          if (sum > best) {
            best = sum;
            pos = p;
          }
        }
      }
    }
    if (pos < 0 || pos > last) break;
    for (let i = 0; i < n; i++) {
      output[outPos + i] += input[pos + i] * window[i];
      weight[outPos + i] += window[i];
    }
    prev = pos;
  }

  const result = new Float32Array(outLength);
  for (let i = 0; i < outLength; i++) result[i] = weight[i] > 1e-3 ? output[i] / weight[i] : output[i];
  return result;
}

module.exports = { timeStretch };
