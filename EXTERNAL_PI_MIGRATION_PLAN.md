# External Pi Migration Plan

## Status

Proposed implementation plan. No production behavior changes have been made by this document.

## Decision

`pi-fleet` must orchestrate the Pi executable selected by the user. Pi is a prerequisite that the user installs and owns. `pi-fleet` must not install, bundle, copy, materialize, substitute, or silently fall back to another Pi distribution.

The current managed dependency on `@earendil-works/pi-coding-agent@0.80.10` violates that requirement. It must be removed before the next beta is published.

## User outcome

A user who runs:

```bash
command -v pi
pi --version
```

must be able to trust that every new Pi process started by `pi-fleet` uses that selected executable. This must remain true for direct CLI startup, detached runtime startup, systemd or launchd supervision, process restoration, and runtime restart.

The first-order proof is an isolated test in which the user-selected Pi is outside the runtime's default PATH and every Pi process started by `pi-fleet` is observed to execute that exact selected command path.

The material second-order effects are:

- Pi becomes an explicit installation prerequisite.
- Pi upgrades and version-manager switches become runtime compatibility events.
- A responsive runtime using another Pi must fail explicitly rather than be replaced or used silently.
- Existing user-owned sessions and durable agents must survive the migration unchanged.
- `pi-fleet`'s immutable runtime continues to protect `pi-fleet`, but no longer contains Pi.
- `pi-fleet`'s production audit covers only code distributed by `pi-fleet`; it does not certify the user's Pi installation.

## Contract decisions

### 1. What “the same Pi executable” means

The authoritative Pi command is the absolute command path selected from the invoking environment's `PATH`, or an absolute path explicitly selected with `PIFLEET_PI_EXECUTABLE`.

Example on the current development host:

```text
selected command: /home/elpapi/.nvm/versions/node/v24.16.0/bin/pi
resolved target:  /home/elpapi/.nvm/versions/node/v24.16.0/lib/node_modules/@earendil-works/pi-coding-agent/dist/cli.js
reported version: 0.82.1
```

The selected command path remains authoritative, including when it is a symlink. The resolved real path, reported version, file metadata, and selected Node path are observations used for compatibility checks and diagnostics; they do not replace the user's selected command.

Shell aliases and shell functions are out of scope. `pi-fleet` launches an executable with `shell: false` and will never invoke an interactive shell to discover or run Pi.

### 2. Selection precedence

1. An explicit absolute `PIFLEET_PI_EXECUTABLE`.
2. The first executable `pi` selected from the invoking process's `PATH`.
3. Typed `pi_not_found` failure.

A relative explicit override is invalid. Directories and non-executable files are rejected. Safe executable symlinks are allowed.

The invoking Node executable is also observed. The Pi child environment prepends the selected Node directory and Pi command directory to `PATH`, so a `#!/usr/bin/env node` Pi shim behaves under systemd as it does in the selecting terminal.

For change detection, define the fingerprint mechanically as SHA-256 over a canonical encoding of `selectedPath`, `realPath`, normalized `version`, and the SHA-256 of the selected executable target's bytes. File metadata such as inode, size, and mtime is diagnostic only. This is same-user change detection, not a sandbox: a malicious same-user process remains inside the trust boundary and can race validation and spawn.

### 3. No fallback

There is no managed fallback, package import fallback, daemon-PATH fallback, or automatic substitution. If the selected Pi is missing, unsupported, or changed incompatibly, process-starting work fails before dispatch.

### 4. Runtime-global selection and availability

Pi selection belongs to the central runtime, not to individual agents. New agents must not persist an executable path or claim that `pi-fleet` owns a Pi artifact.

Runtime readiness and Pi execution availability are separate states:

- **Control-plane ready:** SQLite is open, crash reconciliation has run, passive commands and cleanup are available.
- **Pi execution available:** the configured Pi path currently exists, is executable, reports a supported version, and agrees with the caller's selection.

