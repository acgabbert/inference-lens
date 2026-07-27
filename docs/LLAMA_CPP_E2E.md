# Local llama.cpp endpoint for end-to-end testing

`llama.cpp` provides a small, local OpenAI-compatible server that is useful
for exercising Inference Lens without a hosted-provider account. Treat it as a
development endpoint, not as a claim that every OpenAI-compatible service has
the same behavior.

This guide assumes macOS and the Homebrew `llama.cpp` package. Keep the server
bound to loopback unless you deliberately add authentication and network
controls.

## 1. Install and start a downloaded GGUF

```sh
brew install llama.cpp

mkdir -p ~/Models/llama.cpp

llama-server \
  --model ~/Models/llama.cpp/qwen3-0.6b-q8_0.gguf \
  --host 127.0.0.1 \
  --port 8080 \
  --ctx-size 4096
```

Download the GGUF file separately and place it in `~/Models/llama.cpp` before
starting the server. The server then loads only that local path; it does not
need to download a model dynamically from Hugging Face. Change the filename in
`--model` to match the GGUF you downloaded.

Leave this terminal running. The server has no authentication in this
configuration and exposes its browser UI at <http://127.0.0.1:8080>.

For a more dependable test of tool calls or JSON-shaped replies, use an
instruction model around 1.5B–4B parameters instead. The 0.5B model is ideal
for a fast smoke test but is expected to produce imperfect structured output.

> The exact CLI flags and model filename are intentionally kept here as a
> working setup recipe. Update this guide if the local installation process
> reveals a version-specific change.

## 2. Prove the server works before involving Inference Lens

Run this from a second terminal:

```sh
curl http://127.0.0.1:8080/v1/chat/completions \
  -H 'Content-Type: application/json' \
  -d '{
    "model": "local-test-model",
    "messages": [
      { "role": "system", "content": "You are a concise assistant." },
      { "role": "user", "content": "Return a greeting." }
    ],
    "temperature": 0.2,
    "stream": false
  }'
```

Then verify streaming, which is the Inference Lens request path:

```sh
curl -N http://127.0.0.1:8080/v1/chat/completions \
  -H 'Content-Type: application/json' \
  -d '{
    "model": "local-test-model",
    "messages": [
      { "role": "user", "content": "Count from one to five." }
    ],
    "stream": true
  }'
```

The streaming response should arrive as Server-Sent Events and terminate with
`[DONE]` or a `finish_reason`. Inference Lens deliberately treats a stream that
ends without either terminal signal as a protocol error.

## 3. Connect Inference Lens

Start Inference Lens with `npm run dev` (or `npm run tauri dev`) and create a new
profile with these values:

| Field | Value |
| --- | --- |
| Profile name | `Local llama.cpp` |
| Endpoint | `http://127.0.0.1:8080/v1` |
| API key | Leave empty |
| Model | `local-test-model` |
| Temperature | `0.2` for repeatable smoke tests |

If Inference Lens runs in Docker while llama.cpp runs natively on the host, use
`http://host.docker.internal:8080/v1` instead. See the
[Docker guide](DOCKER.md#connect-to-a-provider) for container networking.

Inference Lens adds `/chat/completions` to this base URL. It sends no
`Authorization` header when the key is empty. If a client library or future
configuration requires a non-empty value, `local-no-key` is a safe dummy value
when the server is started without `--api-key`; it is not a secret.

Use the model field as a manual value first. The model picker can also call
`GET /v1/models`, but model discovery is optional and a failed or incomplete
list must not prevent entering an ID manually.

In the browser/web app, Inference Lens calls its own local API route, which then
contacts llama.cpp; it does not depend on browser CORS permissions from the
model server. The Tauri app's native host contacts the endpoint directly.

## 4. Useful end-to-end checks

Use this endpoint to cover the real transport and event pipeline:

- A normal streamed reply: request serialization, SSE parsing, delta display,
  completion, frames, and token-usage capture when the server supplies it.
- Stop a long request: cancellation propagation and the terminal cancelled
  state.
- Set an unrealistically small context window or submit a large conversation:
  provider-error reporting and preserved diagnostics.
- Stop the llama.cpp process mid-stream: incomplete-stream protocol handling.
- Try a tool definition or constrained/JSON output once the relevant Trace
  Lens UI exists: request shape and defensive parsing, not semantic quality.

The complete request and raw streamed frames recorded by Inference Lens are the
evidence for these tests. Never use an endpoint bound to `0.0.0.0` without
adding authentication and appropriate network controls.

## Compatibility expectations

OpenAI-compatible describes a request/response family, not a promise of
feature parity. llama.cpp is a particularly good test server for the
chat-completions streaming path, but it is not the compatibility oracle for
the OpenAI Responses API, Anthropic, Gemini, or a hosted OpenAI-compatible
gateway.

Inference Lens therefore needs declared capabilities at the protocol/provider
boundary. Features such as model discovery, usage reporting, tools, parallel
tool calls, structured output, vision, embeddings, and a particular API shape
must be enabled only when the selected connection supports them. A capability
should never be inferred merely from an endpoint looking OpenAI-shaped.

The current workbench supports streaming OpenAI-compatible chat completions and
attempts optional model discovery. It accepts a manual model ID if discovery
is unavailable. Capabilities for the remaining features still need a
first-class runtime contract before the corresponding UI or request fields are
added.
