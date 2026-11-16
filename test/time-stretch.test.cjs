'use strict';
// 음높이를 두고 빠르기만 바꾸는 것(WSOLA). 길이는 1/rate가 되고, 음높이(주기)는 그대로여야 한다.
const test = require('node:test');
const assert = require('node:assert');
const { timeStretch } = require('../src/speech/time-stretch.cjs');

const SR = 44100;
function tone(freq, seconds) {
  const out = new Float32Array(Math.round(SR * seconds));
  for (let i = 0; i < out.length; i++) out[i] = 0.5 * Math.sin((2 * Math.PI * freq * i) / SR);
  return out;
}
/** 0을 아래에서 위로 지나는 횟수로 주파수를 잰다 */
function frequency(samples) {
  let crossings = 0;
  for (let i = 1; i < samples.length; i++) if (samples[i - 1] < 0 && samples[i] >= 0) crossings++;
  return crossings / (samples.length / SR);
}

test('2배면 길이가 절반이고 음높이는 그대로다', () => {
  const input = tone(220, 2);
  const out = timeStretch(input, SR, 2);
  assert.ok(Math.abs(out.length - input.length / 2) <= 1, `길이 ${out.length}`);
  const f = frequency(out.subarray(SR * 0.1, out.length - SR * 0.1));
  assert.ok(Math.abs(f - 220) < 5, `주파수 ${f}`);
});

test('1.5배도 음높이를 지킨다', () => {
  const out = timeStretch(tone(180, 2), SR, 1.5);
  const f = frequency(out.subarray(SR * 0.1, out.length - SR * 0.1));
  assert.ok(Math.abs(f - 180) < 5, `주파수 ${f}`);
});

test('1배나 빈 소리는 그대로 돌려준다', () => {
  const input = tone(220, 0.5);
  assert.strictEqual(timeStretch(input, SR, 1), input);
  assert.strictEqual(timeStretch(new Float32Array(0), SR, 2).length, 0);
});