A configured Pi path may become missing or incompatible without preventing the control plane from starting. The runtime reports its configured selection, current availability, and independently observed Pi identity through the private protocol. Work-accepting requests carry the caller's current Pi identity as transport context, not mutation payload. A mismatch is rejected before work acceptance or Pi dispatch.

### 5. Commands during Pi unavailability or mismatch

| Command   | Behavior                                                                |
| --------- | ----------------------------------------------------------------------- |
| `create`  | Reject before Pi start.                                                 |
| `send`    | Reject before prompt or steering, including for resident agents.        |
| `compact` | Reject before restoration or compact RPC.                               |
| `status`  | Continue as passive logical-state inspection.                           |
| `list`    | Continue as passive durable-entry inspection.                           |
| `receive` | Continue returning an already stored latest response or stored failure. |
| `watch`   | May observe an already-bound resident incarnation; it never starts Pi.  |
| `destroy` | Continue cleanup without requiring a usable Pi installation.            |

A Pi mismatch never becomes `delivery_uncertain` or `compaction_uncertain` because dispatch has not occurred.

### 6. Upgrade behavior

A PATH change, version-manager switch, symlink retarget, or in-place Pi upgrade must not silently mix Pi versions.

- Existing active work is never interrupted automatically.
- Existing raw watchers may continue observing their bound process.
- New `create`, `send`, and `compact` requests are rejected with an actionable mismatch until the runtime is repaired or restarted deliberately.
- Runtime restart does not eagerly restore agents.
- A later explicit process-starting command restores the same user-owned native session using the newly selected, validated Pi.
- Pending work proven not to have dispatched remains durably pending while Pi is unavailable; it is not falsely marked uncertain or failed merely because execution is temporarily unavailable.

### 7. Initial compatibility policy

The first external-only release supports only Pi versions for which the full compatibility and lifecycle suite has passed. The current terminal Pi is `0.82.1`; it must pass Phase 0 before implementation proceeds.

Do not infer compatibility from semver alone. Initially use an explicit tested-version set. Broaden it only after additional versions pass the same contract.

## Public error additions

Add these errors to the authoritative public registry and map lower-level failures into them without exposing raw subprocess output:

| Code                      | Meaning                                                                                        |
| ------------------------- | ---------------------------------------------------------------------------------------------- |
| `pi_not_found`            | No selected Pi executable exists or remains accessible.                                        |
| `pi_not_executable`       | The selected path exists but cannot be executed safely.                                        |
| `pi_version_unavailable`  | `pi --version` timed out, overflowed its bound, or returned an invalid value.                  |
| `pi_version_unsupported`  | The selected Pi version has not passed the supported compatibility contract.                   |
| `pi_installation_changed` | The selected command path now resolves to materially different observed installation identity. |
| `pi_runtime_mismatch`     | The invoking client selected a different Pi than the live runtime.                             |
| `pi_service_mismatch`     | The installed service is configured for a different Pi selection.                              |

Errors may include the selected path and normalized version because this is a local user-private interface. They must not include environment values, provider credentials, arbitrary stderr, or package contents.

## Phase 0 — Prove the user's current Pi before changing packaging

### Goal

Prove that the exact terminal-selected Pi `0.82.1` satisfies every pi-fleet dependency on Pi behavior. This is the cheapest point to discover an incompatibility.

### Work

1. Run `scripts/pi-compatibility-probe.mts` with:

   ```bash
   PIFLEET_PI_EXECUTABLE="$(command -v pi)" npm run probe:pi
   ```

2. Extend the compatibility probe only for stable Pi RPC/session observations:
   - authoritative `get_state`;
   - prompt acceptance;
   - active `prompt` with `streamingBehavior: "steer"`;
   - `agent_settled`;
   - latest assistant text retrieval;
   - session materialization;
   - exact `--session`, `--session-id`, `--session-dir`, `--fork`, and `--continue` behavior;
   - exact-session restoration;
   - stdin-close shutdown.

3. Prove pi-fleet lifecycle behavior separately in process/fault tests using the absolute selected command path, not bare `pi`:
   - complete raw RPC stdout availability, including transient deltas;
   - typed `compact` and bounded token metrics;
   - extension UI cancellation;
   - process-group cleanup.

