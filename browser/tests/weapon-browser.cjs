/* Optional browser/Worker parity check. Requires Playwright and installed Edge.
 * node browser/tests/weapon-browser.cjs [directory containing node_modules]
 * Serves only the synthetic harness and weapon JavaScript modules, no backend.
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const {chromium} = require(require.resolve('playwright', {paths: [process.argv[2] || process.cwd()]}));
const core = path.resolve(__dirname, '../core');
const oracle = JSON.parse(fs.readFileSync(path.join(__dirname, 'weapon-oracle.json'), 'utf8'));

function equivalent(actual, expected, location = '') {
  if (typeof expected === 'number') {
    const tolerance = /score$/.test(location) ? 1e-9 : 2e-10 + 2e-11 * Math.abs(expected);
    assert.ok(Number.isFinite(actual) && Math.abs(actual - expected) <= tolerance, `${location}: ${actual} != ${expected}`);
  } else if (Array.isArray(expected)) {
    assert.equal(actual.length, expected.length, location);
    expected.forEach((v, i) => equivalent(actual[i], v, `${location}[${i}]`));
  } else if (expected && typeof expected === 'object') {
    assert.deepEqual(Object.keys(actual).sort(), Object.keys(expected).sort(), location);
    for (const key of Object.keys(expected)) equivalent(actual[key], expected[key], `${location}.${key}`);
  } else assert.equal(actual, expected, location);
}

(async () => {
  const requests = [];
  const server = http.createServer((request, response) => {
    requests.push({method: request.method, path: request.url});
    if (request.method === 'GET' && request.url === '/') {
      response.setHeader('Content-Type', 'text/html; charset=utf-8');
      return response.end('<!doctype html><meta charset="utf-8"><title>Weapon Worker parity</title>');
    }
    const name = /^\/core\/(weapon-[a-z-]+\.js)$/.exec(request.url);
    if (request.method !== 'GET' || !name) {
      response.writeHead(404); return response.end();
    }
    response.setHeader('Content-Type', 'text/javascript; charset=utf-8');
    fs.createReadStream(path.join(core, name[1])).pipe(response);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  let browser;
  try {
    browser = await chromium.launch({channel: 'msedge', headless: true});
    const page = await browser.newPage(), errors = [];
    page.on('pageerror', e => errors.push(e.message));
    await page.goto(`http://127.0.0.1:${server.address().port}/`);
    const output = await page.evaluate(async inputs => {
      const source = `import {scoreWeaponRecord} from ${JSON.stringify(location.origin + '/core/weapon-scoring.js')};
        import {clearWeaponProfileCache} from ${JSON.stringify(location.origin + '/core/weapon-profile.js')};
        onmessage = ({data}) => {
          const before = performance.now();
          const output = data.map(input => {
            try { return {expected: scoreWeaponRecord(input)}; }
            catch (error) { return {error: error.message}; }
          });
          clearWeaponProfileCache();
          const cold = performance.now();
          const sample = scoreWeaponRecord({N:1000,K6:55,KU:15,profile:'12 5 1'});
          postMessage({output,elapsedMs:performance.now()-before,coldProfileMs:performance.now()-cold,
            worker:typeof window==='undefined',sample});
        };`;
      const url = URL.createObjectURL(new Blob([source], {type: 'text/javascript'}));
      const worker = new Worker(url, {type: 'module'});
      try {
        return await new Promise((resolve, reject) => {
          worker.onmessage = event => resolve(event.data);
          worker.onerror = event => reject(new Error(event.message));
          worker.postMessage(inputs);
        });
      } finally { worker.terminate(); URL.revokeObjectURL(url); }
    }, oracle.records.map(row => row.input));
    output.output.forEach((actual, i) => {
      const {input, ...expected} = oracle.records[i];
      equivalent(actual, expected, `record[${i}]`);
    });
    assert.equal(output.worker, true);
    assert.deepEqual(errors, []);
    assert.ok(requests.every(request => request.method === 'GET'));
    console.log(JSON.stringify({records: oracle.records.length, browser: await browser.version(), worker: true,
      elapsedMs: output.elapsedMs, coldProfileMs: output.coldProfileMs, requests, pageErrors: errors}, null, 2));
  } finally {
    if (browser) await browser.close();
    await new Promise(resolve => server.close(resolve));
  }
})().catch(error => {console.error(error); process.exitCode = 1;});
