#!/usr/bin/env node
/** Writes far more than any sane cap, forever. */
const line = `${"x".repeat(4096)}\n`;
function write() {
  while (process.stdout.write(line)) {
    /* keep going until the pipe pushes back */
  }
  process.stdout.once("drain", write);
}
write();
