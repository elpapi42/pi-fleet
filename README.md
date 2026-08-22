# pi-fleet

pi-fleet provides durable, host-local Pi agents through an SDK and CLI. Slice 1 supports agent creation, discovery, and status checks on Unix-like hosts.

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

# Pass session selection directly to Pi
pif create existing --cwd "$PWD" -- --session /path/to/session.jsonl
```

## Develop locally

Requirements: Node.js 22 or later and npm 10 or later.

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