4. Add crash/recovery proof:
   - idle process loss and one restoration;
   - active process loss without replay;
   - same native session restoration;
   - no dual writer;
   - user session preservation after destroy.

5. Regenerate the checked-in compatibility profile only after the new evidence passes. Do not merely edit `0.80.10` literals.

### Primary files

- `scripts/pi-compatibility-probe.mts`
- `test/compat/pi-compatibility.test.ts`
- `test/fixtures/pi-compatibility-profile.json`
- `test/fixtures/fake-pi-contract.json`
- `test/process/real-pi-lifecycle.test.ts`

### Gate

Stop and return to design if Pi `0.82.1` fails RPC, session, raw-watch, compaction, steering, settlement, or shutdown behavior. Do not remove the managed dependency until this gate passes.

## Phase 1 — Add a pure external Pi selection boundary

### Goal

Resolve and validate the user's selected Pi without starting the central runtime or touching durable state.

### Work

1. Add a dormant external selection module, such as `src/pi/external-installation.ts`. Keep the managed fallback active during this phase so every commit remains operational; external-only activation occurs only after protocol identity and all startup paths are ready in Phase 3.

2. Introduce pure types:

   ```ts
   interface PiSelection {
     selectedPath: string;
     realPath: string;
     version: string;
     nodePath: string;
     fingerprint: string;
   }
   ```

3. Implement PATH lookup without a shell.

4. Validate:
   - explicit overrides are absolute;
   - selected path is an executable regular file or safe executable symlink;
   - realpath resolution succeeds;
   - `pi --version` runs with `shell: false`;
   - timeout, stdout, and stderr are bounded;
   - output normalizes to one supported version;
   - selected Node is absolute and executable;
   - paths with spaces and Unicode remain exact.

5. Keep `PIFLEET_PI_EXECUTABLE` as an explicit user override. Mark `PIFLEET_PI_ARTIFACT_ID` for removal at the activation boundary rather than removing it in this dormant phase.

6. Add a test-only injected resolver rather than relying on host PATH in deterministic tests.

7. Do not route production startup through this resolver yet.

### Primary files

- `src/pi/managed-target.ts` → replace/rename
- `src/pi/adapter.ts`
- `src/pi/process.ts`
- `src/shared/product-identity.ts` or a new focused Pi identity module
- `test/unit/managed-target.test.ts` → replace/rename
- Pi resolver fixtures under `test/fixtures/`

### Required tests

- PATH selects the first expected executable.
- Explicit override wins.
- Relative override fails.
- Missing, directory, and non-executable paths fail distinctly.
- Safe symlink preserves selected path while recording realpath.
- Symlink retarget changes fingerprint.
- Version timeout, malformed output, oversized output, and nonzero exit fail closed.
- Spaces and Unicode survive without shell interpretation.
- Child PATH selects the same Node environment as the user's Pi command.

### Gate

The resolver must be deterministic, side-effect bounded, and fully testable without a real provider or central runtime.

## Phase 2 — Enforce Pi identity at the runtime and private protocol boundary

### Goal

Make it impossible for a new CLI to dispatch work through an old managed-Pi runtime or a live runtime configured for another Pi.

### Work

1. Bump the private protocol major from `1` to `2`.

   This is required because beta.9 runtimes can otherwise accept work while continuing to launch bundled Pi. A responsive protocol-v1 runtime is never stale and must not be killed automatically.

2. Add runtime identity to the protocol handshake or response metadata:

   ```json
   {
     "pi": {
       "selectedPath": "/absolute/path/pi",
       "realPath": "/observed/target",
       "version": "0.82.1",
       "fingerprint": "opaque-local-identity"
     }
   }
   ```

3. Include the caller's current Pi identity in work-accepting requests:
   - `agent.create`;
   - `agent.send`;
   - `agent.compact`.

4. Treat caller Pi identity as transport/runtime context, not semantic mutation payload. Exclude it from operation fingerprints.

