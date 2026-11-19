'use strict';

const http = require('http');

function check(port, path) {
  return new Promise((resolve, reject) => {
    const req = http.get({
      hostname: '127.0.0.1',
      port,
      path,
      timeout: 3000,
    }, (res) => {
      res.resume();
      if (res.statusCode >= 200 && res.statusCode < 300) resolve();
      else reject(new Error(`${path} returned ${res.statusCode}`));
    });
    req.on('timeout', () => req.destroy(new Error(`${path} timed out`)));
    req.on('error', reject);
  });
}

Promise.all([
  check(Number(process.env.DUMATE_ADMIN_PORT || 9080), '/health'),
  check(Number(process.env.DUMATE_ADMIN_PORT || 9080), '/api/admin/healthz'),
]).catch((error) => {
  console.error(error.message);
  process.exit(1);
});
