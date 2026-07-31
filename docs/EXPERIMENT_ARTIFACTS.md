# Experiment artifacts

Repeated Experiment keeps its durable, credential-free grouping data beside a
project rather than in `project.json` or an individual run trace:

```text
traces/<runId>.json
experiments/<experimentId>.plan.json
experiments/<experimentId>.result.json
```

The v1 plan is written before provider work starts. It freezes a repeated
request’s common resolved input, ordered cells, and preallocated run IDs. The
optional terminal result records only the terminal experiment status and each
cell’s disposition. Run evidence, including output, events, timing, usage,
retries, and tool calls, remains in the referenced immutable trace.

An existing plan with no result represents an interrupted experiment. This
includes an application crash and a failed terminal-trace write: the controller
stops scheduling, does not write a result that would claim clean completion or
user cancellation, and reports the persistence failure to its caller. A result
whose trace has been removed remains valid; consumers must surface that cell as
`trace missing` instead of rejecting the artifact.

Workspace listings pair the optional result with its plan by experiment ID, so
an interrupted plan and a damaged result-only folder can be represented without
inventing a mutable checkpoint file.

Both files use `schemaVersion: 1`. Parsers reject unknown fields, unsupported
versions, invalid or duplicate IDs, mismatched result references, and
credential-like keys at provider-option boundaries. Serializers produce stable
JSON with a trailing newline. Artifacts are write-once: saving byte-identical
contents again is idempotent, while different replacement contents are refused.

Future incompatible shapes require a new schema version and an explicit parser
migration. Existing serializers always write the current supported version;
they never silently reinterpret an unknown future artifact.
