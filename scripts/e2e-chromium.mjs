import { constants } from "node:fs";
import { access, readdir } from "node:fs/promises";
import path from "node:path";

/**
 * Names a Chromium executable for the browser suite instead of the pinned one.
 *
 * Set by hand, it skips the pinned check entirely. `run-e2e.mjs` also sets it
 * for the Playwright child when it falls back, and `playwright.config.ts`
 * passes it to every project as `launchOptions.executablePath`.
 */
export const CHROMIUM_OVERRIDE_ENV = "INFERENCE_LENS_E2E_CHROMIUM";

const CHROMIUM_DIRECTORY = /^chromium-(\d+)$/;

async function isExecutable(file) {
  try {
    await access(file, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * The newest other `chromium-<revision>` build installed beside the pinned one,
 * at the same relative executable path.
 */
async function findInstalledChromium(pinnedExecutable) {
  const segments = pinnedExecutable.split(path.sep);
  const pinnedIndex = segments.findLastIndex((segment) => CHROMIUM_DIRECTORY.test(segment));
  if (pinnedIndex < 0) return null;
  const root = segments.slice(0, pinnedIndex).join(path.sep) || path.sep;
  const relativeExecutable = path.join(...segments.slice(pinnedIndex + 1));
  let entries;
  try {
    entries = await readdir(root);
  } catch {
    return null;
  }
  const candidates = entries
    .filter((entry) => entry !== segments[pinnedIndex])
    .map((entry) => ({ entry, revision: Number(CHROMIUM_DIRECTORY.exec(entry)?.[1]) }))
    .filter(({ revision }) => Number.isInteger(revision))
    .sort((left, right) => right.revision - left.revision);
  for (const { entry } of candidates) {
    const candidate = path.join(root, entry, relativeExecutable);
    if (await isExecutable(candidate)) return candidate;
  }
  return null;
}

function pinnedLabel(pinnedExecutable) {
  return pinnedExecutable.split(path.sep).findLast((segment) => CHROMIUM_DIRECTORY.test(segment))
    ?? pinnedExecutable;
}

/**
 * Decides which Chromium the suite launches.
 *
 * The pinned build is always preferred, and CI never gets anything else: a
 * missing pinned browser there is a real failure. Elsewhere, when the pinned
 * build is absent and cannot be installed (a sandbox that blocks Playwright's
 * download host, say), the newest other installed build is used and `notice`
 * says so, because Playwright only guarantees its own build and a failure on
 * another one may be version skew rather than the app.
 *
 * `executablePath` is null when Playwright's own pinned build should launch.
 */
export async function resolveChromium({ env, pinnedExecutable, installPinned }) {
  const override = env[CHROMIUM_OVERRIDE_ENV];
  if (override) {
    if (!(await isExecutable(override))) {
      throw new Error(`${CHROMIUM_OVERRIDE_ENV} is not an executable file: ${override}`);
    }
    return {
      executablePath: override,
      notice: `Using ${override} from ${CHROMIUM_OVERRIDE_ENV} instead of Playwright's pinned ${pinnedLabel(pinnedExecutable)}.`,
    };
  }
  if (await isExecutable(pinnedExecutable)) return { executablePath: null, notice: null };
  try {
    await installPinned();
    return { executablePath: null, notice: null };
  } catch (error) {
    if (env.CI) throw error;
    const fallback = await findInstalledChromium(pinnedExecutable);
    if (!fallback) throw error;
    return {
      executablePath: fallback,
      notice: [
        `Playwright's pinned ${pinnedLabel(pinnedExecutable)} is not installed and could not be installed:`,
        `  ${error instanceof Error ? error.message : String(error)}`,
        `Running against ${pinnedLabel(fallback)} instead (${fallback}).`,
        "Playwright only guarantees its pinned build; a failure here may be version skew. CI never falls back.",
      ].join("\n"),
    };
  }
}
