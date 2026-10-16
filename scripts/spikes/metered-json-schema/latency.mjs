import { createServer } from 'node:http';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir, cpus, platform, release } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import assert from 'node:assert/strict';
import { build } from 'vite';
import { chromium, webkit } from '@playwright/test';
const core = process.argv.includes('--core');
const entry = new URL(core ? '../../json-schema-latency-entry.ts' : './latency-entry.mjs', import.meta.url);
const { measure } = await import(entry.href);

const native = process.argv.includes('--native');
const outputIndex = process.argv.indexOf('--output');
if (outputIndex !== -1 && !process.argv[outputIndex + 1]) throw new Error('--output needs a filename');
const report = { engine: core ? 'core' : 'spike', date: new Date().toISOString(), host: { platform: platform(), release: release(), cpu: cpus()[0]?.model }, runtimes: [] };
let reference;
function record(runtime, data) {
  if (data.results) {
    const accounting = data.results.map(({ firstMs, medianMs, p95Ms, maxMs, ...result }) => {
      for (const time of [firstMs, medianMs, p95Ms, maxMs]) assert.ok(Number.isFinite(time) && time >= 0);
      return result;
    });
    if (reference) assert.deepEqual(accounting, reference, `${runtime}: accounting differs from Node`);
    else reference = accounting;
  }
  report.runtimes.push({ runtime, ...data });
  console.log(JSON.stringify({ runtime, ...data }));
}
record('node', { version: process.version, ...measure() });
const directory = await mkdtemp(join(tmpdir(), 'if-schema-latency-'));
let server;
let child;
try {
  await build({ configFile: false, publicDir: false, logLevel: 'error', build: {
    outDir: directory, target: 'es2021', minify: true,
    lib: { entry: entry.pathname, formats: ['es'], fileName: () => 'probe.mjs' },
  } });
  const bundle = await readFile(join(directory, 'probe.mjs'));
  let completeNative;
  const nativeResult = new Promise((resolve) => { completeNative = resolve; });
  const runner = `import { measure } from '/probe.mjs';
    globalThis.measureLatency = measure;
    document.querySelector('p').textContent = 'ready';
    if (location.pathname === '/native') {
      setTimeout(async () => {
        try {
          if (!globalThis.__TAURI_INTERNALS__) throw new Error('Not running in Tauri');
          const result = { userAgent: navigator.userAgent, ...measure() };
          document.querySelector('p').textContent = 'Complete';
          await fetch('/result', { method: 'POST', body: JSON.stringify(result) });
        } catch (error) { await fetch('/result', { method: 'POST', body: JSON.stringify({ error: String(error) }) }); }
      }, 100);
    }`;
  server = createServer(async (request, response) => {
    const path = new URL(request.url, 'http://localhost').pathname;
    response.setHeader('Content-Security-Policy', "default-src 'none'; script-src 'self'; connect-src 'self'");
    if (path === '/result' && request.method === 'POST') {
      let body = '';
      for await (const chunk of request) {
        body += chunk;
        if (body.length > 1_000_000) { response.writeHead(413).end(); return; }
      }
      try { completeNative(JSON.parse(body)); response.end('ok'); }
      catch { response.writeHead(400).end(); }
      return;
    }
    response.setHeader('Content-Type', path.endsWith('.mjs') ? 'text/javascript' : 'text/html');
    response.end(path === '/probe.mjs' ? bundle : path === '/runner.mjs' ? runner : '<!doctype html><title>Schema latency measurements</title><p></p><script type="module" src="/runner.mjs"></script>');
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const origin = `http://127.0.0.1:${server.address().port}`;
  for (const [name, browserType] of [['chromium', chromium], ['webkit', webkit]]) {
    let browser;
    try {
      browser = await browserType.launch({ headless: true, ...(name === 'webkit' && process.env.IF_METERED_WEBKIT_EXECUTABLE ? { executablePath: process.env.IF_METERED_WEBKIT_EXECUTABLE } : {}) });
    } catch (error) {
      if (!String(error).includes("Executable doesn't exist")) throw error;
      record(name, { status: 'unavailable', reason: 'Playwright executable is not installed' });
      continue;
    }
    try {
      const page = await browser.newPage();
      await page.goto(origin);
      await page.locator('p').filter({ hasText: 'ready' }).waitFor();
      record(name, { version: browser.version(), ...await page.evaluate(() => globalThis.measureLatency()) });
    } finally { await browser.close(); }
  }
  if (native) {
    // Override only this invocation's frontend. Never edit the app config or
    // inject benchmark code into the production application's routes.
    child = spawn(process.execPath, ['node_modules/.bin/tauri', 'dev', '--no-watch', '--config', JSON.stringify({
      build: { beforeDevCommand: '', devUrl: `${origin}/native` },
      app: { windows: [{ label: 'main', title: 'Schema latency measurements', width: 640, height: 240 }] },
    })], { stdio: ['ignore', 'inherit', 'inherit'], detached: true });
    let timer;
    let onExit;
    let onError;
    try {
      const result = await Promise.race([
        nativeResult,
        new Promise((_, reject) => {
          timer = setTimeout(() => reject(new Error('Native probe timed out after 5 minutes')), 300_000);
          onExit = (code) => reject(new Error(`Native launcher exited: ${code}`));
          onError = reject;
          child.once('exit', onExit);
          child.once('error', onError);
        }),
      ]);
      if (result.error) throw new Error(result.error);
      record('native-tauri', result);
    } finally {
      clearTimeout(timer);
      child.removeListener('exit', onExit);
      child.removeListener('error', onError);
    }
  } else record('native-tauri', { status: 'not-run', reason: 'Pass --native to launch the actual Tauri host' });
} finally {
  if (child?.pid) {
    try { process.kill(-child.pid, 'SIGTERM'); } catch (error) { if (error.code !== 'ESRCH') throw error; }
  }
  if (server) await new Promise((resolve) => server.close(resolve));
  await rm(directory, { recursive: true, force: true });
  if (outputIndex !== -1) await writeFile(process.argv[outputIndex + 1], `${JSON.stringify(report, null, 2)}\n`);
}
