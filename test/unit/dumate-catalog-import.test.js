// test/unit/dumate-catalog-import.test.js - 浏览器上传 DuMate 模型清单
const { test, after } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'dumate-catalog-import-'));
process.env.DUMATE_ADMIN_DATA = TMP;
process.env.DUMATE_USER_DATA_DIR = path.join(TMP, 'appdata');

const catalog = require('../../src/dumate-catalog');
const { routes } = require('../../src/admin/routes/models');

const ACCOUNT = 'acct-upload';
const DESKTOP = path.join(
  process.env.DUMATE_USER_DATA_DIR,
  'qianfan_desk_xdg',
  ACCOUNT,
  'config',
  'opencode',
  'opencode.json',
);

function writeDesktop(models) {
  fs.mkdirSync(path.dirname(DESKTOP), { recursive: true });
  fs.writeFileSync(path.join(process.env.DUMATE_USER_DATA_DIR, 'auth.json'), JSON.stringify({
    activeProfileId: 'p1',
    accountProfiles: [{ profileId: 'p1', bceAccountId: ACCOUNT }],
  }), 'utf8');
  fs.writeFileSync(DESKTOP, JSON.stringify({
    provider: { QianfanPersonalQuota: { models } },
  }), 'utf8');
}

function dumateConfig(models) {
  return JSON.stringify({ provider: { QianfanPersonalQuota: { models } } });
}

function fakeRes() {
  return {
    statusCode: null,
    body: null,
    writeHead(code) { this.statusCode = code; },
    end(body) { this.body = body; },
  };
}

function invokeCatalogImport(body) {
  const route = routes.find((r) => r.method === 'POST' && r.path === '/catalog/import');
  assert.ok(route, 'POST /catalog/import 应已注册');
  const res = fakeRes();
  route.handler({ res, body, user: { username: 'admin' } });
  return { status: res.statusCode, body: JSON.parse(res.body) };
}

