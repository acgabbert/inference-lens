# Pinned draft-07 conformance fixtures

Source: [JSON-Schema-Test-Suite](https://github.com/json-schema-org/JSON-Schema-Test-Suite)
at revision `55719286c33ae0d1823bfb65fea10338a19bc37c`.

`draft7/` contains unchanged copies of all 37 top-level `tests/draft7/*.json`
files at that revision (929 tests in 258 groups). `LICENSE` is the upstream MIT
notice. Optional suites and remote fixture resources are not vendored.

`manifest.json` explicitly lists every group and its test count. It selects 804
tests. The other 125 require features outside the chosen profile: `pattern`,
`patternProperties`, non-pointer references, `$id`, or assertions beside `$ref`.
Each excluded group records its expected core preflight `rejectionCode`.
The sibling-assertion group is excluded because core rejects assertions beside
`$ref`, rather than ignoring them as draft-07 permits. The exclusions were
classified from schema positions before running the new interpreter; they are
not generated from evaluator failures. An unsupported assertion inside `const`,
`enum`, examples, or defaults is literal data, not a reason for exclusion.

`load-official.mjs` checks group/count coverage. Neither the Node conformance
runner nor the browser runner silently skips a selected test that returns
`not-evaluated`; that is a failure. These are supported-profile results, not a
claim of complete draft-07 conformance. Updating the revision or exclusions is
an explicit review change.

`tests/json-schema-profile.test.ts` runs in `npm run test:core` and reads this
snapshot directly. It asserts `ready` for every selected schema and the explicit
rejection code for every excluded schema, and checks complete manifest coverage.
This sweep establishes preflight support, not answer-validation conformance.
Earlier spike measurements used the original 807-test selection; the shared
manifest now excludes the three sibling-assertion tests for the core profile.
