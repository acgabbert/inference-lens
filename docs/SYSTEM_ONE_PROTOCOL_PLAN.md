# System One protocol plan

Status: **D1–D52 and U1–U6 accepted. Phase 5a (project-owned decision requests) is implemented, 5b and 5c are not. Phases 1 and 2 are merged; D16's fixes
and host tests are in, with its native-app check still to run on a desktop
build. Phases 3 and 4 are implemented together (D20): the Compose owner and
topbar (D29-A), trace opening by kind (D30), the decision draft, target, and
views, the Connections declaration, and D21's browser coverage. What D21
leaves uncovered is listed under [Phase 3](#phase-3-ui). llama.cpp and
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

The user accepted every recommendation below (D1–D43) and the UI decisions in
[U1–U6](#ui-decisions-u1u6).
Changes made after the source check are marked *(revised)*; a later decision
that changes an earlier one is named in the marker, as in *(revised by D18)*.

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
- *(revised by U3 and D18)* Because `state`, `instructions`, and criteria are
  JSON values, the editor must preserve more than strings. U3 and D18 settle the controls and draft
  model, superseding the earlier proposal for a text/JSON toggle per field.

### D5. Trace format

- **A. Same `traces/` directory, new trace `kind` discriminator.** Absent means
  chat, so existing traces stay valid. Bump `RUN_TRACE_SCHEMA_VERSION` to 8.
- **B. Separate directory and file format.**
- **Recommendation: A.** Run history, import, and export keep one entry point,
  and the history list can label the kind.

### D6. Capabilities and per-runtime limits

- *(revised by D9-B)* Declare System One with the device-local profile flag
  in D9-B, outside
  the portable capability snapshot. `streaming`, `tools`, and
  `structuredOutput` don't apply to decision requests.
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
  kind's draft. *(revised by D17)* D17 locks the switch during execution and
  retains each kind's latest result afterward.
- **U2. Target per kind.** Each kind keeps its own connection and model.
  Switching to Decision never sends to whichever chat model was selected. The
  decision model picker offers only connections that declare System One.
- **U3. JSON-valued fields.** *(revised by D18)* A string-first structured
  form, plus one "Edit as JSON" view of the whole `DecisionInput` (`state` and `questions`; the target
  remains separate). Both views belong to the same editor draft (D18), which
  derives a validated `DecisionInput` for execution. Only `state` gets its own
  text/JSON toggle. This replaces the per-field toggle sketched in D4.
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
  declaration, not the profile. *(revised by D9a)* While
  `INFERENCE_LENS_API_PROTOCOLS` is set, `withServerProtocols` sets it too.
- This supersedes D6's original capability proposal; D6 now reflects the
  device-local profile flag.
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
- *(revised while implementing)* `protocol: "systemone"` is itself the request
  for the decision listing, so the web discovery request has no separate
  `listing` field: no protocol needs the other listing. The selector exists
  only on the Tauri command, which is asked for one step at a time.

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

### D16. Host and adapter correctness before Phase 3 *(accepted)*

The Phase 2 review reproduced four issues. Fix them before implementing the
UI, with committed regression tests written and run red against the actual
incorrect values before each fix:

- **Complete error evidence.** The desktop decision reader currently uses
  Rust's error message as the response body, but Rust truncates it at 4,000
  characters. Preserve the complete body independently of any shortened
  display summary. A validation response over 4,000 characters must retain
  the full raw frame and yield the same readable message on web and desktop.
  D25 settles where the body is preserved.
- **Startup cancellation.** An already-aborted signal, or an abort while
  registering the listener or starting the native command, must not be lost.
  Prevent dispatch where possible; cancel any native work already started,
  terminate as cancelled, and release the listener. Stale completion must
  never replace cancelled state.
- **Caller-chosen question ids.** Accumulate answers in a dictionary that
  preserves every own key, including `__proto__`, through normalization and
  JSON serialization. Test own-key membership and the serialized result.
- **Probability validation.** Choice and score probability maps must be
  non-empty. Keep the existing known-key and finite [0, 1] checks. Accept
  the rounding in the captured responses: do not require an exact sum of 1,
  renormalize the reported probabilities, or recompute the reported score.

The scratch IPC probes from the review establish the failures; they are not
committed regression coverage or a native-app verification. Add reproducible
host tests and check desktop cancellation and error evidence in the native
app, reporting any part that could not be exercised.

Done, each test run red on the incorrect value first:

- `tests/tauri-decision-transport.test.mjs` drives the shipped desktop
  transport through `window.__TAURI_INTERNALS__` against a stand-in for the
  raw proxy. A synthetic 12,122-character 422 kept only 4,000 characters as
  its frame; it is now whole on both hosts with the same failure. An abort
  before or during startup now rejects with the signal's reason, as `fetch`
  does on the web, without dispatching (or, once started, with a cancel sent
  after the start). After the stream is returned, a stop ends it as
  `cancelled` even if a completion was already queued or the native side never
  answers, and the listener is released either way.
- Rust: `provider_error_event` keeps `message` cut at 4,000 characters and
  adds `body`, the complete response (D25); covered by `cargo test`.
- `tests/system-one.test.ts`: `__proto__`, `constructor`, and `toString`
  question ids stay own keys in authored order through normalization and JSON,
  a missing `constructor` answer reads as missing, and empty choice or score
  probability maps are protocol errors.

Not yet exercised: the native app itself. These ran on Linux; the desktop
cancellation and error-evidence check in a built app is still owed, and the
decision UI that would drive it arrives in Phase 3. Chat's `executeTurn` has
the same startup race; it is out of D16's scope.

### D17. Switching request kinds and run lifecycle *(accepted)*

The alternatives were to lock switching during execution, cancel on switch,
or allow background execution. **Lock the Chat / Decision switch during
execution.** Compose has one foreground execution; switching kinds cannot
implicitly cancel it or start another. Keep existing batch execution guards;
D24 settles how decision runs join them.

- Preserve each kind's draft, independent connection/model selection, and
  latest result when switching after execution ends, including failed or
  cancelled results and their evidence.
- Run, Stop, Retry, and the keyboard shortcut address the foreground kind.
  Unlock switching after cancellation or another terminal outcome. Keep
  draft ownership above conditional pane mounts so switching views is lossless.
- A run captures its validated input and target before dispatch. Retry uses
  that exact snapshot and retains earlier attempt evidence; edits belong to
  a new run. Honour `retry-after` on 429 when permitting a retry; D23
  settles how.
- The decision session owns cancellation and invalidation of asynchronous
  work, so late events cannot revive a stopped or superseded run.

### D18. Editor draft versus executable input *(accepted)*

`DecisionInput` is the executable core contract. A separate application-local
editor draft under `app/decisions/` owns incomplete form rows, raw JSON text,
parse and validation errors, stable editor row identities, and options kept
for reversible question-type changes. These editing details are not added to
the provider input, project format, or saved execution trace.

- Derive a validated `DecisionInput` from the current draft before running.
  Invalid JSON or an incomplete form blocks Run with a useful location and
  message; it never runs a silently retained last-valid version.
- Switching form/JSON views preserves values. JSON-authored objects, arrays,
  and `null` in instructions and criteria must survive a round trip without
  stringification, replacement with an empty value, or an implicit default.
  Values that need JSON editing remain accessible there from the form.
- Keep invalid JSON text and its error until corrected; switching views must
  not discard it. A form transition that needs valid parsed input is blocked
  with the parse error rather than replacing the draft.
- Question ids are authored keys, separate from editor row identity. Renaming
  and reordering must not attach another question's draft state to a row.
  U4's retained options live in this draft, not in the executable request.

### D19. Compose and evidence ownership *(accepted)*

- The decision feature under `app/decisions/` owns its editor, readiness,
  target selection, execution session, result view, and decision inspection.
  Its session exposes status and Run/Stop/Retry commands; its view supplies
  request, response, and inspect regions to the workbench shell.
- A small Compose owner under `app/compose/` owns request-kind selection and
  selects a UI-facing handle for readiness, execution status, commands, and
  pane content. The topbar and keyboard shortcut use the same handle. This
  is an application-local adapter, not a union that generalizes the chat
  kernel or serializes decisions as assistant text.
- `app/page.tsx` composes these owners and genuine cross-feature adapters;
  decision effects, refs, and mutation workflows stay with their owner.
- Extract reusable request/response/frame evidence presentation from the
  chat-specific inspector as its own step (D26). Feed it the shared exchange
  evidence structures; keep chat-only tools, transcript, comparison, and
  template resolution with chat. Decisions show duration and reported token usage, with missing usage
  kept missing, rather than token-stream timing or throughput.
- Extend model discovery's UI state and cache to retain `unfiltered` along
  with model ids and accept `ConnectionProtocol`. Keep catalogues distinct
  by profile, endpoint, and protocol, discard stale responses, and show D10's
  unfiltered notice while continuing to accept a typed model id.

### D20. UI and persistence delivery boundary *(accepted)*

The alternatives were a transient Phase 3 release or delivering Phases 3 and
4 together. **Ship Phases 3 and 4 together, implementing trace support early.**
The first usable decision workflow must save, reopen, import, and export its
evidence through the shared Runs entry point.

Keep the phase numbers as scope labels, not a requirement to finish all UI
before persistence. After D16, implement and test the decision trace format
and session persistence before wiring the complete composer workflow. UI work
may land incrementally, but enabling the feature for release requires both
phases' acceptance checks. D4-B still holds: saved traces contain executed
input; project-owned decision drafts and question sets wait for Phase 5.

### D21. Acceptance coverage *(accepted)*

Use committed tests for the contracts below and the Playwright suite for the
running UI. The System One fixture belongs in the suite's server configuration;
do not start it by hand for a Playwright run. Follow D15's scenario selection
and question guard: seed captured questions for execution tests, and use
synthetic extensions only when labelled as such.

- Draft retention across Chat/Decision switches, independent targets, and
  the switch lock during execution, including startup and cancellation.
- Lossless form/JSON round trips for strings, objects, arrays, and `null`;
  invalid JSON blocking Run; incomplete rows; question rename/reorder; and
  options restored after a reversible type change.
- Only declared System One connections offered for decisions; the server's
  locked declaration respected; filtered discovery for the captured runtimes;
  and the proxied Ollama unfiltered notice plus typed-id fallback.
- Exact rendered choices, fractional scores, probability values, confidence
  presence/absence, and reported token usage against known fixture values;
  duration derived from recorded timing. Inspect the relevant rendered region
  for `NaN`, `Infinity`, and `undefined`; a green transport test alone does not
  cover the result view.
- Cancellation before and during execution, stale events ignored, retry of
  the frozen input with earlier attempts retained, 429 `retry-after`, and
  readable provider/protocol failures with complete redacted evidence.
- Save, reload, import, and export of decision traces, retaining the same
  rendered result and raw evidence. Open schema-7 chat traces unchanged and
  select chat and decision entries through shared history.

Run the affected specs while iterating, then the full browser suite once
before handoff. Report the commands, skipped checks, fixture limitations, and
the native desktop paths actually exercised. Keep tests introduced for D16
red for the relevant incorrect value before fixing it, per `AGENTS.md`.

### D22. Decision trace shape *(accepted: A)*

D5 settles where decision traces live, but not what they hold, and D20 builds
the format first. Core already defines the run: `DecisionRun` carries
`ResolvedDecisionRunInput`, status, `DecisionAttempt`s, and
`DecisionExchangeTrace`s keyed by exchange id. A chat trace instead stores an
ordered event log and re-derives its projections on import.

- **A. Store the terminal `DecisionRun`.** The body is `schemaVersion: 8`,
  `kind: "decision"`, `runId`, `input`, a `TerminalRunStatus`, `attempts`,
  `exchanges`, `startedAt`, and `endedAt`. Import checks the shape and the
  consistency between the parts, then reconstructs the run as stored.
- **B. Store each attempt's `DecisionTransportEvent` stream** and reduce it on
  import, as chat does. This matches chat more closely, but a decision exchange
  has a single frame, so the events repeat what the exchange trace already
  holds and need a reducer that exists only to read them back.
- **C. A, plus re-normalizing every completed attempt's raw body** through the
  current adapter and rejecting a mismatch. This guarantees the most, but it
  ties old traces to adapter changes: a later validation rule would reject
  traces that were valid when saved.
- **Recommendation: A.** Import rejects, naming the path:
  - attempt numbers that don't run 1…n;
  - an attempt whose `exchangeId` is missing or shared;
  - a completed attempt that isn't the last;
  - a status that disagrees with the last attempt;
  - a completed attempt without a result, or whose answer ids and types differ
    from the input's questions;
  - a failed attempt without an error.
- What is saved follows the chat rules in `docs/RUN_TRACE_FORMAT.md`:
  completed and cancelled runs, non-retryable failures, and retryable failures
  that the user stops instead of retrying. A retryable failure stays live
  session state until then. The D18 editor draft is never saved.
- The input's `ResolvedDecisionTarget` is the stored target: it holds the
  profile id, protocol, endpoint, model, and capability snapshot, and no
  credential. A trace opens read-only without that profile on the device.
- Version 8 covers both kinds. New chat traces write version 8 without `kind`,
  so their contents are otherwise unchanged, and versions 1–7 still import as
  chat. The parser accepts `kind` only when it is absent or `"decision"`, and
  rejects a decision trace that claims a version below 8.
- Ownership: `packages/core/src/run-trace.ts` keeps the file envelope,
  deterministic serialization, filenames, and dispatch by `kind`. Decision
  validation lives beside the decision types in core. One parser returns
  either kind for history, import, and export. The chat-only parser rejects a
  decision trace with a readable message instead of misreading it.
- Run history keeps one `traces/` listing. A decision summary shows the kind,
  model, question count, and status, and selecting the entry opens Decision
  Compose's inspection state.

Settled when implementing (2026-10-24):

- `DecisionAttempt.status` gains `cancelled`; a saved attempt is never
  `running`. A cancelled run's last attempt is cancelled and holds neither
  result nor error. Earlier attempts are all failed: a retry follows only a
  failure.
- A saved run has at least one attempt. The session records attempt 1 before
  calling the transport, so a stop before dispatch saves as attempt 1,
  cancelled, with an exchange that has no request evidence.
- Stopping during a 429 wait (D23) saves the run as failed with that attempt's
  error, as chat's Stop does on a paused failed attempt. A failed run's error
  must equal its last attempt's.
- An exchange holds at most one frame, at index 0. The status timestamp equals
  `endedAt`.
- Decision traces keep authored key order under `decision` and `result`
  (questions, options, answers, probabilities); the rest of the file uses the
  usual deterministic order.
- History lists decision entries; opening one from history or import is
  wired with the decision UI (D30). The chat-only parser still rejects a
  decision trace with a readable message; import now uses the parser for
  either kind.

Done: `packages/core/src/decision-trace.ts` (shape and consistency) and the
version 8 envelope, `parseSavedRunTrace`, and `serializeDecisionRunTrace` in
`run-trace.ts`, covered by `tests/decision-trace.test.ts`. Chat traces now
write version 8. History summaries carry `kind`; the Runs list shows a decision
row disabled until Decision Compose exists (`run-history-render`, and
`runs-result-discovery` in the browser). Session persistence waits for the
decision session it saves.

### D23. Retry after a 429 *(accepted: A)*

D2 and D17 say Retry honours `retry-after`, but not how. In Compose, chat
Retry doesn't read the header today. Only batches pause:
`rateLimitPauseMs` in `packages/runner/src/rate-limit-pause.ts` reads
`retry-after-ms`, then `Retry-After` as seconds or an HTTP date, defaults to
5 s, and caps the wait at 60 s.

- **A. Manual Retry with a wait.** After a 429, Retry is disabled with a
  visible countdown until the wait elapses; then the user retries. Stop stays
  available and makes the run terminal.
- **B. Automatic retry after the wait,** for a bounded number of attempts.
  This spends requests the user didn't ask for, and it adds a timer that owns
  execution, so the D17 lock would have to cover the wait as well.
- **C. Advisory only.** Show the wait but don't block Retry.
- **Recommendation: A.** Use the same header rules as batches. Move
  `rateLimitPauseMs` into core so `app/decisions/` doesn't depend on the
  runner; `rateLimitedAttempt` reads chat `RunState` and stays in the runner.
  The wait starts when the 429 response arrives and is read from the failed
  attempt's recorded headers. The countdown is session state, not trace
  content.
- While a retryable failure waits, nothing is executing, so the kind switch
  is unlocked. The countdown survives switching away and back.
- Fixture limitation: the synthetic `429` scenario always sends
  `retry-after: 1` and answers every request with 429. A spec can show the
  wait, the re-enabled Retry, and a second retained 429 attempt, but not a
  success after waiting. Say so when reporting D21's 429 coverage.

### D24. Decision runs and other activity *(accepted: A)*

`app/page.tsx` already treats a single chat request, a repeated experiment,
and an evaluation run as one foreground activity. While any of them runs, the
others can't start, and the keyboard shortcut does nothing.

- **A. A decision run joins that guard.** Decision Run is disabled with a
  reason while a chat request or batch is active, and chat Run and batch
  starts are blocked while a decision run executes. A 429 wait (D23) doesn't
  count as active.
- **B. Let a decision run go alongside a batch.** Sampling a decision during a
  long batch is useful, but both may share a provider and its rate limit, and
  the topbar and shortcut would then have two live runs to address.
- **Recommendation: A.** The D19 Compose handle exposes whether its kind is
  executing, and the route feeds that into the existing activity check. It is
  the cross-feature adapter that the route is meant to keep. Add the guard in
  both directions to D21's switch-lock coverage.

### D25. Where the complete error body is preserved *(accepted: A)*

D16 requires the complete error body, but the truncation is shared with chat.
`stream_provider_turn` in `src-tauri/src/lib.rs` cuts the provider error
message at 4,000 characters. The same cut is copied in
`app/tauri-inference-transport.client.ts`,
`packages/core/src/decision-execution.ts`,
`packages/core/src/openai-compatible.ts`, and
`packages/core/src/provider-adapters.ts`, so long chat error bodies are
truncated too, on both web and desktop.

- **A. Shared path, additive.** The Rust error event gains a field carrying
  the complete response body; `message` stays the shortened summary. The
  decision reader records the complete body as its frame and derives the
  readable message from it, so web and desktop agree. Chat ignores the new
  field, and its behaviour is unchanged.
- **B. A decision-only Rust branch.** Leaves chat code untouched, but
  duplicates the request and response handling D12 deliberately shares.
- **C. Fix chat's evidence in the same step.** Changes chat traces and the
  chat UI, widening Phase 3.
- **Accepted: A.** The only chat-facing change is the event shape. Cover it
  with the existing Rust tests plus a new one asserting that `message` is still
  truncated and the body is complete. Keeping the full body in chat's own
  evidence is a separate follow-up, not part of Phase 3.

### D26. Extracting the shared evidence presentation *(accepted: A)*

D19 extracts the request, response, and frame presentation from the
chat-specific inspector in `app/run-trace-panel.client.tsx`. That is a
refactor of chat UI.

- **A. A separate behaviour-preserving step before the decision result
  view.** Move the presentation into a shared component that takes only
  exchange evidence; tools, transcript, comparison, and template resolution
  stay with chat. Run the browser specs covering the inspector before and
  after, and they must pass unchanged: at least `raw-request-evidence`,
  `tool-execution-evidence`, `runs-result-discovery`, `pr2-workbench`, and
  `experiment-history`. Confirm which evaluation specs open the inspector
  before relying on them. Then build the decision view on the shared
  component with D21's coverage.
- **B. Extract it while building the decision view.** No clean
  before-and-after for chat, so a chat regression would surface mixed into
  decision work.
- **Accepted: A.**

Done (2026-10-24): the inspector had one dedicated evidence presentation, the
request (`RequestEvidence`: method and URL, the body reformatted for reading,
a copy of the exact bytes, and the redacted header list). The response status
and headers and the raw frames appeared only inside each event's JSON dump, so
there was no response or frame presentation to move. `RequestEvidence` moved
unchanged to `app/evidence/exchange-evidence.client.tsx`, which takes only
exchange evidence; chat's inspector imports it and keeps its event stream,
metrics, templates, and attempt diff. The response and raw-body presentation
is new decision-view work in that module. Chat keeps its event JSON: adopting
the new pieces would change chat UI, which D26 rules out.

`tests/exchange-evidence-render.test.mjs` pins the shared component's output.
It was written for the moved component, not as a regression test, so it was
not run red. The inspector's browser specs passed before and after (51 tests
in each run, light and dark): `raw-request-evidence`, `tool-execution-evidence`,
`runs-result-discovery`, `pr2-workbench`, `experiment-history`,
`provider-protocols`, `run-attempt-diff`, `tool-parameter-order`, and
`ui-ux-workflow-review`, plus `evaluation-baseline-comparison`, the only
evaluation spec that opens Run details.

### D27. Where decision run transitions live *(accepted: A)*

Nothing in core turns `DecisionTransportEvent`s into a `DecisionRun` yet. Chat
has `RunCoordinator` (core) and `driveProviderTurn` (runner).

- **A. A pure core module, `packages/core/src/decision-run.ts`.** Functions
  over `DecisionRun`: start, begin an attempt, apply a transport event, fail,
  cancel, retry. Plus `driveDecisionAttempt`, which calls a `DecisionTransport`,
  folds its events, and drops them once an `isCurrent()` check fails. It
  depends on nothing in the runner, the same way D23 moves `rateLimitPauseMs`
  into core.
- **B. Transitions inside the React session hook.** Fewer files, but they can
  be tested only through React, and the Phase 5 CLI would have to duplicate
  them.
- **Recommendation: A.** The session hook keeps only React state,
  invalidation refs, persistence, and the countdown timer.
- **Accepted: A.**

Done (2026-10-24), with D28 and D23's move: `packages/core/src/decision-run.ts`
has `createDecisionRun`, `beginDecisionAttempt`, `retryDecisionRun`,
`applyDecisionEvent`, `finishDecisionAttemptStream`, `stopDecisionRun`,
`decisionRetryWaitMs`, and `driveDecisionAttempt`.

- The driver takes `open(execution, signal)` rather than a
  `DecisionTransport`, because core does not import `packages/contracts`. The
  session composes `prepareCredential` and `executeDecision` into it.
- A thrown error is classified as chat's driver does. It reads a numeric
  `status` from the error, since core cannot import the runner's
  `InferenceTransportError`.
- An abort is returned to the caller, whose Stop decides the terminal state.
  A superseded attempt reports nothing.
- A second frame fails the attempt as a protocol error rather than breaking
  D22's one-frame rule. A stream that ends without an outcome fails it the
  same way, non-retryable.
- `decisionRetryWaitMs` uses the batch rule for which failure is a 429
  (`provider_error` with `providerStatus` 429).
- `rateLimitPauseMs` and its constants now live in
  `packages/core/src/rate-limit-pause.ts`. The runner re-exports them and
  keeps `rateLimitedAttempt`.

`tests/decision-run.test.ts` checks that every terminal run is accepted by
the D22 trace format. The tests were red only because the module did not
exist yet. Breaking the retryable check, the second-frame check, or the
superseded check each made them fail.

### D28. A retryable failure's live status *(accepted: A)*

`DecisionRunStatus` is `not_started | running | terminal`. D22 and D23 keep a
retryable failure live until the user retries or stops, so the run needs a
non-terminal state between the failed attempt and the user's choice.

- **A. Add `{ kind: "paused"; reason: "attempt_failed"; attempt; exchangeId;
  error }` to `DecisionRunStatus`**, mirroring chat's paused status. Traces
  are unaffected: they store only terminal statuses (D22). Stop turns it into
  `failed` with that error, as chat's Stop does.
- **B. Mark the run `failed` and keep a "retry allowed" flag in the session.**
  Retry would then reopen a terminal run, and autosave, which fires when a run
  becomes terminal, would save a run that may still be retried.
- **Recommendation: A.** `RunError.retryable`, set by the failure mapping
  shared with chat, decides between paused and failed. After a 429 the
  session holds the time Retry becomes available
  (`retryAvailableAt`, epoch ms). It reads that time from the attempt's
  recorded headers with `rateLimitPauseMs`. It is session state, never trace
  content.
- **Accepted: A.**

### D29. The decision session and Compose handles *(accepted: A)*

Owners, per D19:

- `app/decisions/use-decision-draft.client.ts`: the D18 editor draft, and
  `validated(): { input: DecisionInput } | { problems }`.
- `app/decisions/use-decision-target.client.ts`: the decision kind's own
  connection and model (U2). Its readiness lists only System One profiles
  (D9) and its discovery keeps `unfiltered` (D19).
- `app/decisions/use-decision-session.client.ts`:

```ts
interface DecisionSessionHandle {
  run: DecisionRun | null;          // live or opened; paused per D28
  executing: boolean;               // an attempt is in flight (D24)
  retryAvailableAt?: number;        // D23 wait; Retry is disabled until then
  traceStorage: TraceStorageStatus | null;
  start(input: ResolvedDecisionRunInput, context: { workspace: ProjectWorkspaceHandle | null }): Promise<void>;
  retry(): Promise<void>;           // only while paused and the wait is over
  stop(): void;                     // idempotent; executing → cancelled, paused → failed
  reset(): void;
  exportTrace(): Promise<void>;
  adoptTrace(trace: DecisionRunTrace, origin: TraceOrigin): void;
}
```

  The options mirror the chat session's: `transport: DecisionTransport`,
  `prepareCredential`, `onShowResponse`, `onTraceSaved`, `onError`. Decisions
  have no diagnostics capture. The trace already holds the whole exchange.
- `app/compose/use-compose.client.ts` owns the request kind and selects one
  handle:

```ts
type ComposeKind = "chat" | "decision";
type ComposePrimary =
  | { kind: "run"; label: string; disabledReason?: string; run(): void }
  | { kind: "stop"; stop(): void }
  | { kind: "none" };                // paused, the action is on the failure card

interface ComposeHandle {
  kind: ComposeKind;
  setKind(kind: ComposeKind): void; // no-op while kindLocked
  kindLocked: boolean;              // either kind is executing (D17)
  executing: boolean;               // feeds the route's activity guard (D24)
  primary: ComposePrimary;          // topbar button and ⌘↵
  panes: { request: ReactNode; response: ReactNode; inspect: ReactNode };
  trace: { available: boolean; export(): void };
}
```

- **A. The topbar reads `primary`.** It drops the chat-specific
  `isRequestActive`/`awaitingToolResults`/`retryableFailure`/`runDisabled`
  props for Compose. Chat maps its states to the same buttons, so chat
  behaviour is unchanged. The shortcut fires `primary.run` (or chat's Retry,
  as today).
- **B. Keep the topbar's chat props** and have the Compose owner translate
  decision state into them. There is less churn, but chat vocabulary leaks
  into decisions, and the button still needs a per-kind label.
- **Recommendation: A.** Chat's own session, response view, and inspector are
  untouched; only the route's topbar wiring changes.
- **Accepted: A.**
- Persistence helpers (`saveRunTraceWorkspace`, `exportRunTraceFile`,
  `runTraceWorkspaceLocation`) widen from `RunTrace` to `SavedRunTrace` and
  serialize by kind.

Done (2026-10-24): the session and the widened persistence helpers.
`app/decisions/use-decision-session.client.ts` implements the handle above
over D27's transitions. Its `prepareCredential` option takes the run's frozen
`ResolvedDecisionTarget`, so a retry never follows a target selection changed
since the run started. Its `open` composes `prepareCredential` and
`executeDecision`; a paused run sets `retryAvailableAt` from the 429's headers
when it pauses, and a timer clears it once the wait is over, so Retry reads
as available without the view polling. A finished run autosaves once, as
chat's does; a trace opened from the project is not saved back. Chat callers
pass `{ kind: "chat", trace }`, and chat's saved bytes are unchanged.

`tests/decision-session-interaction.test.mjs` drives the hook in jsdom:
completion, Stop in flight with late events ignored, the 429 wait and a retry
of the frozen input, Stop while paused, autosave, and adoption. It was written
after the hook, so it was not run red first. Removing the wait guard, the
invalidation, the paused Stop, or the persisted-run guard each made it fail.
The hook has no user-visible surface until the Compose owner mounts it.

Done (2026-10-24): the Compose owner and topbar.
`app/compose/use-compose.client.ts` selects one `ComposeKindHandle` per kind;
`app/decisions/use-decision-compose.client.tsx` builds the decision handle
from its draft, target, and session, and the route builds chat's from its
existing session, response, and inspector. Two changes from the sketch above:
the `run` primary carries `disabled` and `disabledReasonId` instead of a
reason string, because the topbar names the element that states the reason
in visible text rather than using a tooltip; and the handle also carries
`shortcut`, `inspectAvailable`, and `responseStatus`, which the shell and ⌘↵
read. The Chat / Decision switch (`app/compose/compose-kind-switch.client.tsx`)
sits above the request pane in the shell's new `toolbar` slot.

### D30. Opening a trace of either kind *(accepted: A)*

History and Import run trace now get a `SavedRunTrace` of either kind.

- **A. The Compose owner dispatches by `kind`.** It stops whichever kind is
  executing, switches to the trace's kind, and calls that session's
  `adoptTrace`. This is what chat import does today: opening a trace already
  stops a live chat run. D17's lock covers the switch control, not an
  explicit open.
- **B. Disable opening traces while anything executes.** This is stricter,
  but it changes chat's current behaviour.
- **Recommendation: A.** The decision row in Runs becomes selectable and, as
  D22 says, opens Decision Compose's inspection state.
- **Accepted: A.**

Done (2026-10-24): `Import run trace…` parses either kind and the route's
`openSavedTrace` dispatches it; the Runs decision row reads the file through
`readSavedTrace` and opens the same way. Opening a chat trace from an
evaluation case or a baseline comparison also switches Compose to Chat first.
A chat import still leaves the mode as it was; a decision opens Compose's
inspect view.

### Phase 5 decisions (D31–D37)

Checks run only inside experiments (evaluation suites and repeated runs), a
check is stored only on an evaluation case, and the CLI runs only what the
project owns. Decision checks and CLI support therefore both wait on
project-owned decision requests (D4-A), which fixes the order: 5a, then 5b,
then 5c (see [Phase 5](#phase-5-checks-cli-evaluations)).

### D31. Project-owned decision requests *(accepted: A)*

D4-A, in project schema 13.

- **A. A request with immutable revisions,** like conversations:
  `decisionRequests` and `decisionRequestRevisions`, each revision holding
  the `DecisionInput` (`state` and `questions`). A suite pins one revision.
- **B. One mutable object per request.** Simpler, but editing it would
  change what a past suite result claims to have run.
- **C. Input owned by the suite.** Nothing to share, and nothing for Compose
  to save into.
- **Recommendation: A.** It gives decision suites the reproducibility chat
  suites already have.
- **Accepted: A.**

### D32. How cases vary a decision request *(accepted: A)*

- **A. Template variables in string leaves** of `state` and `instructions`,
  through the existing template engine. Case values stay strings, as they are
  today.
- **B. A whole `state` per case** (string or JSON); questions stay fixed.
- **C. Bindings that target a JSON location** and take any JSON value. Most
  flexible, but case values stop being strings, which ripples through the
  project format.
- **Recommendation: A.** D4 deferred template variables in `state` to A. A
  `state` that is a single `{{state}}` string covers B.
- **Accepted: A.**

### D33. Decision suites beside chat suites *(accepted: A)*

- **A. A suite union discriminated by `input.kind`.** A decision suite's
  execution holds a target and repetitions only: no response mode, options,
  tools, or turn ceiling. Its configurations override the target only.
- **B. A separate `decisionEvaluationSuites` list.**
- **C. One shape with chat-only fields ignored.**
- **Recommendation: A.** The decision target is typed to
  `DecisionWireProtocol`, since `ExecutionTarget.protocol` is chat-only. The
  connection requirement is unchanged: D9 keeps the System One declaration
  device-local.
- **Accepted: A.**

### D34. Decision check vocabulary *(accepted)*

Check vocabulary 5. Each kind names one question id:

- `decision-choice`: `{ questionId, option, negate? }`.
- `decision-option-probability`: `{ questionId, option, comparator:
  "at-least" | "at-most", value }`. For a score question, `option` is the
  level number as a string, the key the answer's `probabilities` use.
- `decision-score-range`: `{ questionId, min?, max? }`, inclusive, against
  the fractional score; at least one bound.
- `decision-noul`: `{ questionId, comparator: "at-least" | "at-most", value }`,
  one kind with a comparator like `tool-call-count`.
- `decision-confidence`: `{ questionId, atLeast }`. Choice and score only;
  an answer without confidence is `not-evaluated`.

Probability and confidence values are in [0, 1]. A question id missing from
the pinned revision, or a question of the wrong type for the kind, is a
preflight diagnostic, not a parse error, as a missing template variable is.
A decision suite refuses chat output checks when authored, rather than
storing them to report `not-evaluated` (D7 still holds for that case
elsewhere); chat suites refuse decision kinds. `max-duration-ms` and
`max-total-tokens` apply to both.

**Accepted** as recommended, adding `decision-option-probability`.

### D35. Running a decision suite *(accepted: A)*

- **A. Extend the experiment plan, result, and scheduler** with a decision
  cell `kind`, as D5 did for traces, bumping both schemas. Checks read a
  separate decision check subject (the normalized answers plus duration and
  usage) rather than overloading `RunCheckSubject`'s chat fields.
- **B. A separate decision experiment pipeline.** Isolated, but it duplicates
  scheduling, concurrency, result writing, and assessment that the app and
  CLI already share.
- **Recommendation: A.** Rate-limit retry follows D23.
- **Accepted: A.**

### D36. CLI surface *(accepted)*

`run` dispatches on the suite's kind; flags, credentials, `--no-auth`,
`--retry-rate-limits`, and exit codes are unchanged. `repeat` stays
chat-only, since it would need a "current decision request" project default,
and there is no ad hoc `decide <file>` command.

### D37. Decision Compose and the project *(accepted: A)*

- **A. Decision Compose edits a project-owned request,** as Messages edits a
  conversation: saving appends a revision, and a suite can start from it.
- **B. Compose stays ad hoc,** with a "Save as decision request" action.
- **Recommendation: A.** D18's draft is already a portable `DecisionInput`,
  so the change is mostly persistence. Before the route grows, 5a names the
  owner of the project-backed decision draft and its contract.
- **Accepted: A.**

### 5a decisions (D38–D43) *(accepted)*

The user accepted each recommendation.

- **D38. Revisions like conversations.** `decisionRequests[{ id, name }]` and
  `decisionRequestRevisions[{ id, decisionRequestId, parentRevisionId?,
  decision, values, createdAt }]`, with ids `decision-request_…` and
  `decision-revision_…`. `decision` is a `DecisionInput` and is
  order-sensitive in every serialization, as in traces. The active revision
  is edited in place; once it has run in this session or was loaded from
  disk, the next edit appends a child revision and moves the pointer, as
  template edits on a conversation do.
- **D39. The active request.** Optional `defaults.decisionRequestRevisionId`.
  No decision target is stored in 5a: the target stays session-local, and
  suites carry their own in 5b.
- **D40. Variables.** `{{name}}` may appear in string values anywhere in
  `state` and in question `instructions` (string leaves included), never in
  object keys or criteria; `\{{` escapes. A revision's `values` hold one
  string per variable, may name only variables its input uses, and never a
  secret-like name. Resolution reports the template engine's diagnostics, and
  any diagnostic blocks the run, as `prepareProjectRevisionRun` does for
  chat. The trace keeps the resolved input that was sent, so its format is
  unchanged. Case values override `values` in 5b.
- **D41. Project schema 13.** v12 opens by adding the two empty arrays; v10
  and v11 upgrade through it. Check vocabulary stays 4 until 5b.
- **D42. Ownership.** Pure core functions in `decision-request.ts`
  (create, update-or-branch, resolve) and project validation in `project.ts`.
  `useDecisionCompose` stays the feature owner; `useDecisionDraft` gains the
  revision's values and an `adopt`. The project workspace folds the decision
  owner's contribution into `currentProjectDocument()` and hands it the
  active revision on load. The route keeps one adapter connecting the two,
  because the workspace is built before the decision owner.
- **D43. No project open.** Compose is ad hoc as today. Materializing or
  saving a project includes the draft as a request named "Decision request"
  when the draft is valid. A project with no request gains one at the first
  valid decision edit.

The project holds only a draft that validates (D18): while the editor shows
problems, the revision keeps its last valid content and the composer says the
draft is not saved to the project.

### 5b decisions (D44–D51) *(accepted)*

D33–D35 fixed the direction: a suite union, check vocabulary 5, and one
shared experiment pipeline. These settle the contracts 5b builds against.
The user accepted each recommendation. Where an option refines the wording
of D34 or D35, it says so.

What exists today, which shapes the options: `EvaluationSuite` is chat-only
(`input.kind: "conversation-revision"`, tools, response mode, options, turn
ceiling). Cases key their values by input binding, and a binding targets a
template use's variable. The experiment plan (schema 4) snapshots resolved
chat input per case. Both `ExperimentController` and
`evaluationParsedExperimentAggregateSteps` are typed to `RunState`,
`RunTrace`, and `ProviderTurnTransport`. The result (schema 6) records only
cell dispositions, concurrency, and the retry policy, so it does not depend
on what a cell ran.

#### D44. The decision suite shape *(accepted: A)*

- **A. Two arms under one `EvaluationSuite` union**, with a shared base
  (`id`, `name`, `variants`, `inputBindings`, `cases`):
  - `ChatEvaluationSuite`: today's shape, unchanged.
  - `DecisionEvaluationSuite`: `input: { kind: "decision-request-revision",
    decisionRequestRevisionId }`, `execution: { target:
    DecisionExecutionTarget, repetitions }`. Variants are `{ id, name,
    overrides: { target?: Partial<DecisionExecutionTarget> } }`.
  - `DecisionExecutionTarget` is `{ connectionRequirementId, model,
    protocol: DecisionWireProtocol }`. Nothing about System One goes into
    `ConnectionRequirement`, because D9 keeps the declaration device-local.
- **B. Make the shared fields generic** (`EvaluationSuite<Input,
  Execution>`). Saves a little repetition, but generic Zod schemas and error
  messages get harder to read.
- **Recommendation: A.** Existing suites already carry
  `input.kind: "conversation-revision"`, so they parse unchanged and need no
  migration.

#### D45. How case values reach decision variables *(accepted: A)*

- **A. Reuse input bindings with a new target kind,** `{ kind:
  "decision-variable", variableName }`. `EvaluationCase` stays exactly as it
  is (`values` keyed by binding id), so the case table, promotion, alignment,
  and comparison keep one code path. A case value overrides the revision's
  `values` for that variable (D40). A variable with no binding keeps the
  revision's value. A variable that still has no value after that is the
  existing `unresolved-template-variable` diagnostic, which blocks the run.
- **B. Key case values by variable name** for decision suites. There are
  fewer concepts for the author, but cases split into two shapes, and every
  case consumer has to branch.
- **Recommendation: A.** Bindings must name a variable the pinned revision
  uses, and a secret-like name is refused, as in D40.

#### D46. Check vocabulary 5 and project schema 14 *(accepted: A)*

Checks are stored on cases, so the vocabulary bump forces a project bump
(see `CHECK_SCHEMA_VERSION`).

- **A. One bump.** `CHECK_SCHEMA_VERSION = 5` adds D34's five kinds, and
  `checkVocabularyIssue` refuses them below 5. `PROJECT_SCHEMA_VERSION = 14`
  adds the decision suite arm and the decision binding target. v13 opens
  as-is, and v10–v12 upgrade through it, as today.
  - Project validation also refuses, structurally, a decision kind in a chat
    suite, a chat output check in a decision suite, and a binding target of
    the wrong kind. D34 says these are refused when authored. This makes a
    hand-edited file fail the same way.
  - The D34 preflight problems need the pinned revision, so they stay
    diagnostics: `missing-decision-question`, `wrong-question-type`, and
    `unknown-decision-option` (an option or level that is not in the
    question's criteria).
- **B. Ship suites in 14 and checks in 15.** That bumps twice for one
  feature, and a decision suite in 14 could hold only duration and token
  checks.
- **Recommendation: A.**

#### D47. Experiment plan and result versions *(accepted: A; refines D35)*

- **A. A plan-level kind, plan schema 5, result unchanged.**
  - The plan union gains `kind: "decision-evaluation"`. Its `suite`
    snapshot holds `decisionRequestRevisionId`, `inputBindings`, the case
    snapshots, and the variant snapshots, with no tools.
  - A case snapshot holds `input: { decisionRequestId,
    decisionRequestRevisionId, decision, resolvedAt }`. `decision` is the
    resolved `DecisionInput` that is sent, and it is order-sensitive in
    serialization, as in traces (D38).
  - A variant snapshot holds `{ variantId, name, target }`.
  - Cells keep today's shape (`caseId`, `variantId`, `repetition`, `runId`).
    One suite is one kind, so a per-cell `kind` would allow mixed plans that
    can never happen.
  - `EXPERIMENT_SCHEMA_VERSION = 5`, so an older build reports "newer
    version" rather than "invalid". Version 4 plans keep opening, read as
    their v5 equivalent.
  - The result stays at schema 6. A decision cell's disposition is the same
    `TerminalRunStatus` kind, and concurrency and the retry policy mean the
    same thing. D35 said "bumping both"; this narrows it to the plan, the
    only file whose shape changes.
- **B. A per-cell `kind` in a single evaluation plan,** as D35 literally
  worded it.
- **C. Bump the result to 7 as well,** with no field changes, so that a
  version always moves with its plan.
- **Recommendation: A.**

#### D48. The decision check subject and evaluation *(accepted: A)*

- **A. One `evaluateCheck` over a subject union,** `{ kind: "chat", … } |
  { kind: "decision", … }`.
  - `DecisionCheckSubject` is `{ unavailable?, answers?:
    Record<questionId, DecisionAnswer>, totalDurationMs?,
    totalTokenCoverage?, reportedTotalTokens? }`, projected once from a
    `DecisionRun`.
  - `totalDurationMs` means what chat's does: wall time from the run's start
    to its last event, retries included.
  - Tokens come from the completed attempt's reported `usage`. Absent usage
    stays absent, so a token check is `not-evaluated`, never zero.
  - A kind evaluated against a subject of the other kind is `not-evaluated`,
    not a throw. Authoring and validation already prevent it, so this guards
    old artifacts only.
  - On a completed run, an answer missing for the check's question,
    or of the wrong type, is `not-evaluated` with a reason. So is a
    probability key the server omitted.
- **B. A separate `evaluateDecisionChecks`.** Both kinds share
  `max-duration-ms` and `max-total-tokens`, so those would be implemented
  twice, and the aggregate would branch at every call.
- **Recommendation: A.** This is the "separate decision check subject" D35
  asked for, behind one entry point. Check evidence stays measurements only:
  the observed choice, probability, or score, never instructions or state.

#### D49. Generalizing the experiment controller *(accepted: A)*

- **A. A per-kind cell executor behind the shared scheduler.** The
  controller keeps planning order, connection limits, the 429 connection
  pause, the retry policy, stop, and result writing.
  - A `CellExecutor<State, Trace>` starts one cell and reports terminal
    state, trace, and rate-limit retries.
  - The chat executor is today's `runCell`. The decision executor drives
    `driveDecisionAttempt` and retries a 429 through the same policy and wait
    (D23).
  - Options take either `transport` (chat) or `decisionTransport`
    (decision), checked against the plan kind. Tool bindings do not apply to
    decision plans.
  - Progress becomes `ExperimentProgress<State>`, and `onTerminalTrace`
    receives the kind's trace.
- **B. Branch on the plan kind inside `runCell`.** It is quicker to write,
  but chat's tool-serving and turn-ceiling code ends up beside decision code
  it never touches.
- **Recommendation: A.** D35 rejected a separate controller. A is how one
  controller serves two kinds without a branch inside each method.

#### D50. Scoring decision repetitions *(accepted: A)*

- **A. Project each cell into common repetition evidence before scoring.**
  The projection, `{ status, rateLimited, rateLimitRetries, metrics,
  subject }`, comes from a `RunState` or a `DecisionRun`.
  `evaluationParsedExperimentAggregateSteps` then classifies, counts, and
  scores one way.
  - The aggregate, reassessment (criteria overrides), baselines, and
    comparison work for decision suites without kind branches.
  - Comparing a chat execution with a decision execution is refused, the
    way a different suite is refused today.
- **B. A parallel decision aggregate.** It would duplicate classification
  rules that must not drift, such as a 429 counting as missing evidence
  rather than failure.
- **Recommendation: A.**

#### D51. Authoring and results in the app *(accepted: A)*

- **A. The same Evaluations surface, with a kind-specific settings owner.**
  - The rail lists both kinds, with a kind label.
  - `evaluation-suite-editor` composes a per-kind "Input and execution"
    section. Chat keeps the current one. The decision section, owned by a
    new `useDecisionSuiteSettings`, picks the request and revision,
    the target (System One profiles only, through the D29 decision
    target), and repetitions.
  - Cases, bindings, and the check editor stay shared. The check picker
    offers only the kinds valid for the suite's kind and lists the pinned
    revision's question ids and options.
  - Decision Compose gains "New suite from this request", which pins the
    active revision (D37).
  - A repetition in results opens its decision trace in Decision Compose,
    as Runs already does.
  - Promoting a decision trace to a case waits for later.
- **B. A separate Decision suites surface.** Its ownership is simpler, but
  it duplicates the rail, case table, results, reassessment, and baselines.
- **C. Author decision suites only from Decision Compose.** Then no surface
  would list or compare them.
- **Recommendation: A.** The editor is 919 lines. Before it grows, 5b moves
  chat's input-and-execution block into its own owner. That move is
  behavior-preserving and lands first, under the existing specs.

#### D52. Execution drift between decision executions *(accepted: A; refines D50)*

D50 has comparison and baselines work for decision suites without kind
branches. Step 3 left them refusing a decision execution: `derive()` in
`evaluation-comparison.ts` and the baselines loader both throw on any plan
that is not a chat evaluation. Case alignment needs nothing, because it reads
only values, reference answers, and checks. Baseline pins need nothing either,
because a pin is an `experimentId` and a `variantId`, so the baselines file
keeps its version. What does need a decision is `EvaluationExecutionDrift`,
whose fields are chat-shaped: `inputRevision` reads `conversationRevisionId`,
and `responseMode` and `optionsChanged` do not exist on a decision variant,
which varies only its target (D33). A comparison is derived on open and never
persisted, so this is an internal contract between core and the comparison
view, not a serialization boundary.

What each kind could report:

| Field | Chat | Decision |
|---|---|---|
| Input revision | conversation revision | decision request revision |
| Model, endpoint | yes | yes |
| Repetitions, concurrency | yes | yes |
| Response mode, options changed | yes | no |
| Wire protocol | no | candidate |
| Capability snapshot | no | candidate |

- **A. A kind-discriminated drift.** `EvaluationExecutionDrift` becomes a
  union on `kind`. Both arms carry input revision, model, endpoint,
  repetitions, and concurrency; the chat arm adds response mode and options,
  and the decision arm adds its own fields. `DriftList` selects its rows by
  kind.
  - The type cannot express a combination that never occurs.
  - It follows the per-kind split in plans (D47) and cell executors (D49).
  - It costs a small change to the one consumer and to the comparison tests.
- **B. Extend the flat shape.** `inputRevision` carries whichever revision id
  applies, decision executions never set the chat-only fields, and an optional
  `protocol` is added. It is the smallest diff, but the type no longer says
  which fields apply to which kind.
- **C. Shared fields only.** Decision drift reports what both kinds share and
  nothing kind-specific. It is the simplest, but a change of decision adapter
  shows only as an endpoint change, which is usual but not guaranteed.
- Under A or B, the decision fields to report: the wire protocol, yes; the
  capability snapshot, no. `ProviderCapabilities` holds connection-wide flags
  (tools, streaming, vision) that a decision request does not depend on, so
  its drift would mostly be noise.
- Whichever option is taken, the following hold and need no decision:
  - `derive()` accepts a `SuiteExperimentPlan`.
  - Durations come from the D50 repetition evidence `metrics` instead of
    `runMetrics(RunState)`.
  - Comparing a chat execution with a decision execution stays refused (D50).
  - The baselines loader opens decision traces.
  - Comparing different suites behaves as it does for chat.
- **Recommendation: A, with protocol drift and without capability drift.**
  Its cost over B is small, and it keeps the per-kind pattern D47 and D49
  set. The user accepted it.

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

The implementation below is merged. D16 records the correctness fixes made
before Phase 3 work begins.

- ✅ Web service: `POST /api/decisions` (D14) executes one exchange with the
  server-held credential and streams D12's `DecisionTransportEvent`s as NDJSON.
  Core owns the pieces (`decision-execution.ts`): the redacted request, the
  whole body as frame 0 (an error body included), then the normalized result,
  or the protocol's own error message with the status. `executeDecision`
  shares the chat turn's failure mapping. `HttpInferenceTransport` implements
  the separate `DecisionTransport` contract.
- ✅ `INFERENCE_LENS_API_PROTOCOLS` accepts `systemone` (D9a-A): parsed apart
  from the chat protocols, reported as `systemOne` in runtime status beside
  `protocols` (empty for a decision-only list), and applied to the server
  default profile by `withServerProtocols`. The drawer toggle it locks arrives
  with the toggle in Phase 3. `docs/DOCKER.md` documents it.
- ✅ Tauri: `WireProtocol::SystemOne` with its path and Bearer credential, and
  `/systemone` in `PROTOCOL_PATHS`. Decisions use the existing buffered raw
  proxy (`start_provider_turn`, `streaming: false`); Rust still parses
  nothing. The webview reads the body with the same core pieces as the web
  service.
- ✅ Decision-model discovery (D10-B, D13): `discoverDecisionModels` runs the
  three steps against an injected fetcher, unit-tested against
  `openrouter-models`, `ollama-models`, and `llamacpp-models`. Rust's
  `discover_models` takes a `listing` name (`chat`, `decisions`,
  `ollama-tags`) and builds each URL itself.
- ✅ The fixture provider, `npm run dev:systemone-provider` (D11-B, D15), with
  a fourth personality, `/ollama-proxied/v1`, for D10's step 3 (a proxy that
  forwards only `/v1/*`). `tests/system-one-provider.test.ts` runs it as a
  process and reaches every discovery step and each runtime's error envelope
  through the host code.
- Verified against the running dev server (2026-10-24): `/api/models` returned
  each personality's decision listing (the proxied one flagged `unfiltered`),
  and `/api/decisions` returned answers, the synthetic 429 with its
  `retry-after`, and a 400 for a request with no questions. The Tauri webview
  path was exercised only in a scratch harness with mocked IPC, not in the
  desktop app; the Rust tests ran on Linux.
- The four doc-derived fixtures (`typesafe-all-types`, `typesafe-422`,
  `openrouter-extras`, `openrouter-error`) don't block this phase: captured
  fixtures cover every response shape it uses. They are replaced when a
  TypeSafe key is available. The fixture provider never serves them.

### Phase 3: UI

Prerequisite: D16's committed regression coverage, preserving the complete
error body on the shared path (D25), is in; its native-app check is still owed. Delivery: ship with Phase 4
(D20), implementing trace support early.

Order: D16 → the decision trace format (D22) → the behaviour-preserving
evidence extraction (D26) → the decision session and UI. All of it is in.

Implemented (2026-10-24), in one change at the user's choice so the switch
appears only once Decision is usable:

- ✅ Compose owner, topbar `primary`, ⌘↵, and the kind switch (D29-A); trace
  opening by kind (D30); the activity guard (D24).
- ✅ The D18 draft (`app/decisions/decision-draft.ts`, pure, and its hook),
  covered by `tests/decision-draft.test.ts`. Strings are edited as text; any
  other JSON value is shown and left to the JSON view, so nothing is
  stringified. Option rows are kept across every type change (U4): a score
  reads an option's label as the level and keeps its description. A
  structured level kept on a choice question is refused by validation and by
  the switch to the JSON view, since a choice label is an object key; it is
  never stringified, so changing back to score restores it.
- ✅ The decision target (`use-decision-target.client.ts`): System One
  profiles only, a model remembered per connection for the session, and
  discovery through `useModelDiscovery`, which now takes a
  `ConnectionProtocol` and keeps `unfiltered`.
- ✅ Views: the composer, the result (`decision-result-view.ts`, covered by
  `tests/decision-result-view.test.ts` against the captured all-types values),
  the failure card with the D23 countdown, and the inspect pane on the shared
  `RequestEvidence` plus the response status, headers, and raw body. The
  trace-storage notice moved out of chat's response pane unchanged so both
  kinds share it.
- ✅ The Connections switch for System One (D9-B), locked with the chat APIs
  when the server declares its list (D9a).

D21 browser coverage: `tests/e2e/system-one-decisions.spec.ts` against the
fixture provider, which the suite now starts on port 44028, plus additions to
`runs-result-discovery` (the history row opens Decision Compose) and
`provider-protocols` (the server's declaration is shown locked and offered
for decisions). Not covered in the browser: the batch direction of D24 (a
decision Run refused while a batch runs), retry of a frozen input after the
selected target changed, and the native desktop paths. The 429 coverage is
limited as D23 says: the fixture answers every request with 429, so a
success after the wait is not shown. The specs and the two unit test files
were written after the code they cover, so none was run red first.

Review fixes (2026-10-24), each with its test run red first: a structured
level on a choice question no longer stringifies in the JSON view
(`decision-draft`); a paused run's Retry is disabled with the refusing
activity stated beside it (`decision-response-render`); the editor and state
format tabs are inert while a decision runs, and chat's diagnostics are not
offered while Decision is on screen (`system-one-decisions`). That spec now
also checks that ⌘↵ sends no second request during a run and that a retry
sends the run's frozen input; both held before and were not shown failing.

- Ownership and shell integration follow D19: the decision feature owns its
  state and workflow; the Compose owner selects the active kind's panes,
  readiness, and commands for both the topbar and keyboard shortcut.
- Implement the decision session with a frozen execution snapshot, attempt
  evidence, cancellation, invalidation, and Retry (D17), with the 429 wait in
  D23. Lock kind switching during execution; retain each kind's draft, target,
  and latest result. A decision run joins the shared foreground-activity guard
  (D24).
- Composer: the D18 draft drives a structured form and whole-input JSON
  editor. State has a text/JSON toggle; questions expose type, id,
  instructions, options or ordered levels, and optional noul true/false.
  Preserve JSON values and reversible edits, and block invalid input.
- Result view: one row per question.
  - Choice: the selected option, a bar per option in authored order, and
    confidence when supplied.
  - Score: the fractional score on the level scale, a bar per level labelled
    from `legend`, and confidence when supplied.
  - Noul: P(true), without a confidence placeholder.

  Shared evidence presentation shows the redacted request, response, raw body,
  duration, and reported usage without chat-only inspection controls (D19).
- Connection drawer: the System One profile toggle (D9-B), locked when the
  server declares its API list (D9a). Model discovery retains and displays
  `unfiltered` and supports typed ids (D10, D19).
- Committed browser specs against the fixture provider cover D21; see
  `tests/e2e/README.md`. Enable the feature for release only after Phase 4's
  round-trip and history checks pass too.

### Phase 4: traces and history

Implement trace support early in the combined Phase 3/4 delivery (D20).

Implemented with Phase 3 (2026-10-24). Decision runs export and import
through Run data and render the same answers and evidence after import
(`system-one-decisions` round trip), and a saved one reopens from Runs
(`runs-result-discovery`). Autosave into the project folder is covered by
`decision-session-interaction` in jsdom, not by a browser spec. Runs lists
only chat's live run as the current entry; a live decision run appears there
once it is saved.

- Trace schema 8 with the `kind` discriminator (D5) and the decision trace
  shape in D22; decision traces save, reload, import, and export with executed
  input, attempts, normalized answers, and complete exchange evidence. Missing
  `kind` still means chat, and chat traces at schemas 1–7 still open.
- Wire decision session persistence to the existing workspace and export
  entry points, preserving save status and surfacing failures.
- History labels decision runs and opens the correct request kind and its
  result/inspection surface. Verify chat and decision entries together.
- Run D21's trace round trips and compare rendered values and evidence before
  and after reload/import. Both phases must pass before the first UI release.

### Phase 5: checks, CLI, evaluations

Decided in D31–D37, with 5a's details in D38–D43. Delivered in order:

- **5a.** Project-owned decision requests and revisions (D31) in project
  schema 13, with template variables (D32), and Decision Compose editing and
  saving them (D37).
  Implemented (2026-10-24): `decision-request.ts` and `decision-variables.ts`
  in core, project schema 13, and `useDecisionProject` beside the draft.
  Covered by `tests/decision-request.test.ts` (run red first; the key-order
  test was also shown red with `decision` removed from the order-sensitive
  keys) and `tests/e2e/system-one-decision-requests.spec.ts`. The browser
  spec was written after the app code; with the app changes stashed, its two
  main tests failed on the missing Variables fields and the unsaved request.
  The third, that an untouched draft creates no request, cannot fail on the
  old code. Not covered: the Tauri project folder, and opening a request
  while a decision run executes.
- **5b.** Check vocabulary 5 (D34), decision suites (D33), and their
  execution through the shared experiment pipeline (D35), with suite
  authoring in the app. Contracts accepted in D44–D51.
  First step done (2026-10-24): D51's behavior-preserving move. A chat
  suite's setup band now lives in `app/evaluations/chat-suite-setup.client.tsx`
  (`ChatSuiteSetup`, plus `chatSuiteSetupFacts`, which returns the
  `SuiteSetupFacts` contract the editor reads: device-local issues, collapsed
  summary facts, and the batch shape). The editor keeps the header,
  preflight, band, and cases. It has no new test of its own, since nothing
  observable changed; the existing evaluation render, interaction, and
  browser specs cover it.
  Second step done (2026-10-24): check vocabulary 5 with the decision check
  subject (D46, D48) in `checks.ts`, covered by `tests/decision-checks.test.ts`;
  and the decision suite arm with project schema 14 (D44, D45, D46), with
  decision preflight in `evaluation-suites.ts`, covered by
  `tests/decision-suites.test.ts`. The evaluator tests were run red on wrong
  values (decision kinds returned nothing; `called-tool` on a decision run
  reported failed); the vocabulary and subject tests were first red only on the
  missing exports. The suite tests were run red on the parser rejecting
  decision suites and on the missing preflight; the one asserting that
  malformed decision suites are refused could not fail on the old code. Plans and assessments written with vocabulary 4 still open
  (`structured-output-checks`, also run red first). Chat-only paths narrow to
  `ChatEvaluationSuite`; the plan builder, the app's start path, and the CLI
  refuse a decision suite until step 3, and the editor shows no setup band
  for one until step 4.
  Third step done (2026-10-24): decision suites execute through the shared
  pipeline. Plan schema 5 adds the `decision-evaluation` kind (D47), built by
  `createDecisionEvaluationExperimentPlan`; Version 4 plans open as Version 5.
  `repetitionEvidence` projects either run kind before scoring (D50), so the
  aggregate and reassessments score decision executions with no kind
  branches. `ExperimentController` hands each cell to a per-kind executor
  (`ChatCellExecutor`, today's cell loop moved unchanged, and
  `DecisionCellExecutor`) behind one scheduler (D49); a decision batch is
  `new ExperimentController<DecisionRun>({ decisionTransport, … })`. Covered
  by `tests/decision-experiment-plan.test.ts`,
  `tests/decision-experiment-scoring.test.ts`, and
  `tests/decision-experiment-controller.test.ts`. The controller tests were
  run red on the old controller refusing decision plans. The scoring tests
  were red on the old aggregate throwing on a decision run (it read chat
  events), not on a wrong value. The plan tests were red only on the missing
  exports. Chat behavior is unchanged under the existing unit suites and the
  batch browser specs. One difference is forced by D22: a decision cell
  stopped during its 429 wait ends failed with that 429, which scores as
  rate-limited, where a chat cell ends cancelled. A decision trace cannot be
  cancelled from a paused attempt. Still chat-only until step 4: the app's
  start path and the CLI (5c) keep refusing decision suites, project history
  lists a decision plan as one it cannot show, and comparison and baselines
  refuse a decision execution, because their drift fields are chat-shaped
  (D52).
  Fourth step, core half (2026-10-24): comparison accepts decision
  executions with the kind-split drift (D52), and project history lists
  decision evaluations. `EvaluationExecutionDrift` is a union on `kind`;
  decision drift reports the request revision, model, endpoint, repetitions,
  concurrency, and wire protocol. Protocol drift cannot occur yet, because
  `DECISION_WIRE_PROTOCOLS` has one member. Durations come from repetition
  evidence, and comparing a chat execution with a decision execution is
  refused. The history facet replaces `conversationRevisionId` with
  `runKind` and `inputRevisionId`, and `loadRunHistoryFilesWithStates` also
  returns decision runs by run id. Covered by
  `tests/decision-evaluation-comparison.test.ts` (red on the old refusal of
  decision plans), two additions to `tests/evaluation-comparison.test.ts`
  (red on the missing `kind` and on the wrong refusal message), and one to
  `tests/experiment-history.test.ts` (red on the "cannot be shown by this
  build yet" failure). The app half (authoring, start, results, Compose
  entry) is still to come.
- **5c.** `inference-lens run` for decision suites (D36).

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
