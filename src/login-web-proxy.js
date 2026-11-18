// src/login-web-proxy.js - 无图形界面环境下的浏览器登录代理
//
// Docker/Linux 管理端没有桌面浏览器，无法沿用 login-browser.js 的弹窗方案。
// 这个模块把百度登录链路的固定域反代到管理端，服务端自己保存 CookieJar；
// 用户仍在自己的浏览器里完成登录，管理端轮询到 BDUSS 和控制台会话后落库。
//
// 安全边界：
//   - 只允许百度登录/静态资源与搭子域，不接受任意 URL 或 IP；
//   - 每个登录流程一枚不可猜测的 session id，Cookie/密钥不交给浏览器；
//   - 代理 HTML 带 CSP sandbox，第三方脚本处于不透明源，不能读取管理端；
//   - 管理登录 Cookie 永远不转发给上游。
const crypto = require('crypto');
const http = require('http');
const https = require('https');
const zlib = require('zlib');
const proxyAgent = require('./proxy-agent');

const LOGIN_PROXY_PREFIX = '/api/admin/web-accounts/login/proxy/';
const SESSION_TTL_MS = 15 * 60 * 1000;
const MAX_SESSIONS = 24;
const MAX_UPSTREAM_RESPONSE = 16 * 1024 * 1024;
const MAX_REQUEST_BODY = 2 * 1024 * 1024;
const SETTLE_URLS = [
  'https://console.bce.baidu.com/',
  'https://console.bce.baidu.com/ai/#/app/dumate/overview',
];
const ALLOWED_SUFFIXES = [
  'baidu.com',
  'bdstatic.com',
  'dumate.cn',
  'baidubce.com',
];
const TELEMETRY_HOSTS = new Set([
  'hm.baidu.com',
  'nsclick.baidu.com',
]);
const SILENT_BACKGROUND_REQUESTS = new Map([
  ['cloud.baidu.com/404.html', 'image'],
  ['cas.baidu.com/ucaction/collectlog', 'image'],
  ['passport.baidu.com/error.html', 'script'],
]);

const sessions = new Map();

function isAllowedHostname(hostname) {
  const host = String(hostname || '').toLowerCase().replace(/\.$/, '');
  if (!host || host.includes(':') || /^\d+\.\d+\.\d+\.\d+$/.test(host)) return false;
  return ALLOWED_SUFFIXES.some((suffix) => host === suffix || host.endsWith(`.${suffix}`));
}

function isAllowedUrl(url) {
  try {
    const u = url instanceof URL ? url : new URL(String(url));
    if (u.protocol !== 'https:' || u.username || u.password) return false;
    if (u.port && u.port !== '443') return false;
    return isAllowedHostname(u.hostname);
  } catch (e) {
    return false;
  }
}

function proxyHostBase(sid, host) {
  return `${LOGIN_PROXY_PREFIX}${encodeURIComponent(sid)}/https/${host}`;
}

function proxyUrl(sid, upstreamUrl) {
  const u = upstreamUrl instanceof URL ? upstreamUrl : new URL(String(upstreamUrl));
  if (!isAllowedUrl(u)) throw new Error('登录代理目标不在白名单内');
  return `${proxyHostBase(sid, u.host)}${u.pathname || '/'}${u.search || ''}${u.hash || ''}`;
}

function cleanupSessions() {
  const now = Date.now();
  for (const [sid, session] of sessions) {
    expireSession(session, now);
  }
  while (sessions.size > MAX_SESSIONS) {
    const oldest = [...sessions.entries()]
      .sort((a, b) => a[1].started_at - b[1].started_at)[0];
    if (!oldest) break;
    sessions.delete(oldest[0]);
  }
}

function expireSession(session, now = Date.now()) {
  if (!session || now - session.started_at <= SESSION_TTL_MS) return false;
  if (session.status === 'failed' || session.status === 'cancelled') return false;
  session.status = 'failed';
  session.message = '登录会话已过期，请重新打开';
  session.jar.clear();
  return true;
}

function start(opts = {}) {
  cleanupSessions();
  const sid = crypto.randomBytes(24).toString('hex');
  const target = 'https://login.bce.baidu.com/?redirect=' +
    encodeURIComponent('https://console.bce.baidu.com/');
  const session = {
    id: sid,
    name: String(opts.name || '').trim(),
    started_at: Date.now(),
    status: 'waiting',
    message: '请在打开的代理页完成百度登录',
    jar: new Map(),
    settling: false,
    settled_at: 0,
  };
  sessions.set(sid, session);
  return {
    ok: true,
    mode: 'proxy',
    session_id: sid,
    login_url: proxyUrl(sid, target),
    ...snapshot(sid),
  };
}

