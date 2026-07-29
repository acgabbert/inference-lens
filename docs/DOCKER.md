# Docker guide

## Run locally

Run the published image with a port bound only to the local machine:

```sh
docker run --rm -p 127.0.0.1:3000:3000 \
  --add-host=host.docker.internal:host-gateway \
  ghcr.io/acgabbert/inference-lens:latest
```

Open <http://localhost:3000> (or <http://127.0.0.1:3000>) in a browser. The
published port is bound to `127.0.0.1`, so the workbench is not reachable from
other machines on the network. Map another local port with
`-p 127.0.0.1:8080:3000`.

`--add-host` is what makes `host.docker.internal` resolve on plain Linux Docker
Engine, so a provider running natively on the host can be reached. Docker
Desktop provides the name on its own and ignores the flag; passing it always is
simpler than remembering which platform needs it.

The container prints where to open it, then Vinext logs
`http://0.0.0.0:3000`. That second address is the one the server listens on
*inside* the container, not a URL to open in a browser. Use `localhost` or
`127.0.0.1`; browsers treat those local origins as trustworthy even over HTTP.
Open the app on `0.0.0.0` anyway and it says so, with a link to the equivalent
`localhost` URL — nothing breaks there, but browsers withhold some web APIs
from origins they do not trust.

## Connect to a provider

From inside a container, `127.0.0.1` and `localhost` refer to that container,
not to the host computer.

### Provider runs on the host

Use `host.docker.internal` as the provider hostname. For example, if a native
llama.cpp server listens on port 8080, set this provider base URL in the UI:

```text
http://host.docker.internal:8080/v1
```

Docker Desktop resolves that name for you. On plain Linux Docker Engine it
exists only when the container was started with
`--add-host=host.docker.internal:host-gateway` (or the `extra_hosts` entry in
`compose.yaml`); without it the name fails to resolve. Both invocations above
pass it.

