import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import { gzipSync } from 'node:zlib';
import { build } from 'vite';
import { chromium, webkit } from '@playwright/test';
import { run } from './runtime-entry.mjs';
import { workloads } from './workloads.mjs';
import { loadOfficial } from './load-official.mjs';

const { tasks: official, revision } = await loadOfficial();
const tasks = [...workloads(), ...official];
const expected = run(tasks);
for (let i = 0; i < tasks.length; i++) {
  assert.equal(expected[i].status, tasks[i].expected, tasks[i].name);
  if (tasks[i].code) assert.equal(expected[i].code, tasks[i].code, tasks[i].name);
}
const digest = createHash('sha256').update(JSON.stringify(expected)).digest('hex');
console.log(JSON.stringify({ runtime: 'node-source', cases: tasks.length, digest, revision }));
for (let i = 42; i < workloads().length; i++) console.log(JSON.stringify({ name: tasks[i].name, result: expected[i] }));
const directory = await mkdtemp(join(tmpdir(), 'if-metered-schema-'));
const bundles = new Map();
let server;
try {
  for (const target of ['web', 'tauri', 'cli']) {
    const outDir = join(directory, target);
    await build({
      configFile: false, publicDir: false, logLevel: 'error',
      define: { 'process.env.INFERENCE_LENS_TARGET': JSON.stringify(target === 'tauri' ? 'tauri' : 'web') },
      build: {
        outDir, target: target === 'cli' ? 'node22' : 'es2021', minify: true, sourcemap: false,
        lib: { entry: new URL('./runtime-entry.mjs', import.meta.url).pathname, formats: ['es'], fileName: () => 'probe.mjs' },
      },
    });
    const file = join(outDir, 'probe.mjs');
    const code = await readFile(file);
    console.log(JSON.stringify({ target, bytes: code.length, gzipBytes: gzipSync(code).length }));
    if (target === 'cli') {
      const bundled = await import(pathToFileURL(file).href);
      assert.deepEqual(bundled.run(tasks), expected);
      console.log(JSON.stringify({ runtime: 'node-bundle', cases: tasks.length, digest }));
    } else bundles.set(`/${target}.mjs`, code);
  }
  bundles.set('/runner.mjs', Buffer.from(`
    const { run } = await import('/' + new URLSearchParams(location.search).get('target') + '.mjs');
    globalThis.runSpike = run;
    document.querySelector('#ready').textContent = 'ready';
  `));
  server = createServer((request, response) => {
    const path = new URL(request.url, 'http://localhost').pathname;
    response.setHeader('Content-Security-Policy', "default-src 'none'; script-src 'self'");
    response.setHeader('Content-Type', bundles.has(path) ? 'text/javascript' : 'text/html');
    response.end(bundles.get(path) ?? '<!doctype html><title>Metered JSON Schema probe</title><p id="ready"></p><script type="module" src="/runner.mjs"></script>');
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  for (const [name, browserType] of [['chromium', chromium], ['webkit', webkit]]) {
    // An explicit executable can exercise a locally available WebKit build.
    // Missing WebKit is a reported gap, never silently treated as a pass.
    let browser;
    try {
      browser = await browserType.launch({ headless: true, ...(name === 'webkit' && process.env.IF_METERED_WEBKIT_EXECUTABLE ? { executablePath: process.env.IF_METERED_WEBKIT_EXECUTABLE } : {}) });
    } catch (error) {
      if (name !== 'webkit' || !String(error).includes("Executable doesn't exist")) throw error;
      console.log(JSON.stringify({ runtime: name, status: 'unavailable', reason: 'Playwright WebKit executable is not installed' }));
      continue;
    }
    try {
      for (const target of ['web', 'tauri']) {
        const page = await browser.newPage();
        await page.goto(`http://127.0.0.1:${server.address().port}/?target=${target}`);
        await page.locator('#ready').filter({ hasText: 'ready' }).waitFor();
        // Send JSON text: object-argument transport can lose own __proto__ keys.
        const inputJson = JSON.stringify(tasks);
        const actual = await page.evaluate((input) => globalThis.runSpike(JSON.parse(input)), inputJson);
        for (let i = 0; i < tasks.length; i++) assert.deepEqual(actual[i], expected[i], `${name}/${target}: ${tasks[i].name}`);
        // A second run in the same page must not gain a warm-cache advantage.
        const again = await page.evaluate((input) => globalThis.runSpike(JSON.parse(input)), inputJson);
        assert.deepEqual(again, expected, `${name}/${target}: repeated evaluation changed accounting`);
        console.log(JSON.stringify({ runtime: name, browserVersion: browser.version(), target, cases: tasks.length, strictCsp: true, repeated: true, digest }));
        await page.close();
      }
    } finally { await browser.close(); }
  }
} finally {
  if (server) await new Promise((resolve) => server.close(resolve));
  await rm(directory, { recursive: true, force: true });
}
