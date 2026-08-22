# pi-fleet

pi-fleet provides durable, host-local Pi agents through an SDK and CLI. The project is in active development. Slice 1 will add agent creation and discovery.

## Packages

- `@elpapi42/pi-fleet-sdk` provides the TypeScript SDK.
- `@elpapi42/pi-fleet-cli` installs the `pif` command and depends on the SDK.

## Install

After the first release, install the SDK in an application:

```bash
npm install @elpapi42/pi-fleet-sdk
```

Install the CLI globally:

```bash
npm install --global @elpapi42/pi-fleet-cli
pif --help
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

The SDK and CLI use matching versions. Publish the SDK first, then publish the CLI because the CLI declares an exact SDK dependency.
