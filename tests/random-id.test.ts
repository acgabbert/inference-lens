import assert from "node:assert/strict";
import test from "node:test";

import { randomUUID } from "../packages/core/src/random-id.ts";

const uuidPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

const nativeGetRandomValues = globalThis.crypto.getRandomValues.bind(globalThis.crypto);

function withCrypto<T>(value: unknown, run: () => T): T {
  const original = Object.getOwnPropertyDescriptor(globalThis, "crypto");
  Object.defineProperty(globalThis, "crypto", {
    value,
    configurable: true,
    enumerable: true,
  });
  try {
    return run();
  } finally {
    Object.defineProperty(globalThis, "crypto", original!);
  }
}

test("uses crypto.randomUUID when the secure-context API is available", () => {
  const id = randomUUID();
  assert.match(id, uuidPattern);
});

test("falls back to getRandomValues when randomUUID throws, as it does in an insecure context", () => {
  const id = withCrypto(
    {
      randomUUID: () => {
        throw new DOMException("randomUUID requires a secure context", "SecurityError");
      },
      getRandomValues: (array: Uint8Array) => nativeGetRandomValues(array),
    },
    () => randomUUID(),
  );
  assert.match(id, uuidPattern);
});

test("falls back to getRandomValues when randomUUID is missing entirely", () => {
  const id = withCrypto(
    {
      getRandomValues: (array: Uint8Array) => nativeGetRandomValues(array),
    },
    () => randomUUID(),
  );
  assert.match(id, uuidPattern);
});

test("generates distinct ids across calls in the fallback path", () => {
  const ids = withCrypto(
    {
      getRandomValues: (array: Uint8Array) => nativeGetRandomValues(array),
    },
    () => new Set([randomUUID(), randomUUID(), randomUUID()]),
  );
  assert.equal(ids.size, 3);
});

test("throws when no crypto source is available at all", () => {
  withCrypto(undefined, () => {
    assert.throws(() => randomUUID());
  });
});
