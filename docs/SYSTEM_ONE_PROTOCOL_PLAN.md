# System One protocol plan

Status: **draft, unverified.** Written without network access to the primary
documentation. Every fact about the wire format below comes from search-result
summaries and third-party write-ups, and is marked with a verification item in
[Phase 0](#phase-0-verify-the-wire-format). No implementation starts until
Phase 0 is done and the [open decisions](#decisions) are settled.

## Goal

Let Inference Lens send requests to *System One* (decision) models and inspect
the result with the same evidence guarantees it gives chat runs: a redacted
request, the raw response, normalized results, saved traces, and checks.

This is support for a wire protocol, not for a vendor. Nothing here is specific
to TypeSafe or Jev.

## What we believe the landscape is

There appears to be **one** format, introduced by TypeSafe with Jev and adopted
by the local runtimes:

| Implementation | Endpoint | Notes |
| --- | --- | --- |
| TypeSafe (Jev) | `POST https://api.typesafe.ai/v1/systemone` | Reference format. Models `jev-1.13.0`, `jev-latest`, `jev-preview`. |
| DigitalOcean, Databricks, LiteLLM | `<their base>/v1/systemone` | Hosted re-serving of the same shape. |
| llama.cpp `llama-server` | `/v1/systemone` | Merged in ggml-org/llama.cpp#29818 (2026-10-02). Said to follow TypeSafe's format exactly. |
| Ollama ≥ 0.35 | `/v1/systemone` | Reported limit of 26 options per choice question (TypeSafe: 255). Secondary sources only. |
| OpenRouter | `/api/v1/systemone` **and/or** `POST /api/alpha/decisions` | The alpha "Decisions API" could have its own shape. This is the only candidate for a second format. |

The reported shape:

```jsonc
// request
{
  "model": "jev-latest",
  "state": "<text to evaluate>",
  "questions": {
    "<caller-chosen id>": { /* choice | score | noul question */ }
  }
}

// response
{
  "model": "jev-1.13.0",
  "answers": {
    "<same id>": { /* typed value + probabilities (+ confidence) */ }
  },
  "usage": { "input_tokens": 0, "output_tokens": 0 }
}
```

Question types:

- **choice**: one of up to 255 options. The answer has the selected option,
  a probability per option, and a confidence.
- **score**: an ordered scale of 2–10 levels. The answer has a position,
  a probability per level, and a confidence.
- **noul**: yes/no. The answer is a single probability between 0 and 1.

Reported limits: text-only input, 64k tokens of context (state plus all
questions), roughly 70–500 ms per response. Nothing found mentions streaming,
tools, or multi-turn state.

## Why this is not "add a fourth protocol"

The protocol layer would take this easily: `PROVIDER_WIRE_PROTOCOLS`,
`provider-protocols.ts` (path, credential headers, capability, label),
`provider-adapters.ts`, and the Tauri `WireProtocol` enum are each one more
entry. The difficulty is that every contract *above* the adapter assumes a
chat turn:

| Contract | Chat assumption | System One reality |
| --- | --- | --- |
| `ResolvedRunInput` / `ProviderTurnInput` | `messages`, `tools`, `options.temperature` | `state` + `questions`; no messages, tools, or sampling options known |
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

Per `AGENTS.md`, these are open until the user confirms them. Each lists the
options and a recommendation.

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
- **Recommendation: B.** A connection can say "this server also speaks System
  One" (llama-server and Ollama will serve both from one base URL), while a chat
  run cannot type-check against a decision adapter.

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
  retry).

### D3. Provider-neutral result representation

Proposed normalized answer type, owned by `packages/core`:

```ts
type DecisionAnswer =
  | { kind: "choice"; value: string; probabilities: Record<string, number>; confidence?: number }
  | { kind: "score"; value: number; probabilities: number[]; confidence?: number }
  | { kind: "noul"; probability: number };
```

The raw response body is always kept as frame evidence next to the normalized
answers, as raw SSE lines are for chat runs. Open points for Phase 0: whether
score levels are labelled or just indexed, and whether choice probabilities are
keyed by option text or by index.

- **Recommendation:** normalize to the shape above. Store unknown extra fields
  in the raw evidence only, not in the normalized type. Treat an answer that is
  missing or ill-typed as a `ProviderProtocolError`, as other adapters do.

### D4. Authored input and project format

What does a user edit and save?

- **A. A new project-owned `DecisionRequest`** (state + questions), revisioned
  like conversations. Bumps the project schema to 13.
- **B. Ad hoc only:** decision requests live in the composer and in traces,
  not in the project, until the shape settles.
- **Recommendation: B first, then A.** Ad hoc runs plus saved traces are enough
  to prove out the adapter and the result view without committing the project
  format. Template variables in `state`, and saved question sets, come with A.

### D5. Trace format

- **A. Same `traces/` directory, new trace `kind` discriminator.** Absent means
  chat, so existing traces stay valid. Bump `RUN_TRACE_SCHEMA_VERSION` to 8.
- **B. Separate directory and file format.**
- **Recommendation: A.** Run history, import, and export keep one entry point,
  and the history list can label the kind.

### D6. Capabilities and per-runtime limits

- Add one capability, `systemOne`, that declares the connection serves the
  protocol. `streaming`, `tools`, and `structuredOutput` don't apply to it.
- Do **not** model per-runtime limits (Ollama's 26 options) as capabilities.
  When a server rejects an oversized request, show its error as evidence. Add a
  soft pre-flight warning later only if users hit it.
- Response mode is always buffered. The composer hides the streaming toggle for
  this protocol rather than offering a mode that doesn't exist.

### D7. Checks and evaluations

- Chat output checks report `not-evaluated` on a decision run, following the
  existing rule that a check that cannot apply is never a failure.
- `max-duration` and `max-total-tokens` apply unchanged.
- New check kinds, in a later phase: answer equals, probability at least /
  at most, confidence at least, for a named question id.
- Evaluation suites over decision requests depend on D4-A and come last.

## Phases

### Phase 0: verify the wire format

Do this in a session with network access. Record the results in this document
and update the decisions above if anything contradicts them.

- [ ] Exact request body for each question type: field names for options,
      levels, labels, and question text.
- [ ] Exact response body for each type: how choice probabilities are keyed,
      whether score levels are labelled, whether `confidence` is always present.
- [ ] Error response shape and status codes (oversized input, too many
      options, unknown model, unknown question type).
- [ ] Authentication: `Authorization: Bearer` or something else, for TypeSafe,
      OpenRouter, and keyless local servers.
- [ ] Whether any implementation streams, batches multiple states, or accepts
      sampling options (temperature, seed).
- [ ] Whether `usage` is reported by llama.cpp and Ollama, not only TypeSafe.
- [ ] llama.cpp: confirm byte-level compatibility with TypeSafe; option and
      level limits; whether `/v1/models` lists decision models.
- [ ] Ollama: confirm the 0.35 endpoint, the 26-option limit, and model
      discovery.
- [ ] OpenRouter: whether `/api/alpha/decisions` is a different shape from
      `/v1/systemone`. If it is, decide whether to support it at all (it is
      alpha); the recommendation is not to, unless it is the only route to a
      model users need.
- [ ] Capture one real request/response pair per implementation as fixture
      material (redacted), following `docs/PROVIDER_FIXTURES.md`.

### Phase 1: core contracts and adapter (no UI)

- Connection-level protocol entry, `systemOne` capability, path
  `/systemone`, label, credential headers (`provider-protocols.ts`, `types.ts`).
- `DecisionRequest`, `DecisionAnswer`, `DecisionRun` types and a pure
  `DecisionProtocolAdapter` (build request, normalize response) in
  `packages/core`.
- Unit tests from the Phase 0 captures, written red first, covering each
  question type, missing answers, ill-typed answers, and provider error bodies.

### Phase 2: hosts

- Web service HTTP route executes a decision request with the server-held
  credential, mirroring the chat transport's redaction.
- Tauri: add the protocol to the closed `WireProtocol` enum, with its path and
  credential handling; Rust still does no protocol parsing.
- A fixture provider, `npm run dev:systemone-provider`, next to the flaky and
  paced fixtures, serving deterministic answers for all three question types
  plus an error mode.

### Phase 3: UI

- Route ownership: a new feature owner under `app/decisions/` holds the
  composer state, the run workflow, and the result view. The workbench shell
  and mode strip only compose it; no decision state lives in the route.
- Composer: state text plus a question list editor (type, id, options or
  levels).
- Result view: one row per question with the selected value, the probability
  distribution (bar per option or level), and confidence; raw request and
  response in the existing evidence panel.
- Connection drawer: the `systemOne` capability toggle.
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

- A TypeSafe- or Jev-specific integration.
- Converting decision answers into chat completions, or the reverse.
- Running decision models in-process.

## Sources (not opened directly; see status note)

- TypeSafe docs: <https://docs.typesafe.ai/introduction/quickstart>,
  <https://docs.typesafe.ai/primitives/choice>,
  <https://docs.typesafe.ai/primitives/score>
- OpenRouter Jev guide: <https://openrouter.ai/docs/guides/community/jev>
- DigitalOcean System One API:
  <https://docs.digitalocean.com/products/inference/how-to/use-system-one-api/>
- Databricks System One guide:
  <https://docs.databricks.com/aws/en/machine-learning/model-serving/query-systemone-models>
- llama.cpp PR: <https://github.com/ggml-org/llama.cpp/pull/29818>
- ggml-org announcement:
  <https://huggingface.co/blog/ggml-org/decision-models-in-llamacpp>
- Ollama write-ups: <https://kmail.at/blog/system-one-goes-local>,
  <https://modelsystem.one/runtimes/ollama/>,
  <https://huggingface.co/iapp/OpenThai-SystemOne-Ollama>
