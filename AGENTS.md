<!-- opm:managed:start -->
- The user prefers direct edits for planning-only artifacts. Implementation and review forks must have small, specific scopes. A balanced fork must not own a full delivery slice.
- When the user requests easy copy-paste commands, they expect literal commands with fixed names and no shell variables or substitutions.
- Interactive npm authentication and 2FA are user-operated. The agent handles non-interactive release actions after authentication. Trusted-publisher setup is documented in the npm-trusted-publisher-bootstrap skill.
- `proposal.md` is the target architecture and product contract. `plan.md` defines the delivery sequence. Both are local planning artifacts outside Git.
- Before pi-fleet becomes stable, backward compatibility is not required unless a current product reason requires it.
- Updating the SDK or CLI does not update workers that already run. Existing agents keep their worker code version. Testing new runtime behavior requires a newly created agent.
- When committed work changes an SDK or CLI package version, publish that version before reporting completion unless the user explicitly says not to publish.
- Fake-Pi tests prove pi-fleet protocol behavior, not real-Pi compatibility. After each user-visible runtime feature, real-Pi checks use the slice-runtime-acceptance skill with an installed public-SDK script and an installed `pif` end-to-end flow. Use deterministic intermediate-state signals instead of fixed delays.
- The user expects AGENTS.md to remain tracked project guidance and new .pi/ content to remain ignored by Git.
- The user treats cohesion as the primary code-organization rule. Organize code by capability, prefer larger cohesive files over generic shared inventories, and split only for independent responsibilities while keeping split files in one cohesive folder.
<!-- opm:managed:end -->
