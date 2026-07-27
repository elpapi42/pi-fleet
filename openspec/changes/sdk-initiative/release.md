# Release

## Environment parameters

1. Set `CANDIDATE_COMMIT` to the reviewed implementation commit on `main`, `RELEASE_VERSION` to the next unused immutable beta version, and `RELEASE_TAG` to `v${RELEASE_VERSION}`. After release metadata is committed, set `RELEASE_COMMIT` to that final commit; the tag, `package.json`, `src/shared/product-identity.ts`, npm version, runtime manifest, provenance, and registry evidence must agree with `RELEASE_COMMIT` exactly.
2. Set `PIFLEET_PI_EXECUTABLE` and `PIFLEET_PI_NODE` to absolute paths for separately installed Pi `0.82.1` and its selected Node. Verify both before release; no managed Pi fallback is allowed.
3. Set `CANDIDATE_SPEC` to the exact candidate tarball path during pre-publication validation or `@elpapi42/pi-fleet@${RELEASE_VERSION}` during registry validation. Record Linux x64 distribution/kernel, Node/npm versions, candidate tarball path/SHA-256, isolated test root, evidence directory, target npm dist-tag `beta`, and the released baseline under test as `OLD_RELEASE_VERSION`, `OLD_RELEASE_TAG`, and `OLD_PROTOCOL_MAJOR`; do not hardcode beta.10 or protocol v2 into this reusable runbook.
4. Require GitHub repository write/tag access, permission to run the OIDC trusted-publishing workflow, npm package visibility for `@elpapi42/pi-fleet`, and read access to workflow/provenance/registry metadata. No npm token is used by the OIDC publication job.
5. Require Docker or equivalent privileged-container/cgroup access for the release-gating PID-1/systemd and bounded-filesystem checks. If unavailable, release is blocked rather than inferred from unit tests.
6. Require an explicitly authorized development provider configuration only for the final reviewer-agent dogfood. Never use production credentials or production sessions.

## Pre-release checks

1. Confirm `main` is clean, synchronized with `origin/main`, reviewed, and contains no uncommitted OpenSpec or production changes. Confirm `CANDIDATE_COMMIT="$(git rev-parse HEAD)"`, `RELEASE_VERSION` is absent from `npm view @elpapi42/pi-fleet versions --json`, and `RELEASE_TAG` is absent from both `git tag --list` and `git ls-remote --tags origin`.
2. Confirm package/product/runtime identity, protocol major, destructive schema version/checksum, runtime-manifest artifact inventory, external Pi mode, Linux x64 metadata, and the one-package `@elpapi42/pi-fleet/client` export/declarations are mutually consistent. Require release checks to compare `package.json`, `src/shared/product-identity.ts`, runtime manifest identity, and the eventual tag version.
3. Run the full automated matrix from `testing.md` on `CANDIDATE_COMMIT`, including production audit, static checks, ordinary/fault/process/platform/compat/package/version-matrix/soak/benchmark suites, release checks, exact lifecycle projection, segmentation, migration reset/rollback, UUID isolation, storage faults, and package import inertness. This is the mandatory pre-tag gate; `.github/workflows/publish.yml` must also enforce the complete configured release matrix against `RELEASE_COMMIT` before npm publication rather than relying on a separate nightly run.
4. Run real bounded-filesystem ENOSPC and privileged PID-1/systemd validation from `testing.md`. Preserve evidence separately from injected `SQLITE_FULL` and do not substitute one for the other.
5. Complete the main-agent/reviewer dogfood with the exact candidate artifact and authorized development environment. Confirm the problem-defining workflow receives useful lifecycle starts/finishes without raw RPC parsing or CLI subprocess orchestration.
6. Pack the candidate and record its SHA-256. Install it and Pi 0.82.1 into separate disposable prefixes; verify one pi-fleet package contains CLI/runtime/installer/SDK declarations, importing `/client` is inert, materialized runtime contains no Pi package, and runtime-backed SDK/CLI lifecycle succeeds.
7. Exercise the `OLD_RELEASE_VERSION`/`OLD_PROTOCOL_MAJOR` runtime with the candidate SDK/CLI. Require `protocol_incompatible` while preserving old PID, socket inode, service definition, database bytes, immutable releases, and Pi process tree; the candidate must not open or migrate that state root.
8. Exercise the destructive transition only in a disposable populated old-schema/systemd environment. Finish active work, capture the old unit/runtime/state/Pi identities for pre-migration recovery, then use the supported installer boundary and systemd evidence:

   ```bash
   export OLD_PACKAGE_ROOT="$(npm root -g)/@elpapi42/pi-fleet"
   node "$OLD_PACKAGE_ROOT/dist/installer.mjs" uninstall
   systemctl --user is-active pi-fleet.service && exit 1 || true
   npm install --global "$CANDIDATE_SPEC"
   export NEW_PACKAGE_ROOT="$(npm root -g)/@elpapi42/pi-fleet"
   node "$NEW_PACKAGE_ROOT/dist/installer.mjs" install
   ```

   Before candidate startup, prove the old cgroup/process tree is absent, no live process owns the old socket, and intended `PIFLEET_PI_EXECUTABLE`, `PIFLEET_PI_NODE`, and state root are preserved. Only then allow transactional reset. Require an empty new pi-fleet state, unchanged native-session hashes, and no eager Pi restoration. Never execute this transition against the user's persistent host during release validation.

