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

test('HTML/CSS 根路径与绝对地址改写回代理，普通 JavaScript 保持不变', () => {
  const html = proxy.rewriteContent(
    '<html><head></head><body><a href="/passport">x</a><img src="https://passport.baidu.com/a.png"></body></html>',
    'text/html; charset=utf-8',
    SID,
    'login.bce.baidu.com',
  );
  assert.match(html, new RegExp(`/login/proxy/${SID}/https/login\\.bce\\.baidu\\.com/passport`));
  assert.match(html, new RegExp(`/login/proxy/${SID}/https/passport\\.baidu\\.com/a\\.png`));
  assert.match(html, /function mapUrl/);
  assert.match(html, /u\.protocol==='http:'/);
  assert.match(html, /patchUrlProperty\(window\.HTMLImageElement,'src'\)/);
  assert.match(html, /_status/);

  const js = 'fetch("/api/login"); fetch("https://passport.baidu.com/check");';
  assert.equal(proxy.rewriteContent(
    js,
    'application/javascript',
    SID,
    'login.bce.baidu.com',
  ), js);

  const css = proxy.rewriteContent(
    'body{background:url("/static/bg.png")}',
    'text/css',
    SID,
    'passport.baidu.com',
  );
  assert.match(css, new RegExp(`/login/proxy/${SID}/https/passport\\.baidu\\.com/static/bg\\.png`));
});

test('JSONP 检测只接受 callback 对应的响应体', () => {
  const target = new URL(
    'https://passport.baidu.com/v2/?getphonestatus&callback=bd__cbs__abc',
  );
  assert.equal(proxy.isJsonpResponse(
    target,
    'text/html',
    Buffer.from('bd__cbs__abc({"ok":true})'),
  ), true);
  assert.equal(proxy.isJsonpResponse(
    target,
    'text/html',
    Buffer.from('<html><body>not jsonp</body></html>'),
  ), false);
  assert.equal(proxy.isJsonpResponse(
    new URL('https://passport.baidu.com/v2/?getphonestatus&callback=bad-name'),
    'text/html',
    Buffer.from('bad-name({"ok":true})'),
  ), false);
});

test('普通 JavaScript 中的正则、Cookie 路径和注释不会被改写', () => {
  const source = [
    '// https://passport.baidu.com/keep-comment',
    'var absolute=/https?:\\/\\/passport\\.baidu\\.com\\/check/g;',
    'var relative=/(^|;)\\s*path=\\//;',
    'document.cookie="sid=1; path=/; secure";',
    'fetch("/api/login"); fetch("https://passport.baidu.com/check");',
  ].join('\n');

  assert.equal(
    proxy.rewriteContent(source, 'application/javascript; charset=utf-8', SID, 'login.bce.baidu.com'),
    source,
  );
});

test('已代理资源不会被根路径或重复改写再次嵌套', () => {
  const target = `${proxy.LOGIN_PROXY_PREFIX}${SID}/https/cas.baidu.com/staticv2/dep/common-login/api.js`;
  const source = `<html><head><script src="https://cas.baidu.com/staticv2/dep/common-login/api.js"></script></head></html>`;
  const once = proxy.rewriteContent(source, 'text/html; charset=utf-8', SID, 'login.bce.baidu.com');
  assert.equal(once.split(target).length - 1, 1);
  assert.match(once, new RegExp(`src="${target.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}"`));

  const twice = proxy.rewriteContent(once, 'text/html; charset=utf-8', SID, 'login.bce.baidu.com');
  assert.equal(twice.split(target).length - 1, 1);
  assert.doesNotMatch(twice, new RegExp(`/login/proxy/${SID}/https/login\\.bce\\.baidu\\.com/api/admin/`));

  const js = `fetch("${target}");`;
  assert.equal(proxy.rewriteContent(js, 'application/javascript', SID, 'login.bce.baidu.com'), js);
});

test('百分号编码 HTML 不会生成 https://api 或嵌套代理地址', () => {
  const target = `${proxy.LOGIN_PROXY_PREFIX}${SID}/https/bce.bdstatic.com/fe-static/console/index.js`;
  const source = `var h='%3Cscript%20src%3D%22https%3A//bce.bdstatic.com/fe-static/console/index.js%22%3E%3C/script%3E';document.write(unescape(h));`;
  const rewritten = proxy.rewriteContent(
    source,
    'application/javascript',
    SID,
    'bce.bdstatic.com',
  );
  const payload = rewritten.match(/var h='([^']+)'/);
  assert.ok(payload);

  const decoded = unescape(payload[1]);
  assert.equal(decoded.split(target).length - 1, 1);
  assert.match(decoded, new RegExp(`src="${target}"`));
  assert.doesNotMatch(decoded, /https:\/\/api\//);
  assert.doesNotMatch(decoded, /\/https\/bce\.bdstatic\.com\/fe-static\/console\/index\.js.*\/https\/bce\.bdstatic\.com\//);
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
