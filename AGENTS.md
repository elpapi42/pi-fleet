<!-- opm:managed:start -->
- The user prefers direct edits for planning-only artifacts. Implementation and review forks must have small, specific scopes. A balanced fork must not own a full delivery slice.
- When the user requests easy copy-paste commands, they expect literal commands with fixed names and no shell variables or substitutions.
- Interactive npm authentication and 2FA are user-operated. The agent handles non-interactive release actions after authentication. Trusted-publisher setup is documented in the npm-trusted-publisher-bootstrap skill.
- `proposal.md` is the target architecture and product contract. `plan.md` defines the delivery sequence. Both are local planning artifacts outside Git.
- Before pi-fleet becomes stable, backward compatibility is not required unless a current product reason requires it.
- Updating the SDK or CLI does not update workers that already run. Existing agents keep their worker code version. Testing new runtime behavior requires a newly created agent.
- Fake-Pi tests prove pi-fleet protocol behavior, not real-Pi compatibility. Real-Pi checks use the slice-runtime-acceptance skill. Intermediate-state tests use deterministic files or signals instead of fixed delays.
<!-- opm:managed:end -->