5. Preserve idempotency ordering exactly:
   - validate the identity shape at the protocol boundary without deciding compatibility there;
   - perform durable operation lookup and reconstruction first;
   - a retry of an already completed operation returns its original result even if Pi later changed;
   - a retry attaches to an existing nonterminal operation and follows existing uncertainty recovery;
   - only a genuinely new operation evaluates Pi compatibility;
   - persist a pre-dispatch Pi mismatch as that operation's terminal typed result so matching retries remain deterministic;
   - perform the compatibility decision before capacity reservation, pending send/compact persistence, process restoration, or dispatch.

6. Keep passive commands usable without a matching caller Pi identity. Runtime control-plane readiness must not require Pi execution availability.

7. Expose runtime Pi identity in private diagnostics only. Do not add Pi paths to ordinary public `status` or `list` unless a later user need justifies it.

8. Map old responsive runtimes to actionable `protocol_incompatible` guidance. Do not replace their socket, kill their PID, or start another runtime.

9. Define startup reconciliation as an independent dispatch caller:
   - reconcile and prove prior process-tree absence before considering new dispatch;
   - `dispatching` work remains uncertain and is never replayed;
   - pending create/send/compact work may resume only when the runtime independently observes a valid supported Pi;
   - while Pi is unavailable or incompatible, proven-undispatched work remains durably pending rather than becoming false uncertainty or terminal failure;
   - a matching retry attaches to the existing operation and never creates duplicate work.

10. Add an explicit control-plane availability state so the runtime can open SQLite, reconcile interruption/cleanup state, and serve passive commands even when Pi execution is unavailable.

### Primary files

- `src/protocol/version.ts`
- `src/protocol/envelope.ts`
- `src/protocol/validation.ts`
- `src/client/fleet-client.ts`
- `src/client/socket-fleet-client.ts`
- `src/runtime/control-server.ts`
- `src/runtime/fleet-service.ts`
- `src/platform/client/start-runtime.ts`
- protocol, socket, compatibility, and released-version tests

### Required race tests

- Runtime and client select the same Pi: work proceeds.
- Different selected paths: reject before any Pi write.
- Same path but changed version/fingerprint: reject before dispatch.
- Mismatch against resident idle agent: no prompt occurs.
- Mismatch during active work: accepted work is not interrupted; later work is rejected.
- Completed operation retry after a Pi switch returns the original result rather than `operation_conflict` or mismatch.
- Matching retry of an existing nonterminal operation attaches without creating duplicate work.
- Runtime starts with configured Pi missing, completes crash reconciliation, and serves passive commands.
- Pending create/send/compact remains pending without dispatch when Pi is unavailable and resumes once after repair.
- Current CLI against beta.9 runtime fails explicitly while preserving old PID/socket.
- Beta.9 CLI against current runtime fails explicitly.

### Gate

No work-accepting operation can reach a managed, missing, changed, or differently selected Pi.

## Phase 3 — Propagate the exact selection through detached and supervised startup

### Goal

Make terminal, detached, systemd, and launchd startup select the same Pi even when their PATH environments differ.

### Work

1. Resolve Pi and Node in the invoking CLI or installer environment.

2. Detached startup persists only durable selection inputs:

   ```text
   PIFLEET_PI_EXECUTABLE=<selected absolute command path>
   PIFLEET_PI_NODE=<selected absolute node path>
   ```

   Do not persist caller-supplied expected versions or fingerprints. At runtime startup, independently derive realpath, version, and fingerprint. Pi observation failure does not prevent control-plane readiness; it marks Pi execution unavailable.

3. Extend `ServiceDefinitionOptions` with Pi selection and selected Node data.

4. Persist the exact selection in systemd and launchd definitions. Do not persist the entire interactive environment.

5. Construct the Pi child PATH deliberately from trusted absolute directories. Reject empty or relative PATH segments if any configured PATH is accepted.

6. Extend installed-service inspection and mismatch handling, following the existing state-root mismatch pattern.

