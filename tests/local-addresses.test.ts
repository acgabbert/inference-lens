import assert from "node:assert/strict";
import test from "node:test";

import {
  hostnameFromAuthority,
  isIpLiteral,
  isLoopbackAddress,
  isWildcardAddress,
} from "../packages/core/src/local-addresses.ts";

test("separates a bind wildcard from a loopback name", () => {
  for (const wildcard of ["0.0.0.0", "::", "[::]", "0.0.0.0 "]) {
    assert.equal(isWildcardAddress(wildcard), true, wildcard);
    assert.equal(isLoopbackAddress(wildcard), false, wildcard);
  }
  for (const loopback of ["localhost", "LOCALHOST", "127.0.0.1", "127.5.0.1", "::1", "[::1]"]) {
    assert.equal(isLoopbackAddress(loopback), true, loopback);
    assert.equal(isWildcardAddress(loopback), false, loopback);
  }
  assert.equal(isLoopbackAddress("api.openai.com"), false);
  assert.equal(isWildcardAddress("api.openai.com"), false);
});

test("recognizes the literals no DNS answer can redirect", () => {
  for (const literal of ["127.0.0.1", "0.0.0.0", "192.168.1.10", "::1", "[::1]", "fe80::1"]) {
    assert.equal(isIpLiteral(literal), true, literal);
  }
  for (const name of ["localhost", "evil.test", "127.0.0.1.evil.test", "1.2.3", "999.1.1.1"]) {
    assert.equal(isIpLiteral(name), false, name);
  }
});

test("drops the port and brackets from an authority", () => {
  assert.equal(hostnameFromAuthority("localhost:3000"), "localhost");
  assert.equal(hostnameFromAuthority("[::1]:3000"), "::1");
  assert.equal(hostnameFromAuthority("[::1]"), "::1");
  assert.equal(hostnameFromAuthority("Example.Test"), "example.test");
});
