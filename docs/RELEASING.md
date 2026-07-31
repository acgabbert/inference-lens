# Releasing Inference Lens

Inference Lens has two independent release paths:

- `.github/workflows/docker.yml` publishes the web application as a
  multi-architecture image on GHCR.
- `.github/workflows/release.yml` builds the universal macOS application and
  prepares a draft GitHub release.

Release tags must point to a commit on `main` that has passed CI. The workflows
do not currently enforce that ancestry or CI requirement themselves.

The repository validator does enforce the release-tag shape and version
contract at every publishing boundary. Release tags must be either
`vMAJOR.MINOR.PATCH` or a SemVer prerelease such as
`vMAJOR.MINOR.PATCH-rc.1`. Build metadata (`+...`), shortened versions, leading
zeroes, and other `v*` strings are rejected before an image or desktop artifact
can be published.

## Container image

The image path is derived from `${{ github.repository }}`, so it follows the
GitHub repository name. Renaming the repository changes the image path and
invalidates the quick-start command published in the README, which hardcodes it.

Pushes to `main` publish `ghcr.io/acgabbert/inference-lens:main`. Valid release
tags publish semantic-version tags, and a stable version tag also updates
`:latest`. For example, `v0.1.0` publishes `:0.1.0`, `:0.1`, and `:latest`.
`v0.1.0-rc.1` publishes `:0.1.0-rc.1` without updating `:latest`.

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
secret makes the workflow fail before dependency installation or build. When
the variable is unset or has any value other than `true`, the macOS job exits
successfully without building an artifact.

## Preparing a version

The base application version appears in five committed files:

- `package.json`
- `package-lock.json`
- `src-tauri/Cargo.toml`
- `src-tauri/Cargo.lock`
- `src-tauri/tauri.conf.json`

Do not edit those files independently. Set the next stable base version with:

```sh
npm run version:bump -- 0.2.0
```

The command accepts an explicit, stable `MAJOR.MINOR.PATCH` version, requires it
to be greater than the current version, and refuses to run if the existing
files disagree. It updates both manifests and generated lockfile metadata. Run
`npm install` only when dependencies also changed; the bump command itself does
not resolve or update dependencies.

Prerelease labels belong to the Git tag, not the manifests. For example, leave
the files at `0.2.0` for both `v0.2.0-rc.1` and the eventual `v0.2.0` release.
Check the complete contract locally with either:

```sh
npm run version:check
npm run version:check -- v0.2.0-rc.1
```

The initial release is a special case: all five files already contain `0.1.0`,
so `v0.1.0` does not need a bump commit.

Commit version changes through a pull request and let CI validate them before
tagging. The version commit can also carry release-note edits, but it should not
contain unrelated feature work.

## Tagging a release

Before tagging, update local `main`, confirm the worktree is clean, and verify
that the intended commit's **CI** and **Container image** runs passed on GitHub.
The workflows reject malformed and mismatched tags, but intentionally do not
try to infer whether a commit belongs to `main` or whether an earlier CI run
passed.

Run the tag-aware version check and create an annotated tag:

```sh
git switch main
git pull --ff-only
git status --short
npm run version:check -- v0.1.0
git tag -a v0.1.0 -m "Inference Lens v0.1.0"
git push origin v0.1.0
```

`git status --short` must print nothing. Maintainers who sign Git tags can use
`git tag -s` instead of `git tag -a`.

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

When macOS releases are disabled, the workflow does not create a GitHub Release.
After the container passes the verification below, create a draft with generated
notes:

```sh
gh release create v0.1.0 \
  --draft \
  --verify-tag \
  --title "Inference Lens v0.1.0" \
  --generate-notes
```

Review the generated notes, add upgrade or compatibility guidance where useful,
and publish the draft in GitHub. For a prerelease, also pass `--prerelease` and
leave `:latest` unchanged.

## Verify a published release

Wait for both tag-triggered workflows to finish. A skipped macOS build is
expected while `MACOS_RELEASE_ENABLED` is not `true`; a failed version check or
container build is not.

Inspect the multi-architecture manifests:

```sh
docker buildx imagetools inspect ghcr.io/acgabbert/inference-lens:0.1.0
docker buildx imagetools inspect ghcr.io/acgabbert/inference-lens:0.1
docker buildx imagetools inspect ghcr.io/acgabbert/inference-lens:latest
```

Each stable tag must report `linux/amd64` and `linux/arm64`, and the top-level
digest for the exact version, minor version, and `latest` must match. A
prerelease has only its exact prerelease tag.

Pull and run the exact version rather than a moving alias:

```sh
docker pull ghcr.io/acgabbert/inference-lens:0.1.0
docker run --rm -d \
  --name inference-lens-release-check \
  -p 127.0.0.1:3000:3000 \
  ghcr.io/acgabbert/inference-lens:0.1.0
curl --fail --show-error http://127.0.0.1:3000/
docker inspect --format '{{json .State.Health}}' inference-lens-release-check
docker stop inference-lens-release-check
```

Open the running application before stopping it when a UI change is part of the
release. Exercise the changed path with predictable values and scan rendered
text for `NaN`, `Infinity`, and `undefined`; a healthy root response alone does
not verify browser behavior. Confirm from a signed-out browser that the GHCR
package and exact image tag are public.

For a signed macOS release, download the DMG from the draft release and perform
one clean-machine launch check before publishing it. The workflow verifies the
signature, Gatekeeper assessment, and notarization staple, but it cannot verify
the user-visible first-launch experience.

After verification, publish the GitHub draft and confirm that the README quick
start pulls successfully. Do not move or recreate a published version tag. If a
release is defective, fix it on `main` and publish the next patch version (or
the next prerelease identifier) instead.

## Manual macOS build

Running the release workflow with `workflow_dispatch` still requires enabled
and complete Apple signing configuration. It does not create a GitHub release;
after verification, it uploads the signed DMG as a workflow artifact.
