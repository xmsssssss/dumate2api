'use strict';

// The public admin listener is also the public model-data listener. Keep the
// gateway on loopback and forward only the model API surface through this
// module; admin routes and browser-management cookies never enter this path.
const http = require('http');
const ipTrust = require('../ip-trust');

const DEFAULT_GATEWAY_PORT = 18081;
const HOP_BY_HOP = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
]);

const EXACT_PATHS = new Set([
  '/health',
  '/ping',
  '/messages',
  '/messages/count_tokens',
  '/responses',
  '/api/v1/messages',
  '/api/v1/messages/count_tokens',
  '/images/generations',
  '/videos/generations',
  '/audio/speech',
  '/search/web',
  '/search/images',
  '/voice/polish',
  '/files/upload',
]);

const PREFIXES = ['/v1/', '/v1beta/'];

function pathnameOf(value) {
  const raw = String(value || '');
  const query = raw.indexOf('?');
  return query === -1 ? raw : raw.slice(0, query);
}

function isDataPlanePath(value) {
  const pathname = pathnameOf(value);
  if (!pathname || pathname === '/api/admin' || pathname.startsWith('/api/admin/')) {
    return false;
  }
  if (EXACT_PATHS.has(pathname)) return true;
  return PREFIXES.some((prefix) => pathname.startsWith(prefix));
}

function copyWithoutHopByHop(source) {
  const headers = {};
  const connectionTokens = new Set(
    String((source && source.connection) || '')
      .split(',')
      .map((value) => value.trim().toLowerCase())
      .filter(Boolean),
  );
  for (const [rawKey, value] of Object.entries(source || {})) {
    const key = rawKey.toLowerCase();
    if (HOP_BY_HOP.has(key) || connectionTokens.has(key)) continue;
    headers[key] = value;
  }
  return headers;
}

function gatewayPort(value) {
  const parsed = Number(value == null || value === '' ? DEFAULT_GATEWAY_PORT : value);
  return Number.isInteger(parsed) && parsed > 0 && parsed < 65536
    ? parsed
    : DEFAULT_GATEWAY_PORT;
}

function buildUpstreamHeaders(req, port) {
  const headers = copyWithoutHopByHop(req.headers || {});
  delete headers.cookie;
  delete headers['x-dumate-client-ip'];
  const clientIP = ipTrust.clientIP(req) || req.socket && req.socket.remoteAddress || '';
  if (clientIP) headers['x-dumate-client-ip'] = clientIP;
  headers.host = `127.0.0.1:${port}`;
  return headers;
}

function sendProxyError(res, status, message) {
  if (res.headersSent) {
    res.destroy();
    return;
  }
  const body = JSON.stringify({
    error: {
      message,
      type: 'proxy_error',
    },
  });
  res.writeHead(status, {
    ...(res._cors || {}),
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

function proxyDataPlane(req, res, opts = {}) {
  const port = gatewayPort(
    opts.port == null ? process.env.DUMATE_ADMIN_GATEWAY_PORT : opts.port,
  );
  const headers = buildUpstreamHeaders(req, port);
  let upstreamReq;

  try {
    upstreamReq = http.request({
      hostname: '127.0.0.1',
      port,
      method: req.method,
      path: req.url,
      headers,
    }, (upstreamRes) => {
      const responseHeaders = copyWithoutHopByHop(upstreamRes.headers || {});
      res.writeHead(upstreamRes.statusCode || 502, responseHeaders);
      upstreamRes.pipe(res);
    });
  } catch (error) {
    sendProxyError(res, 502, `模型网关不可用：${error.message}`);
    return null;
  }

  upstreamReq.on('error', (error) => {
    if (!res.headersSent) sendProxyError(res, 502, `模型网关不可用：${error.message}`);
    else res.destroy();
  });
  req.on('aborted', () => upstreamReq.destroy());
  req.pipe(upstreamReq);
  return upstreamReq;
}

module.exports = {
  DEFAULT_GATEWAY_PORT,
  HOP_BY_HOP,
  isDataPlanePath,
  gatewayPort,
  buildUpstreamHeaders,
  proxyDataPlane,
};
