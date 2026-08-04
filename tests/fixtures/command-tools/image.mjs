#!/usr/bin/env node
/**
 * Answers with content the provider vocabulary cannot carry, so the visible
 * placeholder projection is exercised by an executor with a transport rather
 * than only by a hand-written outcome.
 */
process.stdout.write(
  JSON.stringify({
    content: [
      { type: "text", text: "Radar image attached." },
      { type: "image", mimeType: "image/png", data: "iVBORw0KGgo=" },
    ],
  }),
);
