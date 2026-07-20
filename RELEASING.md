# Releasing pi-fleet

pi-fleet publishes scoped public prereleases as `@elpapi42/pi-fleet` under the npm `beta` dist-tag.

## Trusted publisher setup

Configure an npm trusted publisher for:

```text
Provider:   GitHub Actions
Repository: elpapi42/pi-fleet
Workflow:   publish.yml
Environment: npm
```

The GitHub `npm` environment should require approval. The workflow uses OIDC (`id-token: write`) and npm provenance; do not add a long-lived `NPM_TOKEN`.

The first package publication may require an authenticated manual publish before npm exposes package settings for trusted publishing:

```bash
npm login
npm whoami
npm ci
npm test
npm run release:check
npm publish --access public --tag beta --provenance
```

## Release procedure

1. Update `package.json`, `package-lock.json`, `src/shared/product-identity.ts`, and `CHANGELOG.md` to the same beta version.
2. Run:

   ```bash
   npm ci
   npm run audit:production
   npm run typecheck
   npm run lint
   npm run format:check
   npm test
   npm run release:check
   ```

3. Commit and push `main`.
4. Create and push an exact prerelease tag, for example:

   ```bash
   git tag v0.1.0-beta.0
   git push origin v0.1.0-beta.0
   ```

5. Approve the protected `npm` environment deployment.
6. Verify the registry and clean installation:

   ```bash
   npm view @elpapi42/pi-fleet dist-tags --json
   npm install --global @elpapi42/pi-fleet@beta
   pifleet --version
   pifleet list
   ```

The workflow rejects non-beta versions and tags that do not exactly match `package.json`. It always publishes with `--tag beta`. The production-audit gate normally requires zero vulnerabilities; while managed Pi remains at `0.80.10`, it permits only the exact `brace-expansion@5.0.6` advisory `GHSA-3jxr-9vmj-r5cp` recorded in upstream issue #6882. Any changed package/version/path or any additional advisory fails closed, and the exception should be removed as soon as Pi publishes the patched closure.

## Rollback

npm versions cannot be overwritten or unpublished as a routine rollback. If a beta is defective:

1. Deprecate the affected version with an actionable message.
2. Publish a fixed incremented beta.
3. Move only the `beta` dist-tag.

Do not recommend downgrading a pi-fleet database after a newer runtime applies an incompatible migration. npm uninstall and `pifleet destroy` never delete Pi sessions.
