# Testing

<!--
This is a repeatable verification runbook for agents and humans. It is not a tracked task list.

Use ordered numbered steps. Do not use markdown checkbox syntax in this file.
Run or adapt this guide for each target environment and after relevant implementation phases.
Name credentials, roles, tenants/workspaces, seeded data, flags, URLs, and services required for testing, but never include secret values. If required access is unavailable during execution, stop and ask the user.
-->

## Environment parameters
<!-- List the placeholders or per-environment values the tester must resolve before running the guide: environment name, base URL, user role/account, tenant/workspace, feature flags/config, seeded data, database target, service URLs, credentials/access needed. -->

1. <parameter to confirm>

## Phase-level verification
<!-- Ordered checks that can run after individual implementation phases or parallel lanes. Reference phase/task ids from implementation.md when useful. Include what to test, expected result, and what evidence to capture. -->

1. After <Phase/Task>, verify <behavior> by <browser/API/DB/CLI/log check>; expect <result>; capture <evidence>.

## Final verification
<!-- End-to-end checks for the completed initiative. Include browser flows, API requests, DB/data checks, integrations/jobs/events/notifications, permissions, negative/error cases, regression checks, observability, and cleanup/reset. -->

1. Browser: <flow and role>; expect <UI states/outcome>; watch for <loading/error/empty/accessibility/workflow issue>.
2. API: <method path payload/auth>; expect <status/body/side effect>; include negative or permission case when relevant.
3. Data: <query/table/collection/ORM command>; expect <record/state transition/no unintended change>.
4. Observability/integration: check <logs/metrics/traces/jobs/queues/webhooks/notifications/events>; expect <signal>.
5. Regression: verify <old behavior> still works by <check>.
6. Cleanup/reset: restore or remove <test data/state> when appropriate.

## Watchouts
<!-- Plain bullets only: likely failure modes, flaky areas, cache/state drift, race conditions, data hazards, environment-specific gotchas, or false positives. Do not use checkbox syntax. -->
