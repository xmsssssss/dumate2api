const test = require('node:test');
const assert = require('node:assert/strict');
const ipTrust = require('../../src/ip-trust');

function request(peer, forwarded) {
  return {
    socket: { remoteAddress: peer },
    headers: forwarded === undefined ? {} : { 'x-dumate-client-ip': forwarded },
  };
}

test('trusted client IP header is accepted only from a loopback peer', () => {
  assert.equal(ipTrust.clientIP(request('127.0.0.1', '203.0.113.9')), '203.0.113.9');
  assert.equal(ipTrust.clientIP(request('::1', '2001:db8::9')), '2001:db8::9');
  assert.equal(
    ipTrust.clientIP(request('::ffff:127.0.0.1', '198.51.100.8')),
    '198.51.100.8',
  );
});

test('untrusted or malformed forwarded values never override the TCP peer', () => {
  assert.equal(ipTrust.clientIP(request('192.0.2.10', '203.0.113.9')), '192.0.2.10');
  assert.equal(ipTrust.clientIP(request('127.0.0.1', 'not-an-ip')), '127.0.0.1');
  assert.equal(ipTrust.clientIP(request('::ffff:192.0.2.10', '203.0.113.9')), '192.0.2.10');
});
