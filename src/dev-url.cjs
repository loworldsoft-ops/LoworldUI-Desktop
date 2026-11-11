/**
 * LoworldUI-Desktop/src/dev-url.cjs
 *
 * 개발 모드의 주소. 작업하는 동안에는 묶은 번들(app/www) 대신 켜 둔 개발 서버(ng serve)를 띄운다.
 * 그래야 공통이나 앱을 고칠 때마다 다시 묶지 않아도 창에 바로 반영된다.
 *
 * 주소는 `--dev-url=<주소>` 인자나 LOWORLD_DEV_URL 환경 변수로 받는다. 인자가 먼저다
 * (이미 떠 있는 창에 두 번째 실행이 인자로 새 주소를 넘긴다).
 * 이 기기 안의 주소(localhost, 127.0.0.1)만 받는다. 셸은 네이티브 통로(window.loworldNative)를 열어 주므로,
 * 밖의 주소를 개발 모드로 띄우면 그 페이지가 통로를 쓰게 된다.
 */

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);

function parseDevUrl(raw) {
  if (typeof raw !== 'string' || raw.trim() === '') return null;
  let url;
  try {
    url = new URL(raw.trim());
  } catch {
    return null;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
  if (!LOCAL_HOSTS.has(url.hostname)) return null;
  return url.toString();
}

function devUrlFrom(argv, env) {
  const arg = (argv || []).find((a) => typeof a === 'string' && a.startsWith('--dev-url='));
  if (arg) return parseDevUrl(arg.slice('--dev-url='.length));
  return parseDevUrl(env ? env.LOWORLD_DEV_URL : undefined);
}

/** 개발 서버와 같은 출처면 창 안에서 연다. 다른 곳은 기본 브라우저로 보낸다 */
function isSameOrigin(devUrl, target) {
  try {
    return new URL(devUrl).origin === new URL(target).origin;
  } catch {
    return false;
  }
}

function argValue(argv, name) {
  const arg = (argv || []).find((a) => typeof a === 'string' && a.startsWith(`--${name}=`));
  return arg ? arg.slice(name.length + 3) : '';
}

/**
 * 개발 모드로 띄운 앱의 이름표. 앱마다 창과 저장 공간(userData)을 따로 두는 데 쓴다.
 * 그래서 여러 앱을 동시에 띄울 수 있고, 한 앱의 기록이 다른 앱에 섞이지 않는다. 폴더 이름이 되므로 글자를 좁힌다.
 */
function devAppFrom(argv) {
  const id = argValue(argv, 'dev-app').toLowerCase();
  return /^[a-z0-9][a-z0-9-]{0,40}$/.test(id) ? id : 'overview';
}

/** 창 제목(앱 이름과 버전). 없으면 빈 글 */
function devTitleFrom(argv) {
  return argValue(argv, 'dev-title').slice(0, 80);
}

/**
 * 떠 있는 창에 "다시 읽기만 하라"는 두 번째 실행인지. 콘텐츠를 다시 묶을 때마다 dev-desktop.mjs가 보낸다.
 * 주소를 바꾸지 않고, 창을 앞으로 꺼내지도 않는다(편집기에서 글을 쓰는 중에 창이 끼어들지 않게).
 */
function devReloadFrom(argv) {
  return (argv || []).includes('--dev-reload');
}

module.exports = { parseDevUrl, devUrlFrom, isSameOrigin, devAppFrom, devTitleFrom, devReloadFrom };
