const test = require('node:test');
const assert = require('node:assert/strict');
const { parseDevUrl, devUrlFrom, isSameOrigin, devAppFrom, devTitleFrom, devReloadFrom } = require('../src/dev-url.cjs');

test('이 기기 안의 http 주소만 개발 주소로 받는다', () => {
  assert.equal(parseDevUrl('http://localhost:4310/overview'), 'http://localhost:4310/overview');
  assert.equal(parseDevUrl(' http://127.0.0.1:4310 '), 'http://127.0.0.1:4310/');
  assert.equal(parseDevUrl('https://example.com'), null);
  assert.equal(parseDevUrl('file:///etc/passwd'), null);
  assert.equal(parseDevUrl('javascript:alert(1)'), null);
  assert.equal(parseDevUrl(''), null);
  assert.equal(parseDevUrl(undefined), null);
});

test('인자가 환경 변수보다 먼저다', () => {
  const env = { LOWORLD_DEV_URL: 'http://localhost:1111/' };
  assert.equal(devUrlFrom(['electron', '.', '--dev-url=http://localhost:2222/a'], env), 'http://localhost:2222/a');
  assert.equal(devUrlFrom(['electron', '.'], env), 'http://localhost:1111/');
  assert.equal(devUrlFrom(['electron', '.'], {}), null);
});

test('개발 서버와 같은 출처만 창 안에서 연다', () => {
  assert.equal(isSameOrigin('http://localhost:4310/overview', 'http://localhost:4310/overview/story-reader'), true);
  assert.equal(isSameOrigin('http://localhost:4310/', 'http://localhost:5000/'), false);
  assert.equal(isSameOrigin('http://localhost:4310/', 'https://loworldsoft.com'), false);
});

test('앱 이름표는 폴더 이름으로 쓸 수 있는 글자만 받는다', () => {
  assert.equal(devAppFrom(['--dev-app=story-reader']), 'story-reader');
  assert.equal(devAppFrom(['--dev-app=../../etc']), 'overview');
  assert.equal(devAppFrom([]), 'overview');
  assert.equal(devTitleFrom(['--dev-title=스토리리더 0.6.4']), '스토리리더 0.6.4');
  assert.equal(devTitleFrom([]), '');
});

test('다시 읽기만 하는 두 번째 실행을 가린다', () => {
  assert.equal(devReloadFrom(['electron', '.', '--dev-url=http://localhost:4735/', '--dev-app=story-reader', '--dev-reload']), true);
  assert.equal(devReloadFrom(['electron', '.', '--dev-url=http://localhost:4735/']), false);
  assert.equal(devReloadFrom(undefined), false);
});
