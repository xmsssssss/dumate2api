// test/unit/login-web-proxy-upstream.test.js - 登录代理必须复用全局出站代理
const { test } = require('node:test');
const assert = require('node:assert');
const { EventEmitter } = require('node:events');
const { Readable, Writable } = require('node:stream');
const https = require('node:https');

const proxy = require('../../src/login-web-proxy');
const proxyAgent = require('../../src/proxy-agent');

function invokeProxy(sessionId, host, method = 'GET', body = '', headers = {}, requestPath) {
  const requestUrl = requestPath || `${proxy.LOGIN_PROXY_PREFIX}${sessionId}/https/${host}/test?q=1`;
  const path = requestUrl.split('?')[0];
  const req = Readable.from(body ? [Buffer.from(body)] : []);
  req.method = method;
  req.url = requestUrl;
  req.headers = {
    host: '127.0.0.1:9081',
    'content-length': String(Buffer.byteLength(body)),
    ...headers,
  };

  return new Promise((resolve) => {
    const res = {
      headersSent: false,
      statusCode: 0,
      headers: null,
      body: '',
      writeHead(statusCode, responseHeaders) {
        this.headersSent = true;
        this.statusCode = statusCode;
        this.headers = responseHeaders;
      },
      end(chunk) {
        if (chunk) this.body += Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk);
        resolve(this);
      },
    };
    proxy.handleProxy(req, res, path);
  });
}

test('登录代理的上游请求复用 DUMATE_PROXY 对应的全局 agent', async (t) => {
  const originalRequest = https.request;
  const started = proxy.start({ name: '代理链路测试' });
  const captured = {};
  proxyAgent.setGlobalProxy('http://127.0.0.1:3128');
  proxyAgent.clearAgentCache();

  t.after(() => {
    https.request = originalRequest;
    proxyAgent.setGlobalProxy('');
    proxyAgent.clearAgentCache();
    proxy.cancel(started.session_id);
  });

  https.request = (target, options, callback) => {
    captured.target = target;
    captured.options = options;
    captured.requestBody = '';
    const req = new Writable({
      write(chunk, _encoding, done) {
        captured.requestBody += chunk.toString('utf8');
        done();
      },
      final(done) {
        const response = new EventEmitter();
        response.statusCode = 200;
        response.headers = { 'content-type': 'application/json; charset=utf-8' };
        done();
        process.nextTick(() => {
          callback(response);
          response.emit('data', Buffer.from('{"ok":true}'));
          response.emit('end');
        });
      },
    });
    return req;
  };

  const body = 'mobile=12345678901&token=test';
  const res = await invokeProxy(started.session_id, 'passport.baidu.com', 'POST', body, {
    'content-type': 'application/x-www-form-urlencoded',
  });

  assert.equal(res.statusCode, 200);
  assert.equal(res.body, '{"ok":true}');
  assert.equal(captured.requestBody, body);
  assert.equal(captured.target.hostname, 'passport.baidu.com');
  assert.ok(captured.options.agent, '配置全局代理后必须带 agent');
  assert.equal(captured.options.agent.proxy.host, '127.0.0.1');
  assert.equal(captured.options.agent.proxy.port, 3128);
});

test('上游网络错误返回带域名与错误码的 502，而不是笼统失败', async (t) => {
  const originalRequest = https.request;
  const started = proxy.start({ name: '错误透传测试' });

  t.after(() => {
    https.request = originalRequest;
    proxyAgent.setGlobalProxy('');
    proxyAgent.clearAgentCache();
    proxy.cancel(started.session_id);
  });

  proxyAgent.setGlobalProxy('');
  proxyAgent.clearAgentCache();
  https.request = () => {
    const req = new Writable({
      write(_chunk, _encoding, done) {
        done();
      },
    });
    process.nextTick(() => {
      const error = new Error('getaddrinfo ENOTFOUND passport.baidu.com');
      error.code = 'ENOTFOUND';
      req.emit('error', error);
    });
    return req;
  };

  const res = await invokeProxy(started.session_id, 'passport.baidu.com');
  assert.equal(res.statusCode, 502);
  assert.match(res.body, /passport\.baidu\.com/);
  assert.match(res.body, /\[ENOTFOUND\]/);
});

