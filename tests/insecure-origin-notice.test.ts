import assert from "node:assert/strict";
import test from "node:test";

import { insecureOriginNotice } from "../app/insecure-origin-notice.client.ts";

test("says nothing on an origin browsers already trust", () => {
  assert.equal(
    insecureOriginNotice({
      isSecureContext: true,
      hostname: "localhost",
      port: "3000",
      containerized: true,
    }),
    undefined,
  );
});

test("names the listening address a container logs and offers localhost", () => {
  const notice = insecureOriginNotice({
    isSecureContext: false,
    hostname: "0.0.0.0",
    port: "3000",
    containerized: true,
  });
  assert.ok(notice);
  assert.match(notice.headline, /0\.0\.0\.0 is a listening address/);
  assert.equal(notice.suggestedUrl, "http://localhost:3000");
  assert.match(notice.detail, /network namespace/);
});

test("carries the port through to the suggested URL", () => {
  assert.equal(
    insecureOriginNotice({
      isSecureContext: false,
      hostname: "0.0.0.0",
      port: "8080",
      containerized: true,
    })?.suggestedUrl,
    "http://localhost:8080",
  );
  assert.equal(
    insecureOriginNotice({
      isSecureContext: false,
      hostname: "0.0.0.0",
      port: "",
      containerized: false,
    })?.suggestedUrl,
    "http://localhost",
  );
});

test("does not offer localhost for a host this browser may not share", () => {
  // Suggesting localhost to someone browsing from another machine sends them
  // to their own machine, which serves nothing.
  const notice = insecureOriginNotice({
    isSecureContext: false,
    hostname: "192.168.1.24",
    port: "3000",
    containerized: true,
  });
  assert.ok(notice);
  assert.equal(notice.suggestedUrl, undefined);
  assert.match(notice.detail, /HTTPS/);
});

test("treats the IPv6 wildcard the same as the IPv4 one", () => {
  const notice = insecureOriginNotice({
    isSecureContext: false,
    hostname: "[::]",
    port: "3000",
    containerized: true,
  });
  assert.equal(notice?.suggestedUrl, "http://localhost:3000");
});
