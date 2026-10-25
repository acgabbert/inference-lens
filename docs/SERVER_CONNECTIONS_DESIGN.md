# Several server-held connections

**Status:** decisions 1–9 agreed as recommended (October 24, 2026); for
decision 9 that is option A, so the CLI is left alone. Slice 1 (server) is in
progress.
**Baseline:** `main` at `dab81e4`, reviewed October 24, 2026.

## Goal

Let one running service hold more than one provider connection with a
server-side key, so that a web user can switch between them without
restarting the service or pasting a key into the browser.

The case that prompted this: a chat gateway and a separate decision (System
One) gateway, each with its own key, both used from the same Docker
deployment. Today one of them has to be a **Session key** profile, re-entered
in every browser session.

## Non-goals

- Per-user credentials or accounts. The service still has no users; anyone
  who can open the UI can spend every key it holds, exactly as with the single
  default today.
- Editing connections from the UI. The catalog is operator configuration.
- The desktop (Tauri) host, which never reads server-held credentials and keeps
  its own keychain profiles.
- Changing how a key is presented on the wire. Each protocol keeps its current
  header (`Authorization: Bearer`, or `x-api-key` for Anthropic).

## What exists today

| Concern | Owner | Single-connection assumption |
| --- | --- | --- |
| Reading the key, endpoint, model and protocol list | `EnvironmentCredentialStore` in `services/api/src/credential-store.ts` | Four fixed variable names |
| Selecting the server key in a request | `CredentialSelection` `{ kind: "environment-default" }` in `packages/contracts/src/inference.ts` | No way to say *which* key |
| Parsing that selection | `parseCredential` in `services/api/src/inference-request.ts` | Same |
| Telling the UI what is configured | `GET /api/runtime-status` (`app/api/runtime-status/route.ts`) | One flat object |
| Provisioning and locking the browser profile | `reconcileServerDefaultProfile` in `app/use-connection-profiles.client.ts` | Finds *the* profile whose `credentialRef` is `environment-default` |
| Per-profile authentication choice | `WebCredentialMode` in `app/web-credential-mode.ts`, stored under `inference-lens:web-credential-modes:v1` | `"environment-default"` means the one key |
| Refusing deletion, protocol locks, readiness wording | `profile-store.client.ts`, `connection-drawer.client.tsx`, `run-readiness.client.ts` | Name `INFERENCE_LENS_API_*` variables |
| Headless CLI | `packages/cli/src/credentials.ts` | Reads the same four variables plus per-requirement `INFERENCE_LENS_CONNECTION_<ID>_*` |

Two properties carry over unchanged and are what make this a medium change
rather than a large one:

- The browser never holds a server key; it sends an opaque selection, and the
  server releases the key only to the origin (scheme, host, port) the operator
  bound it to.
- `runtimeCredentialStore()` is built per request, and the command-tool catalog
  (`services/api/src/command-tool-catalog-source.ts`) is already read per call.
  Configuration can therefore change without a restart.

## Proposed shape

An operator points `INFERENCE_LENS_CONNECTIONS` at a JSON catalog and mounts it,
with the key files it names, into the container:

```json
{
  "schemaVersion": 1,
  "connections": [
    {
      "id": "chat",
      "name": "Chat gateway",
      "endpoint": "https://openrouter.ai/api/v1",
      "protocols": ["chat-completions", "responses"],
      "apiKeyFile": "openrouter.key"
    },
    {
      "id": "decide",
      "name": "Decision models",
      "endpoint": "https://decide.home.gabbert.xyz/v1",
      "model": "local-decision",
      "protocols": ["systemone"],
      "apiKeyFile": "decide.key"
    }
  ]
}
```

```yaml
# deploy/compose.yaml (excerpt)
    environment:
      INFERENCE_LENS_CONNECTIONS: ${INFERENCE_LENS_CONNECTIONS:-}
    volumes:
      - ~/.config/inference-lens:/config:ro
```

```sh
# .env
INFERENCE_LENS_CONNECTIONS=/config/connections.json
```

Each catalog entry becomes a locked profile in Connections, next to the
existing **Server default** profile when the `INFERENCE_LENS_API_*` variables
are also set. Selecting a profile selects its key. Reloading the page picks up
an edited catalog; the service is never restarted.

## Decisions to agree

### 1. Catalog format

**Recommendation:** a versioned JSON file, parsed by a pure function in
`packages/core` (alongside `command-tool-catalog.ts`) and read by a source in
`services/api/src` that mirrors `readCommandToolCatalog`.

