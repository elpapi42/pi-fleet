# Release

<!--
This is a repeatable release/deployment runbook for agents and humans. It is not a tracked task list.

Use ordered numbered steps. Do not use markdown checkbox syntax in this file.
Run or adapt this guide once per target environment. Treat it as environment-parameterized, not environment-agnostic.
Name env vars, config keys, flags, database operations, explicit SQL/manual data steps, branches, services, approvals, and access requirements, but never include secret values. If required access is unavailable during execution, stop and ask the user.
-->

## Environment parameters
<!-- List the placeholders or per-environment values required before release: environment name, source branch/PR/tag/commit, target services/repos, deploy surface, base URL, database/schema/index target, feature flags/config namespace, required credentials/access, approval gates, monitoring links. -->

1. <parameter to confirm>

## Pre-release checks
<!-- Ordered checks to run before deployment or promotion. Include branch/PR status, CI/tests/evals, dependency compatibility, feature flag/config readiness, migration/backfill readiness, and known blockers. -->

1. Confirm <source branch/PR/tag/commit> is the intended source for <environment> and required reviews/checks have passed.

## Release steps
<!-- Ordered environment-promotion steps. Include merge/promote order, env vars/config/flags, explicit SQL/manual DB statements, backfills/indexes/manual data changes, service deploy order, smoke checks, monitoring, rollback checkpoints, and cleanup. Include the exact SQL or command snippets required when they are known; if a value is environment-specific or secret, use a placeholder and name the owner/access needed. -->

1. Promote or merge <source> to <target> using <project release path>.
2. Configure <env vars/config keys/feature flags> in <environment>; use placeholders only, never secret values.
3. Apply required database/schema/data changes in this order: <order>; include exact SQL statements, psql commands, migration file paths, backfill commands, index statements, and rollback/cleanup SQL when known. If SQL or access is not yet known, mark it as a blocker with owner/access needed.
4. Deploy services/repos in this order: <order>.
5. Run smoke checks from `testing.md`: <specific steps or subset>.
6. Monitor <logs/metrics/errors/jobs/queues/dashboards> for <duration or release window>.
7. Roll back or kill via <branch revert/deploy rollback/flag disable/config revert/data recovery path> if <failure condition> occurs.

## Post-release follow-up
<!-- Plain bullets only: cleanup, flag removal, docs/support notes, runbook updates, known limitations, or follow-up monitoring. Do not use checkbox syntax. -->
