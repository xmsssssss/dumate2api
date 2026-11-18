// 真实百度登录代理冒烟测试。需要本机 Chrome 和可访问百度的 HTTP 代理：
//   $env:DUMATE_PROXY='http://127.0.0.1:7897'
//   node test/manual/login-proxy-browser-smoke.js
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { chromium } = require('playwright-core');
const proxy = require('../../src/login-web-proxy');

const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';

async function main() {
  const started = proxy.start({ name: '真实浏览器冒烟测试' });
  const server = http.createServer((req, res) => {
    const pathname = String(req.url || '').split('?')[0];
    if (pathname.startsWith(proxy.LOGIN_PROXY_PREFIX)) {
      if (req.method === 'OPTIONS') return proxy.handleOptions(req, res);
      const status = pathname.match(
        /^\/api\/admin\/web-accounts\/login\/proxy\/([^/]+)\/_status\/?$/,
      );
      if (status && req.method === 'GET') {
        return proxy.sendStatus(req, res, decodeURIComponent(status[1]));
      }
      return proxy.handleProxy(req, res, pathname);
    }
    if (pathname === '/favicon.ico') {
      res.writeHead(204);
      return res.end();
    }
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('not found');
  });

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });

  const port = server.address().port;
  const browser = await chromium.launch({
    executablePath: CHROME,
    headless: true,
  });
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  const observed = [];
  const failed = [];
  const responseFailures = [];
  const consoleErrors = [];
  const pageErrors = [];

  page.on('response', async (response) => {
    const url = response.url();
    const item = {
      status: response.status(),
      url,
      contentType: response.headers()['content-type'] || '',
    };
    if (response.status() >= 400) responseFailures.push(item);
    if (!/baidu|passport|xlab|nsclick|hm\.baidu/i.test(url)) return;
    observed.push(item);
    if (response.status() >= 400) failed.push(item);
  });
  page.on('requestfailed', (request) => {
    failed.push({
      status: 'requestfailed',
      url: request.url(),
      error: request.failure() ? request.failure().errorText : '',
      method: request.method(),
      resourceType: request.resourceType(),
    });
  });
  page.on('console', (message) => {
    if (message.type() === 'error') {
      const location = message.location();
      consoleErrors.push({
        text: message.text(),
        url: location.url || '',
        lineNumber: location.lineNumber,
        columnNumber: location.columnNumber,
      });
    }
  });
  page.on('pageerror', (error) => pageErrors.push(error.message));

  try {
    await page.goto(`http://127.0.0.1:${port}${started.login_url}`, {
      waitUntil: 'domcontentloaded',
      timeout: 30000,
    });
    await page.waitForTimeout(5000);

    const title = await page.title();
    const frames = page.frames().map((frame) => frame.url());
    const smsTab = page.getByText('短信登录', { exact: true }).first();
    if (await smsTab.count()) {
      await smsTab.click();
      await page.waitForTimeout(3000);
    } else {
      const baiduTab = page.getByText('百度账号', { exact: true }).first();
      if (await baiduTab.count()) {
        await baiduTab.click();
        await page.waitForTimeout(3000);
      }
    }

    const phoneInput = page.getByPlaceholder('手机号', { exact: true }).first();
    await phoneInput.waitFor({ state: 'visible', timeout: 10000 });
    await phoneInput.fill('19900000000');

    const agreement = page.locator('input[type="checkbox"]').first();
    if (await agreement.count() && !(await agreement.isChecked())) {
      await agreement.check({ force: true });
    }

    const smsResponse = page.waitForResponse(
      (response) => /getphonestatus/i.test(response.url()),
      { timeout: 20000 },
    ).catch(() => null);
    await page.getByText('发送验证码', { exact: true }).first().click();
    await smsResponse;
    await page.waitForTimeout(2000);

    const loginPage = observed.filter((x) => /login\.bce\.baidu\.com/i.test(x.url));
    const jsonp = observed.filter((x) => /getphonestatus/i.test(x.url));
    const telemetry = observed.filter((x) => /hm\.baidu|nsclick\.baidu/i.test(x.url));
    const screenshot = path.join(os.tmpdir(), 'dumate2api-login-proxy-smoke.png');
    await page.screenshot({ path: screenshot, fullPage: true });

    console.log(JSON.stringify({
      title,
      login_page: loginPage,
      getphonestatus: jsonp,
      telemetry,
      failed,
      response_failures: responseFailures,
      console_errors: consoleErrors,
      page_errors: pageErrors,
      frames,
      observed_count: observed.length,
      screenshot,
    }, null, 2));

    if (!loginPage.some((x) => x.status === 200)) {
      throw new Error('登录页没有返回 200');
    }
    if (!jsonp.some((x) => x.status === 200 && /javascript/i.test(x.contentType))) {
      throw new Error('getphonestatus 没有返回可执行的 200 JavaScript 响应');
    }
    if (failed.length) {
      throw new Error(`登录链路仍有失败请求：${JSON.stringify(failed)}`);
    }
    if (responseFailures.length) {
      throw new Error(`登录链路仍有 HTTP 错误：${JSON.stringify(responseFailures)}`);
    }
  } finally {
    await browser.close();
    await new Promise((resolve) => server.close(resolve));
    proxy.cancel(started.session_id);
  }
}

main().catch((err) => {
  console.error(err.stack || err.message);
  process.exitCode = 1;
});
