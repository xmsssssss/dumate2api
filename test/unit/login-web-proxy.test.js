// test/unit/login-web-proxy.test.js - Docker/远程部署的百度登录代理
const { test } = require('node:test');
const assert = require('node:assert');

const proxy = require('../../src/login-web-proxy');

const SID = 'a'.repeat(48);

test('登录代理只接受白名单 HTTPS 域名', () => {
  for (const host of [
    'baidu.com',
    'login.bce.baidu.com',
    'passport.baidu.com',
    'console.bce.baidu.com',
    'dumate.cn',
    'www.dumate.cn',
    'cdn.bdstatic.com',
  ]) {
    assert.equal(proxy.isAllowedHostname(host), true, host);
  }
  for (const host of [
    'evilbaidu.com',
    'baidu.com.evil.test',
    '127.0.0.1',
    'localhost',
    'example.com',
  ]) {
    assert.equal(proxy.isAllowedHostname(host), false, host);
  }

  const url = proxy.proxyUrl(SID, 'https://login.bce.baidu.com/path?q=1#top');
  assert.equal(
    url,
    '/api/admin/web-accounts/login/proxy/' + SID + '/https/login.bce.baidu.com/path?q=1#top',
  );
  assert.throws(() => proxy.proxyUrl(SID, 'http://login.bce.baidu.com/'), /白名单/);
  assert.throws(() => proxy.proxyUrl(SID, 'https://login.bce.baidu.com:8443/'), /白名单/);
  assert.throws(() => proxy.proxyUrl(SID, 'https://evil.test/'), /白名单/);
});

test('代理路径解析拒绝畸形 sid 和主机', () => {
  assert.deepEqual(
    proxy.parseProxyPath(`${proxy.LOGIN_PROXY_PREFIX}${SID}/https/login.bce.baidu.com/a?b=1`),
    { sid: SID, host: 'login.bce.baidu.com', path: '/a?b=1' },
  );
  assert.equal(proxy.parseProxyPath('/api/admin/web-accounts/login/proxy/%E0%A4%A/https/baidu.com/'), null);
  assert.equal(proxy.parseProxyPath('/api/admin/web-accounts/login/proxy/no-scheme'), null);
});

test('HTML/JS/CSS 根路径与绝对地址改写回代理', () => {
  const html = proxy.rewriteContent(
    '<html><head></head><body><a href="/passport">x</a><img src="https://passport.baidu.com/a.png"></body></html>',
    'text/html; charset=utf-8',
    SID,
    'login.bce.baidu.com',
  );
  assert.match(html, new RegExp(`/login/proxy/${SID}/https/login\\.bce\\.baidu\\.com/passport`));
  assert.match(html, new RegExp(`/login/proxy/${SID}/https/passport\\.baidu\\.com/a\\.png`));
  assert.match(html, /function mapUrl/);
  assert.match(html, /_status/);

  const js = proxy.rewriteContent(
    'fetch("/api/login"); fetch("https://passport.baidu.com/check");',
    'application/javascript',
    SID,
    'login.bce.baidu.com',
  );
  assert.match(js, new RegExp(`/login/proxy/${SID}/https/login\\.bce\\.baidu\\.com/api/login`));
  assert.match(js, new RegExp(`/login/proxy/${SID}/https/passport\\.baidu\\.com/check`));

  const css = proxy.rewriteContent(
    'body{background:url("/static/bg.png")}',
    'text/css',
    SID,
    'passport.baidu.com',
  );
  assert.match(css, new RegExp(`/login/proxy/${SID}/https/passport\\.baidu\\.com/static/bg\\.png`));
});

test('会话成功后凭证可读多次但只能取走一次', () => {
  const started = proxy.start({ name: '测试登录' });
  assert.equal(started.ok, true);
  assert.equal(started.mode, 'proxy');
  assert.equal(proxy.snapshot(started.session_id).status, 'waiting');

  assert.equal(proxy.__test.seedSessionCookiesForTest(
    started.session_id,
    [
      'BDUSS=bduss-value; Domain=.baidu.com; Path=/; Secure; HttpOnly',
      'bce-long-term-sessionid=session-value; Domain=.baidu.com; Path=/; Secure; HttpOnly',
    ],
    new URL('https://console.bce.baidu.com/'),
  ), true);

  const snap = proxy.snapshot(started.session_id);
  assert.equal(snap.status, 'success');
  assert.equal(snap.has_cookie, true);

  const first = proxy.peekCookie(started.session_id);
  assert.match(first, /BDUSS=bduss-value/);
  assert.match(first, /bce-long-term-sessionid=session-value/);
  assert.equal(proxy.peekCookie(started.session_id), first);
  assert.equal(proxy.takeCookie(started.session_id), first);
  assert.equal(proxy.peekCookie(started.session_id), null);
  assert.equal(proxy.takeCookie(started.session_id), null);
  assert.equal(proxy.snapshot(started.session_id).has_cookie, false);
  assert.deepEqual(proxy.cancel(started.session_id), { ok: true });
});

test('代理会话超过有效期后清空凭证', () => {
  const started = proxy.start({ name: '过期测试' });
  assert.equal(proxy.__test.seedSessionCookiesForTest(
    started.session_id,
    [
      'BDUSS=bduss-value; Domain=.baidu.com; Path=/; Secure; HttpOnly',
      'bce-long-term-sessionid=session-value; Domain=.baidu.com; Path=/; Secure; HttpOnly',
    ],
    new URL('https://console.bce.baidu.com/'),
  ), true);
  assert.equal(proxy.snapshot(started.session_id).has_cookie, true);

  assert.equal(proxy.__test.expireSessionForTest(started.session_id), true);
  const expired = proxy.snapshot(started.session_id);
  assert.equal(expired.status, 'failed');
  assert.equal(expired.has_cookie, false);
  assert.equal(proxy.peekCookie(started.session_id), null);
});