9. Confirm rollback boundaries are understood before tagging: pre-commit migration failure restores schema v2; after successful reset, reinstalling beta.10 or another old binary is not rollback. Recovery is a forward fix or restoration from an externally managed backup together with a compatible runtime. pi-fleet does not create an automatic sensitive-state backup.
10. Update release-facing changelog/version metadata for `RELEASE_VERSION`, including the destructive beta reset, SDK import path, watch removal, continuous receive, explicit service transition, Linux x64/Pi 0.82.1 requirements, and unsupported post-reset binary rollback. Commit those changes, set `RELEASE_COMMIT="$(git rev-parse HEAD)"`, and rerun the complete required release matrix or its equivalent mandatory CI gate against `RELEASE_COMMIT`, including build, package, materialization, and fresh candidate dry-pack identity; formatting/release checks alone are insufficient.

## Release steps

1. Push `RELEASE_COMMIT` on `main` and verify `origin/main` resolves to that exact commit with every required release check green; preserve `CANDIDATE_COMMIT` and `RELEASE_COMMIT` as separate evidence identities.
2. Create one annotated immutable `RELEASE_TAG` pointing exactly at `RELEASE_COMMIT`, verify the tag version equals package/product/runtime identity, and push it without moving or reusing any failed prior tag.
3. Allow `.github/workflows/publish.yml` to build from the tag, install external Pi `0.82.1`, run the complete release matrix configured by implementation Task 6.4 against `RELEASE_COMMIT`, and only then publish `@elpapi42/pi-fleet@${RELEASE_VERSION}` with `--access public --tag beta --provenance` through OIDC trusted publishing; a scheduled/nightly result is supporting evidence, not a substitute for the tag gate.
4. If the workflow fails before npm publication, fix forward on `main`, choose a new version and tag, and never move or reuse the failed immutable tag. If npm publication succeeded but later gates fail, treat the version as immutable and publish a new corrective beta rather than overwriting it.
5. Verify the GitHub Actions run completed successfully, provenance is present, npm metadata reports the exact version/repository/commit, and the `beta` dist-tag points to `RELEASE_VERSION`. Do not move `latest` unless the user separately authorizes that dist-tag change and the registry permits it.
6. Perform an independent mandatory fresh-registry smoke in a new isolated root with Pi and pi-fleet installed into separate prefixes; do not rely only on the workflow's historical `list/create/status/destroy` smoke. Import `@elpapi42/pi-fleet/client` before connection and prove inertness; then connect, create a shared agent, establish receive and save `ReceiveStream.cursor`, send deterministic work, observe lifecycle events, inspect through CLI, send follow-up, destroy, and verify user-owned session preservation plus no managed Pi in the materialized release.
7. Run the release artifact through the privileged disposable systemd transition: old responsive runtime refusal, explicit old-service/process-tree quiescence, candidate installation with absolute Pi/Node paths, destructive reset, clean restart without gap, unclean working and idle-resident gaps with explicit continuation, no eager restoration, one later writer, and native-session preservation.
8. During the bounded release-validation window defined by `testing.md`, capture actual available evidence from the disposable candidate environment: publication workflow status, fresh smoke, registry/provenance metadata, `systemctl --user status`, content-redacted journal/runtime logs, SQLite health, DB/WAL/SHM sizes, journal backlog/append latency, receive errors, continuity gaps, and process containment. Do not imply a hosted metrics/dashboard system unless one exists, and never log raw retained content.
9. If a defect occurs before migration commit, stop the candidate, prove no candidate Pi process remains, verify the database is still the old schema, and only then restore the captured old service/runtime definition in the disposable environment. If a defect occurs after migration commit, never start an old binary against the new database; stop new work, preserve structural evidence and native sessions, and choose forward fix or explicitly approved external backup restoration.
10. Record release evidence: candidate/release commits, tag/version, workflow run, provenance URL, npm dist-tags, tarball integrity, external Pi/Node identities, automated matrix, ENOSPC result, systemd result, fresh-registry smoke, dogfood result, known unsupported environments, and any blocked/not-validated claim. Retain event types, IDs, activity IDs, cursors, order, counts, sizes, timestamps, redacted/synthetic payloads, and session hashes by default—not real dogfood thinking or tool content. Any necessary raw diagnostic bundle must be private, access-controlled, time-bounded, and explicitly approved.

## Post-release follow-up

- Keep npm versions and Git tags immutable. Correct defects with a new beta version and tag.
- Do not describe disposable PID-1/systemd evidence as physical-host reboot/logout proof, and do not claim macOS, launchd, non-x64, or arbitrary Pi-version support.
- Keep `beta` as the intended prerelease channel. Treat `latest` as a separate explicit product/release decision.
- Document that existing beta state is intentionally reset only after explicit service transition; native Pi sessions remain user-owned and untouched.
- Watch retained-history disk growth, WAL/checkpoint behavior, storage failures, semantic-start latency, receive reconnect/gap errors, and SDK adoption during dogfood without collecting raw sensitive content centrally.
- If release validation reveals a product-contract mismatch in lifecycle events, receive boundaries, cursor behavior, or destructive deletion, stop and route back to specification/shape rather than adding a compatibility shim.
- Retain only the release evidence required for provenance and diagnosis; remove disposable roots, containers, prefixes, and development credentials after verification.
