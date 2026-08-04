# Command tools

A command tool is a local executable that answers a model's tool call. It reads
one JSON object on stdin and writes one result on stdout. That is the whole
protocol.

It exists for two reasons. The first is practical: a deterministic local
fixture is the cheapest way to debug an agent, and a twelve-line script is a
smaller thing to write than a server. The second is structural — a command tool
is the first executor with a transport, a timeout, and asynchronous failure, so
it is the one that proves [the executor contract](TOOL_EXECUTION.md) is not
shaped around any single protocol.

## Where it runs, and where it does not

| Shell | Command tools |
| --- | --- |
| Local web app (`npm run dev`) and self-hosted service | Yes, when a catalog is configured |
| Browser with no Inference Lens service | No — a browser cannot spawn a process |
| Tauri desktop app | Not yet; the desktop build has no local service. The UI says so rather than hiding the feature |

The UI states which of these applies instead of showing an empty picker. A
feature that is unavailable for a reason the user can act on is a different
thing from one that is broken.

## Declaring commands

Nothing can be executed until the operator of the service says what may run:

```sh
INFERENCE_LENS_COMMAND_TOOLS=/path/to/command-tools.json npm run dev
```

```json
{
  "schemaVersion": 1,
  "commands": [
    {
      "id": "weather",
      "label": "Local weather script",
      "description": "Answers with a fixed reading for the requested city.",
      "executable": "./weather.mjs",
      "args": ["--json"],
      "timeoutMs": 30000,
      "maxOutputBytes": 1048576,
      "resultFormat": "json"
    }
  ]
}
```

- `id` is required and must be unique. It is the only part of a command the
  browser ever names, and it is what a run trace records.
- `executable` is required. A relative path resolves against the catalog file's
  own directory, not the service's working directory.
- `args` is a fixed vector. It is never a command line, never interpolated with
  the model's arguments, and never passed through a shell.
- `label` defaults to `id`, `timeoutMs` to 30000, `maxOutputBytes` to 1048576,
  and `resultFormat` to `json`.

The file is read on each request, so editing it takes effect without a restart —
including removing a command, which is how a grant is revoked service-side.

An unusable catalog disables **every** command and reports why. It is not
treated as "nothing declared": a typo that silently switched the feature off
would send an operator looking in the wrong place.

## Allowing a command to answer a tool

Declaring a command makes it *available*. Binding it to a tool is a separate,
per-tool grant made in the app, on the **Tools** tab, after the exact command
line, its timeout, and how its output will be read are shown. The grant is
stored on the device — never in the project — so a project shared with a
teammate carries the tool definition and nothing about how it is served here.

A granted command outranks an enabled project mock, and the tools pane says so
beside the mock. The grant is a deliberate act on this device; a mock arrives
with the project and is often left switched on.

## The wire contract

The executor writes one line of JSON to stdin and closes it:

```json
{"tool":"get_weather","toolCallId":"tool-call_1","arguments":"{\"city\":\"Chicago\"}"}
```

`arguments` is the model's own argument text, passed through byte for byte. A
model that emits invalid JSON is a case worth debugging, so the tool sees
exactly what the model produced rather than a repaired copy.

With `resultFormat: "json"`, stdout must be a result envelope:

```json
{ "content": [{ "type": "text", "text": "61F and drizzle" }], "isError": false }
```

`content` accepts `text`, `image`, `audio`, and `resource` parts. Anything that
is not text is replaced by visible placeholder text before it reaches the model,
and the substitution is disclosed in the UI — never dropped silently.

With `resultFormat: "text"`, stdout is taken verbatim as a single text part.
That mode makes an existing script usable with no wrapper, and it can never
report a tool error, which is why it is not the default.

### How an outcome is classified

| What happened | Outcome |
| --- | --- |
| Exit 0, valid envelope | Completed |
| Exit 0, envelope with `"isError": true` | Completed, carrying the tool's error |
| Exit 0, `resultFormat: "text"`, any output | Completed |
| Nonzero exit, or killed by a signal | `execution_failed`, with the exit code and a stderr excerpt |
| Exit 0, nothing on stdout | `invalid_result` |
| Exit 0, stdout that is not a result envelope | `invalid_result` |
| More than `maxOutputBytes` on stdout | `invalid_result`; the command is stopped |
| Still running at `timeoutMs` | `timeout`; the command and its children are stopped |
| The run was cancelled | `cancelled` |
| The command could not be started | `execution_failed` |
| The command id is not declared here | `rejected` |

A **tool error** and a **failed execution** are deliberately different. A tool
that ran and reported an error is a result the model is entitled to reason
about, and it says so in the envelope. A process that fell over is not a result
at all: the call stays pending, the failure is shown, and a person can answer it
by hand. The exit code never decides this — reading a crash as a tool error
would let a broken process answer the model.

## What a command does not get

- **No shell.** The executable and its arguments are passed as a vector.
- **No environment.** The child receives a constructed environment (`PATH`,
  `HOME`, and a few locale and temp-directory variables), not the service's.
  Provider credentials cannot leak into a tool this way.
- **No arguments from the model on its command line.** They arrive on stdin.
- **No working directory, and no per-command environment**, in this version.

## What lands in a trace

Execution evidence records the command's **id** and **label**, its duration, and
its classification. It never records the executable path, the argument vector,
or when the grant was made: a trace is a portable artifact a teammate opens, and
device-local configuration staying device-local is the whole point of the
binding split.

A stderr excerpt (bounded, and the first 500 characters) *is* recorded on a
failure, because a command that exits 3 with no explanation is otherwise
unactionable. Commands should not print secrets to stderr.

## Security posture

The service can be deployed beyond loopback — this repository supports a
container image and a proxy allowlist — so the browser is never allowed to name
what runs. The catalog is a ceiling: a page can ask for a declared id and
nothing else, and the argument vector is fixed by whoever wrote the file. That
holds even if the UI is compromised by what it renders, which matters for a
product whose next step is displaying tool descriptions fetched from
third-party MCP servers.

Two consequences worth stating plainly:

- A declared command's path and arguments are visible to anyone who can open the
  UI on that origin. A catalog is not a place for secrets.
- Anyone who can open the UI can run any declared command. Declare only commands
  that are safe for every user of that service.

## In a container

The published image declares no catalog and contains no tools, so command tools
are off there by default. Enabling them means mounting both the catalog and the
executables it names and passing `INFERENCE_LENS_COMMAND_TOOLS` — and being
clear about what that means: the process runs **inside the container**, under
its user and its filesystem, not on the host. The image's `read_only` root and
dropped capabilities apply to the command as well, which is a reason to keep
tools in a mounted directory rather than expecting to write anywhere.

## Fixtures

`tests/fixtures/command-tools/` holds one executable per normalized outcome, and
a catalog the browser suite hands to its dev server. They are the fastest way to
see each classification without writing anything:

```sh
INFERENCE_LENS_COMMAND_TOOLS="$PWD/tests/fixtures/command-tools/catalog.json" npm run dev
```