7. Add a private protocol-v2 `runtime.prepare-restart` or equivalent quiescence operation before changing installer restart behavior. It must account for active work, nonterminal operations, starting/restoring/stopping or cleanup-uncertain incarnations, coordinator and mutation lanes, held receives, and raw watchers. The policy for held clients must be explicit; they are either a deferral reason or deliberately terminated with typed errors.

8. Change installer `repair` semantics:
   - materialize and integrity-check the new runtime first;
   - resolve and validate the Pi selected in the invoking environment;
   - report old and new selected paths/versions;
   - preserve custom state root independently;
   - request runtime quiescence before writing a changed service definition;
   - if quiescence is unavailable, return `runtime_upgrade_deferred` without changing the active definition;
   - stage and atomically write the new definition only after quiescence;
   - restart and verify protocol v2 plus the independently observed Pi selection;
   - surface `repair_incomplete` with the exact boundary if activation fails;
   - never automatically restart beta.9 after schema v2 has been opened.

9. A live runtime with a different selection returns `pi_runtime_mismatch`; it is not replaced automatically.

10. A service definition with a different selection returns `pi_service_mismatch` and repair guidance before startup attempts.

11. Treat beta.9 → beta.10 as a one-time manual transition because protocol v1 cannot prove quiescence:

- detect protocol v1 and leave its PID/socket untouched;
- instruct the user to finish work with beta.9;
- require explicit user-confirmed service stop/repair;
- stop the old service/cgroup and prove recorded process groups absent;
- activate protocol v2 without eager restoration;
- preserve SQLite and every native session;
- document that beta.9 is not a valid automatic rollback after schema v2 opens.

12. Activate external-only production behavior only after protocol identity, passive unavailable mode, detached propagation, supervised propagation, and safe repair are all green. At this boundary remove the managed fallback and `PIFLEET_PI_ARTIFACT_ID` production behavior.

### Primary files

- `src/platform/client/start-runtime.ts`
- `src/platform/install/service-definition.ts`
- `src/platform/install/service-installer.ts`
- `src/entry/installer.ts`
- `src/entry/runtime.ts`
- `src/pi/process.ts`
- service installer, definition, process, and runtime startup tests

### Required tests

- Pi outside systemd's default PATH still launches from its persisted absolute path.
- A `#!/usr/bin/env node` Pi shim uses the selected Node environment.
- Detached and supervised runtime identities match.
- Service path mismatch is distinct from state-root mismatch.
- Paths with spaces are safely represented in systemd and launchd definitions.
- Repair is idempotent when selection is unchanged.
- Repair updates a changed selection only after protocol-v2 quiescence.
- Active work, unresolved cleanup, nonterminal mutations, and the chosen held-client policy defer repair without interruption.
- Failure injection covers before definition write, after write, after daemon reload, after old runtime stop, after SQLite migration/open, and before new runtime readiness.
- A current CLI detects beta.9 protocol v1 without changing its PID, socket inode, service definition, or managed Pi process state.
- Runtime restart performs no eager agent restoration.
- Service repair proves the complete old cgroup/process group absent before external Pi restoration, preserving the single-writer invariant.

### Gate

A disposable PID-1/systemd test must prove that the selected Pi is outside manager PATH yet create, restart, restoration, interruption, and session preservation still work.

## Phase 4 — Remove misleading per-agent Pi artifact state

### Goal

Make durable state reflect the real ownership model: one user-selected runtime-global Pi installation, not a pi-fleet-owned artifact per agent.

### Work

1. Remove required `piArtifactId` from newly created `AgentLaunchProfile` values.

2. Tolerate legacy beta.9 JSON containing `piArtifactId` and ignore it.

3. Do not add executable paths, realpaths, versions, or fingerprints to individual agents.

4. Preserve unchanged:
   - immutable agent ID and name;
   - cwd;
   - Pi argv and session selectors;
   - concrete session path and ID;
   - restore argv;
   - latest response;
   - send/compact/operation state;
   - incarnation and cleanup evidence.

5. Do not rewrite, copy, move, normalize, or delete any Pi session file.

### Primary files