function getSession(sid) {
  const session = sessions.get(String(sid || ''));
  if (!session) return null;
  expireSession(session);
  return session;
}

function snapshot(sid) {
  const session = typeof sid === 'string' ? getSession(sid) : sid;
  if (!session) {
    return {
      active: false,
      mode: 'proxy',
      status: 'failed',
      message: '登录代理会话不存在或已过期',
      has_cookie: false,
    };
  }
  const auth = extractAuthCookie(session);
  return {
    active: session.status === 'waiting' || (session.status === 'success' && !session.cookieTaken),
    mode: 'proxy',
    session_id: session.id,
    status: session.status,
    message: session.message,
    started_at: session.started_at,
    has_cookie: !session.cookieTaken && !!auth,
    login_url: proxyUrl(session.id, 'https://login.bce.baidu.com/?redirect=' +
      encodeURIComponent('https://console.bce.baidu.com/')),
  };
}

function cancel(sid) {
  const session = getSession(sid);
  if (!session) return { ok: true };
  session.status = 'cancelled';
  session.message = '已取消';
  session.jar.clear();
  return { ok: true };
}

function peekCookie(sid) {
  const session = getSession(sid);
  if (!session || session.status !== 'success' || session.cookieTaken) return null;
  return extractAuthCookie(session);
}

function takeCookie(sid) {
  const session = getSession(sid);
  if (!session || session.status !== 'success' || session.cookieTaken) return null;
  const cookie = peekCookie(sid);
  if (!cookie) return null;
  session.cookieTaken = true;
  session.jar.clear();
  return cookie;
}

function cookieKey(name, domain, path) {
  return `${domain}|${path}|${name}`;
}

function normalizeCookieDomain(hostname, domainAttr) {
  if (!domainAttr) return String(hostname || '').toLowerCase();
  return String(domainAttr).toLowerCase().replace(/^\./, '');
}

function domainMatches(hostname, domain) {
  const host = String(hostname || '').toLowerCase();
  const d = String(domain || '').toLowerCase().replace(/^\./, '');
  return host === d || host.endsWith(`.${d}`);
}

function defaultCookiePath(pathname) {
  const p = String(pathname || '/');
  if (!p.startsWith('/')) return '/';
  const i = p.lastIndexOf('/');
  return i <= 0 ? '/' : p.slice(0, i);
}

function pathMatches(requestPath, cookiePath) {
  const p = String(requestPath || '/');
  const c = String(cookiePath || '/');
  return p === c || p.startsWith(c.endsWith('/') ? c : `${c}/`);
}

function parseSetCookie(header, requestUrl) {
  const u = requestUrl instanceof URL ? requestUrl : new URL(String(requestUrl));
  const parts = String(header || '').split(';');
  const first = parts.shift() || '';
  const eq = first.indexOf('=');
  if (eq <= 0) return null;
  const name = first.slice(0, eq).trim();
  const value = first.slice(eq + 1).trim();
  if (!name) return null;

  const attrs = Object.create(null);
  for (const part of parts) {
    const i = part.indexOf('=');
    const k = (i < 0 ? part : part.slice(0, i)).trim().toLowerCase();
    const v = i < 0 ? '' : part.slice(i + 1).trim();
    if (k) attrs[k] = v;
  }

  const domain = normalizeCookieDomain(u.hostname, attrs.domain);
  if (!domainMatches(u.hostname, domain)) return null;
  const path = attrs.path && attrs.path.startsWith('/') ? attrs.path : defaultCookiePath(u.pathname);
  let expiresAt = null;
  if (attrs['max-age'] != null) {
    const seconds = Number(attrs['max-age']);
    if (Number.isFinite(seconds)) expiresAt = Date.now() + seconds * 1000;
  } else if (attrs.expires) {
    const t = Date.parse(attrs.expires);
    if (Number.isFinite(t)) expiresAt = t;
  }
  return {
    name,
    value,
    domain,
    path,
    expiresAt,
    secure: 'secure' in attrs,
  };
}

function storeSetCookies(session, setCookie, requestUrl) {
  const list = Array.isArray(setCookie)
    ? setCookie
    : (setCookie ? [setCookie] : []);
  for (const header of list) {
    const cookie = parseSetCookie(header, requestUrl);
    if (!cookie) continue;
    const key = cookieKey(cookie.name, cookie.domain, cookie.path);
    if (cookie.expiresAt != null && cookie.expiresAt <= Date.now()) {
      session.jar.delete(key);
      continue;
    }
    session.jar.set(key, cookie);
  }
}

