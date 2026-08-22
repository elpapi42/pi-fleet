---
name: pi-fleet-npm-release
description: Create and verify an independent GitHub release for either the pi-fleet SDK or CLI so `.github/workflows/publish.yml` publishes it to npm. Use this skill whenever the user asks to release, publish, or create a GitHub release for `@elpapi42/pi-fleet-sdk` or `@elpapi42/pi-fleet-cli`, including beta or other prerelease versions. Check immutable tags, package versions, the CLI's pinned SDK dependency, GitHub Actions, npm dist-tags, provenance, and installation.
compatibility: Requires authenticated `gh` and `git`, an npm CLI for registry checks, and existing npm trusted publishers for both packages.
source: opm
---

# pi-fleet npm release

Release one package at a time from the exact committed source. The GitHub release triggers `.github/workflows/publish.yml`. Do not run `npm publish` directly for normal releases.

## Package map

| Target | npm package | Directory | Release tag |
| --- | --- | --- | --- |
| SDK | `@elpapi42/pi-fleet-sdk` | `packages/sdk` | `sdk-v<version>` |
| CLI | `@elpapi42/pi-fleet-cli` | `packages/cli` | `cli-v<version>` |

The packages have independent versions. The CLI must keep an exact SDK dependency without `^`, `~`, ranges, or tags.

## 1. Select the target

Infer `sdk` or `cli` from the request. Ask one short question if the target is unclear.

Read the selected package version from its `package.json`. Do not change the version as part of release creation. If the requested version differs, stop and ask the user to update and commit it first.

Set the release type from the version:

- A version without `-` is stable.
- A version with a prerelease suffix is a GitHub prerelease.
- Stable releases publish npm dist-tag `latest`.
- Prereleases publish npm dist-tag `next`.

## 2. Run release preflight

Run these checks before creating a tag:

1. Confirm `gh auth status` succeeds and the npm CLI is available.
2. Confirm the working tree is clean.
3. Fetch `origin` and confirm `HEAD` equals `origin/master`.
4. Confirm the selected package version is valid and not already on npm.
5. Confirm the release tag does not exist locally, on `origin`, or as a GitHub release.
6. Confirm `.github/workflows/publish.yml` exists at `HEAD`.
7. Confirm the selected package declares `repository.url` as `https://github.com/elpapi42/pi-fleet-v2.git`.
8. For an existing package, confirm its previous release has npm provenance from this repository and the trusted workflow identity has not changed.

Do not run `npm whoami` or `npm trust list` during a routine release. Local npm authentication does not participate in GitHub OIDC publishing, and these account commands can force unnecessary browser authentication.

Run `npm trust list <package>` only when:

- this is the package's first trusted release;
- the repository, workflow filename, or GitHub environment changed since the last successful release; or
- GitHub publishing failed with an npm authentication or authorization error.

When a trust check is required, use npm 11.15.0 or newer and confirm:

- repository `elpapi42/pi-fleet-v2`;
- file `publish.yml`;
- permission `publish`.

For a CLI release, also:

1. Read `dependencies["@elpapi42/pi-fleet-sdk"]` from `packages/cli/package.json`.
2. Reject a missing or non-exact version.
3. Confirm that exact SDK version exists on npm.

Stop before side effects if any check fails. Report the exact failed check and the smallest correction.

## 3. Validate the package

Install from the lockfile:

```bash
npm ci
```

Build the SDK before the CLI when the CLI is the target. Then build and test the selected package:

```bash
npm run build --workspace <package>
npm run test --workspace <package>
npm pack --dry-run --workspace <package>
```

Do not release if a command fails.

## 4. Create the immutable release

Create and push one annotated tag at the current commit:

```bash
git tag -a <release-tag> -m "Release <SDK-or-CLI> <version>"
git push origin <release-tag>
```

Create the GitHub release from that existing tag:

```bash
gh release create <release-tag> \
  --verify-tag \
  --title "<SDK-or-CLI> <version>" \
  --generate-notes
```

Add `--prerelease` when the package version has a prerelease suffix.

Do not create or move a release tag if that tag already exists. Do not delete or replace a published release to repair a failure. A source fix requires a new package version and release tag.

## 5. Check the publishing workflow

Find the `.github/workflows/publish.yml` run created by the release. Match the release title, tag commit, and release event instead of selecting an unrelated recent run.

If GitHub has not created the run yet, set a short timer and check once. If the run is queued or active, set a timer with the run ID and finish with a short timer checkpoint. Do not poll or block with `gh run watch`.

When the timer fires, inspect the run once:

```bash
gh run view <run-id> --json status,conclusion,url,jobs
```

If the run fails, inspect:

```bash
gh run view <run-id> --log-failed
```

Before recommending a retry, check whether npm already accepted the package version. Never assume that a failed workflow means publication did not occur.

## 6. Verify npm

After a successful workflow, verify:

1. `npm view <package>@<version> version` returns the released version.
2. The expected npm dist-tag points to that version.
3. npm metadata contains provenance attestations.
4. The published package has the expected repository URL.
5. A CLI release still pins the expected SDK version.

For a CLI release, install it in a clean temporary prefix and run its installed executable:

```bash
temp_prefix="$(mktemp -d)"
npm install --prefix "$temp_prefix" "@elpapi42/pi-fleet-cli@<version>"
"$temp_prefix/node_modules/.bin/pif" --help
rm -rf "$temp_prefix"
```

## 7. Report

Report:

- package and version;
- GitHub release URL;
- workflow run URL and result;
- npm dist-tag;
- provenance result;
- clean-install result for CLI;
- any check that could not run.

Do not deprecate versions, remove dist-tags, change package access, or modify trusted publishers unless the user asks for that separate operation.
