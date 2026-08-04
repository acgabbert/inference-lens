#!/usr/bin/env node
/** Failed as a process: a result on stdout must not rescue this. */
process.stdout.write(JSON.stringify({ content: [{ type: "text", text: "ignored" }] }));
process.stderr.write("weather-tool: credentials file missing\n");
process.exit(3);