Setting `INFERENCE_LENS_API_ENDPOINT` to this value is enough on its own for a
provider that needs no key: the UI adds a profile for it with no authentication.
See [Set a server-side default credential](#set-a-server-side-default-credential)
to add a key as well.

### Provider runs in Compose

When Inference Lens and the provider are Compose services on the same network,
use the provider service name as the hostname. For example:

```text
http://llama-cpp:8080/v1
```

### Provider runs elsewhere

Use its real DNS name or LAN address. If the Inference Lens browser URL is
reachable beyond the local machine, serve Inference Lens over HTTPS and put
authentication in front of it. Plain HTTP browser origins do not expose every
browser security API, and Inference Lens does not provide user accounts of its
own.

## Connect the read-only n8n integration

Configure the n8n instance root and public API key together:

```sh
INFERENCE_LENS_N8N_BASE_URL=https://n8n.example.com/automation
INFERENCE_LENS_N8N_API_KEY=your-public-api-key
```

The base URL includes an installation subpath such as `/automation`, but
excludes `/api/v1`; Inference Lens appends that prefix itself. Both values are
server-only. The browser receives configuration state and bounded
workflow/execution summaries, never the API key, base URL, or raw execution
payload.

Use HTTPS outside a trusted local network. Where the installed n8n edition
offers scoped keys, choose its workflow-read and execution-read scopes. Some
editions cannot narrow public API keys, so protect the container environment
accordingly and do not commit a populated `.env`.

Container addressing follows the provider rules above:

- n8n on a Docker Desktop host is commonly
  `http://host.docker.internal:5678`;
- on Linux, use the configured host-gateway address, a shared Docker network,
  or a resolvable service name; and
- n8n in the same Compose network should be addressed by its service name.

The integration issues only public API `GET` requests, refuses redirects, and
does not run, edit, activate, retry, or delete workflows.

## Set a server-side default credential

To avoid entering a key each session, set it on the service and leave the UI
key field empty. A key must be bound to the provider endpoint it belongs to, so
configure both; setting only the key fails requests with `The default credential
is not bound to a provider.` Setting only the endpoint is valid and describes a
provider that needs no key.

The published-image quick start has no `.env.example` file to copy, so create
the file directly:

```sh
cat > .env <<'EOF'
INFERENCE_LENS_API_KEY=sk-your-key-here
INFERENCE_LENS_API_ENDPOINT=https://api.openai.com/v1
# Optional: prefill the server-default profile's model.
INFERENCE_LENS_MODEL=gpt-4.1-mini
EOF
```

Pass it to the container:

```sh
docker run --rm -p 127.0.0.1:3000:3000 \
  --add-host=host.docker.internal:host-gateway \
  --env-file .env \
  ghcr.io/acgabbert/inference-lens:latest
```

Avoid separate `-e INFERENCE_LENS_API_KEY=...` flags: the key becomes part of
shell history. An env file avoids that exposure, but Docker still stores the
container environment and a host user with Docker access can read the key with
`docker inspect`. Do not use a `NEXT_PUBLIC_` prefix or commit a populated
`.env` file. The image excludes `.env` from its build context, so the credential
is never baked into it.

The service releases its default credential only to a selected endpoint with
the same scheme, hostname, and port as `INFERENCE_LENS_API_ENDPOINT`, and the
connection drawer warns before a run when the selected profile points somewhere
else. A key entered in the UI takes precedence and leaves the server-side
credential unread.

### The Server default profile

Inference Lens adds a separate **Server default** profile, prefilled from
`INFERENCE_LENS_API_ENDPOINT` and, when set, `INFERENCE_LENS_MODEL`. On a first
visit — a browser that has never stored a profile — it becomes the active
profile, since setting the variables says plainly which provider you meant.
Once you have profiles of your own it is added alongside them and offered
rather than switched to, and it never overwrites an existing profile.

Leave `INFERENCE_LENS_MODEL` unset and the profile starts with no model rather
than a guess: a local llama.cpp server has never heard of `gpt-4.1-mini`. A run
is blocked until you pick one, with a notice pointing at the model picker,
which lists what the provider actually serves.

Its **Authentication** mode is **Server default (.env)** when a key is
configured and **No authentication** when only an endpoint is. The mode is
listed but unselectable when the server holds no key, so the option explains
its own absence. The selection is opaque: the browser receives the endpoint and
model but never `INFERENCE_LENS_API_KEY`.

You can edit the profile's model normally, and it is yours from then on:
`INFERENCE_LENS_MODEL` fills the model in only while the profile has none, so a
restart never replaces a model you chose. The endpoint is the server's — the
default credential is released only to the origin it names — so each app start
refreshes it and the UI keeps it locked; create a new profile to use another
provider. Remove the variables and restart, and the profile unlocks and falls
back to no authentication rather than failing every run.

## Serve it from a name

The API refuses requests whose `Host` header is a DNS name it was not told
about. Address literals and loopback names are always served — `127.0.0.1`,
the `0.0.0.0` a container logs, a LAN address such as `192.168.1.10`,
`localhost` and `*.localhost` — so nothing about the local setups above needs
configuring.

The check exists because the same-origin check alone cannot stop DNS rebinding.
A page on `evil.example` whose name is re-resolved to `127.0.0.1` reaches this
service with the browser believing the request is same-origin, and could spend
the server-held credential. Rebinding needs a *name* to re-point, which is
exactly what an address literal does not have.

Putting Inference Lens behind a reverse proxy or a real hostname therefore
means naming it:

```sh
INFERENCE_LENS_ALLOWED_HOSTS=lens.example.com,workbench.internal
```

Separate several names with commas or whitespace; ports are ignored. A request
arriving under any other name is answered with `403` and a message naming this
variable. Serve such a deployment over HTTPS and put authentication in front of
it — the workbench itself has no user accounts.

## Build from source with Compose

Compose builds the image locally. It requires a `.env` file:

```sh
cp .env.example .env
docker compose up --build
```

Set `INFERENCE_LENS_API_KEY` and point `INFERENCE_LENS_API_ENDPOINT` at the
matching provider base URL, or leave both empty and enter a key in the UI. To
use another local port, set `INFERENCE_LENS_PORT` in `.env`.

The Compose service is locked down beyond what `docker run` gives you: it runs
as the non-root `node` user on a read-only filesystem (`/tmp` is a tmpfs) with
every capability dropped. The app needs none of what is removed, so nothing
behaves differently — but if you shell into the container to debug, writes
outside `/tmp` fail by design. The health check is built into the image, so
`docker run` gets it too.

## Troubleshooting

**A provider address that points back at the container**

`127.0.0.1` and `localhost` resolve to the Inference Lens container, so nothing
is listening there. Running in a container, the app detects this and says so in
place of the bare `fetch failed` that Node reports. For a host-native provider,
use `http://host.docker.internal:<port>/v1`; for a Compose provider, use its
service name.

**`host.docker.internal` fails to resolve (`ENOTFOUND`)**

Plain Linux Docker Engine does not provide the name by itself. Restart the
container with `--add-host=host.docker.internal:host-gateway`, or use the
host's LAN address instead.

**Container advice appears when running with `--network host`**

Under `--network host` the container shares the host's network, so loopback
addresses do reach host-native providers and the advice above is wrong. The
image declares itself containerized with `INFERENCE_LENS_CONTAINER=1`; override
it with `-e INFERENCE_LENS_CONTAINER=0`.

**`Requests for host "..." are not allowed`**

The service was reached under a DNS name rather than an address. See
[Serve it from a name](#serve-it-from-a-name).

**Server default (.env) cannot be selected**

The service holds no key. Set both `INFERENCE_LENS_API_KEY` and
`INFERENCE_LENS_API_ENDPOINT` and restart the container.

**The credential is bound to a different origin**

The selected profile's endpoint differs in scheme, hostname, or port from
`INFERENCE_LENS_API_ENDPOINT`. Point the profile at the configured provider, or
choose **Session key** and enter a key for the endpoint you want.
