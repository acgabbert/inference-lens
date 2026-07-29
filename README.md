# Inference Lens

Inference Lens is a local web workbench for sending streaming chat-completion requests to an OpenAI-compatible API and inspecting normalized run events. **Inspect every model run.** The fastest way to try it is the [Docker quick start](#quick-start) — one command, nothing to install. To run from source instead, install Node.js 22.13 or newer, then run `npm ci` followed by `npm run dev` from the repository root and open the local URL printed in the terminal.

`npm run dev` reads the same server configuration as Compose from a `.env` file
in the repository root. To configure a server-default connection for local
development:

```sh
cp .env.example .env
npm run dev
```

Set `INFERENCE_LENS_API_ENDPOINT`, `INFERENCE_LENS_API_KEY`, and optionally
`INFERENCE_LENS_MODEL` in `.env`. These values remain server-only; shell
environment variables take precedence. Restart the development server after
changing `.env`.

In the UI, enter the provider base URL (for example, `https://api.openai.com/v1`), API key, model, and messages, then select **Run request**; unless the endpoint already ends with `/chat/completions`, the app appends that path. The key is used for the live request but excluded from exported project files and displayed diagnostics. Run `npm test` for the web build and TypeScript/runtime test suite, or use `npm run build` and `npm start` to run a production build locally.

For a no-account, local end-to-end endpoint, see [the llama.cpp testing guide](docs/LLAMA_CPP_E2E.md). It covers a loopback-only server, direct curl checks, and the Inference Lens profile values.

### Test a failed-turn retry locally

Run `npm run dev:flaky-provider` in a second terminal, then configure a profile
with endpoint `http://127.0.0.1:4010/v1`, no API key, and model
`flaky-test-model`. The first request returns HTTP 503. Inference Lens preserves
that attempt and offers **Retry**; the second request succeeds with a streamed
response. The fixture logs whether the retry body exactly matches the first
request. Reset it with:

```sh
curl -X POST http://127.0.0.1:4010/reset
```

### Test run timing locally

Run `npm run dev:paced-provider` in a second terminal and use endpoint
`http://127.0.0.1:4011/v1` with model `paced-test-model`. It stalls before the
first byte, streams deltas at a fixed interval, and reports token usage, so the
metrics the app derives can be checked against known values. Both delays are
configurable with `INFERENCE_LENS_PACED_FIRST_BYTE_MS` and
`INFERENCE_LENS_PACED_DELTA_MS`.

See [the provider fixture guide](docs/PROVIDER_FIXTURES.md) for writing new
fixtures and for driving them through the UI in a browser.

## Project folders

Inference Lens projects use a strict, credential-free
`inference-lens.project.json` manifest. In browsers that support directory access,
**New project** and **Open folder** use the browser's native host-folder picker.
Other browsers can use **Import** and **Export** with the same Project v2 JSON
format.

The Docker container does not need a project volume: the browser reads and
writes only the host folder the user explicitly selects. Tauri uses a native
folder picker and performs project I/O in Rust. In both cases, Inference Lens checks
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

Use **Project → Run history** to browse an open folder's validated traces.
History is derived directly from the immutable artifacts, sorted newest first,
and shows each run's model, status, duration, token count, turn count, and any
retries. Selecting a run restores its transcript, event stream, metrics, and
timeline without making the historical run resumable. The folder is read when
the drawer is opened rather than in the background, so a project with a long
history costs nothing until its history is asked for.

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
docker run --rm -p 127.0.0.1:3000:3000 \
  --add-host=host.docker.internal:host-gateway \
  ghcr.io/acgabbert/inference-lens:latest
```

Open http://localhost:3000, then enter the provider base URL, API key, and
model in the UI. A key entered this way remains only in the current browser
session. For provider networking, server-side credentials, Compose, and
troubleshooting, see the [Docker guide](docs/DOCKER.md).

### Running from source with Compose

Compose builds the image locally, which is the right choice when working on
Inference Lens itself. It requires a `.env` file:

```sh
cp .env.example .env
docker compose up --build
```

Set `INFERENCE_LENS_API_KEY` and point `INFERENCE_LENS_API_ENDPOINT` at the
matching provider base URL, or leave both empty and enter a key in the UI. To
use another local port, set `INFERENCE_LENS_PORT` in `.env`.

## macOS app (Tauri)

Inference Lens can also run as a self-contained macOS desktop app. The React UI is
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

Release tags publish the container image independently of the desktop app.
macOS DMGs are produced only when signing and notarization are configured, and
only verified DMGs are attached to draft GitHub releases. Maintainers should
follow the [release guide](docs/RELEASING.md) for versioning, GHCR visibility,
Apple signing setup, and release verification.
