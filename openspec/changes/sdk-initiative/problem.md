# Problem

## What is the problem?

pi-fleet manages durable shared agents and native Pi sessions, but its public interaction model is built around finite, lifecycle-coupled operations. Waiting for an agent to become idle and retrieving one mutable latest response does not provide a dependable continuous communication boundary for agents that receive repeated instructions, use tools, move through multiple lifecycle states, and may produce later activity after an apparent settlement.

This affects local programs that coordinate shared long-lived Pi agents over time. The first proving case is a main Pi extension coordinating persistent reviewer subordinates, but the problem applies to any local orchestration program that needs to observe and react to ongoing agent activity across repeated interactions and interruptions.

## Why does it matter?

This blocks pi-fleet's primary intended machine-first orchestration use rather than merely making the CLI inconvenient. A program cannot build a trustworthy long-running communication loop when output availability is represented by an idle boundary and one latest-text snapshot instead of a reliable continuous observation contract.

The observed timer and empty-assistant-message sequence demonstrates the mismatch: Pi produced visible output, later settled an assistant entry with empty visible text, and subsequently produced more visible output. The current receive behavior returned `no_response` at the empty-text boundary. This does not prove that the later output was lost, but it proves that agent idleness and latest visible text are not reliable substitutes for continuous communication state.

## What gets better if this is solved?

Local orchestration programs can continuously observe meaningful completed agent activity that pi-fleet declares durable, in per-agent order, across client, runtime, and Pi-process interruptions. Completed activity is not silently lost, possible redelivery is identifiable, and interrupted partial activity does not need to be reconstructed.

This makes long-lived orchestration trustworthy enough for the primary reviewer-subordinate use case and other local orchestration programs, while finite scripts and manual interactions remain straightforward secondary uses of the same behavior.
