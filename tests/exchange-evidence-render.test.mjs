import assert from "node:assert/strict";
import test from "node:test";

import { ssrLoadModule } from "./support/ssr.mjs";

async function renderRequestEvidence(request) {
  const [
    { RequestEvidence },
    { renderToStaticMarkup },
    { createElement },
  ] = await Promise.all([
    ssrLoadModule("/app/evidence/exchange-evidence.client.tsx"),
    import("react-dom/server"),
    import("react"),
  ]);
  return renderToStaticMarkup(createElement(RequestEvidence, { request }));
}

test("request evidence reformats a JSON body and lists the redacted headers", async () => {
  const html = await renderRequestEvidence({
    method: "POST",
    url: "http://127.0.0.1:44014/v1/systemone",
    headers: { authorization: "[redacted]", "content-type": "application/json" },
    body: '{"state":"hi","questions":{"q":{"type":"noul","instructions":"?"}}}',
  });

  assert.match(html, /POST http:\/\/127\.0\.0\.1:44014\/v1\/systemone/);
  assert.match(html, /Copy raw request/);
  assert.match(html, /&quot;state&quot;: &quot;hi&quot;/);
  assert.match(html, /Headers: authorization: \[redacted\], content-type: application\/json/);
});

test("request evidence keeps a body that is not JSON as sent", async () => {
  const html = await renderRequestEvidence({
    method: "POST",
    url: "http://example.test/v1/systemone",
    headers: {},
    body: "not json {",
  });

  assert.match(html, /<pre class="request-evidence-body">not json \{<\/pre>/);
});

test("request evidence without a body offers no copy and no body", async () => {
  const html = await renderRequestEvidence({
    method: "GET",
    url: "http://example.test/v1/models",
    headers: {},
  });

  assert.doesNotMatch(html, /Copy raw request/);
  assert.doesNotMatch(html, /request-evidence-body/);
});