- `src/pi/launch-profile.ts`
- `src/runtime/fleet-service.ts`
- `src/store/fleet-store.ts`
- memory/SQLite fixtures and launch-profile tests

### Migration decision

No new SQLite schema migration is expected. Agent launch profiles are stored inside `agents.data_json`, and `piArtifactId` is not indexed or constrained. The implementation must nevertheless include a real beta.9 database fixture proving old JSON remains readable.

### Required tests

- Existing beta.9 agent JSON loads without rewriting its session.
- `status`, `list`, stored `receive`, and `destroy` work before Pi starts.
- Later `send` restores the same native session with external Pi.
- Legacy `piArtifactId` does not choose or override Pi.
- Same-name generation and stale-operation protections remain intact.

### Gate

Existing durable entries and user-owned sessions survive the correction without a new writer or semantic replay.

## Phase 5 — Remove Pi from package dependencies and immutable materialization

### Goal

Make the shipped npm package and immutable runtime contain only pi-fleet and pi-fleet's own dependencies.

### Work

1. While the managed dependency still exists, first prepare external-Pi test infrastructure:
   - install Pi in a separate temporary prefix;
   - make real-Pi and package tests select it explicitly;
   - update CI setup without changing the production default;
   - prove tests no longer rely on Pi being present under pi-fleet's `node_modules`.

2. Prepare one atomic green cutover containing dependency removal, manifest/materializer support, separate-prefix package fixtures, CI setup, release smoke setup, and the zero-exception audit policy. `main` must never contain an intermediate state where clean install, build, audit, or package tests are structurally broken.

3. Remove `@earendil-works/pi-coding-agent` from `package.json` and regenerate `package-lock.json` with `npm install --package-lock-only` or the repository's clean install convention.

4. Bump runtime manifest schema from `3` to `4`.

5. Remove `managedPi` from the manifest. Optionally record only the product invariant:

   ```json
   { "piRuntime": { "mode": "external" } }
   ```

   Never put a machine-specific Pi path or version in the published manifest.

6. Keep closure integrity for remaining production dependencies:
   - source-before hash;
   - staged-copy hash;
   - source-after hash;
   - exact direct dependency names/versions;
   - link-safety checks;
   - immutable release identity;
   - concurrent materialization convergence;
   - corrupt destination fail-closed behavior.

7. Never copy or hash the external Pi installation into the application root.

8. Rewrite package tests so Pi and pi-fleet are installed into separate prefixes.

9. Preserve the package-removal guarantee correctly:
   - materialize pi-fleet;
   - remove the npm-installed pi-fleet package;
   - leave external Pi installed;
   - restart the materialized pi-fleet runtime;
   - complete lifecycle/restoration through that external Pi.

### Primary files

- `package.json`
- `package-lock.json`
- `scripts/build.mjs`
- `src/platform/install/runtime-release.ts`
- `test/integration/runtime-materialization.test.ts`
- `test/package/artifact.test.ts`
- runtime manifest fixtures and release checks

### Required negative tests

- Materialized release contains no Pi package or Pi executable.
- Pi missing after settlement blocks new work before dispatch while preserving sessions.
- Reinstalling Pi and repairing selection restores operation.
- Corrupt pi-fleet closure still fails closed.
- Different valid external Pi installations do not alter immutable pi-fleet release identity.

### Gate

A fresh packed install must start Pi from a separate prefix, survive removal of the pi-fleet npm source installation, and preserve the same user-owned session.

## Phase 6 — Prove the zero-exception production audit cutover

### Goal

Audit only what pi-fleet distributes and return to a strict zero-vulnerability policy.

### Work

This code change lands in the same atomic green transition as Phase 5; Phase 6 is its explicit validation boundary, not a later independently broken commit.

1. Remove the managed-Pi advisory exception from `scripts/check-production-audit.mjs`.

2. Stop reading nested Pi package metadata.

3. Fail closed on any production vulnerability or malformed audit report.

4. Update tests to prove:
   - zero vulnerabilities pass;
   - one vulnerability fails;
   - malformed output fails;
   - no package/path exception remains.