test('上传配置：只落筛选后的模型元数据，并优先于桌面自动同步', async (t) => {
  await t.test('正确 DuMate 配置可导入，敏感字段不落盘', () => {
    const imported = catalog.importFromConfig(dumateConfig({
      'model-text': {
        id: 'model-text',
        limit: { context: 1000000, output: 384000 },
        tool_call: true,
        modalities: { input: ['text', 'image'], output: ['text'] },
        apiKey: 'SECRET-KEY',
        endpoint: 'http://127.0.0.1:11434',
        headers: { Cookie: 'SECRET-COOKIE' },
      },
      'kimi-k31': {
        id: 'kimi-k31',
        limit: { context: 1048576, output: 1048576 },
        modalities: { input: ['text'] },
      },
      'text-embedding-3': {
        id: 'text-embedding-3',
        limit: { context: 8192, output: 8192 },
      },
    }));

    assert.equal(imported.count, 2);
    assert.equal(imported.inputCount, 3);
    assert.equal(imported.excluded, 1);
    assert.equal(imported.origin, 'upload');
    assert.match(imported.asOf, /^\d{4}-\d{2}-\d{2}$/);

    const raw = fs.readFileSync(catalog.filePath(), 'utf8');
    const snap = JSON.parse(raw);
    assert.equal(snap.origin, 'upload');
    assert.deepEqual(Object.keys(snap.models).sort(), ['kimi-k31', 'model-text']);
    assert.doesNotMatch(raw, /SECRET-KEY|SECRET-COOKIE|127\.0\.0\.1|apiKey|headers|Cookie|endpoint/);
    const allowed = ['attachment', 'id', 'limit', 'modalities', 'name', 'reasoning', 'tool_call'];
    for (const meta of Object.values(snap.models)) {
      assert.ok(Object.keys(meta).every((key) => allowed.includes(key)));
      assert.ok(meta.id);
      assert.ok(meta.name);
      assert.ok(meta.limit);
      assert.ok(meta.modalities);
    }
  });

  await t.test('管理接口返回摘要，错误配置返回 400', () => {
    const config = dumateConfig({
      'model-text': {
        id: 'model-text',
        limit: { context: 1000000, output: 384000 },
        modalities: { input: ['text'] },
        apiKey: 'ROUTE-SECRET-KEY',
      },
      'route-alias': {
        id: 'model-text',
        limit: { context: 1000000, output: 384000 },
        modalities: { input: ['text'] },
      },
      'route-kimi': {
        id: 'route-kimi',
        limit: { context: 262144, output: 65536 },
        modalities: { input: ['text', 'image'] },
      },
    });

    const imported = invokeCatalogImport({ content: config, filename: '../opencode.json' });
    assert.equal(imported.status, 200);
    assert.equal(imported.body.ok, true);
    assert.equal(imported.body.origin, 'upload');
    assert.equal(imported.body.count, 2);
    assert.equal(imported.body.inputCount, 3);
    assert.equal(imported.body.excluded, 1);

    const snapshot = fs.readFileSync(catalog.filePath(), 'utf8');
    const audit = fs.readFileSync(path.join(TMP, 'admin-audit.jsonl'), 'utf8');
    assert.doesNotMatch(snapshot, /ROUTE-SECRET-KEY/);
    assert.doesNotMatch(audit, /ROUTE-SECRET-KEY/);
    assert.match(audit, /dumate_catalog_import/);
    assert.match(audit, /opencode\.json/);

    const rejects = (body, code) => {
      const r = invokeCatalogImport(body);
      assert.equal(r.status, 400);
      assert.equal(r.body.code, code);
    };
    rejects({ content: '  ' }, 'empty_config');
    rejects({ content: '{' }, 'invalid_json');
    rejects({
      content: JSON.stringify({
        provider: {
          opencode: {
            models: { 'gpt-4o': { limit: { context: 128000, output: 8192 } } },
          },
        },
      }),
    }, 'not_dumate_config');
  });

  await t.test('重新加载后来源是 snapshot/upload', () => {
    catalog.resetCache();
    const cat = catalog.load();
    assert.equal(cat.source, 'snapshot');
    assert.equal(cat.origin, 'upload');
    assert.equal(cat.snapshotAvailable, true);
    assert.equal(Object.keys(cat.models).length, 2);
  });

  await t.test('桌面配置变化不能覆盖上传快照', () => {
    writeDesktop({
      'desktop-only': {
        id: 'desktop-only',
        limit: { context: 128000, output: 8192 },
        modalities: { input: ['text'] },
      },
    });
    catalog.resetCache();
    const cat = catalog.load();
    assert.equal(cat.source, 'snapshot');
    assert.equal(cat.origin, 'upload');
    assert.equal(cat.sourceAvailable, true);
    assert.equal(cat.models['desktop-only'], undefined);
    assert.ok(cat.models['model-text']);
    assert.equal(JSON.parse(fs.readFileSync(catalog.filePath(), 'utf8')).origin, 'upload');
  });

  await t.test('独立 OpenCode 配置与无效内容被拒绝', () => {
    const rejects = (content, code) => {
      assert.throws(
        () => catalog.importFromConfig(content),
        (e) => e && e.code === code,
      );
    };
    rejects('', 'empty_config');
    rejects('{', 'invalid_json');
    rejects(JSON.stringify({
      provider: {
        opencode: {
          models: { 'gpt-4o': { limit: { context: 128000, output: 8192 } } },
        },
      },
    }), 'not_dumate_config');
    rejects(
      dumateConfig({
        'model-text': { id: 'model-text', limit: { context: 1000, output: 100 } },
      }) + ' '.repeat(catalog.MAX_IMPORT_BYTES),
      'config_too_large',
    );
  });

  await t.test('删掉上传快照后仍可降级到 22 条内置默认', () => {
    fs.rmSync(catalog.filePath(), { force: true });
    fs.rmSync(path.join(process.env.DUMATE_USER_DATA_DIR, 'qianfan_desk_xdg'), {
      recursive: true,
      force: true,
    });
    fs.rmSync(path.join(process.env.DUMATE_USER_DATA_DIR, 'auth.json'), { force: true });
    catalog.resetCache();
    const cat = catalog.load();
    assert.equal(cat.source, 'default');
    assert.equal(cat.origin, 'default');
    assert.equal(Object.keys(cat.models).length, 22);
  });
});

after(() => {
  fs.rmSync(TMP, { recursive: true, force: true });
});
