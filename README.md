# Trace Lens

Trace Lens is a local web workbench for sending streaming chat-completion requests to an OpenAI-compatible API and inspecting normalized run events. **Inspect every model run.** The fastest way to try it is the [Docker quick start](#quick-start) — one command, nothing to install. To run from source instead, install Node.js 22.13 or newer, then run `npm ci` followed by `npm run dev` from the repository root and open the local URL printed in the terminal.

In the UI, enter the provider base URL (for example, `https://api.openai.com/v1`), API key, model, and messages, then select **Run request**; unless the endpoint already ends with `/chat/completions`, the app appends that path. The key is used for the live request but excluded from exported project files and displayed diagnostics. Run `npm test` for the web build and TypeScript/runtime test suite, or use `npm run build` and `npm start` to run a production build locally.

For a no-account, local end-to-end endpoint, see [the llama.cpp testing guide](docs/LLAMA_CPP_E2E.md). It covers a loopback-only server, direct curl checks, and the Trace Lens profile values.

### Test a failed-turn retry locally

Run `npm run dev:flaky-provider` in a second terminal, then configure a profile
with endpoint `http://127.0.0.1:4010/v1`, no API key, and model
`flaky-test-model`. The first request returns HTTP 503. Trace Lens preserves
that attempt and offers **Retry**; the second request succeeds with a streamed
response. The fixture logs whether the retry body exactly matches the first
request. Reset it with:

```sh
curl -X POST http://127.0.0.1:4010/reset
```

## Project folders

Trace Lens projects use a strict, credential-free
`trace-lens.project.json` manifest. In browsers that support directory access,
**New project** and **Open folder** use the browser's native host-folder picker.
Other browsers can use **Import** and **Export** with the same Project v2 JSON
format.

The Docker container does not need a project volume: the browser reads and
writes only the host folder the user explicitly selects. Tauri uses a native
folder picker and performs project I/O in Rust. In both cases, Trace Lens checks
for external file changes before saving instead of silently overwriting them.
See [the project format](docs/PROJECT_FORMAT.md) for ownership and compatibility
details.

Terminal runs from an open project are saved automatically as immutable
`traces/<runId>.json` files. Ad hoc terminal runs can be exported from the
Project menu, and saved traces can be imported there for inspection. Trace
artifacts preserve the redacted serialized request and raw SSE lines separately
from normalized run events. The response pane shows the saved path or clearly
marks an ad hoc trace as unsaved with a **Save trace…** action. See
[the run trace format](docs/RUN_TRACE_FORMAT.md).

## Tool registry

Reusable, secret-free tool definitions live in a versioned local registry.
Definitions can be copied into an open Project v2 file or attached only to the
next run. The GUI schema builder and Advanced JSON mode share one canonical
JSON Schema object, so unsupported keywords are preserved. See
[the tool registry design](docs/TOOL_REGISTRY.md) for snapshot and persistence
semantics.

## Quick start

No clone, no build, no configuration:

```sh
docker run --rm -p 127.0.0.1:3000:3000 ghcr.io/acgabbert/trace-lens:latest
```

Open http://localhost:3000, then enter the provider base URL, API key, and
model in the UI. A key entered this way remains only in the current browser
session. The published port is bound to `127.0.0.1`, so the workbench is not
reachable from other machines on the network; map a different local port with
`-p 127.0.0.1:8080:3000`.

### Server-side default credential

To avoid re-entering a key each session, set it on the service instead and
leave the UI key field empty:

```sh
docker run --rm -p 127.0.0.1:3000:3000 \
  --env-file .env \
  ghcr.io/acgabbert/trace-lens:latest
```

`TRACE_LENS_API_KEY` is a server-only default credential: never use a
`NEXT_PUBLIC_` prefix and do not commit the populated `.env` file. It is
excluded from the Docker build context and read by the Node API routes when a
model request is made. The service sends it only when the selected endpoint has
the same scheme, hostname, and port as `TRACE_LENS_API_ENDPOINT`.

### Running from source with Compose

Compose builds the image locally, which is the right choice when working on
Trace Lens itself. It requires a `.env` file:

```sh
cp .env.example .env
docker compose up --build
```

Set `TRACE_LENS_API_KEY` and point `TRACE_LENS_API_ENDPOINT` at the matching
provider base URL, or leave both empty and enter a key in the UI. To use
another local port, set `TRACE_LENS_PORT` in `.env`.

## macOS app (Tauri)

Trace Lens can also run as a self-contained macOS desktop app. The React UI is
bundled as static assets; TypeScript constructs provider requests and
normalizes streamed events, while a small Rust host resolves credentials and
performs the streaming HTTP requests. No Node server is shipped with the app.

Install the prerequisites once (Rust and Xcode Command Line Tools), then run:

```sh
xcode-select --install
curl --proto '=https' --tlsv1.2 https://sh.rustup.rs -sSf | sh
npm ci
npm run tauri dev
```

Build a local installer with `npm run tauri build`. The macOS DMG is written
under `src-tauri/target/release/bundle/dmg/` (or `target/debug/bundle/dmg/`
when using `npm run tauri build -- --debug`).

Debug builds (`npm run tauri dev` and `npm run tauri build -- --debug`) keep an
entered API key only in the current UI session. They never read from or write
to an OS credential store. Release builds (`npm run tauri build`) store desktop
API keys under the app's profile ID in the OS credential store and bind each
key to its approved endpoint origin.

In a release build, only the opaque profile ID is used to resolve a key for
model requests. The Rust host checks that it is approved for the selected
endpoint origin. Profile metadata is stored locally without API keys.

Run `npm run test:rust` for the debug host tests. On macOS,
`cargo test --release --manifest-path src-tauri/Cargo.toml` additionally
exercises a real Keychain round-trip with a temporary item that is removed
during cleanup.

### Releases

Pushing a `v*` tag runs `.github/workflows/release.yml`, which builds a
universal (Apple Silicon and Intel) bundle and attaches it to a **draft**
GitHub release.

Signing and notarization are already wired into that workflow but stay inert
until the corresponding repository secrets exist: `APPLE_CERTIFICATE`,
`APPLE_CERTIFICATE_PASSWORD`, `APPLE_SIGNING_IDENTITY`, `APPLE_ID`,
`APPLE_PASSWORD`, and `APPLE_TEAM_ID`. Without them the workflow produces an
unsigned bundle, and macOS reports that a downloaded unsigned app "is damaged
and can't be opened" until the quarantine attribute is removed. Adding the
secrets turns on signing with no workflow change.

The tag must match the version in `package.json`, `src-tauri/Cargo.toml`, and
`src-tauri/tauri.conf.json`; the workflow checks this before building.
