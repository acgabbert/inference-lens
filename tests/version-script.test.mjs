import assert from "node:assert/strict";
import { cp, mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  bumpProjectVersion,
  checkProjectVersion,
  parseReleaseTag,
} from "../scripts/version.mjs";

const repositoryRoot = path.resolve(import.meta.dirname, "..");
const versionFiles = [
  "package.json",
  "package-lock.json",
  "src-tauri/Cargo.toml",
  "src-tauri/Cargo.lock",
  "src-tauri/tauri.conf.json",
];

async function versionFixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), "inference-lens-version-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(path.join(root, "src-tauri"));
  await Promise.all(
    versionFiles.map(async (relativePath) => {
      await cp(
        path.join(repositoryRoot, relativePath),
        path.join(root, relativePath),
      );
    }),
  );
  return root;
}

function nextPatchVersion(version) {
  const [major, minor, patch] = version.split(".");
  return `${major}.${minor}.${Number(patch) + 1}`;
}

test("accepts stable and prerelease release tags", () => {
  assert.deepEqual(parseReleaseTag("v0.1.0"), {
    baseVersion: "0.1.0",
    prerelease: null,
  });
  assert.deepEqual(parseReleaseTag("v12.34.56-rc.1"), {
    baseVersion: "12.34.56",
    prerelease: "rc.1",
  });
  assert.deepEqual(parseReleaseTag("v1.0.0-alpha-beta.2"), {
    baseVersion: "1.0.0",
    prerelease: "alpha-beta.2",
  });
});

test("rejects tags that could otherwise publish an invalid latest image", () => {
  for (const tag of [
    "0.1.0",
    "vbanana",
    "v1.2",
    "v01.2.3",
    "v1.2.3-",
    "v1.2.3-01",
    "v1.2.3+build.1",
  ]) {
    assert.throws(() => parseReleaseTag(tag), undefined, tag);
  }
});

test("checks every project version location and release-tag base", async (t) => {
  const root = await versionFixture(t);
  const version = await checkProjectVersion({ root });
  const nextVersion = nextPatchVersion(version);
  assert.match(version, /^\d+\.\d+\.\d+$/);
  assert.equal(
    await checkProjectVersion({ root, tag: `v${version}-rc.1` }),
    version,
  );
  await assert.rejects(
    checkProjectVersion({ root, tag: `v${nextVersion}` }),
    new RegExp(`tag v${nextVersion.replaceAll(".", "\\.")}.*project manifests use ${version.replaceAll(".", "\\.")}`),
  );

  const lockPath = path.join(root, "package-lock.json");
  const packageLock = JSON.parse(await readFile(lockPath, "utf8"));
  packageLock.packages[""].version = "0.0.9";
  await writeFile(lockPath, `${JSON.stringify(packageLock, null, 2)}\n`);
  await assert.rejects(
    checkProjectVersion({ root }),
    /Project versions do not agree/,
  );
});

test("bumps manifests and generated lockfile metadata together", async (t) => {
  const root = await versionFixture(t);
  const previousVersion = await checkProjectVersion({ root });
  const version = nextPatchVersion(previousVersion);
  assert.deepEqual(await bumpProjectVersion(version, { root }), {
    previousVersion,
    version,
  });
  assert.equal(await checkProjectVersion({ root }), version);
  assert.equal(
    await checkProjectVersion({ root, tag: `v${version}-rc.1` }),
    version,
  );
  await assert.rejects(
    bumpProjectVersion(version, { root }),
    /must be greater than current version/,
  );
});
