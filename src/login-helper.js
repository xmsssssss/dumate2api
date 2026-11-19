// src/login-helper.js - local browser login pairing sessions
//
// The admin service may run in Docker on another machine. It cannot read the
// browser cookies on the user's computer, so a lightweight local helper opens
// a real Chrome/Edge window and submits the captured cookie with a one-time
// pairing code. This module stores only a hash of that code and never exposes
// the submitted cookie through a snapshot.
const crypto = require('crypto');

const LOGIN_URL = 'https://login.bce.baidu.com/?redirect=' +
  encodeURIComponent('https://console.bce.baidu.com/');
const SESSION_TTL_MS = 15 * 60 * 1000;
const MAX_SESSIONS = 100;
const RATE_WINDOW_MS = 60 * 1000;
const RATE_MAX_ATTEMPTS = 30;

const sessions = new Map();
const rateLimits = new Map();

function normalizeCode(raw) {
  return String(raw || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
}

function hashCode(code) {
  return crypto.createHash('sha256').update(normalizeCode(code)).digest();
}

function generateCode() {
  const raw = crypto.randomBytes(10).toString('hex').toUpperCase();
  return raw.match(/.{1,4}/g).join('-');
}

function cookieNames(cookie) {
  const names = new Set();
  for (const part of String(cookie || '').split(/;\s*/)) {
    const i = part.indexOf('=');
    if (i <= 0) continue;
    const name = part.slice(0, i).trim();
    const value = part.slice(i + 1).trim();
    if (name && value) names.add(name);
  }
  return names;
}

function validateCookie(cookie) {
  const names = cookieNames(cookie);
  if (!names.has('BDUSS')) return 'Cookie 缺少 BDUSS，请确认已完成百度登录';
  if (!names.has('bce-long-term-sessionid')) {
    return 'Cookie 缺少 bce-long-term-sessionid，请登录后打开一次 console.bce.baidu.com';
  }
  return '';
}

function publicSession(session) {
  return {
    active: session.status === 'waiting' || session.status === 'success',
    mode: 'helper',
    session_id: session.id,
    status: session.status,
    message: session.message,
    started_at: session.started_at,
    expires_at: session.expires_at,
    has_cookie: session.status === 'success',
    ...(session.account ? { account: publicAccount(session.account) } : {}),
  };
}

function publicAccount(account) {
  if (!account) return null;
  const { cookie, proxy, ...rest } = account;
  return rest;
}

function expire(session, now) {
  if (!session || session.status !== 'waiting') return false;
  if (now <= session.expires_at) return false;
  session.status = 'failed';
  session.message = '配对码已过期，请重新生成';
  session.pairingHash = null;
  return true;
}

function cleanup(now = Date.now()) {
  for (const session of sessions.values()) expire(session, now);
  while (sessions.size > MAX_SESSIONS) {
    const oldest = [...sessions.values()].sort((a, b) => a.started_at - b.started_at)[0];
    if (!oldest) break;
    sessions.delete(oldest.id);
  }
  for (const [key, entry] of rateLimits) {
    if (now - entry.windowStart > RATE_WINDOW_MS * 2) rateLimits.delete(key);
  }
}

function rateKey(remoteKey) {
  return String(remoteKey || 'unknown').slice(0, 200);
}

function takeRateLimit(remoteKey, now) {
  const key = rateKey(remoteKey);
  let entry = rateLimits.get(key);
  if (!entry || now - entry.windowStart >= RATE_WINDOW_MS) {
    entry = { windowStart: now, count: 0 };
    rateLimits.set(key, entry);
  }
  entry.count += 1;
  return entry.count <= RATE_MAX_ATTEMPTS;
}

function start(opts = {}) {
  const now = Number.isFinite(opts.now) ? opts.now : Date.now();
  cleanup(now);
  const id = crypto.randomBytes(18).toString('hex');
  const pairingCode = generateCode();
  const session = {
    id,
    name: String(opts.name || '').trim(),
    started_at: now,
    expires_at: now + SESSION_TTL_MS,
    status: 'waiting',
    message: '请运行本机登录助手并完成百度登录',
    pairingHash: hashCode(pairingCode),
    account: null,
  };
  sessions.set(id, session);
  return {
    ok: true,
    ...publicSession(session),
    pairing_code: pairingCode,
    login_url: LOGIN_URL,
    helper_download_url: '/api/admin/web-accounts/login/helper/download',
  };
}

function get(sessionId, now = Date.now()) {
  const session = sessions.get(String(sessionId || ''));
  if (!session) return null;
  expire(session, now);
  return session;
}

function getSnapshot(sessionId, now = Date.now()) {
  const session = get(sessionId, now);
  return session ? publicSession(session) : null;
}

function cancel(sessionId) {
  const session = get(sessionId);
  if (!session) return null;
  if (session.status === 'waiting') {
    session.status = 'cancelled';
    session.message = '已取消';
  }
  session.pairingHash = null;
  return publicSession(session);
}

function claim(pairingCode, cookie, opts = {}) {
  const now = Number.isFinite(opts.now) ? opts.now : Date.now();
  cleanup(now);
  if (!takeRateLimit(opts.remoteKey, now)) {
    return { ok: false, status: 429, error: '配对尝试过于频繁，请稍后再试' };
  }
  const normalized = normalizeCode(pairingCode);
  if (normalized.length < 16) {
    return { ok: false, status: 401, error: '配对码无效或已过期' };
  }
  const candidate = hashCode(normalized);
  let match = null;
  for (const session of sessions.values()) {
    if (session.status !== 'waiting' || !session.pairingHash) continue;
    if (crypto.timingSafeEqual(candidate, session.pairingHash)) {
      match = session;
      break;
    }
  }
  if (!match) return { ok: false, status: 401, error: '配对码无效或已过期' };

  const cookieError = validateCookie(cookie);
  if (cookieError) return { ok: false, status: 400, error: cookieError };

  match.status = 'success';
  match.message = '本机助手已提交凭证，正在验证并保存';
  match.pairingHash = null;
  return { ok: true, session_id: match.id, name: match.name, cookie: String(cookie) };
}

function complete(sessionId, account) {
  const session = get(sessionId);
  if (!session) return null;
  session.status = 'saved';
  session.message = '账号已添加';
  // The route normally passes accounts.toPublic(), but keep this boundary
  // defensive: a future caller must not leak raw cookies or proxy passwords
  // through the polling snapshot.
  session.account = publicAccount(account);
  return publicSession(session);
}

function fail(sessionId, message) {
  const session = get(sessionId);
  if (!session) return null;
  session.status = 'failed';
  session.message = String(message || '登录结果保存失败');
  return publicSession(session);
}

function resetForTests() {
  sessions.clear();
  rateLimits.clear();
}

module.exports = {
  SESSION_TTL_MS,
  LOGIN_URL,
  normalizeCode,
  validateCookie,
  publicAccount,
  start,
  getSnapshot,
  cancel,
  claim,
  complete,
  fail,
  resetForTests,
};
