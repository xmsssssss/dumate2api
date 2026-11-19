const test = require('node:test');
const assert = require('node:assert/strict');
const { createZip, crc32 } = require('../../src/zip-store');

test('zip-store creates a valid empty zip', () => {
  const zip = createZip([], { now: new Date('2026-01-02T03:04:06') });
  assert.equal(zip.readUInt32LE(0), 0x06054b50);
  assert.equal(zip.length, 22);
});

test('zip-store writes stored files and crc32', () => {
  const data = Buffer.from('Write-Host helper');
  const zip = createZip([{ name: 'dumate-login-helper.ps1', data }], {
    now: new Date('2026-01-02T03:04:06'),
  });
  assert.equal(zip.readUInt32LE(0), 0x04034b50);
  assert.equal(zip.readUInt32LE(14), crc32(data));
  assert.match(zip.toString('utf8'), /dumate-login-helper\.ps1/);
  assert.match(zip.toString('utf8'), /Write-Host helper/);
});
