#!/usr/bin/env node
/** Ran successfully and reported a tool error. Exit status is still 0. */
process.stdout.write(
  JSON.stringify({
    content: [{ type: "text", text: "The weather service rejected the city." }],
    isError: true,
  }),
);
