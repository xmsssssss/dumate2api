// test/unit/auth-import-upload.test.js - 上传桌面端加密登录态
const { test } = require('node:test');
const assert = require('node:assert');
const crypto = require('node:crypto');

const authImport = require('../../src/auth-import');

const KEY = Buffer.alloc(32, 0x42);

function encryptCookies(cookies, key = KEY, tamper = false) {
  const iv = Buffer.alloc(12, 0x24);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const encrypted = Buffer.concat([
    cipher.update(JSON.stringify(cookies), 'utf8'),
    cipher.final(),
  ]);
  const tag = cipher.getAuthTag();
  const packed = Buffer.concat([iv, tag, encrypted]);
  if (tamper) packed[packed.length - 1] ^= 0xff;
  return packed.toString('base64');
}

function authJson(cookies) {
  return JSON.stringify({
    cookies,
    activeProfileId: 'profile-1',
    accountProfiles: [{
      profileId: 'profile-1',
      displayName: '测试账号',
      bceUserId: 'bce-user-1',
      lastLogin: 1,
    }],
  });
}

test('.cookie-key Base64：仅接受规范的 32 字节密钥', () => {
  const padded = KEY.toString('base64');
  const unpadded = padded.replace(/=+$/, '');
  assert.deepEqual(authImport.decodeCookieKeyBase64(padded), KEY);
  assert.deepEqual(authImport.decodeCookieKeyBase64(unpadded), KEY);
  assert.equal(authImport.decodeCookieKeyBase64(''), null);
  assert.equal(authImport.decodeCookieKeyBase64('not base64!'), null);
  assert.equal(authImport.decodeCookieKeyBase64(Buffer.alloc(31).toString('base64')), null);
  assert.equal(authImport.decodeCookieKeyBase64(Buffer.alloc(33).toString('base64')), null);
  assert.equal(authImport.decodeCookieKeyBase64(`${padded}=`), null);
});

test('auth.json：解密、过滤并返回身份提示', () => {
  const authContent = authJson(encryptCookies([
    { name: 'BDUSS', value: 'bduss-secret', domain: '.baidu.com' },
    { name: 'STOKEN', value: 'stoken-secret', domain: '.baidu.com' },
    { name: '_hm', value: 'analytics', domain: '.hm.baidu.com' },
  ]));
  const result = authImport.importAuthContent({ authContent, keyBuffer: KEY });

  assert.equal(result.ok, true);
  assert.equal(result.cookie, 'BDUSS=bduss-secret; STOKEN=stoken-secret');
  assert.equal(result.cookie_count, 2);
  assert.equal(result.skipped_domains, 1);
  assert.equal(result.has_bduss, true);
  assert.equal(result.bce_user_id, 'bce-user-1');
  assert.equal(result.name_hint, '测试账号');
  assert.equal(Object.prototype.hasOwnProperty.call(result, 'keyBuffer'), false);
  assert.doesNotMatch(JSON.stringify(result), /QkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkI=/);
});

test('auth.json：错误输入如实拒绝', () => {
  let result = authImport.importAuthContent({ authContent: '{', keyBuffer: KEY });
  assert.equal(result.ok, false);
  assert.match(result.error, /合法 JSON/);

  result = authImport.importAuthContent({
    authContent: authJson('AAAA'),
    keyBuffer: Buffer.alloc(31),
  });
  assert.equal(result.ok, false);
  assert.match(result.error, /32 字节/);

  result = authImport.importAuthContent({
    authContent: authJson(encryptCookies([
      { name: 'BDUSS', value: 'x', domain: '.baidu.com' },
    ], KEY, true)),
    keyBuffer: KEY,
  });
  assert.equal(result.ok, false);
  assert.match(result.error, /解密失败/);

  result = authImport.importAuthContent({
    authContent: authJson(encryptCookies([
      { name: '_hm', value: 'analytics', domain: '.hm.baidu.com' },
    ])),
    keyBuffer: KEY,
  });
  assert.equal(result.ok, false);
  assert.match(result.error, /没有可用 cookie/);

  result = authImport.importAuthContent({
    authContent: 'x'.repeat(authImport.MAX_AUTH_CONTENT_BYTES + 1),
    keyBuffer: KEY,
  });
  assert.equal(result.ok, false);
  assert.match(result.error, /512KB|字节上限/);
});
