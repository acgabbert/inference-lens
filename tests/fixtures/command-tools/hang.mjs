#!/usr/bin/env node
/**
 * Never finishes, and starts a child that never finishes either.
 *
 * With a path argument, the child's pid is written there: that is how a test
 * proves the *tree* was terminated rather than only the process this executor
 * spawned directly.
 */
import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";

const pidPath = process.argv[2];
if (pidPath) {
  const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
    stdio: "ignore",
  });
  writeFileSync(pidPath, String(child.pid));
}
setInterval(() => {}, 1000);
