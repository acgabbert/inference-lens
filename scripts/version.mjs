import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const BASE_VERSION_PATTERN = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const PRERELEASE_PATTERN =
  /^(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*$/;

const VERSION_PATHS = {
  packageJson: "package.json",
  packageLock: "package-lock.json",
  cargoToml: "src-tauri/Cargo.toml",
  cargoLock: "src-tauri/Cargo.lock",
  tauriConfig: "src-tauri/tauri.conf.json",
};

export class VersionError extends Error {
  constructor(message) {
    super(message);
    this.name = "VersionError";
  }
}

function parseJson(source, fileName) {
  try {
    return JSON.parse(source);
  } catch (error) {
    throw new VersionError(`${fileName} is not valid JSON: ${error.message}`);
  }
}

function locateTomlBlock(source, headerPattern, label, predicate = () => true) {
  const headers = [...source.matchAll(headerPattern)];
  const matches = [];

  for (let index = 0; index < headers.length; index += 1) {
    const start = headers[index].index;
    const end = headers[index + 1]?.index ?? source.length;
    const block = source.slice(start, end);
    if (predicate(block)) matches.push({ start, end, block });
  }

  if (matches.length !== 1) {
    throw new VersionError(
      `Expected exactly one ${label} block, found ${matches.length}.`,
    );
  }
  return matches[0];
}

function versionInTomlBlock(block, label) {
  const matches = [...block.matchAll(/^version\s*=\s*"([^"]+)"\s*$/gm)];
  if (matches.length !== 1) {
    throw new VersionError(
      `Expected exactly one version in ${label}, found ${matches.length}.`,
    );
  }
  return matches[0][1];
}

function replaceTomlBlockVersion(source, locatedBlock, nextVersion, label) {
  const matches = [
    ...locatedBlock.block.matchAll(/^(version\s*=\s*")[^"]+("\s*)$/gm),
  ];
  if (matches.length !== 1) {
    throw new VersionError(
      `Expected exactly one version in ${label}, found ${matches.length}.`,
    );
  }
  const nextBlock = locatedBlock.block.replace(
    /^(version\s*=\s*")[^"]+("\s*)$/m,
    `$1${nextVersion}$2`,
  );
  return `${source.slice(0, locatedBlock.start)}${nextBlock}${source.slice(locatedBlock.end)}`;
}

function cargoPackageBlock(cargoToml) {
  return locateTomlBlock(cargoToml, /^\[[^\]]+\]\s*$/gm, "Cargo.toml [package]", (block) =>
    block.startsWith("[package]"),
  );
}

function cargoLockPackageBlock(cargoLock) {
  return locateTomlBlock(
    cargoLock,
    /^\[\[package\]\]\s*$/gm,
    'Cargo.lock package "inference-lens"',
    (block) => /^name\s*=\s*"inference-lens"\s*$/m.test(block),
  );
}

function assertBaseVersion(version, label = "Version") {
  const match = BASE_VERSION_PATTERN.exec(version);
  if (!match) {
    throw new VersionError(
      `${label} must be a stable semantic version such as 0.2.0.`,
    );
  }
  return match.slice(1).map((part) => BigInt(part));
}

export function parseReleaseTag(tag) {
  if (typeof tag !== "string" || !tag.startsWith("v")) {
    throw new VersionError(
      "Release tag must start with v and use semantic versioning, such as v0.2.0 or v0.2.0-rc.1.",
    );
  }

  const value = tag.slice(1);
  const separator = value.indexOf("-");
  const baseVersion = separator === -1 ? value : value.slice(0, separator);
  const prerelease = separator === -1 ? null : value.slice(separator + 1);
  assertBaseVersion(baseVersion, "Release tag base version");
  if (prerelease !== null && !PRERELEASE_PATTERN.test(prerelease)) {
    throw new VersionError(
      "Release tag prerelease identifiers must follow semantic versioning, such as rc.1.",
    );
  }
  return { baseVersion, prerelease };
}

async function loadProject(root) {
  const entries = await Promise.all(
    Object.entries(VERSION_PATHS).map(async ([key, relativePath]) => [
      key,
      await readFile(path.join(root, relativePath), "utf8"),
    ]),
  );
  const sources = Object.fromEntries(entries);
  const packageJson = parseJson(sources.packageJson, VERSION_PATHS.packageJson);
  const packageLock = parseJson(sources.packageLock, VERSION_PATHS.packageLock);
  const tauriConfig = parseJson(sources.tauriConfig, VERSION_PATHS.tauriConfig);
  const cargoPackage = cargoPackageBlock(sources.cargoToml);
  const cargoLockPackage = cargoLockPackageBlock(sources.cargoLock);

  const versions = new Map([
    [VERSION_PATHS.packageJson, packageJson.version],
    [`${VERSION_PATHS.packageLock} root`, packageLock.version],
    [
      `${VERSION_PATHS.packageLock} workspace`,
      packageLock.packages?.[""]?.version,
    ],
    [VERSION_PATHS.cargoToml, versionInTomlBlock(cargoPackage.block, "Cargo.toml [package]")],
    [
      `${VERSION_PATHS.cargoLock} inference-lens package`,
      versionInTomlBlock(cargoLockPackage.block, 'Cargo.lock package "inference-lens"'),
    ],
    [VERSION_PATHS.tauriConfig, tauriConfig.version],
  ]);

  return {
    root,
    sources,
    packageJson,
    packageLock,
    tauriConfig,
    cargoPackage,
    cargoLockPackage,
    versions,
  };
}

function consistentProjectVersion(project) {
  const uniqueVersions = new Set(project.versions.values());
  if (uniqueVersions.size !== 1 || uniqueVersions.has(undefined)) {
    const details = [...project.versions]
      .map(([file, version]) => `  ${file}: ${version ?? "<missing>"}`)
      .join("\n");
    throw new VersionError(`Project versions do not agree:\n${details}`);
  }
  const [version] = uniqueVersions;
  assertBaseVersion(version, "Project version");
  return version;
}

export async function checkProjectVersion({ root, tag } = {}) {
  const projectRoot = root ?? path.resolve(import.meta.dirname, "..");
  const project = await loadProject(projectRoot);
  const version = consistentProjectVersion(project);
  if (tag) {
    const release = parseReleaseTag(tag);
    if (release.baseVersion !== version) {
      throw new VersionError(
        `Release tag ${tag} has base version ${release.baseVersion}, but project manifests use ${version}.`,
      );
    }
  }
  return version;
}

function compareBaseVersions(left, right) {
  const leftParts = assertBaseVersion(left);
  const rightParts = assertBaseVersion(right);
  for (let index = 0; index < leftParts.length; index += 1) {
    if (leftParts[index] < rightParts[index]) return -1;
    if (leftParts[index] > rightParts[index]) return 1;
  }
  return 0;
}

function serializeJson(value) {
  return `${JSON.stringify(value, null, 2)}\n`;
}

export async function bumpProjectVersion(nextVersion, { root } = {}) {
  assertBaseVersion(nextVersion, "Target version");
  const projectRoot = root ?? path.resolve(import.meta.dirname, "..");
  const project = await loadProject(projectRoot);
  const currentVersion = consistentProjectVersion(project);
  if (compareBaseVersions(nextVersion, currentVersion) <= 0) {
    throw new VersionError(
      `Target version ${nextVersion} must be greater than current version ${currentVersion}.`,
    );
  }

  project.packageJson.version = nextVersion;
  project.packageLock.version = nextVersion;
  project.packageLock.packages[""].version = nextVersion;
  project.tauriConfig.version = nextVersion;

  const nextSources = {
    packageJson: serializeJson(project.packageJson),
    packageLock: serializeJson(project.packageLock),
    cargoToml: replaceTomlBlockVersion(
      project.sources.cargoToml,
      project.cargoPackage,
      nextVersion,
      "Cargo.toml [package]",
    ),
    cargoLock: replaceTomlBlockVersion(
      project.sources.cargoLock,
      project.cargoLockPackage,
      nextVersion,
      'Cargo.lock package "inference-lens"',
    ),
    tauriConfig: serializeJson(project.tauriConfig),
  };

  for (const [key, relativePath] of Object.entries(VERSION_PATHS)) {
    await writeFile(path.join(projectRoot, relativePath), nextSources[key], "utf8");
  }
  return { previousVersion: currentVersion, version: nextVersion };
}

function usage() {
  return [
    "Usage:",
    "  npm run version:check",
    "  npm run version:check -- v0.2.0-rc.1",
    "  npm run version:bump -- 0.2.0",
  ].join("\n");
}

async function runCli() {
  const [command, value, ...extra] = process.argv.slice(2);
  if (extra.length > 0 || !["check", "bump"].includes(command)) {
    throw new VersionError(usage());
  }

  if (command === "check") {
    const version = await checkProjectVersion({ tag: value || undefined });
    console.log(
      value
        ? `Version ${version} matches release tag ${value}.`
        : `All project versions agree on ${version}.`,
    );
    return;
  }

  if (!value) throw new VersionError(usage());
  const result = await bumpProjectVersion(value);
  console.log(`Bumped project version from ${result.previousVersion} to ${result.version}.`);
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : null;
if (invokedPath === fileURLToPath(import.meta.url)) {
  runCli().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
