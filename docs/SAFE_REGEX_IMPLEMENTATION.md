# Safe regex v1 implementation record

Safe regex v1 is implemented by the exactly pinned `re2js` 2.8.5 behind
`packages/core/src/safe-regex.ts`. The package is an implementation detail: a
replacement must pass the same conformance and runtime probes before it can
claim the persisted `syntax: "re2"` dialect.

## Package spike

Two portable candidates were inspected and exercised with ordinary matches,
the `i`, `m`, and `s` flags, unsupported syntax, and a pathological nested
quantifier.

| Candidate | Published payload | Initialization and loading | License | Decision |
| --- | ---: | --- | --- | --- |
| `re2js` 2.8.5 | About 253 KB ESM JavaScript; 875 KB unpacked package | Synchronous ESM/CJS; no external asset and no dependencies | MIT | Selected |
| `re2-wasm` 1.0.2 | 859 KB WASM plus about 236 KB JavaScript; 1.2 MB unpacked package | Synchronous CommonJS wrapper with an embedded Emscripten module | Apache-2.0 | Rejected |

`re2js` was selected because it has a direct ESM export, no WASM asset-loading
contract, no dependencies, and current browser and Node support. Its optional
non-RE2 lookbehind extension is disabled by default; Safe regex additionally
rejects lookbehind before compilation so package options cannot expand the
persisted language accidentally.

There is no asynchronous initialization. The core module can therefore remain
pure and synchronous in browser, Tauri, tests, and a Node headless runner.

## Verification surfaces

- `tests/safe-regex.test.ts` owns the provider-neutral conformance, validation,
  bounds, and adversarial cases.
- `scripts/safe-regex-runtime-probe.mjs` consumes the core contract directly in
  Node.
- `tests/safe-regex-browser-runtime.test.mjs` bundles the core module through
  the application's Vite toolchain and executes it in Chromium.
- The production Vinext and Tauri-target builds verify that the dependency is
  compatible with both application bundles.
