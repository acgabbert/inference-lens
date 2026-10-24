# System One protocol plan

Status: **D1–D15 and U1–U6 accepted; Phase 1 complete, Phase 2 in progress. llama.cpp and
OpenRouter captured on 2026-10-24, Ollama on 2026-10-23; direct TypeSafe still
doc-derived only.** On 2026-10-24 each implementation's
documentation was read directly (see [Sources](#sources)). What it showed is
recorded in [Phase 0](#phase-0-verify-the-wire-format), along with what is still
open. The items still open need credentials: direct TypeSafe captures and
error bodies other than 422.

The user chose to start Phase 1 before captures exist. The core adapter is
tested against fixtures assembled from the docs, each labelled `doc-derived`
(`tests/fixtures/system-one/`). Those fixtures are replaced with redacted
captures before host or UI work (Phase 2 onward) depends on them. The llama.cpp
fixtures (`llamacpp-*.json`) are captured from a home `llama-server`
(b11669-620d2225c, a Laya BF16 GGUF served as `local-decision`, `--api-key` set,
behind Caddy). The Ollama fixtures (`ollama-*.json`) are captured from the
development machine's Ollama 0.40.10 (Ollama.app, default 2048-token context)
serving `tev1:0.8b`. Its own `llama-server` (build 10090) predates the route. The OpenRouter fixtures (`openrouter-*.json`, apart from the
doc-derived `openrouter-extras` and `openrouter-error`) are captured from
`https://openrouter.ai` against `~typesafe/jev-latest`, which resolved to
`typesafe/jev-1.14-20261014`, plus one request to
`inception/mercury-decide:free`.

## Goal

Let Inference Lens send requests to *System One* (decision) models and inspect
the result with the same evidence guarantees it gives chat runs: a redacted
request, the raw response, normalized results, saved traces, and checks.

This is support for a wire protocol, not for a vendor. Nothing here is specific
to TypeSafe or Jev.

## The landscape

There is **one** format, defined by TypeSafe's System One API and adopted by
the hosted re-servers and the local runtimes. Every implementation below uses
the same `state` / `questions` / `answers` / `usage` core. They differ in their
extensions, limits, auth, and error bodies, but not in the core shape.

| Implementation | Endpoint | Auth | Notes |
| --- | --- | --- | --- |
| TypeSafe (Jev) | `POST https://api.typesafe.ai/v1/systemone` | `Authorization: Bearer` | Reference. Models `jev-1.14.0` (from 2026-10-14), `jev-1.13.0`; aliases `jev-latest` and `jev-preview` both → `jev-1.14.0`. `GET /v1/models` lists names. |
| OpenRouter | `POST https://openrouter.ai/api/v1/systemone` | Bearer | For the TypeSafe SDKs (base-URL swap). Model ids are namespaced: `typesafe/jev-1.13`, `~typesafe/jev-latest`. |
| OpenRouter (alpha) | `POST https://openrouter.ai/api/alpha/decisions` | Bearer | **Same core shape, not a second format.** Adds optional `provider`, `session_id`, `trace`, `user` request fields; `id`, `provider`, `usage.cost` in the response; OpenRouter's error envelope. |
| DigitalOcean | `POST https://inference.do-ai.run/v1/systemone` | Bearer (model access key) | Model `typesafe-jev-1.13.0`. Text only, no streaming. |
| Databricks | `POST https://<workspace>/ai-gateway/typesafe/v1/systemone` | Example uses HTTP basic (`token:<PAT>`) | Path is **not** `<base>/v1/systemone`. Model is a Unity Catalog serving name. 422 + `detail` on validation errors. |
| LiteLLM | unverified | — | No primary source found. Was in the earlier draft's table only from a summary. |
| llama.cpp `llama-server` | `/v1/systemone` | Keyless, or `--api-key` bearer | ggml-org/llama.cpp#29818, merged 2026-10-02. Models laya, julia-1, lev, openjev, kev (wrappers over embedding models). Extensions: optional `images` array, `state` may be a chat-message list. `model` ignored with one model loaded. `/v1/models` lists models. |
| Ollama ≥ 0.35 | `POST http://localhost:11434/v1/systemone` | Keyless | Released 2026-09-29. Models `nimble`, `tev1`, `tev1:0.8b`; rejects cloud models. Tighter and different limits (below). No streaming, images, tools, or generation controls. Captured on 0.40.10: criteria must be strings, the response adds `prompt_eval_cached_count`, and a Bearer header is ignored. |

The New Stack also reports AWS Strands Decider, SGLang, and Ollaya serving the
same endpoint. None of these were checked.

### Request

```jsonc
{
  "model": "jev-latest",
  "state": "…",            // string | JSON object | array
  "questions": {           // at least one; keys are caller-chosen and never sent to the model
    "intent": {
      "type": "choice",
      "instructions": "…", // string | object | array
      "criteria": { "billing": "…", "bug": "…", "other": null }
    },
    "severity": {
      "type": "score",
      "instructions": "…",
      "criteria": ["minor", "major", "critical"] // ordered low→high; levels are 0-based
    },
    "is_spam": {
      "type": "noul",
      "instructions": "…",
      "criteria": { "true": "…", "false": "…" } // optional
    }
  }
}
```

- `instructions` and each criterion are **JSON values**, not only strings.
  The docs recommend a string to start with but accept objects and arrays.
- Choice `criteria` maps an option label to a description, which may be `null`.
- Score `criteria` is an ordered array. A level can be a string or an object;
  DigitalOcean mentions objects with a `label`.
- Noul `criteria` is optional. When it is present, OpenRouter requires both
  `"true"` and `"false"`.

### Response

```jsonc
{
  "model": "jev-1.14.0", // the resolved model; may differ from the alias sent
  "answers": {
    "intent":   { "type": "choice", "choice": "billing", "confidence": 0.91,
                  "probabilities": { "billing": 0.95, "bug": 0.04, "other": 0.01 } },
    "severity": { "type": "score", "score": 1.3, "confidence": 0.62,
                  "legend": { "0": "minor", "1": "major", "2": "critical" },
                  "probabilities": { "0": 0.1, "1": 0.5, "2": 0.4 } },
    "is_spam":  { "type": "noul", "noul": 0.03 }
  },
  "usage": { "input_tokens": 841, "output_tokens": 0 }
}
```

This example is assembled from the documented field names. It is not a
capture.

- Choice `probabilities` is keyed by option label and sums to 1. `choice` is
  the most probable option.
- Score `score` is the **probability-weighted position**. It can fall between
  levels, so it is not an index. `probabilities` is keyed by the level number
  *as a string*, and `legend` maps each level number back to its criterion.
- Noul has **no** `confidence`; `noul` is P(true).
- `confidence` is in [0, 1] and comes from how the probability is spread. In
  OpenRouter's schema it is not a required field.
- `usage.output_tokens` is currently free on TypeSafe and 0 in llama.cpp's
  example. Ollama counts internal scoring tokens, so its value can be non-zero.
  OpenRouter adds `usage.cost` (USD).

### Gated and non-portable features

- **Box questions** (`type: "box"`, `instructions` only, answer
  `box: {top, bottom, left, right}` as 0–1 fractions, nullable `confidence`).
  TypeSafe gates them behind `TypeSafe-Danger-Zone-Images: true`. OpenRouter
  documents them for `typesafe/jev-1.14`.
- **Images**: three mutually incompatible encodings.
  - TypeSafe: `assets` (placeholder → `{type: "image", format, data_base64}`,
    or multipart parts), plus the danger-zone header.
  - OpenRouter: `image_url` parts inside a `state` array.
  - llama.cpp: an `images` array of data URLs, or `state` as chat messages.

  TypeSafe's models page still describes Jev as text only, and DigitalOcean says
  the same.
- **Long context**: `TypeSafe-Danger-Zone-Long-Context: true` raises both
  limits to 262k tokens on Jev 1.13 and 1.14. It is TypeSafe-specific.

### Limits

| | TypeSafe | Databricks | Ollama | llama.cpp |
| --- | --- | --- | --- | --- |
| Choice options | 1–255 (256 is a 422 through OpenRouter, captured) | 1–255 | 2–26 generically, but Tev1 caps it at 24 (captured) | 1–255 (captured; a 1-option question answers with probability 1) |
| Score levels | 1–10 (docs advise ≥ 2; 1 level answers with probability 1 and 11 is a 422, captured) | 1–10 | 2–10, not the documented 2–26 (captured) | 2–10 (captured) |
| Questions per request | ≥ 1 | ≥ 1 | 1–64 (captured) | ≥ 1; 200 accepted (captured) |
| Size | 64k tokens per request; 32k for state + any one question. Through OpenRouter a 150,437-token state was accepted and billed (captured) | not stated | 64 KiB body, a 413 past it. Each prompt must fit the *loaded* context (`ollama ps`), not the model's: `tev1:0.8b` loads with 2048 tokens against a 262,144-token model, so a 60 KB state is a 400 well inside the body limit (captured) | the physical batch (`-ub`), not `n_ctx`: with `-ub 512` and `n_ctx` 8192, 429 tokens passed and 629 failed. Options count toward it, so a legal 255-option question failed at 774 tokens (captured) |

DigitalOcean repeats TypeSafe's 64k/32k token limits.

**Not supported anywhere documented:** streaming, sampling options
(temperature, seed), batching several states in one request, multi-turn
state. TypeSafe's 429 responses carry `retry-after`.

The "70–500 ms" latency figure appears only in secondary write-ups and is
vendor-reported. No primary source states it, so it should not be used as a
design input.

### Errors

| Source | Shape |
| --- | --- |
| TypeSafe, Databricks | `422` with `{ "detail": [{ "loc", "msg", "type", "input"?, "ctx"? }] }` (FastAPI style). Other statuses are not documented, apart from TypeSafe's `429`. |
| OpenRouter | `{ "error": { "code", "message", "metadata"? }, "openrouter_metadata"?, "user_id"? }`; statuses 400, 401, 402, 403, 404, 413, 429, 500, 502, 503, 524, 529. |
| llama.cpp (captured) | OpenAI-style `{ "error": { "code", "message", "type" } }`. Validation is **400** `invalid_request_error`, not 422 (unknown type, missing `state`, empty `questions`, array choice `criteria`, too many options or levels, malformed JSON). Bad key is 401 `authentication_error`. Oversized input is **500** `server_error`. An unknown `model` is not an error: the single loaded model answers and the response names it. |
| OpenRouter (captured) | OpenRouter validates the request itself first (zod), as **400**, and `error.message` is the issue list JSON-encoded as a string: unknown type, missing `state`, empty `questions`, missing `model`, malformed JSON. An unknown model is 400 `"Model … does not exist"`. A bad key is 401 `"User not found."`. Limits it does not check (too many options or levels) pass through to TypeSafe, and the 422 arrives as `code: 422` with `message` set to `"HTTP 422: "` plus the FastAPI `detail` body as a string. Validation errors carry `user_id`; redacted in fixtures. The adapter unpacks both encodings into `path: message` lines. |
| Ollama (captured) | A bare string, `{ "error": "…" }`, unlike every other implementation. Validation is **400** (unknown type, missing `state` or `model`, empty `questions`, non-string criteria, too many options, levels, or questions, a prompt over the loaded context, malformed JSON). A model that is not pulled is **404**; a pulled chat model is 400 `is not a llama.cpp decision model`; a body over 64 KiB is **413**; a cloud model while signed out is 401 `Unauthorized`. The decision model on `/v1/chat/completions` answers with the OpenAI envelope instead. The adapter reads the bare string as the message. |
| DigitalOcean | Only the tier error `"this model is not available for your subscription tier"` is documented. |

## Why this is not "add a fourth protocol"

The protocol layer would take this easily: `PROVIDER_WIRE_PROTOCOLS`,
`provider-protocols.ts` (path, credential headers, capability, label),
`provider-adapters.ts`, and the Tauri `WireProtocol` enum are each one more
entry. The difficulty is that every contract *above* the adapter assumes a
chat turn:

| Contract | Chat assumption | System One reality |
| --- | --- | --- |
| `ResolvedRunInput` / `ProviderTurnInput` | `messages`, `tools`, `options.temperature` | `state` + `questions`; no messages, tools, or sampling options |
| `ProviderProtocolAdapter` | `normalizeStream` over SSE lines | One buffered JSON response |
| `ProviderEvent` / `RunEvent` | `text_delta`, `reasoning_delta`, `tool_call_delta`, `completed` with a finish reason | Typed answers with probability distributions; no text |
| `RunState` | `turns[].attempts[].text`, tool loop, `awaiting_tool_results` | Exactly one exchange, no loop |
| `RunTrace` (schema 7) | Same as `RunState` | Same mismatch |
| Checks (`checks.ts`, schema 4) | Run on output text, JSON, tool calls, tokens, duration | Only duration and tokens carry over |
| Run metrics | Time to first byte/token, delta pacing | Duration only |
| Templates, experiments, evaluations | Built around conversations | Would need a decision-request input |

Pushing decisions through these contracts (for example, serializing the
answers as assistant text) would work, but it would misrepresent the evidence,
which is the thing Inference Lens exists to show. So the main work is the
contract design, not the adapter.

## Decisions

The user accepted every recommendation below (D1–D15) and the UI decisions in
[U1–U6](#ui-decisions-u1u6). Changes made after the source check are marked *(revised)*.

### D1. Where the protocol lives in the type system

- **A. Add `systemone` to `PROVIDER_WIRE_PROTOCOLS`.** Smallest diff, but every
  chat path that switches on the protocol must then reject it, and the type
  system no longer stops a conversation run from being routed to a decision
  endpoint.
- **B. Split connection-level facts from run-level adapters.** Widen the
  connection-facing protocol list (path, label, capability, credential headers,
  Tauri enum) to include `systemone`, but keep the chat adapter registry and
  `ProviderTurnInput` typed to the chat protocols only. Add a separate
  `DecisionProtocolAdapter` with its own request and result types.
- **Recommendation: B.** Ollama serves chat and System One from one base URL,
  so a connection can say "this server also speaks System One", while a chat
  run still cannot type-check against a decision adapter.
- The path is `/systemone`, appended to the same base as the chat paths
  (`…/v1`). This covers every implementation above, Databricks included: its
  base is just `…/ai-gateway/typesafe/v1`. Bearer credentials match the chat
  protocols, except possibly on Databricks (see Phase 0).
- *(revised)* Model discovery: `GET <base>/models` works on TypeSafe and
  llama.cpp. On Ollama the list would mix chat and decision models with nothing
  to tell them apart, so the model picker must accept a free-text id, as it
  already does. *(revised after the Ollama capture)* Ollama's `/v1/models`
  indeed has no marker, but its native `GET /api/tags` lists
  `capabilities: ["decision"]` per model (chat models list `completion`), as
  does `POST /api/show`. [D10](#d10-decision-model-discovery-accepted-b) settles
  how Phase 2 uses the markers.

### D2. Run model

- **A. Reuse `RunState`** with one turn and the answers as JSON text. Cheap;
  JSON Schema checks work as-is. Misrepresents evidence (see above).
- **B. A sibling `DecisionRun` kind** that reuses the shared sub-structures
  (`ExchangeTrace`, `RunError`, `RunTokenUsage`, `TerminalRunStatus`, retry and
  attempt semantics) but has its own input and result shape and no turn loop.
- **C. Generalize `RunState`** into a union discriminated by run kind. Most
  invasive; touches the reducer, coordinator, and every consumer.
- **Recommendation: B.** It keeps the chat reducer untouched and still shares
  the evidence pieces that are the same (request, response, frames, errors,
  retry). Retry should honour `retry-after` on 429, which TypeSafe documents.

### D3. Provider-neutral request and result representation *(revised)*

The earlier draft modelled score probabilities as an array and the score value
as a level. Both were wrong. It also assumed string-only inputs. Proposed
types, owned by `packages/core`:

```ts
type DecisionQuestion =
  | { type: "choice"; instructions: JsonValue; criteria: Record<string, JsonValue | null> }
  | { type: "score"; instructions: JsonValue; criteria: JsonValue[] }
  | { type: "noul"; instructions: JsonValue; criteria?: { true: JsonValue; false: JsonValue } };

interface DecisionRequest {
  model: string;
  state: string | JsonObject | JsonValue[];
  questions: Record<string, DecisionQuestion>; // non-empty
}

type DecisionAnswer =
  | { type: "choice"; choice: string; probabilities: Record<string, number>; confidence?: number }
  | {
      type: "score";
      score: number;                          // probability-weighted, may be fractional
      probabilities: Record<string, number>;  // keyed by level number as a string
      legend?: Record<string, JsonValue>;
      confidence?: number;
    }
  | { type: "noul"; noul: number };            // P(true); no confidence on the wire
```

- **Recommendation:** keep the wire's field names (`choice`, `score`, `noul`)
  rather than renaming them to `value`. They are identical across every
  implementation, and keeping them makes raw-versus-normalized evidence read the
  same. Keep the raw response body as frame evidence next to the normalized
  answers. Unknown extra fields, such as `id`, `provider`, and `usage.cost`,
  stay in the raw evidence only.
- A missing answer, an ill-typed answer, or an answer whose `type` differs from
  its question is a `ProviderProtocolError`. A `box` answer is treated the
  same way. TypeSafe gates box behind the image header (D8), but OpenRouter
  answers it without one (captured), so the adapter rejects it explicitly.
- JSON-valued criteria are not portable. Ollama accepts any JSON `state` and
  `instructions` but rejects a criterion that is not a string (or `null` for
  a choice option) with a 400 (captured). The type stays as the wider wire
  contract; the server's error is the evidence, as D6 does for limits.
- `usage.cost` is not normalized now. If cost is wanted later, it belongs in
  the shared `RunTokenUsage` work, not in this protocol.

### D4. Authored input and project format

What does a user edit and save?

- **A. A new project-owned `DecisionRequest`** (state + questions), revisioned
  like conversations. Bumps the project schema to 13.
- **B. Ad hoc only:** decision requests live in the composer and in traces,
  not in the project, until the shape settles.
- **Recommendation: B first, then A.** Ad hoc runs plus saved traces are enough
  to prove out the adapter and the result view without committing the project
  format. Template variables in `state`, and saved question sets, come with A.
- *(revised)* Because `state`, `instructions`, and criteria are JSON values,
  the composer needs a text/JSON toggle per field, like the existing JSON
  input. A plain textarea is not enough.

### D5. Trace format

- **A. Same `traces/` directory, new trace `kind` discriminator.** Absent means
  chat, so existing traces stay valid. Bump `RUN_TRACE_SCHEMA_VERSION` to 8.
- **B. Separate directory and file format.**
- **Recommendation: A.** Run history, import, and export keep one entry point,
  and the history list can label the kind.

### D6. Capabilities and per-runtime limits

- Add one capability, `systemOne`, that declares the connection serves the
  protocol. `streaming`, `tools`, and `structuredOutput` don't apply to it.
- Do **not** model per-runtime limits as capabilities. *(revised)* The source
  check strengthens this: the limits differ in both directions. Ollama allows
  fewer choice options than TypeSafe (26 against 255) but more score levels
  (26 against 10). When a server rejects an oversized request, show its error
  as evidence. Add a soft pre-flight warning later only if users hit it.
- Response mode is always buffered. The composer hides the streaming toggle for
  this protocol rather than offering a mode that doesn't exist.
- No sampling options are offered, because no implementation documents any.
  *(captured)* The Ollama rows in [Limits](#limits) correct the comparison
  above: its score levels stop at 10, like TypeSafe, and Tev1 allows 24 choice
  options, so it is tighter in both directions rather than looser in one.

### D7. Checks and evaluations

- Chat output checks report `not-evaluated` on a decision run, following the
  existing rule that a check that cannot apply is never a failure.
- `max-duration` and `max-total-tokens` apply unchanged.
- New check kinds, in a later phase, each for a named question id:
  - choice equals
  - score within a range
  - noul at least / at most
  - confidence at least
- Evaluation suites over decision requests depend on D4-A and come last.

### D8. Images, box questions, and vendor headers *(new)*

- **A. Out of scope for the first version.** Send text and JSON `state` only,
  and send no danger-zone headers.
- **B. Support TypeSafe's `assets` form only**, behind a per-connection header
  setting.
- **C. Model images provider-neutrally** and translate them to each
  implementation's encoding.
- **Recommendation: A.** The three encodings are incompatible. The feature is
  marked "danger zone" on the reference API, and the reference models page
  still says text only. Revisit when one encoding wins or users ask. The
  long-context header falls under the same decision: TypeSafe-specific, so out
  of scope for now.

### UI decisions (U1–U6)

Accepted with D1–D8. They refine Phase 3.

- **U1. Navigation.** A Chat / Decision request-kind switch inside Compose, not
  a new top-level mode. The task is the same write → run → inspect → revise
  loop with the same Run action and the same Runs history. The `app/decisions/`
  owner fills both Compose panes. Switching kinds never discards the other
  kind's draft.
- **U2. Target per kind.** Each kind keeps its own connection and model.
  Switching to Decision never sends to whichever chat model was selected. The
  decision model picker offers only connections that declare System One.
- **U3. JSON-valued fields.** A string-first structured form, plus one "Edit as
  JSON" view of the whole request. Both views edit the same `DecisionInput`.
  Only `state` gets its own text/JSON toggle. This replaces the per-field toggle
  sketched in D4.
- **U4. Changing a question's type.** Labels keep their authored order, and
  descriptions are kept wherever the new type has a slot for them. Switching to
  noul keeps the old options so they come back on undo, instead of deleting them
  silently.
- **U5. Result layout.**
  - Choice: bars in authored order (not sorted by probability), so runs read
    the same side by side, with the winner highlighted.
  - Score: a number line across the levels with a marker at the fractional
    score, plus per-level bars labelled from `legend`.
  - Noul: a single P(true) bar.
  - Confidence is shown only when the wire includes it. Noul has none, and the
    UI shows no placeholder for it.
- **U6. Comparing runs.** Decision diffs (per-question probability changes)
  are out of v1 and arrive with the Phase 5 checks.

### D9. Where `systemOne` is declared *(accepted: B)*

Found while starting Phase 1. A connection's capability snapshot is portable
data: `createProjectFile` writes it into the connection requirement's
`capabilityOverrides`, a strict schema, and experiment traces record it under a
strict schema too. Adding a `systemOne` key to `ProviderCapabilities` therefore
writes a key that every earlier release rejects. That contradicts D4-B's "no
project format change yet".

- **A. A `ProviderCapabilities` key, with project schema 13.** v12 files still
  open. Old snapshots read the key as `false`, the way `anthropicMessages` was
  added in v11. This is the simplest model, but it is a format bump for a
  feature that is not yet project-owned.
- **B. A device-local profile flag, outside the portable snapshot.** The
  connection profile records that it serves System One. Readiness and the
  decision model picker read the flag, and a decision trace records the target
  it actually used. Projects and chat traces don't change. It moves into the
  snapshot when D4-A makes decision requests project-owned.
- **Recommendation: B.** It keeps D4-B's promise. Until a project can own a
  decision request, it has nothing that needs to know whether a connection
  speaks System One.
- **Accepted: B.** `StoredInferenceProfile.systemOne?: true`, read with
  `servesSystemOne` and set with `withSystemOne` (`app/profile-store.client.ts`).
  It is stored only when declared. A malformed stored value drops the
  declaration, not the profile. `withServerProtocols` doesn't touch it.
- This supersedes the "one capability, `systemOne`" wording in D6: the
  declaration is a profile flag, not a capability.
- Phase 2 still has to decide how the server-provisioned profile declares it.
  `INFERENCE_LENS_API_PROTOCOLS` currently names chat protocols only.
  Settled below.

#### D9a. The server-default profile's declaration *(accepted: A)*

Today `INFERENCE_LENS_API_PROTOCOLS` sets which chat APIs the **Server default**
profile speaks and locks its protocol switches while set; a list naming
anything unrecognized is ignored whole, with a server warning and a UI banner.

- **A. `systemone` becomes an accepted name in that list**
  (`chat-completions,systemone`). The parser splits it out, and runtime status
  carries `systemOne: true` beside the chat `protocols`.
- **B. A separate variable** (`INFERENCE_LENS_API_SYSTEM_ONE=true`). Older
  releases ignore it silently, but "which APIs this endpoint speaks" is split
  across two variables, and the toggle needs its own locking rules.
- **C. Not provisioned.** Each browser toggles it, while every other connection
  fact comes from the server.
- **Recommendation: A.** The variable already says which APIs the endpoint
  speaks, and parsing, locking, the banner, and old-release behaviour all
  carry over.
- **Accepted: A**, with these rules:
  - The accepted name is `systemone` only. It matches the path
    (`/systemone`) and the connection protocol id, the way the other names
    follow their wire API. `decisions` is not accepted: it is OpenRouter's
    alpha path and output modality, and D1 decided that path is not a separate
    protocol, so an alias would suggest otherwise. Adding an alias later is
    compatible; removing one is not.
  - While the variable is set, the System One toggle is locked to whether the
    list names `systemone`; unset, it stays the browser's (D9-B).
  - A list of only `systemone` is valid, for a decision-only server; chat runs
    then get the existing unlisted-API notice.
  - An older release given `systemone` rejects the whole list with the
    existing warning and banner, as designed for unknown names.

### D10. Decision-model discovery *(accepted: B)*

Found after the captures. Discovery today is one `GET <base>/models` per host;
core (`providerModelsUrl`) and Rust (`models_url`) each build the URL,
`parseModelsResponse` reads only `data[].id`, and Rust returns the raw body
without inspecting it. A profile records no runtime identity, only a chat
protocol plus the D9 flag. Each captured runtime marks decision models
differently:

| Runtime | Marker |
| --- | --- |
| OpenRouter | Listed only by `<base>/models?output_modalities=decisions`; entries carry `architecture.output_modalities: ["decisions"]` |
| llama.cpp | `<base>/models` `data[]` entries carry `architecture.output_modalities: ["decisions"]`; the Ollama-style `models[]` in the same body says `capabilities: ["completion"]` for the same model (captured) |
| Ollama | None in `/v1/models`; `capabilities: ["decision"]` in `/api/tags` at the server root |

- **A. Free text only.** No decision listing; the picker shows the chat
  listing or takes a typed id. No new contracts, but OpenRouter's default
  listing has no decision models and Ollama's mixes them with chat models.
- **B. Follow whatever marker the listing carries.** The discovery request
  gains `listing: "chat" | "decisions"`. For `decisions`, a host:
  1. requests `<base>/models?output_modalities=decisions` and, if any entry
     carries the `output_modalities` marker, returns only the marked entries
     (OpenRouter, llama.cpp);
  2. otherwise, if the base ends in `/v1`, requests `/api/tags` at the base
     with `/v1` removed and keeps entries whose `capabilities` include
     `"decision"` (Ollama);
  3. otherwise returns the plain listing flagged unfiltered, so the picker can
     say so. A typed id always works.
- **C. Pick the runtime per profile.** Widen the D9 flag to a runtime choice
  (none, OpenRouter, llama.cpp, Ollama) with one known request each. Precise,
  but a persisted field and a drawer control for something the server already
  says.
- **Recommendation: B.** No new profile state, covers every captured runtime,
  and degrades to today's behaviour.
- **Accepted: B.** A pure parser in core reads both listing shapes and the
  three outcomes; hosts only build URLs and relay bodies. Rust gains the
  decision listing URLs in its own URL builder, so the UI still cannot hand it
  an arbitrary URL to send a credential to, and it still never inspects a
  body. Step 2 costs a second request only on servers that mark nothing, and
  only when a decision picker opens.
- The parser trusts `data[].architecture.output_modalities` over any
  `models[].capabilities` in the same body: llama.cpp sends both, and its
  `models[]` mislabels the decision model as `completion` (captured,
  `llamacpp-models`). `models[].capabilities` counts only in the step 2
  `/api/tags` body.
- Verified: llama.cpp and Ollama 0.40.10 both ignore `?output_modalities`
  (identical bodies). llama.cpp 404s `/api/tags`; Ollama serves it only at the
  root (`/v1/api/tags` is a 404), so removing `/v1` is the right derivation.
- Known degradation: behind a reverse proxy, step 2 works only when the proxy
  forwards the whole server under its prefix. One that forwards only `/v1/*`
  404s `/api/tags`, and discovery falls to step 3 (unfiltered, typed id still
  works). That is the operator's proxy, not something Phase 2 can verify. Step 2 is a layout guess, which is why it runs only after
  step 1 finds nothing marked.

### D11. The fixture provider *(accepted: B)*

The earlier Phase 2 bullet had the fixture serve TypeSafe's 422 `detail` and a
429. No captured runtime returns a 422: llama.cpp and OpenRouter send
`{error: {message}}` (OpenRouter's sometimes encoded), Ollama a bare
`{error: "…"}`.

- **A. As first planned.** The least likely local error shape, and nothing for
  discovery.
- **B. Replay the committed captures, with runtime personalities.** Answers and
  errors come from `tests/fixtures/system-one/*.json`, selected by model id,
  so the fixtures stay the single source of truth. One server, three path
  prefixes: `/llamacpp/v1`, `/ollama/v1` (plus `/ollama/api/tags`), and
  `/openrouter/v1`, each with its own listing and error envelope. A 429 with
  `retry-after` stays, labelled synthetic because none was captured.
- **C. B without personalities.** One base and one listing; it cannot drive
  D10's fallback steps.
- **Recommendation: B.** The personalities are a few dozen lines of routing and
  the only way to exercise every D10 step and every error-message path in a
  browser without three live runtimes.
- **Accepted: B.** Which capture a request gets is settled in
  [D15](#d15-how-the-fixture-provider-picks-a-capture-accepted-b).

### D12. The host decision transport *(accepted: A)*

Found while starting Phase 2. Chat hosts return a stream of transport events
(`request`, `response_started`, frames, deltas, then `completed` or `failed`).

- **A. A separate `DecisionTransport` contract** whose `executeDecision`
  returns a stream of `DecisionTransportEvent`s: `request`,
  `response_started`, one `frame` holding the raw body, `completed` with the
  normalized `DecisionResult`, and `failed` or `cancelled`. The web service
  and the Tauri webview each normalize with the same core adapter, as chat
  does.
- **B. One buffered JSON reply** (`{request, response, raw, result | error}`).
  Simpler, but a transport failure or a cancellation loses the request
  evidence.
- **Recommendation: A.** Request evidence survives a failure, cancellation
  works as it does for chat, and the Phase 3 run workflow can follow the chat
  coordinator's shape. Keeping it a separate contract keeps decision runs out
  of the chat-only types (D1-B).
- **Accepted: A.** Retry on 429 needs no host change: `retry-after` is already
  in the recorded response headers, which the Phase 3 workflow reads.

### D13. Running the discovery steps *(accepted)*

D10 keeps Rust from inspecting a body, but whether step 2 runs depends on the
step 1 body.

- One core function runs D10's three steps with an injected fetcher. The web
  service passes `fetch`. Tauri passes a command that takes only a listing
  selector (`"chat" | "decisions" | "ollama-tags"`) and builds the URL itself,
  so the webview still cannot direct a credential to an arbitrary URL.
- `ModelDiscoveryResponse` gains `unfiltered?: true` for step 3, so the
  picker can say the list is not filtered. `ModelDiscoveryRequest.protocol`
  widens to `ConnectionProtocol` so it can name `systemone`.

### D14. The web decision route *(accepted)*

- A separate `POST /api/decisions` (`DECISIONS_API_PATH`) beside
  `/api/inference`, with its own request validation and the same credential
  redaction, rather than a kind discriminator on the chat route.

### D15. How the fixture provider picks a capture *(accepted: B)*

Several captures share a model id (`local-decision` serves all-types,
non-ASCII, and message-state), and replaying answers to questions that were
not asked fails normalization.

- **A. Match the request exactly.** Faithful, but an e2e spec must reproduce
  the captured request byte for byte.
- **B. The model id names the scenario, with a guard.** Under each runtime's
  prefix, the model id is the capture's name without the runtime prefix
  (`all-types`, `401`), plus the synthetic `429`. If the questions asked do
  not match the capture's, the server answers with that runtime's 400 envelope
  and a "fixture expects …" message. Listings are served as captured; a
  scenario id is typed.
- **C. Synthesize answers for any question.** Drifts from the captures being
  the single source of truth.
- **Recommendation: B.** Specs stay readable, and a mismatched spec fails
  loudly instead of passing on garbage.
- **Accepted: B.**

## Phases

### Phase 0: verify the wire format

The docs check was done on 2026-10-24. Items marked ✅ are settled by primary
docs; ⬜ items still need a live run or a credential.

- ✅ Request body per question type: `type`, `instructions`, `criteria` (map,
  ordered array, or optional true/false map).
- ✅ Response body per type: choice probabilities are keyed by label, score
  probabilities by level-number string, plus a `legend`. `confidence` is present
  for choice and score and absent for noul.
- ✅ Auth is Bearer for TypeSafe, OpenRouter, and DigitalOcean. Local servers
  are keyless by default, but `llama-server --api-key` takes a Bearer key
  (captured), so the profile must allow an optional key for local runtimes.
- ⬜ Databricks: confirm a Bearer PAT works, since the documented example uses
  basic auth. If it does not, it needs its own credential presentation, or it
  stays out of scope.
- ✅ No documented streaming, multi-state batching, or sampling options
  anywhere. Ollama's docs say it rejects generation controls, but 0.40.10
  silently ignores `temperature` and `stream: true` and answers buffered
  (captured).
- ✅ `usage` is reported by llama.cpp and Ollama, not only TypeSafe.
- ✅ OpenRouter `/api/alpha/decisions` is the same shape plus routing fields.
  **Do not add it as a separate protocol.** `/api/v1/systemone` covers
  OpenRouter. Captured: both paths answer the same request with the same body
  shape.
- ✅ OpenRouter (captured): the response is TypeSafe's shape plus `id`,
  `provider`, and `usage.cost`. `model` names the dated snapshot, not the
  requested alias. TypeSafe through OpenRouter reports nonzero `output_tokens`
  and rounds probabilities to two places; Inception's model does neither.
  Chat-message `state` and non-ASCII labels work. **`box` questions are
  answered without any danger-zone header or image**, so D3's "unreachable"
  premise is false here; the adapter now rejects any answer whose type is
  outside the contract instead of returning nothing for it. Decision models
  are listed only by `GET /api/v1/models?output_modalities=decisions`; the
  default listing omits them all, so Phase 2 discovery must pass the filter.
- 🟡 Error shapes: 422 `detail` (TypeSafe, Databricks) and the OpenRouter
  envelope are documented. ✅ llama.cpp and OpenRouter error bodies captured
  (see [Errors](#errors)), including a TypeSafe 422 relayed by OpenRouter.
  ✅ Ollama error bodies captured.
  ⬜ Still needed: direct TypeSafe 401/429/5xx bodies and OpenRouter 402/429.
- ✅ llama.cpp (captured): the response matches TypeSafe's shape field for
  field, including `legend` and `usage`. Chat-message `state` works. Non-ASCII
  and emoji labels round-trip as keys and as the choice. Limits are in
  [Limits](#limits). `/v1/models` lists the model with
  `architecture.output_modalities: ["decisions"]`, which Phase 2 discovery can
  use to tell decision models apart.
- ✅ Ollama (captured on 0.40.10): the response matches TypeSafe's shape,
  including `legend` and `usage`, plus `prompt_eval_cached_count`. Chat-message
  and object `state`, and non-ASCII labels, work. Criteria must be strings.
  The documented limits were partly wrong; see [Limits](#limits). `/v1/models`
  lists every model with no marker; `/api/tags` marks decision models with
  `capabilities: ["decision"]`.
- 🟡 Capture one real request/response pair per implementation as fixture
  material (redacted), following `docs/PROVIDER_FIXTURES.md`. ✅ llama.cpp:
  all types, non-ASCII labels, message state, 400, 401, and an oversized 500.
  ✅ OpenRouter: the same set on both paths, a box answer, a second provider,
  400/401/relayed 422, an accepted oversized request, and the filtered model
  listing. ✅ Ollama: all types, non-ASCII labels, message state, the native
  model listing, and 400 (object criterion, too many options, over the loaded
  context), 404, and 413 bodies.

### Phase 1: core contracts and adapter (no UI)

- ✅ Connection-level protocol entry: `ConnectionProtocol` widens path, label,
  and credential headers to `systemone`, and a pasted `…/systemone` URL reduces
  to its base. Run-protocol selection and the chat adapter registry remain
  chat-only (`provider-protocols.ts`).
- ✅ The System One declaration is a device-local profile flag (D9-B), covered
  by `tests/connection-profiles.test.ts`. The reload test was run red first and
  failed on the value: the stored declaration was lost.
- ✅ `DecisionInput`, `DecisionQuestion`, `DecisionAnswer`, `DecisionResult`,
  `DecisionRun` types and the `DecisionProtocolAdapter` contract
  (`decision.ts`). The authored request is `DecisionInput` (`state` plus
  `questions`); `model` lives in the resolved target, as it does for chat runs.
- ✅ The pure System One adapter (`system-one.ts`), which builds the request,
  normalizes the response, and reads the message out of an error body.
- ✅ Unit tests (`tests/system-one.test.ts`) against **doc-derived** fixtures;
  captures replace them later. The URL-reduction test was run red against the
  old behaviour first. The adapter tests were red only because the module
  didn't exist yet. They cover:
  - each question type
  - fractional score
  - `null` choice descriptions
  - JSON-valued `state` and `instructions`
  - missing answers, ill-typed answers, and answers whose type doesn't match
    the question
  - both documented error bodies

### Phase 2: hosts

- Web service HTTP route executes a decision request with the server-held
  credential, mirroring the chat transport's redaction.
- `INFERENCE_LENS_API_PROTOCOLS` accepts `systemone` (D9a-A): parsed apart
  from the chat protocols, reported in runtime status, locking the drawer
  toggle while set. `docs/DOCKER.md` documents it.
- Tauri: add the protocol to the closed `WireProtocol` enum, with its path and
  credential handling; Rust still does no protocol parsing. Add `/systemone` to
  `PROTOCOL_PATHS`, so a pasted full URL still reduces to its base.
- Decision-model discovery (D10-B): `listing: "decisions"` on the discovery
  request, the marker-following URLs in core and Rust, and a pure core parser
  for both listing shapes, unit-tested against `openrouter-models`,
  `ollama-models`, and `llamacpp-models`.
- A fixture provider, `npm run dev:systemone-provider` (D11-B), next to the
  flaky and paced fixtures. It replays the committed captures by model id
  under `/llamacpp/v1`, `/ollama/v1`, and `/openrouter/v1`, each with its own
  listing and error envelope, plus a synthetic 429 with `retry-after`.
- The four doc-derived fixtures (`typesafe-all-types`, `typesafe-422`,
  `openrouter-extras`, `openrouter-error`) don't block this phase: captured
  fixtures cover every response shape it uses. They are replaced when a
  TypeSafe key is available.

### Phase 3: UI

- Route ownership: a new feature owner under `app/decisions/` holds the
  composer state, the run workflow, and the result view. The workbench shell
  and mode strip only compose it; no decision state lives in the route.
- Composer: state (text or JSON) plus a question list editor (type, id,
  instructions, options or ordered levels, optional noul true/false).
- Result view: one row per question.
  - Choice: the selected option, a bar per option, and confidence.
  - Score: the fractional score on the level scale, a bar per level labelled
    from `legend`, and confidence.
  - Noul: P(true).

  The raw request and response go in the existing evidence panel.
- Connection drawer: the System One profile toggle (D9-B).
- E2E spec against the fixture provider; see `tests/e2e/README.md`.

### Phase 4: traces and history

- Trace schema 8 with the `kind` discriminator; decision traces save, reload,
  import, and export; chat traces at schema 7 still open.
- History list labels decision runs.

### Phase 5: checks, CLI, evaluations

- Decision check kinds (D7).
- Headless CLI support for decision requests.
- Project-owned decision requests (D4-A) and evaluation suites over them.

## Out of scope

- A TypeSafe- or Jev-specific integration, including danger-zone headers (D8).
- Images and box questions (D8).
- OpenRouter's alpha Decisions API as a separate protocol.
- Converting decision answers into chat completions, or the reverse.
- Running decision models in-process.

## Sources

Read directly on 2026-10-24:

- TypeSafe:
  - <https://docs.typesafe.ai/introduction/quickstart>
  - <https://docs.typesafe.ai/api>
  - <https://docs.typesafe.ai/models.md>
  - <https://docs.typesafe.ai/concepts/system-one.md>
  - <https://docs.typesafe.ai/primitives/choice>
  - <https://docs.typesafe.ai/primitives/score>
  - <https://docs.typesafe.ai/primitives/noul>
- OpenRouter:
  - <https://openrouter.ai/docs/guides/community/jev>
  - <https://openrouter.ai/docs/api/api-reference/alphadecisions/submit-a-decisions-questions-and-answers-request.md>
- DigitalOcean:
  <https://docs.digitalocean.com/products/inference/how-to/use-system-one-api/>
- Databricks:
  <https://docs.databricks.com/aws/en/machine-learning/model-serving/query-systemone-models>
- llama.cpp:
  - <https://github.com/ggml-org/llama.cpp/pull/29818>
  - <https://huggingface.co/blog/ggml-org/decision-models-in-llamacpp>
- Ollama:
  - <https://ollama.com/blog/ollama-now-supports-jev-style-decision-models>
  - <https://modelsystem.one/runtimes/ollama/>
  - <https://huggingface.co/iapp/OpenThai-SystemOne-Ollama>
  - <https://kmail.at/blog/system-one-goes-local> (secondary)

The fetch tool summarizes pages rather than returning their raw text, so field
names were cross-checked across at least two sources wherever possible. Secondary
only: the latency figure, and the AWS Strands, SGLang, and Ollaya reports.
