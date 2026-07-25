# Trace Lens

Trace Lens is a local web workbench for sending streaming chat-completion requests to an OpenAI-compatible API and inspecting normalized run events. **Inspect every model run.** Install Node.js 22.13 or newer, then run `npm ci` followed by `npm run dev` from the repository root and open the local URL printed in the terminal.

In the UI, enter the provider base URL (for example, `https://api.openai.com/v1`), API key, model, and messages, then select **Run request**; unless the endpoint already ends with `/chat/completions`, the app appends that path. The key is used for the live request but excluded from exported project files and displayed diagnostics. Run `npm test` for the web build and TypeScript/runtime test suite, or use `npm run build` and `npm start` to run a production build locally.

For a no-account, local end-to-end endpoint, see [the llama.cpp testing guide](docs/LLAMA_CPP_E2E.md). It covers a loopback-only server, direct curl checks, and the Trace Lens profile values.

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

## Tool registry

Reusable, secret-free tool definitions live in a versioned local registry.
Definitions can be copied into an open Project v2 file or attached only to the
next run. The GUI schema builder and Advanced JSON mode share one canonical
JSON Schema object, so unsupported keywords are preserved. See
[the tool registry design](docs/TOOL_REGISTRY.md) for snapshot and persistence
semantics.

## Local Docker Compose

Copy `.env.example` to `.env`, set `TRACE_LENS_API_KEY`, and set
`TRACE_LENS_API_ENDPOINT` to the matching provider base URL. Then start the
local workbench:

```sh
cp .env.example .env
docker compose up --build
```

Open http://localhost:3000. The only published port is bound to `127.0.0.1`,
so it is not reachable from other machines on the network. To use another
local port, set `TRACE_LENS_PORT` in `.env`.

`TRACE_LENS_API_KEY` is a server-only default credential: never use a
`NEXT_PUBLIC_` prefix and do not commit the populated `.env` file. It is
excluded from the Docker build context and read by the Node API routes when a
model request is made. The service sends it only when the selected endpoint has
the same scheme, hostname, and port as `TRACE_LENS_API_ENDPOINT`. Leave the UI
key field empty to use it. In the web workbench, a user-entered key remains only
in the current browser session.

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

Before distributing the app, configure platform signing and notarization in
the release workflow.
