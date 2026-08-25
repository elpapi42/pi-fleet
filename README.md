# pi-fleet

pi-fleet provides durable, host-local Pi agents through an SDK and CLI. Slice 6 supports agent creation, discovery, status checks, sending work, durable activity replay, and transparent Pi and worker process recovery on Unix-like hosts.

## Packages

- `@elpapi42/pi-fleet-sdk` provides the TypeScript SDK.
- `@elpapi42/pi-fleet-cli` installs the `pif` command and depends on the SDK.

## Install

Install the SDK in an application:

```bash
npm install @elpapi42/pi-fleet-sdk
```

Install the CLI globally:

```bash
npm install --global @elpapi42/pi-fleet-cli
pif create researcher --cwd "$PWD"
pif list
pif status researcher
pif --help

# Show activity from the current tail.
pif receive researcher

# In another terminal:
pif send researcher "Investigate the database schema"

# Replay all durable activity.
pif receive researcher --from-start

# Show full bounded successful tool output and details.
pif receive researcher --verbose

# Stop active work, remove the agent, and delete its history.
pif destroy researcher

# Pass session selection directly to Pi
pif create existing --cwd "$PWD" -- --session /path/to/session.jsonl

# Use a separate pi-fleet environment for any command.
pif --state-dir /tmp/team-fleet create analyst --cwd "$PWD" -- --session /tmp/analyst.jsonl
pif --state-dir /tmp/team-fleet list
pif --state-dir /tmp/team-fleet status analyst
pif --state-dir /tmp/team-fleet send analyst "Continue"
pif --state-dir /tmp/team-fleet receive analyst --from-start
pif --state-dir /tmp/team-fleet destroy analyst
```

By default, pi-fleet stores its LMDB state and IPC sockets in `~/.pi-fleet`. Use the optional global `--state-dir PATH` to select another environment. Commander also accepts this option after a subcommand, such as `pif list --state-dir /tmp/team-fleet`. Relative paths resolve from the CLI process current directory. Put `--state-dir` before create's `--` separator because everything after that separator passes directly to Pi. Event history includes bounded tool details and remains there until the owner runs `pif destroy NAME`. There is no expiry or retention setting yet, so disk use can grow. Pre-stable releases do not migrate state from earlier locations automatically.

`pif destroy NAME` requires no confirmation. It can stop active work, emits a final `agent.destroyed` event to healthy active receivers, then removes the worker, Pi, name, agent record, IPC socket, and complete event history. A destroyed name can be recreated as a new agent with a new ID.

Running agents keep the worker version used at creation. After updating pi-fleet, create a new agent before testing new worker behavior such as worker recovery. SDK `0.12.0` and CLI `0.16.0` remove `work.interrupted` from replay. Destroy and recreate agents made by older versions before using this release.

A later `status`, `send`, or `receive` operation replaces an unavailable worker through one LMDB recovery claim. Durable identity, session metadata, event history, and SDK cursors continue across the new worker generation. A stream reconnects and replays from its last delivered cursor. Pi-fleet never retries a send that the old worker might have accepted. Active Pi runtime loss changes the agent to sticky `interrupted`; use `status` to detect it. The state remains interrupted until Pi starts newly sent work, while `list` remains inventory and can temporarily show stale working state after unobserved worker loss. `pif receive` supports live-only activity, `--from-start` replay, and `--verbose` full bounded successful output and details. Plain `pif receive NAME` is live-only and can miss activity before subscription acknowledgement. Start `pif receive NAME --from-start` before sending work when no first activity may be missed. Exact cursor resume remains available through the SDK, not through the CLI.

## Develop locally

Requirements: Node.js 22.12 or later and npm 10 or later.

```bash
npm install
npm run build
npm test
npm run pif -- --help
npm run pack:check
```

`npm run pack:check` checks the exact files that each publishable package will contain. It does not publish either package.

## Package releases

The SDK and CLI release independently. The CLI pins `@elpapi42/pi-fleet-sdk` to one exact version. Publish that SDK version before a CLI release that uses it.

Publishing starts when a GitHub release is published from one of these tags:

```text
sdk-v<package-version>
cli-v<package-version>
```

The matching package version must equal the tag version. For example, publish SDK version `0.2.0` from `sdk-v0.2.0`.

A stable GitHub release publishes npm tag `latest`. A GitHub prerelease requires an npm prerelease version such as `0.2.0-beta.1` and publishes npm tag `next`. The workflow rejects a stable release with a prerelease version, and the reverse mismatch.

Trusted publishing is configured independently for both npm packages. Each package trusts this GitHub repository and workflow file:

```text
.github/workflows/publish.yml
```

Protect the `sdk-v*` and `cli-v*` tag patterns with GitHub repository rules. Restrict tag creation and updates to approved release actors.

The workflow uses npm provenance and does not require an npm token. It publishes the SDK or CLI selected by the release tag only.
