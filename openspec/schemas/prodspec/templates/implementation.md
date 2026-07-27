# Implementation

## Phases and tasks
<!--
This is the only prodspec artifact that should use markdown checkbox syntax. OpenSpec apply tracks top-level checkbox lines in this file.

Group tasks into numbered phases. Use letter suffixes to show parallel lanes:
- Phase 1 runs before Phase 2.
- Phase 2A and Phase 2B can run in parallel.
- Phase 3 runs after the Phase 2 lanes are complete.

Use the same convention for tasks:
- Task 1.1 runs before Task 1.2.
- Task 1.2A and Task 1.2B can run in parallel.
- Task 1.3 runs after the Task 1.2 lanes are complete.

Each task must be a detailed, granular, self-contained top-level checkbox line with enough context for /pdsx:apply: task number, target files/surfaces/symbols when known, intended behavior, and execution constraints/dependencies.

This artifact is execution-only. Do not create checkbox tasks for testing, validation, verification, smoke checks, browser flows, API checks, DB checks, evals, environment checks, or proof steps. Put all proof of correctness in testing.md.

Every phase should be independently testable after completion when possible, but the checks belong in testing.md. If a phase cannot be independently validated, state why in Notes and identify the later testing.md section or final validation that will prove it. Parallel lanes should have lane-level verification in testing.md where possible plus integration verification after the lanes merge.

Do not rely on sub-bullets for task-critical details; OpenSpec does not attach them to parsed tasks.
-->

### Phase 1: <phase name>
<!-- Example task shape: - [ ] Task 1.1: Update `path/file.ts` so ...; depends on ...; keep compatibility with .... Validation/proof for this task belongs in testing.md, not in this checkbox line. -->

### Phase 2A: <parallel phase name>

### Phase 2B: <parallel phase name>

## Notes
<!-- Plain bullets only: sequencing constraints, parallelization/isolation requirements, implementation risks, blockers, or context not tied to one task. Do not use checkbox syntax here. -->