5. Update security documentation accurately: external Pi has its own independent dependency and advisory posture.

### Primary files

- `scripts/check-production-audit.mjs`
- `test/unit/production-audit.test.ts`
- `README.md`
- `CHANGELOG.md`

### Gate

`npm run audit:production` passes with zero exceptions after a clean `npm ci`.

## Phase 7 — Update CI, release smoke, documentation, and operator guidance

### CI and release workflow

1. Install the tested Pi version separately from pi-fleet in CI jobs that need real Pi.

2. Use separate prefixes so Pi is never reconstructed as a pi-fleet dependency.

3. Update the tag publication smoke:
   - install tested Pi in a temporary Pi prefix;
   - install published pi-fleet in another prefix;
   - verify provenance and version;
   - verify runtime reports the separately selected Pi;
   - run `list`;
   - run at least promptless `create → status → destroy` so the smoke proves Pi actually starts;
   - assert the materialized release contains no Pi package.

4. Update nightly reliability and released-version matrix setup.

5. Add published `0.1.0-beta.9` to the released-version matrix or create a dedicated isolated fixture from that immutable package.

6. Add current CLI versus beta.9 runtime proof: explicit incompatibility, unchanged old PID and socket inode, unchanged service definition, no new runtime materialization, and no request reaching managed Pi.

### Documentation

Update installation order:

```bash
command -v pi
pi --version
npm install --global @elpapi42/pi-fleet@beta
pifleet --version
```

Document:

- Pi is required and installed separately.
- pi-fleet uses the executable selected from PATH.
- `PIFLEET_PI_EXECUTABLE` is an explicit absolute override.
- Shell aliases/functions are unsupported.
- systemd/launchd persist the selected absolute path.
- NVM/fnm/Volta changes may require repair and runtime restart.
- No bundled fallback exists.
- Pi upgrades are compatibility events and never hot-swap active work.
- Missing Pi blocks new work, not passive inspection or cleanup when the runtime can start from its persisted configuration.
- pi-fleet never copies, relocates, normalizes, or deletes Pi or its sessions.
- pi-fleet's npm audit does not audit the separately installed Pi.

Historical changelog entries remain historically accurate. Add the correction under `Unreleased`; do not rewrite old releases to imply they shipped external Pi.

### Primary files

- `.github/workflows/publish.yml`
- `.github/workflows/nightly-reliability.yml`
- `README.md`
- `SKILL.md`
- `CHANGELOG.md`
- CLI help and release checks

## Phase 8 — Full validation and beta release

### Deterministic gates

```text
npm ci
npm run audit:production
npm run typecheck
npm run lint
npm run format:check
npm test
npm run test:faults
npm run test:process
npm run test:package
npm run test:platform
npm run test:compat
npm run test:version-matrix
npm run test:soak
npm run release:check
npm run build
npm pack --dry-run
```

### Required behavioral evidence

- Exact terminal-selected Pi path is used for every spawned Pi process.
- No Pi package exists in pi-fleet's published or materialized closure.
- Raw RPC watch remains byte-exact and incarnation-scoped.
- Prompt, steering, receive, compact, session selectors, restoration, and destroy work with external Pi.
- Missing or mismatched Pi fails before dispatch.
- No accepted input is replayed.
- No dual session writer starts.
- Existing beta.9 agents restore the same session.
- Active work is never interrupted automatically by a Pi change.
- Old managed-Pi runtimes are rejected explicitly and not replaced silently.
- systemd works when Pi is outside manager PATH.
- pi-fleet npm-package removal does not break its materialized runtime while external Pi remains installed.
- User-owned sessions survive all failure, repair, destroy, and upgrade paths.

### Release process

Only after every gate passes:

1. Prepare `0.1.0-beta.10` release metadata.
2. Commit and push `main`.
3. Create immutable annotated tag `v0.1.0-beta.10`.
4. Publish through GitHub Actions OIDC with provenance.
5. Verify exact npm version and `beta`/`latest` dist-tags.
6. Run a clean fresh-registry install with separately installed Pi.
7. Run an operational process-starting smoke, not only `--version` or `list`.

