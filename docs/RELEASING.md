# Releasing Inference Lens

Inference Lens has two independent release paths:

- `.github/workflows/docker.yml` publishes the web application as a
  multi-architecture image on GHCR.
- `.github/workflows/release.yml` builds the universal macOS application and
  prepares a draft GitHub release.

Release tags must point to a commit on `main` that has passed CI. The workflows
do not currently enforce that ancestry or CI requirement themselves.

## Container image

The image path is derived from `${{ github.repository }}`, so it follows the
GitHub repository name. Renaming the repository changes the image path and
invalidates the quick-start command published in the README, which hardcodes it.

Pushes to `main` publish `ghcr.io/acgabbert/inference-lens:main`. Tags matching
`v*` publish semantic-version tags, and a stable version tag also updates
`:latest`. Prerelease tags do not update `:latest`.

GHCR packages are private when first created. After the first successful image
push, make the `inference-lens` package public in its GitHub package settings so
the README quick start works without registry authentication. Public package
visibility cannot be changed back to private.

## macOS signing setup

The macOS workflow is disabled by default and has no unsigned release path. To
enable it, configure these repository secrets:

- `APPLE_CERTIFICATE`
- `APPLE_CERTIFICATE_PASSWORD`
- `APPLE_SIGNING_IDENTITY`
- `APPLE_ID`
- `APPLE_PASSWORD`
- `APPLE_TEAM_ID`

`APPLE_CERTIFICATE` is the base64-encoded Developer ID Application certificate
exported as a `.p12`. `APPLE_PASSWORD` must be an app-specific password for
`APPLE_ID`.

After every secret is configured, set the repository variable
`MACOS_RELEASE_ENABLED` to `true`. Enabling macOS releases with any missing
secret makes the workflow fail before checkout or build. When the variable is
unset or has any value other than `true`, the macOS job exits successfully
without building an artifact.

## Preparing a version

Set the same base version in all three manifests:

- `package.json`
- `src-tauri/Cargo.toml`
- `src-tauri/tauri.conf.json`

The release workflow checks those values against the tag. A prerelease tag such
as `v0.2.0-rc.1` is compared with base version `0.2.0`.

Before tagging, confirm the intended commit is on `main` and its CI run passed.
Then create and push the version tag:

```sh
git tag v0.2.0
git push origin v0.2.0
```

The container and macOS workflows run independently for the tag. Container
images publish immediately. When macOS releases are enabled, the macOS workflow:

1. Builds a universal Apple Silicon and Intel application using Tauri.
2. Verifies the application code signature.
3. Confirms Gatekeeper accepts the application and DMG.
4. Validates the notarization staple on the application and DMG.
5. Creates a draft GitHub release and attaches the verified DMG.

Verification happens before release creation. A signing, Gatekeeper, or
notarization failure therefore cannot attach a DMG to a GitHub release.

Review and publish the draft release manually. Never add an unsigned DMG to a
release.

## Manual macOS build

Running the release workflow with `workflow_dispatch` still requires enabled
and complete Apple signing configuration. It does not create a GitHub release;
after verification, it uploads the signed DMG as a workflow artifact.
