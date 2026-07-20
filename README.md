# Pi Fleet

Pi Fleet is a local runtime and machine-first CLI for named Pi agents.

```text
create · send · receive · status · list · watch · destroy
```

Pi sessions remain under user control. Native Pi arguments pass through after `--`; Fleet is intended to manage named process lifecycle, restoration, latest-response retrieval, and raw session tailing.

## Development status

Milestone 1 is complete: the repository has a strict TypeScript/ESM foundation, test and build tooling, and separate CLI/runtime bundles. Product behavior is not implemented yet.

```bash
npm ci
npm run typecheck
npm run lint
npm test
npm run build
node bin/pifleet.mjs --version
```

The built CLI currently supports only `--version`. Other invocations deliberately exit nonzero with `pifleet is not implemented yet.`

See [`IMPLEMENTATION_PLAN.md`](./IMPLEMENTATION_PLAN.md) for the implementation sequence and evidence gates.
