#!/usr/bin/env node
/**
 * Succeeds, and proves stdin arrived: the city in the answer comes from the
 * model's own arguments, so a run that never delivered them cannot produce
 * this text.
 */
const chunks = [];
for await (const chunk of process.stdin) chunks.push(chunk);
const payload = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
let city = "an unnamed city";
try {
  city = JSON.parse(payload.arguments ?? "{}").city ?? city;
} catch {
  city = "an unparseable city";
}
process.stdout.write(
  JSON.stringify({
    content: [
      { type: "text", text: `61F and drizzle in ${city}, measured by ${payload.tool}` },
    ],
  }),
);