| Field | Required | Rule |
| --- | --- | --- |
| `schemaVersion` | yes | `1`. Anything else refuses the catalog, so a future shape is never half-read. Named as the command-tool catalog names it. |
| `connections[].id` | yes | `^[a-z0-9][a-z0-9-]{0,62}$`, unique. `default` is reserved for the legacy variables (decision 2). Stable: it is the identity the browser persists. |
| `connections[].name` | no | Display name; defaults to the `id`. |
| `connections[].endpoint` | yes | HTTP or HTTPS base URL, as `INFERENCE_LENS_API_ENDPOINT` is today. User info, query, and fragment are refused rather than stripped. |
| `connections[].model` | no | Same role as `INFERENCE_LENS_MODEL`: fills an empty model, never overrides a chosen one. |
| `connections[].protocols` | no | The names `INFERENCE_LENS_API_PROTOCOLS` accepts, as an array. Absent leaves the switches with the user, as an unset variable does today. |
| `connections[].apiKeyFile` | no | Path to a file whose trimmed contents are the key. Relative paths resolve against the catalog's directory, as command-tool executables do. |
| `connections[].apiKeyEnv` | no | Name of an environment variable holding the key. Mutually exclusive with `apiKeyFile`. |

A connection with neither key field needs no key, like an endpoint-only
configuration today. **An inline `apiKey` field is deliberately not accepted.**
The catalog is a file operators will copy, mount, and share, and keeping the
secret out of it is the reason for choosing a catalog at all.

Alternatives considered: YAML (a new dependency and a second parser for one
file); an inline `apiKey` (a catalog becomes a secret, and it is easy to commit
one).

### 2. The legacy variables

**Recommendation:** the `INFERENCE_LENS_API_*` variables keep working and
describe a connection whose `id` is `default` and whose name is **Server
default**. The two sources combine: the legacy connection first, then the
catalog in file order. A catalog that declares `id: "default"` is refused,
with a problem naming the conflict, so the two sources can never disagree about
one connection.

Nothing an existing deployment does changes: no catalog means exactly today's
behavior, and the stored `server-default` profile keeps its identity.

### 3. Failure granularity

**Recommendation:** split by whether the operator can have meant part of it.

- **Structural problems refuse the whole catalog:** the file is unreadable,
  the JSON is invalid, the version is wrong, an `id` is invalid or duplicated,
  `default` is declared, both key fields are set, or an endpoint is invalid.
  The legacy `default` connection is unaffected. This matches the existing
  rule that a protocol list is "ignored as a whole rather than half applied".
- **Per-connection runtime problems leave the rest working:** a key file that
  cannot be read, an empty key, or a missing `apiKeyEnv` variable. The
  connection is still listed and its profile still provisioned, but it reports
  no credential, the same as an endpoint without a key today. Requests that
  select it fail with an error naming the connection.
- **An unrecognized protocol name** behaves exactly as today, scoped to that
  connection: its list is ignored, the server logs a warning once, and the UI
  shows the banner naming the connection.

Problems are logged once per process with full detail. The browser receives a
short reason naming the connection id ("key file could not be read") but never
a filesystem path.

### 4. Selection contract

**Recommendation:** extend the existing variant rather than adding one:

```ts
| { kind: "environment-default"; connectionId?: string }
```

An absent `connectionId` means `default`, so every request shape in use today
stays valid, including those from older CLI builds and from tests. The kind
keeps its name: it already means "a key held by the service", and renaming it
would touch every consumer for no behavioral gain.

`parseCredential` accepts a `connectionId` that matches the id pattern and
rejects anything else. `resolve()` looks the connection up by id and then applies
the existing origin check against *that* connection's endpoint. Two connections
may share an origin: selection is by id, so their keys never mix.

Model discovery and decision requests already carry a `CredentialSelection`, so
they need no separate change.

### 5. `GET /api/runtime-status`

**Recommendation:** replace the flat connection fields with a list:

```ts
{
  containerized: boolean;
  connections: Array<{
    id: string;               // "default" for the legacy variables
    name: string;
    endpoint: string;
    model?: string;
    protocols?: ProviderWireProtocol[];
    systemOne?: boolean;
    unrecognizedProtocols?: string[];
    credentialConfigured: boolean;
    problem?: string;         // per-connection runtime problem, no paths
  }>;
  catalogProblem?: string;    // structural refusal (decision 3), no paths
}
```

The page and the route ship in the same image, so no compatibility period is
needed for the old shape. The desktop host does not call this route.

Slice 1 adds `connections` and `catalogProblem` beside the flat fields rather
than replacing them, so the page keeps working until slice 2 teaches it the
list; slice 2 then removes the flat fields.

### 6. Browser profile identity

**Recommendation:**

- **`credentialRef`:** `environment-default` keeps meaning the `default`
  connection, so profiles already in storage need no migration. Catalog
  connections use `environment-default:<id>`.
- **Profile id:** `server-default` for `default` (unchanged) and `server-<id>`
  for catalog connections, with the existing random suffix on collision.
  Stable ids matter because `project-profile-map.client.ts` maps a project's
  connection requirements to profile `id` and `instanceId`, and needs no change
  of its own.
- **What the server owns:** as today, the endpoint and (when declared) the
  protocol switches and System One declaration are locked and reapplied on
  every load. The model is filled in only while empty. The name is set when
  the profile is created and is the user's to change after that.
