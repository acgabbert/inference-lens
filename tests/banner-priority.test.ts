import assert from "node:assert/strict";
import test from "node:test";

import { chooseAppBanner } from "../app/notifications/banner-priority.client.ts";
import type { AppBanner } from "../app/notifications/banner-priority.client.ts";

function banner(id: string, tone: AppBanner["tone"] = "advisory"): AppBanner {
  return { id, tone, title: `Condition ${id}`, actions: [] };
}

const projectError = banner("project-error", "failure");
const insecureOrigin = banner("insecure-origin");
const serverDefault = banner("server-default");

test("no condition means no banner", () => {
  assert.equal(chooseAppBanner([]), undefined);
  assert.equal(chooseAppBanner([undefined, undefined]), undefined);
});

test("exactly one banner is chosen however many conditions hold", () => {
  const selection = chooseAppBanner([projectError, insecureOrigin, serverDefault]);
  assert.equal(selection?.banner, projectError);
  assert.equal(selection?.suppressed.length, 2);
});

test("priority is argument order, so a failure outranks an advisory", () => {
  assert.equal(
    chooseAppBanner([undefined, insecureOrigin, serverDefault])?.banner,
    insecureOrigin,
  );
  assert.equal(
    chooseAppBanner([projectError, undefined, serverDefault])?.banner,
    projectError,
  );
});

/**
 * The property that makes one slot honest rather than lossy: a condition that
 * loses is counted and named, so fixing the first problem does not reveal a
 * second one the app already knew about but never mentioned.
 */
test("a suppressed condition is named, not dropped", () => {
  const selection = chooseAppBanner([projectError, insecureOrigin, serverDefault]);
  assert.deepEqual(selection?.suppressed, [
    "Condition insecure-origin",
    "Condition server-default",
  ]);
});

test("the winner returns to the slot once what outranked it is resolved", () => {
  const resolved = chooseAppBanner([undefined, insecureOrigin, serverDefault]);
  assert.equal(resolved?.banner, insecureOrigin);
  assert.deepEqual(resolved?.suppressed, ["Condition server-default"]);
});
