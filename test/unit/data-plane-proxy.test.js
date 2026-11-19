const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');

const proxy = require('../../src/admin/data-plane-proxy');

function listen(handler) {
  return new Promise((resolve, reject) => {
    const server = http.createServer(handler);
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve(server));
  });
}

function close(server) {
  return new Promise((resolve) => server.close(resolve));
}

function port(server) {
  return server.address().port;
}

function request(portNumber, path, headers = {}, body = null) {
  return new Promise((resolve, reject) => {
    const req = http.request({
      host: '127.0.0.1',
      port: portNumber,
      path,
      method: body == null ? 'GET' : 'POST',
      headers,
    }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => resolve({
        status: res.statusCode,
        headers: res.headers,
        chunks,
        body: Buffer.concat(chunks).toString('utf8'),
      }));
    });
    req.on('error', reject);
    if (body != null) req.write(body);
    req.end();
  });
}

test('only the model data-plane surface is proxied', () => {
  for (const path of [
    '/health',
    '/ping',
    '/v1/models',
    '/v1/chat/completions',
    '/messages',
    '/messages/count_tokens',
    '/responses',
    '/api/v1/messages',
    '/v1beta/models',
    '/images/generations',
    '/files/upload',
  ]) {
    assert.equal(proxy.isDataPlanePath(path), true, path);
  }
  for (const path of [
    '/api/admin/healthz',
    '/api/admin/web-accounts',
    '/metrics',
    '/',
    '/v1',
  ]) {
    assert.equal(proxy.isDataPlanePath(path), false, path);
  }
});

test('proxy removes management cookies and client-controlled trust headers', async () => {
  let seen;
  const target = await listen((req, res) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      seen = { headers: req.headers, body: Buffer.concat(chunks).toString('utf8') };
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end('{"ok":true}');
    });
  });
  const proxyServer = await listen((req, res) => {
    assert.equal(proxy.isDataPlanePath(req.url), true);
    proxy.proxyDataPlane(req, res, { port: port(target) });
  });
  try {
    const result = await request(port(proxyServer), '/v1/chat/completions', {
      cookie: 'admin_session=secret',
      connection: 'x-remove-me',
      'x-remove-me': 'must-not-pass',
      'x-dumate-client-ip': 'not-an-ip',
      'content-type': 'application/json',
    }, '{"model":"x"}');
    assert.equal(result.status, 200);
    assert.equal(result.body, '{"ok":true}');
    assert.equal(seen.body, '{"model":"x"}');
    assert.equal(seen.headers.cookie, undefined);
    assert.equal(seen.headers['x-remove-me'], undefined);
    assert.equal(seen.headers['x-dumate-client-ip'], '127.0.0.1');
    assert.equal(seen.headers.host, `127.0.0.1:${port(target)}`);
  } finally {
    await close(proxyServer);
    await close(target);
  }
});

test('SSE bytes are forwarded incrementally', async () => {
  const target = await listen((req, res) => {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    });
    res.write('data: first\n\n');
    setTimeout(() => res.end('data: second\n\n'), 200);
  });
  const proxyServer = await listen((req, res) => {
    proxy.proxyDataPlane(req, res, { port: port(target) });
  });
  try {
    let finished = false;
    let resolveFinished;
    let rejectFinished;
    const finishedBody = new Promise((resolve, reject) => {
      resolveFinished = resolve;
      rejectFinished = reject;
    });
    const first = await new Promise((resolve, reject) => {
      const req = http.get({
        host: '127.0.0.1',
        port: port(proxyServer),
        path: '/v1/chat/completions',
      }, (res) => {
        let body = '';
        let sawFirst = false;
        res.setEncoding('utf8');
        res.on('data', (chunk) => {
          body += chunk;
          if (!sawFirst && body.includes('data: first')) {
            sawFirst = true;
            resolve({ beforeEnd: !finished, body });
          }
        });
        res.on('end', () => {
          finished = true;
          if (!sawFirst) {
            rejectFinished(new Error('response ended before the first SSE event'));
            reject(new Error('response ended before the first SSE event'));
            return;
          }
          resolveFinished(body);
        });
      });
      req.on('error', reject);
    });
    assert.equal(first.beforeEnd, true, 'first SSE event must arrive before response end');
    assert.match(first.body, /data: first/);
    assert.match(await finishedBody, /data: second/);
  } finally {
    await close(proxyServer);
    await close(target);
  }
});

test('connection failure becomes a JSON 502', async () => {
  const target = await listen(() => {});
  const targetPort = port(target);
  await close(target);
  const proxyServer = await listen((req, res) => {
    proxy.proxyDataPlane(req, res, { port: targetPort });
  });
  try {
    const result = await request(port(proxyServer), '/v1/models');
    assert.equal(result.status, 502);
    assert.match(result.body, /模型网关不可用/);
  } finally {
    await close(proxyServer);
  }
});