- **Removal:** `reconcileServerDefaultProfile` becomes a loop over the union of
  reported connections and stored server-managed profiles. A profile whose
  connection is no longer reported is released: its endpoint unlocks, its
  stored server mode drops to **No authentication**, and the profile is kept.
  This is today's rule, applied per connection. A failed status probe still
  changes nothing.
- **First run:** a device with no stored profiles replaces the starting
  profile with every server profile and activates the first one (`default`
  when present, otherwise the first in catalog order).
- **Existing devices:** newly provisioned profiles are added, not switched to.
  One notice lists every profile added in this load and offers to switch to the
  first one, generalizing today's single-profile notice.
- **Deletion refusal:** the message names where the connection comes from:
  `INFERENCE_LENS_API_*` for `default`, the catalog otherwise.

### 7. Authentication choice on a user-made profile

Today any web profile can pick **Server default (.env)**. The origin check then
decides whether the key is released, and the drawer warns when the endpoints do
not match.

**Recommendation:** offer one server option per connection that holds a key
*and* whose origin matches the profile's endpoint, labeled with the connection
name, for example "Server: Decision models". Connections at other origins are
not listed, because their keys could never be released there. The stored mode
becomes `environment-default` for `default` (unchanged) or
`environment-default:<id>`. A stored mode naming a connection that is gone is
downgraded to **No authentication**, as today.

`WebCredentialMode` widens from a string union to
`"session" | "none" | { server: string }` inside the app, with the
string form used only at the storage boundary.

### 8. Reload semantics

**Recommendation:** read the catalog and every key file per request, as the
command-tool catalog does. Rotating a key, adding a connection, or removing one
takes effect for the next request without a restart. The browser picks up
added or removed connections on its next page load, because it probes
`/api/runtime-status` once per mount. Live re-probing is not proposed.

Each read is a few small files. If profiling ever shows this matters, an mtime
cache can be added behind the same interface without changing the contract.

### 9. The headless CLI

The CLI currently uses `INFERENCE_LENS_API_*` for any requirement whose
endpoint origin matches, and `INFERENCE_LENS_CONNECTION_<REQ>_*` for a specific
requirement.

**Options:**

- **A. Leave the CLI alone in this work (recommended).** The CLI is usually
  run as a one-off container whose variables are scoped to one suite, and
  per-requirement variables already cover several keys.
- **B. Origin matching against the catalog.** The CLI reads
  `INFERENCE_LENS_CONNECTIONS` and serves any requirement whose endpoint origin
  matches exactly one catalog connection, refusing an ambiguous match. This is
  a natural follow-up slice once the catalog parser exists in `packages/core`.

The `INFERENCE_LENS_CONNECTION_` prefix stays the CLI's. Server connections use
`INFERENCE_LENS_CONNECTIONS` (plural, one variable) and never per-connection
variable names, so the two cannot be confused.

## Deployment notes

- **`deploy/compose.yaml`:** add `INFERENCE_LENS_CONNECTIONS` to the
  environment list, plus a commented-out read-only volume example. The root
  `compose.yaml` already passes the whole `.env`.
- **File permissions:** the image runs as `node` (uid 1000) on a read-only
  root. Docker Desktop maps bind-mount ownership, so a `0600` key file owned by
  the host user is readable. On Linux Docker Engine it is not unless the file is
  readable by uid 1000. `docs/DOCKER.md` must say this, and the per-connection
  problem from decision 3 is what surfaces it ("key file could not be read").
- **`docker inspect`:** keys read from files no longer appear in the container
  environment, which is an improvement on today's `.env`-only route.

## Delivery slices

1. **Server.** Catalog parser and tests in `packages/core`; catalog source in
   `services/api`; a multi-connection credential store that keeps the
   `CredentialStore` interface; `connectionId` in the contract and in
   `parseCredential`; the new `runtime-status` shape.
2. **Browser.** Per-connection reconciliation, `credentialRef` and web-mode
   formats, the authentication options, the generalized notice and banner,
   deletion refusal and readiness wording.
3. **Docs and templates.** `docs/DOCKER.md`, `.env.example`, and
   `deploy/compose.yaml`.
4. **CLI** (only if decision 9 is B).

## Verification

- **Unit tests:** catalog parsing (every refusal in decision 3), resolution by
  id with the origin check, same-origin connections with different keys,
  `parseCredential` with and without `connectionId`, and reconciliation of
  add, remove, and rename in `tests/connection-profiles.test.ts`.
- **End-to-end:** a new `tests/e2e/server-connections.spec.ts` that starts the
  app with a two-connection catalog against fixture providers (one chat, one
  decision-only), and shows that:
  - both profiles appear locked,
  - a chat run on one and a decision run on the other each carry the right key
    to the right fixture,
  - editing the catalog and reloading the page adds and releases a profile
    without restarting the server.

  The existing `server-default-profile-recovery.spec.ts` must stay green
  unchanged, as evidence that decision 2 holds. See
  [the provider fixture guide](PROVIDER_FIXTURES.md) for checking that the
  fixture actually saw each key.
