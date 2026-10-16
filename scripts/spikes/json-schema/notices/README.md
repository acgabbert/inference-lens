# Engine spike dependency notices

The candidates are development-only in the isolated comparison package. These files preserve the notices needed
when distributing their probe bundles; no third-party implementation was copied
into application core.

| Package | Version | Notice source |
| --- | --- | --- |
| `@cfworker/json-schema` | 4.1.1 | `cfworker-LICENSE.md`, upstream `LICENSE.md` |
| Derived punycode / Ajv code in the interpreter | as shipped in 4.1.1 | `cfworker-THIRD_PARTY_NOTICES.md` |
| `ajv` | 8.20.0 | Installed package `LICENSE` |
| `fast-deep-equal` | 3.1.3 | Installed package `LICENSE` |
| `fast-uri` | 3.1.8 | Installed package `LICENSE` |
| `json-schema-traverse` | 1.0.0 | Installed package `LICENSE` |
| `require-from-string` | 2.0.2 | Installed package `license` |

The interpreter npm tarball omits the root license and third-party-notices files.
These snapshots were fetched on 2026-10-16 from
[upstream LICENSE.md](https://github.com/cfworker/cfworker/blob/main/LICENSE.md)
and [THIRD_PARTY_NOTICES.md](https://github.com/cfworker/cfworker/blob/main/THIRD_PARTY_NOTICES.md).
Its npm metadata reports git head `5409fdc2bd144f68e8b28c61c71fcb16600000a6`,
but fetching the root license at that revision returned 404; the snapshots are
from current upstream, not verified release-revision files. Recheck provenance
before shipping a production dependency. Package versions and integrity hashes
for the installed candidates and transitive dependencies are in `../package-lock.json` for that isolated package.
