// src/auth-import.js - 桌面端登录态直读导入（2026-11-07 清单项 6 尾巴）
//
// 把本机 DuMate 桌面客户端的登录态（auth.json 的加密 cookies）解密成
// 网页凭证账号，免去「开浏览器 → DevTools 复制 Cookie」的手工步骤。
// 排布来自 2026-11-07 本机实测（test 临时脚本三轮，跑完即删）：
//
//   auth.json.cookies    base64 密文，排布 = [12B iv][16B authTag][ciphertext]
//                        ——**tag 前置**（紧跟 iv，不在尾部），社区项目
//                        magpie-dumage 只写了「AES-256-GCM + .cookie-key」，
//                        这个排布细节是我们实测出来的
//   .cookie-key          32B 密钥（与 auth.json 同目录）
//   明文                 Electron cookies 数组 JSON：
//                        [{name, value, domain, httpOnly, expirationDate…}]
//
// 域过滤：拼百度登录链路全部 cookie（baidu.com / bce.baidu.com / passport
// 等），排除明确的统计与无关域（hm 统计 / hao123 / yoojia / xlab）——
// 上游自己挑需要的字段，与「手动粘贴完整 Cookie」同一口径。
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const DEFAULT_DIR = () => path.join(process.env.APPDATA || '', 'qianfan-desktop-app');
const MAX_AUTH_CONTENT_BYTES = 512 * 1024;

// 无关域：统计/第三方，与登录态无关（实测 57 条里它们占了 5 条）
const SKIP_DOMAINS = new Set(['.hm.baidu.com', 'hao123.com', '.hao123.com', 'yoojia.com', '.yoojia.com', 'xlab.baidu.com']);

/**
 * 解码浏览器上传的 .cookie-key。允许标准 Base64 的省略尾填充，但拒绝
 * 非规范编码、错误长度和任何不是恰好 32 字节的结果。
 */
function decodeCookieKeyBase64(value) {
  const raw = String(value || '').replace(/\s+/g, '');
  if (!raw || raw.length > 128 || !/^[A-Za-z0-9+/]+={0,2}$/.test(raw)) return null;
  const unpadded = raw.replace(/=+$/, '');
  if (!unpadded || unpadded.length % 4 === 1) return null;
  const padded = raw.endsWith('=')
    ? raw
    : raw + '='.repeat((4 - (raw.length % 4)) % 4);
  if (padded.length % 4 !== 0) return null;
  const key = Buffer.from(padded, 'base64');
  if (key.length !== 32 || key.toString('base64') !== padded) return null;
  return key;
}

/**
 * 从上传内容解密桌面端登录态。
 *
 * @param {object} opts
 * @param {string|Buffer} opts.authContent auth.json 文本或原始字节
 * @param {Buffer} opts.keyBuffer .cookie-key 的 32 字节内容
 */
function importAuthContent(opts = {}) {
  const authText = Buffer.isBuffer(opts.authContent)
    ? opts.authContent.toString('utf8')
    : String(opts.authContent || '');
  if (!authText) return { ok: false, error: 'auth.json 内容为空' };
  if (Buffer.byteLength(authText) > MAX_AUTH_CONTENT_BYTES) {
    return { ok: false, error: `auth.json 超过 ${MAX_AUTH_CONTENT_BYTES} 字节上限` };
  }

  let auth;
  try {
    auth = JSON.parse(authText);
  } catch (e) {
    return { ok: false, error: 'auth.json 不是合法 JSON' };
  }

  const key = Buffer.isBuffer(opts.keyBuffer)
    ? opts.keyBuffer
    : Buffer.from(opts.keyBuffer == null ? '' : opts.keyBuffer);
  if (!key || key.length !== 32) {
    return { ok: false, error: `.cookie-key 不是 32 字节，解密排布可能已变——如实拒绝，不猜` };
  }

  let raw;
  try { raw = Buffer.from(String(auth.cookies || ''), 'base64'); } catch (e) {
    return { ok: false, error: 'auth.json 的 cookies 不是合法 base64' };
  }
  if (raw.length < 12 + 16 + 1) {
    return { ok: false, error: `cookies 密文过短（${raw.length}B），排布异常——如实拒绝` };
  }

  // 实测排布：[12B iv][16B authTag][ciphertext]（tag 前置）
  let cookies;
  try {
    const d = crypto.createDecipheriv('aes-256-gcm', key, raw.slice(0, 12));
    d.setAuthTag(raw.slice(12, 28));
    cookies = JSON.parse(Buffer.concat([d.update(raw.slice(28)), d.final()]).toString('utf8'));
  } catch (e) {
    return { ok: false, error: `解密失败（${e.message}）——客户端可能升级了加密排布，如实拒绝，不猜` };
  }
  if (!Array.isArray(cookies) || !cookies.length) {
    return { ok: false, error: '解密结果不是 cookie 数组' };
  }

  // 拼串：跳过统计/无关域；baidu 登录链路全拼（上游自己挑）
  const parts = [];
  let skipped = 0;
  for (const c of cookies) {
    if (!c || !c.name || c.value == null) continue;
    if (SKIP_DOMAINS.has(String(c.domain))) { skipped += 1; continue; }
    parts.push(`${c.name}=${c.value}`);
  }
  if (!parts.length) return { ok: false, error: '过滤后没有可用 cookie' };

  // 身份提示：auth.json 的 accountProfiles 里有 displayName / bceUserId
  // （明文字段，launcher.activeProfile 同款读取口径）
  const profiles = Array.isArray(auth.accountProfiles) ? auth.accountProfiles : [];
  const active = profiles.find((p) => p.profileId === auth.activeProfileId)
    || profiles.slice().sort((a, b) => (b.lastLogin || 0) - (a.lastLogin || 0))[0]
    || {};
  const hasBduss = parts.some((p) => p.startsWith('BDUSS='));
  return {
    ok: true,
    cookie: parts.join('; '),
    cookie_count: parts.length,
    skipped_domains: skipped,
    has_bduss: hasBduss,
    bce_user_id: active.bceUserId || '',
    name_hint: active.displayName || '',
  };
}

/**
 * 解密本机桌面端登录态。返回形状同 importAuthContent()。
 * @param {object} opts { dir?: string } auth.json 所在目录，默认 %APPDATA%\qianfan-desktop-app
 */
function importDesktopAuth(opts = {}) {
  const dir = String(opts.dir || DEFAULT_DIR());
  const authPath = path.join(dir, 'auth.json');
  const keyPath = path.join(dir, '.cookie-key');
  let authContent, keyBuffer;
  try {
    authContent = fs.readFileSync(authPath);
    keyBuffer = fs.readFileSync(keyPath);
  } catch (e) {
    return { ok: false, error: `读不到桌面端登录态文件（${e.message}）。确认本机装过 DuMate 客户端并登录过。` };
  }
  return importAuthContent({ authContent, keyBuffer });
}

module.exports = {
  importDesktopAuth,
  importAuthContent,
  decodeCookieKeyBase64,
  DEFAULT_DIR,
  SKIP_DOMAINS,
  MAX_AUTH_CONTENT_BYTES,
};