A failed beta.10 tag is never moved or reused; fix forward with beta.11.

## Implementation sequencing and commit boundaries

Use small, reviewable commits in this order while keeping every `main` commit green:

1. `test: prove external Pi compatibility` — evidence only; no production default change.
2. `feat: add external Pi selection` — dormant pure resolver and typed availability states; managed fallback remains active.
3. `feat: separate Pi availability from runtime readiness` — passive control plane works without executable availability; reconciliation does not dispatch pending work through unavailable Pi.
4. `feat: enforce Pi identity across protocol v2` — transport context, operation replay ordering, old-runtime rejection, and beta.9 matrix fixture.
5. `feat: persist Pi selection for supervised startup` — detached/service propagation, quiescence, staged repair, and post-restart verification.
6. `feat: activate user-selected Pi execution` — external-only activation after every startup path is ready; remove managed fallback behavior.
7. `refactor: remove per-agent managed Pi identity` — legacy beta.9 JSON remains readable.
8. `test: isolate external Pi package and CI setup` — separate-prefix fixtures and workflows while the dependency still exists.
9. `refactor: remove Pi from the shipped runtime` — one atomic green cutover containing dependency/lockfile removal, manifest schema 4, materializer changes, package fixtures, release smoke, and zero-exception audit policy.
10. `test: validate external Pi service and recovery` — systemd PID-1, repair failure injection, no-dual-writer transition, package removal, and session preservation.
11. `docs: document user-owned Pi execution`.
12. `chore: release 0.1.0-beta.10`.

Do not parallelize production writes across steps 3–9. They share protocol, startup, runtime, service, packaging, and audit contracts. Within a step, isolated test/fixture work may proceed in parallel only when touched files are explicitly disjoint. The dependency/manifest/audit cutover in step 9 may be developed internally in smaller increments, but it lands on `main` only as one green transition.

## Rollback and failure policy

- No native Pi session is modified as part of migration.
- No old materialized release is deleted automatically.
- No responsive old runtime is killed as stale.
- No active work is interrupted to adopt another Pi.
- Beta.9 → beta.10 is an explicit user-confirmed transition after old work is finished; protocol v1 cannot prove quiescence automatically.
- Service repair materializes and validates the candidate first, establishes quiescence second, writes the definition third, and verifies protocol/Pi identity after restart.
- Failures before definition activation preserve the old definition. Failures after schema migration/open never automatically restart beta.9 and surface `repair_incomplete` with recovery state.
- A failed implementation before tagging can be reverted without touching user sessions.
- After schema v2 is opened, reinstalling beta.9 is not a database rollback and may be refused.
- If beta.10 is published with a defect, deprecate it, fix forward, and move only the `beta` tag.

## Non-goals

- Installing or upgrading Pi.
- Supporting shell aliases or shell functions.
- Bundling or copying Pi into pi-fleet storage.
- Managing multiple Pi versions per agent.
- Hot-swapping Pi while work is active.
- Automatically replacing a responsive runtime.
- Claiming compatibility with every future Pi version.
- Changing session ownership, response semantics, raw-watch semantics, operation idempotency, or no-replay guarantees.

## Definition of done

The migration is complete only when all of the following are true:

1. `@earendil-works/pi-coding-agent` is absent from pi-fleet's production dependencies, lockfile closure, npm tarball, immutable runtime, and release manifest.
2. Every Pi spawn uses the exact absolute command selected by the user or their explicit absolute override.
3. Detached and supervised runtimes report that same selection.
4. Work is rejected before dispatch when client, service, runtime, or installation identity disagrees.
5. Existing beta.9 durable entries and native sessions remain usable.
6. The production audit passes with zero exceptions.
7. External Pi `0.82.1` passes the complete compatibility, process, package, systemd, crash, and restoration gates.
8. A fresh registry install proves process-starting behavior with Pi installed separately.
9. The next beta is published immutably with provenance only after those gates pass.
