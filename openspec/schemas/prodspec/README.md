# prodspec schema

`prodspec` is a product-first OpenSpec workflow for planning real initiatives through seven compact artifacts:

1. `dump.md` — freeform user-authored raw context for the initiative. It is created by `/pdsx:create`, intentionally has no required format, and remains a frozen initial snapshot for the life of the change.
2. `problem.md` — shared understanding of the real problem.
3. `solution.md` — agreed high-level product/workflow behavior and solution mechanics.
4. `specification.md` — code-grounded technical approach.
5. `implementation.md` — phased, granular, self-contained execution tasks tracked by OpenSpec apply; no testing or validation tasks.
6. `testing.md` — repeatable verification and validation runbook for agents and humans.
7. `release.md` — repeatable environment-parameterized release/deployment runbook.

The schema graph is:

```text
dump -> problem -> solution -> specification -> implementation -> testing -> release -> apply
```

The normal operator flow is:

```text
/pdsx:create -> /pdsx:discover -> /pdsx:shape -> /pdsx:specify -> /pdsx:plan -> /pdsx:apply -> /pdsx:archive
```

There is also a fast-track alternate path for simple, low-ambiguity, low-risk initiatives:

```text
/pdsx:create -> /pdsx:fastpass -> /pdsx:apply -> /pdsx:archive
```

`/pdsx:fastpass` does not change the artifact graph or authority model. It is a compressed workflow that should route back to `/pdsx:discover`, `/pdsx:shape`, or `/pdsx:specify` when the change stops being simple enough to safely synthesize in one pass.

`/pdsx:shape` includes product-context gathering before solution shaping, analogous to `/pdsx:specify`'s technical context gathering. It should establish affected users, current behavior, desired outcome, constraints, risks, and success signals from available product evidence before writing `solution.md`.

`dump.md` is a frozen historical input artifact, not an approved decision artifact or current truth. It must not be edited, normalized, or kept aligned with later artifacts. Divergence between `dump.md` and approved downstream artifacts is expected as the initiative becomes more precise. Later steps should read it only to recover original user context, spot possible silent loss of important branches or constraints, and form sharper questions; approved downstream artifacts are the source of truth when they conflict with the dump.

`apply.tracks` is `implementation.md`. OpenSpec apply parses only top-level markdown checkbox lines in `implementation.md`; reserve checkbox syntax for executable implementation tasks only and keep each tracked task self-contained on the checkbox line. Do not encode testing, validation, verification, smoke checks, browser/API/DB checks, evals, environment checks, or proof steps as tracked implementation tasks.

`testing.md` owns proof of correctness. `testing.md` and `release.md` are reusable ordered runbooks, not tracked task lists. They should use numbered steps only and must not use markdown checkbox syntax.

## Canonical specs note

This schema does not create or sync canonical `openspec/specs/` capability specs by default. It preserves `dump.md`, `problem.md`, `solution.md`, `specification.md`, `implementation.md`, `testing.md`, and `release.md` as planning, implementation, and delivery history for a change.

If a project wants archive-time updates to long-lived `openspec/specs/`, add valid OpenSpec spec delta files under `openspec/changes/<change>/specs/` and update project-specific archive expectations accordingly.