test('百度 JSONP 响应保持原文并声明为可执行的 JavaScript', async (t) => {
  const originalRequest = https.request;
  const started = proxy.start({ name: 'JSONP 类型测试' });

  t.after(() => {
    https.request = originalRequest;
    proxy.cancel(started.session_id);
  });

  const jsonp = 'bd__cbs__abc({"errInfo":{"no":"0"},"data":{"ok":true}})';
  https.request = (_target, _options, callback) => {
    const req = new Writable({
      write(_chunk, _encoding, done) {
        done();
      },
      final(done) {
        const response = new EventEmitter();
        response.statusCode = 200;
        response.headers = {
          'content-type': 'text/html',
          'x-content-type-options': 'nosniff',
        };
        done();
        process.nextTick(() => {
          callback(response);
          response.emit('data', Buffer.from(jsonp));
          response.emit('end');
        });
      },
    });
    return req;
  };

  const path = `${proxy.LOGIN_PROXY_PREFIX}${started.session_id}` +
    '/https/passport.baidu.com/v2/?getphonestatus&callback=bd__cbs__abc';
  const res = await invokeProxy(
    started.session_id,
    'passport.baidu.com',
    'GET',
    '',
    {},
    path,
  );

  assert.equal(res.statusCode, 200);
  assert.equal(res.headers['content-type'], 'application/javascript; charset=utf-8');
  assert.equal(res.headers['x-content-type-options'], 'nosniff');
  assert.equal(res.body, jsonp);
});

test('百度统计请求在登录代理内返回本地空响应，不再制造 502', async (t) => {
  const originalRequest = https.request;
  const started = proxy.start({ name: '统计请求测试' });
  let upstreamCalls = 0;

  t.after(() => {
    https.request = originalRequest;
    proxy.cancel(started.session_id);
  });

  https.request = () => {
    upstreamCalls += 1;
    throw new Error('统计请求不应访问上游');
  };

  const scriptPath = `${proxy.LOGIN_PROXY_PREFIX}${started.session_id}/https/hm.baidu.com/hm.js?abc`;
  const script = await invokeProxy(started.session_id, 'hm.baidu.com', 'GET', '', {}, scriptPath);
  assert.equal(script.statusCode, 200);
  assert.match(script.headers['Content-Type'], /javascript/);
  assert.match(script.body, /analytics disabled/);

  const imagePath = `${proxy.LOGIN_PROXY_PREFIX}${started.session_id}/https/nsclick.baidu.com/v.gif?abc`;
  const image = await invokeProxy(started.session_id, 'nsclick.baidu.com', 'GET', '', {}, imagePath);
  assert.equal(image.statusCode, 204);
  assert.equal(image.body, '');
  assert.equal(upstreamCalls, 0);
});

test('百度登录页的已知背景 404 由登录代理本地消化', async (t) => {
  const originalRequest = https.request;
  const started = proxy.start({ name: '背景请求测试' });
  let upstreamCalls = 0;

  t.after(() => {
    https.request = originalRequest;
    proxy.cancel(started.session_id);
  });

  https.request = () => {
    upstreamCalls += 1;
    throw new Error('背景请求不应访问上游');
  };

  const imagePaths = [
    ['cloud.baidu.com', '/404.html'],
    ['cas.baidu.com', '/ucaction/collectlog'],
  ];
  for (const [host, pathname] of imagePaths) {
    const requestPath = `${proxy.LOGIN_PROXY_PREFIX}${started.session_id}/https/${host}${pathname}`;
    const response = await invokeProxy(started.session_id, host, 'GET', '', {}, requestPath);
    assert.equal(response.statusCode, 204, host);
    assert.equal(response.body, '', host);
  }

  const scriptPath = `${proxy.LOGIN_PROXY_PREFIX}${started.session_id}/https/passport.baidu.com/error.html`;
  const script = await invokeProxy(
    started.session_id,
    'passport.baidu.com',
    'GET',
    '',
    {},
    scriptPath,
  );
  assert.equal(script.statusCode, 200);
  assert.match(script.headers['Content-Type'], /javascript/);
  assert.match(script.body, /analytics disabled/);
  assert.equal(upstreamCalls, 0);
});
