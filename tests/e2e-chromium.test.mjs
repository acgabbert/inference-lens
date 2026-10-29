import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { CHROMIUM_OVERRIDE_ENV, resolveChromium } from "../scripts/e2e-chromium.mjs";

const executable = path.join("chrome-linux64", "chrome");

async function browsersFixture(t, revisions) {
  const root = await mkdtemp(path.join(os.tmpdir(), "inference-lens-browsers-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  for (const revision of revisions) {
    const file = path.join(root, `chromium-${revision}`, executable);
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, "");
    await chmod(file, 0o755);
  }
  return {
    pinned: path.join(root, "chromium-1208", executable),
    installed: (revision) => path.join(root, `chromium-${revision}`, executable),
  };
}

function failingInstall() {
  const calls = [];
  return {
    calls,
    install: async () => {
      calls.push("install");
      throw new Error("Download failed: server returned code 403");
    },
  };
}

test("uses the pinned browser without installing when it is present", async (t) => {
  const browsers = await browsersFixture(t, [1208, 1243]);
  const { calls, install } = failingInstall();
  const result = await resolveChromium({ env: {}, pinnedExecutable: browsers.pinned, installPinned: install });
  assert.deepEqual(result, { executablePath: null, notice: null });
  assert.deepEqual(calls, []);
});

test("uses the pinned browser once it installs", async (t) => {
  const browsers = await browsersFixture(t, [1243]);
  const result = await resolveChromium({
    env: {},
    pinnedExecutable: browsers.pinned,
    installPinned: async () => {},
  });
  assert.deepEqual(result, { executablePath: null, notice: null });
});

test("falls back to the newest installed Chromium when the pinned build cannot install", async (t) => {
  const browsers = await browsersFixture(t, [1190, 1243, 1220]);
  const result = await resolveChromium({
    env: {},
    pinnedExecutable: browsers.pinned,
    installPinned: failingInstall().install,
  });
  assert.equal(result.executablePath, browsers.installed(1243));
  assert.match(result.notice, /chromium-1243/);
  assert.match(result.notice, /chromium-1208/);
  assert.match(result.notice, /403/);
});

test("never falls back in CI", async (t) => {
  const browsers = await browsersFixture(t, [1243]);
  await assert.rejects(
    resolveChromium({
      env: { CI: "true" },
      pinnedExecutable: browsers.pinned,
      installPinned: failingInstall().install,
    }),
    /403/,
  );
});

test("reports the install failure when no other Chromium is installed", async (t) => {
  const browsers = await browsersFixture(t, []);
  await assert.rejects(
    resolveChromium({
      env: {},
      pinnedExecutable: browsers.pinned,
      installPinned: failingInstall().install,
    }),
    /403/,
  );
});

test("an explicit override skips the pinned check and install", async (t) => {
  const browsers = await browsersFixture(t, [1243]);
  const { calls, install } = failingInstall();
  const result = await resolveChromium({
    env: { CI: "true", [CHROMIUM_OVERRIDE_ENV]: browsers.installed(1243) },
    pinnedExecutable: browsers.pinned,
    installPinned: install,
  });
  assert.equal(result.executablePath, browsers.installed(1243));
  assert.match(result.notice, new RegExp(CHROMIUM_OVERRIDE_ENV));
  assert.deepEqual(calls, []);
});

test("an override that is not an executable fails instead of falling back", async (t) => {
  const browsers = await browsersFixture(t, [1243]);
  await assert.rejects(
    resolveChromium({
      env: { [CHROMIUM_OVERRIDE_ENV]: path.join(path.dirname(browsers.pinned), "missing") },
      pinnedExecutable: browsers.pinned,
      installPinned: failingInstall().install,
    }),
    new RegExp(CHROMIUM_OVERRIDE_ENV),
  );
});
