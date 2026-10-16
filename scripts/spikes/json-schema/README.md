# External JSON Schema engine comparison

The two candidate engines are pinned in this private package and its lockfile.
They are not dependencies of the application root. Install them only when
reproducing the comparison, from the repository root:

```sh
npm ci --prefix scripts/spikes/json-schema --ignore-scripts
npm run test:json-schema:node
npm run test:json-schema:bundles
```

The browser probe uses the root Vite and Playwright development tools and needs
loopback access. Candidate imports resolve from this package's `node_modules`.
The separate metered evaluator and its tests require neither candidate.

Findings are recorded in `docs/JSON_SCHEMA_ENGINE_SPIKE.md` and
`docs/METERED_JSON_SCHEMA_SPIKE.md` at the repository root. License notices are
preserved under `notices/`.
