import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { gzipSync } from 'node:zlib';
import { build } from 'vite';
import { chromium } from '@playwright/test';

const directory = await mkdtemp(join(tmpdir(), 'if-json-schema-'));
const bundles = new Map();
let server;
let browser;
try {
  for (const engine of ['cfworker', 'ajv']) {
    const entry = new URL(`./${engine}-entry.mjs`, import.meta.url).pathname;
    // Both candidates are included explicitly: ordinary app builds cannot
    // exercise a dev-only dependency that production code never imports.
    for (const target of ['web', 'tauri', 'cli']) {
      const outDir = join(directory, `${engine}-${target}`);
      await build({
        configFile: false, publicDir: false, logLevel: 'error',
        define: { 'process.env.INFERENCE_LENS_TARGET': JSON.stringify(target === 'tauri' ? 'tauri' : 'web') },
        build: {
          outDir, minify: true, sourcemap: false, target: target === 'cli' ? 'node22' : 'es2021',
          lib: { entry, formats: ['es'], fileName: () => 'probe.mjs' },
        },
      });
      const file = join(outDir, 'probe.mjs');
      const code = await readFile(file);
      console.log(JSON.stringify({ engine, target, bytes: code.length, gzipBytes: gzipSync(code).length }));
      if (target === 'cli') {
        const { run } = await import(pathToFileURL(file).href);
        assert.deepEqual(run(), { engine, passed: 42, draft7Differences: engine === 'ajv' ? 1 : 0 });
      } else bundles.set(`/${engine}-${target}.mjs`, code);
    }
  }
  server = createServer((request, response) => {
    const url = new URL(request.url, 'http://localhost');
    if (bundles.has(url.pathname)) {
      response.setHeader('Content-Type', 'text/javascript');
      response.end(bundles.get(url.pathname));
      return;
    }
    const strict = url.searchParams.get('strict') === 'true';
    response.setHeader('Content-Security-Policy', `default-src 'none'; script-src 'self'${strict ? '' : " 'unsafe-eval'"}`);
    response.setHeader('Content-Type', 'text/html');
    response.end('<!doctype html><title>JSON Schema engine probe</title><pre id="result"></pre><script type="module" src="/runner.mjs"></script>');
  });
  bundles.set('/runner.mjs', Buffer.from(`
    const params = new URLSearchParams(location.search);
    const { run } = await import('/' + params.get('engine') + '-' + params.get('target') + '.mjs');
    let result;
    try { result = run(); } catch (error) { result = { errorName: error.name }; }
    document.querySelector('#result').textContent = JSON.stringify(result);
  `));
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  browser = await chromium.launch({ headless: true });
  for (const target of ['web', 'tauri']) {
    for (const engine of ['cfworker', 'ajv']) {
      for (const strict of [false, true]) {
        const page = await browser.newPage();
        await page.goto(`http://127.0.0.1:${server.address().port}/?engine=${engine}&target=${target}&strict=${strict}`);
        await page.locator('#result').filter({ hasText: /./ }).waitFor();
        const result = JSON.parse(await page.locator('#result').textContent());
        assert.deepEqual(result, strict && engine === 'ajv' ? { errorName: 'EvalError' } : { engine, passed: 42, draft7Differences: engine === 'ajv' ? 1 : 0 });
        console.log(JSON.stringify({ target, engine, strictCsp: strict, result }));
        await page.close();
      }
    }
  }
} finally {
  await browser?.close();
  if (server) await new Promise((resolve) => server.close(resolve));
  await rm(directory, { recursive: true, force: true });
}