function cookieHeaderFor(session, targetUrl) {
  const u = targetUrl instanceof URL ? targetUrl : new URL(String(targetUrl));
  const now = Date.now();
  const list = [];
  for (const [key, cookie] of session.jar) {
    if (cookie.expiresAt != null && cookie.expiresAt <= now) {
      session.jar.delete(key);
      continue;
    }
    if (!domainMatches(u.hostname, cookie.domain)) continue;
    if (!pathMatches(u.pathname || '/', cookie.path)) continue;
    list.push(cookie);
  }
  list.sort((a, b) => b.path.length - a.path.length);
  return list.map((c) => `${c.name}=${c.value}`).join('; ');
}

function extractAuthCookie(session) {
  const cookies = [...session.jar.values()].filter((c) => c && c.value);
  const find = (name) => cookies
    .filter((c) => c.name === name)
    .sort((a, b) => (b.domain.length - a.domain.length) || (b.path.length - a.path.length))[0];
  if (!find('BDUSS') || !find('bce-long-term-sessionid')) return null;

  const byName = new Map();
  for (const c of cookies) {
    const prev = byName.get(c.name);
    if (!prev || c.domain.length > prev.domain.length
      || (c.domain.length === prev.domain.length && c.path.length > prev.path.length)) {
      byName.set(c.name, c);
    }
  }
  return [...byName.values()].map((c) => `${c.name}=${c.value}`).join('; ');
}

function markSuccess(session) {
  if (!extractAuthCookie(session)) return false;
  session.status = 'success';
  session.message = '登录成功，已获取凭证';
  return true;
}

function requestJar(session, targetUrl, headers, redirects = 0) {
  return new Promise((resolve, reject) => {
    if (redirects > 5) return reject(new Error('上游重定向次数过多'));
    const u = new URL(String(targetUrl));
    if (!isAllowedUrl(u)) return reject(new Error('登录代理目标不在白名单内'));
    let agent;
    try {
      agent = proxyAgent.getAgentFor(null);
    } catch (e) {
      return reject(new Error(`出站代理配置错误：${e.message}`));
    }
    const cookie = cookieHeaderFor(session, u);
    const reqHeaders = {
      'user-agent': 'Mozilla/5.0 dumate2api login proxy',
      accept: 'text/html,application/xhtml+xml,application/json;q=0.9,*/*;q=0.8',
      'accept-encoding': 'identity',
      ...(headers || {}),
      host: u.host,
    };
    if (cookie) reqHeaders.cookie = cookie;
    const req = https.request(u, {
      method: 'GET',
      headers: reqHeaders,
      timeout: 20000,
      ...(agent ? { agent } : {}),
    }, (up) => {
      const chunks = [];
      let size = 0;
      up.on('data', (chunk) => {
        size += chunk.length;
        if (size <= 2 * 1024 * 1024) chunks.push(chunk);
      });
      up.on('end', async () => {
        storeSetCookies(session, up.headers['set-cookie'], u);
        const location = up.headers.location;
        if (location && up.statusCode >= 300 && up.statusCode < 400) {
          try {
            const next = new URL(location, u);
            const data = await requestJar(session, next, headers, redirects + 1);
            return resolve(data);
          } catch (e) {
            return reject(e);
          }
        }
        resolve({
          status: up.statusCode || 502,
          headers: up.headers,
          body: Buffer.concat(chunks),
        });
      });
    });
    req.on('timeout', () => req.destroy(new Error('上游请求超时')));
    req.on('error', reject);
    req.end();
  });
}

async function settleSession(session) {
  if (!session || session.settling || session.status !== 'waiting') return;
  if (![...session.jar.values()].some((c) => c.name === 'BDUSS')) return;
  if (Date.now() - session.settled_at < 10000) return;
  session.settling = true;
  session.settled_at = Date.now();
  try {
    for (const url of SETTLE_URLS) {
      await requestJar(session, url, { referer: 'https://console.bce.baidu.com/' });
      if (markSuccess(session)) break;
    }
  } catch (e) {
    session.message = '已登录，正在等待控制台会话建立';
  } finally {
    session.settling = false;
  }
}

