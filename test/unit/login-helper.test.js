const test = require('node:test');
const assert = require('node:assert/strict');
const loginHelper = require('../../src/login-helper');

const GOOD_COOKIE = 'BDUSS=bduss-secret; bce-long-term-sessionid=session-secret; STOKEN=stoken';

test.beforeEach(() => loginHelper.resetForTests());

test('pairing code is one-time and never appears in the public snapshot', () => {
  const started = loginHelper.start({ name: 'test', now: 1000 });
  assert.match(started.pairing_code, /^[A-F0-9]{4}(?:-[A-F0-9]{4}){4}$/);
  const snapshot = loginHelper.getSnapshot(started.session_id, 1001);
  assert.equal(snapshot.status, 'waiting');
  assert.equal(snapshot.mode, 'helper');
  assert.equal('pairing_code' in snapshot, false);

  const claimed = loginHelper.claim(started.pairing_code, GOOD_COOKIE, {
    now: 1002,
    remoteKey: 'test-1',
  });
  assert.equal(claimed.ok, true);
  assert.equal(claimed.cookie, GOOD_COOKIE);

  const replay = loginHelper.claim(started.pairing_code, GOOD_COOKIE, {
    now: 1003,
    remoteKey: 'test-2',
  });
  assert.equal(replay.ok, false);
  assert.equal(replay.status, 401);
});

test('wrong and expired pairing codes are rejected', () => {
  const started = loginHelper.start({ now: 1000 });
  const wrong = loginHelper.claim('AAAA-BBBB-CCCC-DDDD-EEEE', GOOD_COOKIE, {
    now: 1001,
    remoteKey: 'wrong',
  });
  assert.equal(wrong.ok, false);

  const expired = loginHelper.claim(started.pairing_code, GOOD_COOKIE, {
    now: 1000 + loginHelper.SESSION_TTL_MS + 1,
    remoteKey: 'expired',
  });
  assert.equal(expired.ok, false);
  assert.match(expired.error, /过期/);
});

test('both critical cookies are required before the code is consumed', () => {
  const started = loginHelper.start({ now: 1000 });
  const missingConsole = loginHelper.claim(started.pairing_code, 'BDUSS=x', {
    now: 1001,
    remoteKey: 'missing-console',
  });
  assert.equal(missingConsole.ok, false);
  assert.match(missingConsole.error, /bce-long-term-sessionid/);

  const accepted = loginHelper.claim(started.pairing_code, GOOD_COOKIE, {
    now: 1002,
    remoteKey: 'accepted',
  });
  assert.equal(accepted.ok, true);
});

test('concurrent claims cannot consume the same pairing code twice', () => {
  const started = loginHelper.start({ now: 1000 });
  const first = loginHelper.claim(started.pairing_code, GOOD_COOKIE, {
    now: 1001,
    remoteKey: 'concurrent-a',
  });
  const second = loginHelper.claim(started.pairing_code, GOOD_COOKIE, {
    now: 1001,
    remoteKey: 'concurrent-b',
  });
  assert.equal(first.ok, true);
  assert.equal(second.ok, false);
});

test('saved snapshot exposes the public account but no cookie', () => {
  const started = loginHelper.start({ now: 1000 });
  const claimed = loginHelper.claim(started.pairing_code, GOOD_COOKIE, {
    now: 1001,
    remoteKey: 'saved',
  });
  loginHelper.complete(claimed.session_id, {
    id: 7,
    name: 'alice',
    cookie: GOOD_COOKIE,
    proxy: 'http://user:pass@proxy.example:8080',
    cookie_len: GOOD_COOKIE.length,
  });
  const snapshot = loginHelper.getSnapshot(started.session_id, 1002);
  assert.equal(snapshot.status, 'saved');
  assert.equal(snapshot.account.name, 'alice');
  assert.equal('cookie' in snapshot.account, false);
  assert.equal('proxy' in snapshot.account, false);
});
