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

## Grouped project history

`loadProjectHistoryFiles` builds the read model for both artifact kinds in one
pass over a project folder. It is pure: adapters supply the listed file
contents, and the projection returns grouped entries, ungrouped runs, and the
artifacts it had to skip.

Reading follows the same rules the artifacts promise:

- One damaged artifact is skipped on its own and never hides a valid neighbour.
  A plan that does not parse leaves its cells' traces listed as ordinary runs.
- A run referenced by a valid plan appears only inside its experiment, so a
  repeated experiment does not flood the list with rows that look unrelated.
- The `experiments/` filename convention lives in `experiment.ts` alone. The
  projection reuses `isExperimentEntryName` and `experimentArtifactIdentity`
  rather than restating the pattern.
- Every artifact is parsed and reduced exactly once. The list summary and the
  grouped projection share one `RunState` per trace instead of reducing the
  same events per consumer.

The projection is still a full folder scan with no persisted index, so its cost
grows with everything the project has ever recorded. It is deliberately run only
on demand, and it reports `artifactCount` and `largeHistory` so a caller can say
so. Whether durable history eventually needs an index is an open decision; it is
not one this projection makes on its own.

A cell whose trace cannot be read back is reported separately from a cell that
never ran. A repetition with no openable trace is presented as `Waiting`,
`Not run`, `Trace missing`, or `Trace could not be read` — never as one
undifferentiated blank.

Both files use `schemaVersion: 1`. Parsers reject unknown fields, unsupported
versions, invalid or duplicate IDs, mismatched result references, and
credential-like keys at provider-option boundaries. Serializers produce stable
JSON with a trailing newline. Artifacts are write-once: saving byte-identical
contents again is idempotent, while different replacement contents are refused.

Future incompatible shapes require a new schema version and an explicit parser
migration. Existing serializers always write the current supported version;
they never silently reinterpret an unknown future artifact.