function parseProxyPath(pathname) {
  if (!String(pathname).startsWith(LOGIN_PROXY_PREFIX)) return null;
  const rest = String(pathname).slice(LOGIN_PROXY_PREFIX.length);
  const m = rest.match(/^([^/]+)\/https\/([^/]+)(\/.*)?$/);
  if (!m) return null;
  let sid;
  let host;
  try {
    sid = decodeURIComponent(m[1]);
    host = decodeURIComponent(m[2]);
  } catch (e) {
    return null;
  }
  return {
    sid,
    host,
    path: m[3] || '/',
  };
}

function isProxiedPath(path) {
  return String(path || '').startsWith(LOGIN_PROXY_PREFIX);
}

function rewriteAbsoluteUrls(text, sid) {
  return String(text).replace(/((?:https?):)?\/\/([a-z0-9.-]+(?::\d+)?)/gi,
    (match, scheme, host, offset, source) => {
      if (!scheme) {
        const before = source.slice(Math.max(0, offset - 12), offset).toLowerCase();
        if (/(?:https?:|https?%3a|%3a)$/.test(before)) return match;
      }
      if (!isAllowedHostname(host.split(':')[0])) return match;
      return proxyHostBase(sid, host);
    });
}

function rewriteRootRelative(text, sid, host, mode) {
  const base = proxyHostBase(sid, host);
  let out = String(text);
  if (mode === 'html') {
    out = out.replace(
      /(\b(?:href|src|action|poster)\s*=\s*)(["'])(\/(?!\/)[^"']*)\2/gi,
      (_m, lead, quote, path) => (
        isProxiedPath(path) ? _m : `${lead}${quote}${base}${path}${quote}`
      ),
    );
    out = out.replace(
      /(\bsrcset\s*=\s*)(["'])([^"']+)\2/gi,
      (_m, lead, quote, value) => {
        const rewritten = value.split(',').map((part) => {
          const bit = part.trim();
          if (!bit.startsWith('/') || bit.startsWith('//') || isProxiedPath(bit)) return bit;
          return `${base}${bit}`;
        }).join(', ');
        return `${lead}${quote}${rewritten}${quote}`;
      },
    );
  }
  if (mode === 'css' || mode === 'html') {
    out = out.replace(
      /url\(\s*(["']?)\/(?!\/)([^"')\s]+)\1\s*\)/gi,
      (_m, quote, path) => (
        isProxiedPath(`/${path}`) ? _m : `url(${quote}${base}/${path}${quote})`
      ),
    );
  }
  if (mode === 'js' || mode === 'html') {
    out = out.replace(
      /(["'])\/(?!\/)([^"'\\\r\n]*?)\1/g,
      (_m, quote, path) => (
        isProxiedPath(`/${path}`) ? _m : `${quote}${base}/${path}${quote}`
      ),
    );
  }
  return out;
}

function rewriteEncodedHtml(text, sid, host) {
  return String(text).replace(
    /(["'])((?:%[0-9a-f]{2}|%u[0-9a-f]{4}|[^"'\\\r\n]){32,})\1/gi,
    (match, quote, value) => {
      if (!/%3c(?:!doctype|html|head|body|script|link|meta)/i.test(value)) return match;
      let decoded;
      try {
        decoded = unescape(value);
      } catch (e) {
        return match;
      }
      if (!/<(?:!doctype|html|head|body|script|link|meta)\b/i.test(decoded)) return match;
      let rewritten = rewriteAbsoluteUrls(decoded, sid);
      rewritten = rewriteRootRelative(rewritten, sid, host, 'html');
      rewritten = rewriteAbsoluteUrls(rewritten, sid);
      return `${quote}${escape(rewritten)}${quote}`;
    },
  );
}

function runtimeScript(sid, currentHost) {
  const rootPrefix = `${LOGIN_PROXY_PREFIX}${sid}`;
  const currentBase = proxyHostBase(sid, currentHost);
  const statusUrl = `${LOGIN_PROXY_PREFIX}${sid}/_status`;
  return `<script>(function(){
try {
  function memoryStorage(){
    var m=Object.create(null);
    return {
      get length(){return Object.keys(m).length},
      key:function(i){return Object.keys(m)[i]||null},
      getItem:function(k){k=String(k);return Object.prototype.hasOwnProperty.call(m,k)?m[k]:null},
      setItem:function(k,v){m[String(k)]=String(v)},
      removeItem:function(k){delete m[String(k)]},
      clear:function(){m=Object.create(null)}
    };
  }
  ['localStorage','sessionStorage'].forEach(function(name){
    try { void window[name]; } catch(e) {
      try { Object.defineProperty(window,name,{configurable:true,value:memoryStorage()}); } catch(_e) {}
    }
  });
  try { void document.cookie; } catch(e) {
    var cookieValue='';
    try { Object.defineProperty(document,'cookie',{
      configurable:true,
      get:function(){return cookieValue},
      set:function(v){cookieValue=String(v||'').split(';')[0]}
    }); } catch(_e) {}
  }
  try {
    var currentDomain=document.domain;
    Object.defineProperty(document,'domain',{
      configurable:true,
      get:function(){return currentDomain},
      set:function(){}
    });
  } catch(e) {}
  var SELF=new URL(location.href).origin;
  var ROOT='${rootPrefix}';
  var CURRENT='${currentBase}';
  var ALLOWED=['baidu.com','bdstatic.com','dumate.cn','baidubce.com'];
  function allowedHost(h){
    h=String(h||'').toLowerCase();
    return ALLOWED.some(function(s){return h===s||h.endsWith('.'+s)});
  }
  function mapUrl(raw){
    if(raw==null||raw==='') return raw;
    var s=String(raw);
    if(/^(data|blob|javascript|mailto|tel):/i.test(s)||s.charAt(0)==='#') return s;
    var u;
    try { u=new URL(s,location.href); } catch(e) { return s; }
    if(u.origin===SELF){
      if(u.pathname.indexOf(ROOT)===0) return u.href;
      return SELF+CURRENT+u.pathname+u.search+u.hash;
    }
    if((u.protocol==='https:'||u.protocol==='http:')&&(!u.port||u.port==='443')){
      if(allowedHost(u.hostname)) return SELF+ROOT+'/https/'+u.host+u.pathname+u.search+u.hash;
    }
    return s;
  }
  var origFetch=window.fetch;
  if(origFetch) window.fetch=function(input,init){
    if(window.Request&&input instanceof Request){
      var mapped=mapUrl(input.url);
      if(mapped!==input.url) input=new Request(mapped,input);
      return origFetch.call(this,input,init);
    }
    return origFetch.call(this,mapUrl(input),init);
  };
  var origOpen=XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.open=function(method,url){
    var args=Array.prototype.slice.call(arguments);
    args[1]=mapUrl(url);
    return origOpen.apply(this,args);
  };
  if(window.EventSource){var ES=EventSource;window.EventSource=function(url,cfg){return new ES(mapUrl(url),cfg)};window.EventSource.prototype=ES.prototype;}
  if(navigator.sendBeacon){var beacon=navigator.sendBeacon.bind(navigator);navigator.sendBeacon=function(url,data){return beacon(mapUrl(url),data)};}
  var origWindowOpen=window.open;
  window.open=function(url){var args=Array.prototype.slice.call(arguments);if(args[0])args[0]=mapUrl(args[0]);return origWindowOpen.apply(window,args)};
  try{var push=history.pushState;history.pushState=function(s,t,u){return push.call(history,s,t,u?mapUrl(u):u)}}catch(e){}
  try{var replace=history.replaceState;history.replaceState=function(s,t,u){return replace.call(history,s,t,u?mapUrl(u):u)}}catch(e){}
  try{var assign=location.assign.bind(location);location.assign=function(u){return assign(mapUrl(u))}}catch(e){}
  try{var replaceLocation=location.replace.bind(location);location.replace=function(u){return replaceLocation(mapUrl(u))}}catch(e){}
  try{
    var origSetAttribute=Element.prototype.setAttribute;
    Element.prototype.setAttribute=function(name,value){
      if(/^(href|src|action|poster|data|srcset)$/i.test(name)) value=mapUrl(value);
      return origSetAttribute.call(this,name,value);
    };
  }catch(e){}
  function patchUrlProperty(ctor,name){
    try{
      if(!ctor||!ctor.prototype)return;
      var d=Object.getOwnPropertyDescriptor(ctor.prototype,name);
      if(!d||!d.get||!d.set)return;
      Object.defineProperty(ctor.prototype,name,{
        configurable:d.configurable,
        enumerable:d.enumerable,
        get:d.get,
        set:function(value){return d.set.call(this,mapUrl(value))}
      });
    }catch(e){}
  }
  patchUrlProperty(window.HTMLImageElement,'src');
  patchUrlProperty(window.HTMLScriptElement,'src');
  patchUrlProperty(window.HTMLIFrameElement,'src');
  patchUrlProperty(window.HTMLLinkElement,'href');
  patchUrlProperty(window.HTMLAnchorElement,'href');
  patchUrlProperty(window.HTMLFormElement,'action');
  patchUrlProperty(window.HTMLMediaElement,'src');
  patchUrlProperty(window.HTMLSourceElement,'src');
  patchUrlProperty(window.HTMLVideoElement,'poster');
  patchUrlProperty(window.HTMLObjectElement,'data');
  document.addEventListener('submit',function(e){
    var f=e.target;
    if(f&&f.getAttribute){
      var a=f.getAttribute('action');
      if(a) f.setAttribute('action',mapUrl(a));
    }
  },true);
  try{
    new MutationObserver(function(nodes){
      nodes.forEach(function(n){
        [].forEach.call(n.addedNodes||[],function(el){
          if(!el.querySelectorAll)return;
          [el].concat(Array.prototype.slice.call(
            el.querySelectorAll('[src],[href],[action],[poster],[data],[srcset]')
          )).forEach(function(x){
            ['src','href','action','poster','data','srcset'].forEach(function(a){
              var v=x.getAttribute(a);if(v)x.setAttribute(a,mapUrl(v));
            });
          });
        });
      });
    }).observe(document.documentElement,{childList:true,subtree:true});
  }catch(e){}
  setInterval(function(){
    fetch('${statusUrl}',{cache:'no-store',credentials:'omit',mode:'cors'}).then(function(r){return r.json()}).then(function(s){
      if(s.status==='success'){
        document.title='登录成功';
        document.body.innerHTML='<main style="font:16px/1.6 sans-serif;max-width:560px;margin:15vh auto;padding:24px"><h2>登录成功</h2><p>凭证已返回管理端，本页可以关闭。</p></main>';
        setTimeout(function(){window.close()},900);
      }
    }).catch(function(){});
  },1500);
} catch(e) {}
})();</script>`;
}

function injectRuntime(html, sid, currentHost) {
  const script = runtimeScript(sid, currentHost);
  const text = String(html);
  const head = text.match(/<head\b[^>]*>/i);
  if (head) {
    const i = head.index + head[0].length;
    return text.slice(0, i) + script + text.slice(i);
  }
  return script + text;
}

function rewriteContent(text, contentType, sid, host) {
  const ct = String(contentType || '').toLowerCase();
  let out = String(text);
  if (ct.includes('text/html') || ct.includes('application/xhtml+xml')) {
    out = rewriteAbsoluteUrls(out, sid);
    out = rewriteRootRelative(out, sid, host, 'html');
    out = rewriteAbsoluteUrls(out, sid);
    return injectRuntime(out, sid, host);
  }
  if (ct.includes('javascript') || ct.includes('ecmascript')) {
    // JavaScript 只处理能明确识别为百分号编码 HTML 的载荷。普通脚本必须
    // 原样返回：全局替换 URL 会误伤正则、注释和用于业务判断的原始地址。
    // 运行时请求由注入脚本统一改写到代理路径。
    return rewriteEncodedHtml(out, sid, host);
  }
  if (ct.includes('text/css')) {
    out = rewriteAbsoluteUrls(out, sid);
    out = rewriteRootRelative(out, sid, host, 'css');
    return rewriteAbsoluteUrls(out, sid);
  }
  if (ct.includes('json') || ct.includes('xml') || ct.includes('svg')) {
    out = rewriteAbsoluteUrls(out, sid);
    out = rewriteRootRelative(out, sid, host, 'js');
    return rewriteAbsoluteUrls(out, sid);
  }
  out = rewriteAbsoluteUrls(out, sid);
  return out;
}

function isJsonpResponse(target, contentType, body) {
  const ct = String(contentType || '');
  if (!/(?:text\/(?:html|plain)|application\/(?:json|javascript)|javascript)/i.test(ct)) {
    return false;
  }
  const callback = String(target.searchParams.get('callback') || '').trim();
  if (!/^[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*$/.test(callback)) return false;
  const prefix = `${callback}(`;
  const text = body.toString('utf8').replace(/^\uFEFF/, '').trimStart();
  return text.startsWith(prefix);
}

function decodeBody(buffer, encoding) {
  const enc = String(encoding || '').toLowerCase();
  if (!enc || enc === 'identity') return buffer;
  if (enc.includes('br')) return zlib.brotliDecompressSync(buffer);
  if (enc.includes('gzip')) return zlib.gunzipSync(buffer);
  if (enc.includes('deflate')) return zlib.inflateSync(buffer);
  return buffer;
}

function mapReferer(referer, target) {
  if (!referer) return '';
  try {
    const u = new URL(String(referer));
    if (!u.pathname.startsWith(LOGIN_PROXY_PREFIX)) return '';
    return target.origin + target.pathname;
  } catch (e) {
    return '';
  }
}

function corsHeaders(req) {
  const headers = {};
  if (String(req.headers.origin || '') === 'null') {
    headers['Access-Control-Allow-Origin'] = 'null';
    headers['Access-Control-Allow-Credentials'] = 'true';
    headers.Vary = 'Origin';
  }
  return headers;
}

function writeError(req, res, status, message) {
  const escaped = String(message || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
  const body = `<!doctype html><meta charset="utf-8"><title>登录代理错误</title><p>${escaped}</p>`;
  res.writeHead(status, {
    'Content-Type': 'text/html; charset=utf-8',
    'Cache-Control': 'no-store',
    'Content-Security-Policy': 'sandbox allow-scripts',
    ...corsHeaders(req),
  });
  res.end(body);
}

function upstreamErrorMessage(target, err) {
  const e = err || {};
  const code = e.code ? `[${e.code}] ` : '';
  const message = e.message || String(e);
  return `上游请求失败（${target.host}）：${code}${message}`;
}

function isTelemetryRequest(target) {
  return TELEMETRY_HOSTS.has(String(target.hostname || '').toLowerCase());
}

function silentBackgroundKind(target) {
  const host = String(target.hostname || '').toLowerCase();
  const key = `${host}${target.pathname || ''}`;
  return SILENT_BACKGROUND_REQUESTS.get(key) || '';
}

function writeTelemetry(req, res, target) {
  const isScript = silentBackgroundKind(target) === 'script'
    || /\.js$/i.test(target.pathname || '');
  const body = isScript ? '/* analytics disabled by login proxy */' : '';
  res.writeHead(isScript ? 200 : 204, {
    'Content-Type': isScript ? 'application/javascript; charset=utf-8' : 'image/gif',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    ...corsHeaders(req),
  });
  res.end(body);
}

function handleProxy(req, res, pathname) {
  const parsed = parseProxyPath(pathname);
  if (!parsed) return writeError(req, res, 400, '登录代理地址格式不正确');
  const session = getSession(parsed.sid);
  if (!session || session.status === 'cancelled') {
    return writeError(req, res, 410, '登录会话不存在或已取消');
  }
  if (session.status === 'failed') return writeError(req, res, 410, session.message || '登录会话已过期');

  const q = String(req.url || '').indexOf('?');
  const search = q >= 0 ? String(req.url).slice(q) : '';
  let target;
  try {
    target = new URL(`https://${parsed.host}${parsed.path}${search}`);
  } catch (e) {
    return writeError(req, res, 400, '上游地址不合法');
  }
  if (!isAllowedUrl(target)) return writeError(req, res, 403, '上游域名不在登录代理白名单内');
  if (isTelemetryRequest(target) || silentBackgroundKind(target)) {
    return writeTelemetry(req, res, target);
  }

  const len = Number(req.headers['content-length'] || 0);
  if (Number.isFinite(len) && len > MAX_REQUEST_BODY) {
    return writeError(req, res, 413, '登录请求体过大');
  }

  const headers = { ...req.headers };
  delete headers.host;
  delete headers.cookie;
  delete headers.authorization;
  delete headers.connection;
  delete headers['proxy-connection'];
  delete headers['keep-alive'];
  delete headers['transfer-encoding'];
  delete headers['content-encoding'];
  delete headers['accept-encoding'];
  delete headers['sec-fetch-site'];
  delete headers['sec-fetch-mode'];
  delete headers['sec-fetch-dest'];
  headers.host = target.host;
  headers['accept-encoding'] = 'identity';
  const cookie = cookieHeaderFor(session, target);
  if (cookie) headers.cookie = cookie;
  const referer = mapReferer(req.headers.referer, target);
  if (referer) headers.referer = referer;
  else delete headers.referer;
  if (req.headers.origin) headers.origin = target.origin;

  let agent;
  try {
    agent = proxyAgent.getAgentFor(null);
  } catch (e) {
    return writeError(req, res, 502, `出站代理配置错误：${e.message}`);
  }

  const upstream = https.request(target, {
    method: req.method,
    headers,
    timeout: 30000,
    ...(agent ? { agent } : {}),
  }, (up) => {
    const chunks = [];
    let size = 0;
    let tooLarge = false;
    up.on('data', (chunk) => {
      if (tooLarge) return;
      size += chunk.length;
      if (size > MAX_UPSTREAM_RESPONSE) {
        tooLarge = true;
        up.destroy(new Error('上游响应过大'));
        return;
      }
      chunks.push(chunk);
    });
    up.on('end', () => {
      if (tooLarge) return writeError(req, res, 502, '上游响应过大');
      storeSetCookies(session, up.headers['set-cookie'], target);
      if (session.status === 'waiting') {
        if (markSuccess(session)) {
          // 已经拿到控制台会话，无需再跑后台补会话。
        } else if ([...session.jar.values()].some((c) => c.name === 'BDUSS')) {
          setImmediate(() => settleSession(session).catch(() => {}));
        }
      }

      let decoded;
      try {
        decoded = decodeBody(Buffer.concat(chunks), up.headers['content-encoding']);
      } catch (e) {
        return writeError(req, res, 502, '上游响应解码失败');
      }
      const contentType = String(up.headers['content-type'] || '');
      const textTypes = /(text\/|javascript|ecmascript|json|xml|svg)/i;
      let body = decoded;
      let responseContentType = contentType;
      if (isJsonpResponse(target, contentType, decoded)) {
        responseContentType = 'application/javascript; charset=utf-8';
      } else if (textTypes.test(contentType)) {
        body = Buffer.from(rewriteContent(decoded.toString('utf8'), contentType, session.id, target.host), 'utf8');
      }

      const out = {};
      const blocked = new Set([
        'set-cookie', 'content-length', 'content-encoding', 'transfer-encoding',
        'connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization',
        'content-security-policy', 'content-security-policy-report-only',
        'x-frame-options', 'strict-transport-security', 'alt-svc',
        'access-control-allow-origin', 'access-control-allow-credentials',
        'cross-origin-opener-policy', 'cross-origin-embedder-policy',
        'cross-origin-resource-policy',
      ]);
      for (const [k, v] of Object.entries(up.headers)) {
        if (!blocked.has(k.toLowerCase()) && v != null) out[k] = v;
      }
      if (up.headers.location) {
        try {
          out.location = proxyUrl(session.id, new URL(up.headers.location, target));
        } catch (e) {
          delete out.location;
        }
      }
      out['content-type'] = responseContentType || 'application/octet-stream';
      out['content-length'] = body.length;
      out['cache-control'] = 'no-store';
      out['referrer-policy'] = 'no-referrer';
      out['x-content-type-options'] = 'nosniff';
      if (/text\/html|application\/xhtml\+xml/i.test(responseContentType)) {
        out['content-security-policy'] = 'sandbox allow-scripts allow-forms allow-popups allow-downloads';
      }
      Object.assign(out, corsHeaders(req));
      res.writeHead(up.statusCode || 502, out);
      res.end(req.method === 'HEAD' ? undefined : body);
    });
    up.on('error', (e) => {
      if (!res.headersSent) writeError(req, res, 502, upstreamErrorMessage(target, e));
      else res.end();
    });
  });
  upstream.on('timeout', () => upstream.destroy(new Error('上游请求超时')));
  upstream.on('error', (e) => {
    if (!res.headersSent) writeError(req, res, 502, upstreamErrorMessage(target, e));
    else res.end();
  });
  req.pipe(upstream);
}

function sendStatus(req, res, sid) {
  const data = snapshot(sid);
  const body = JSON.stringify(data);
  res.writeHead(data.status === 'failed' ? 404 : 200, {
    'Content-Type': 'application/json',
    'Cache-Control': 'no-store',
    'Content-Length': Buffer.byteLength(body),
    ...corsHeaders(req),
  });
  res.end(body);
}

function handleOptions(req, res) {
  res.writeHead(204, {
    ...corsHeaders(req),
    'Access-Control-Allow-Methods': 'GET, POST, PUT, PATCH, DELETE, HEAD, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Accept, X-Requested-With',
    'Access-Control-Max-Age': '600',
  });
  res.end();
}

function seedSessionCookiesForTest(sid, setCookie, requestUrl) {
  const session = getSession(sid);
  if (!session) return false;
  storeSetCookies(session, setCookie, requestUrl);
  return markSuccess(session);
}

module.exports = {
  LOGIN_PROXY_PREFIX,
  start,
  snapshot,
  cancel,
  peekCookie,
  takeCookie,
  handleProxy,
  handleOptions,
  sendStatus,
  isAllowedHostname,
  proxyUrl,
  rewriteContent,
  parseProxyPath,
  isJsonpResponse,
  __test: {
    seedSessionCookiesForTest,
    expireSessionForTest(sid) {
      const session = getSession(sid);
      if (!session) return false;
      session.started_at = Date.now() - SESSION_TTL_MS - 1;
      return expireSession(session);
    },
  },
};
