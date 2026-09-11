# Final Proposed Protocol: ACM-CP/1.0 Core

The final protocol proposal is narrowed to one profile:

> `ACM-CP/1.0 Core`

ACM-CP means Agent Communication-Memory Control Plane. It is a semantic overlay
for agent-to-agent transports, not a replacement for HTTP, JSON-RPC, MCP, A2A,
message queues, or framework-specific runtimes.

## Why This One

Earlier hypotheses tested separable semantics:

- typed envelope
- evidence capsule
- proof-carrying capability card
- delegation commitment receipt
- scoped memory
- causal-policy trace
- context manifest

The final protocol is not any one of these components alone. The evidence so
far indicates that each component controls a different failure mode, so the
standardizable unit should be the bundled control plane.

## Required Core Semantics

`ACM-CP/1.0 Core` requires:

1. Typed envelope with trace, sender, receiver, intent, state, and payload hash.
2. Evidence capsules for claim transfer and replayable provenance.
3. Proof-carrying capability cards for delegation under policy scope.
4. Delegation commitment receipts with success predicates and deliverables.
5. Scoped memory operations with read/write/commit/revoke/forget semantics.
6. Causal-policy trace for memory access, redaction, and audit replay.
7. Context manifests for large-context negotiation without raw context copying.

## Non-Core Baselines

These are not final proposals:

- `freeform-chat`
- `typed-envelope`
- `evidence-capsule`
- `proof-capability`
- `commitment-receipt`
- `scoped-memory`

They remain as controls and ablations only.

## Claim Boundary

Current Tier 0 deterministic runs show that the benchmark evaluator can isolate
the intended failure modes.

Current Tier 1 live pilots show that `gpt-5.4-mini` responds to protocol-visible
structured inputs.

The final empirical claim requires Tier 2 live multi-agent transcript evidence:
separate API-backed agents, explicit messages, memory events, and oracle-hidden
evaluation over full transcripts.

## Current Target Claim

If Tier 2 results hold, the paper should claim:

> ACM-CP/1.0 Core improves protocol-layer reliability for multi-agent LLM
> systems by making evidence, capability proof, commitments, scoped memory,
> policy trace, and context manifests first-class transcript semantics.

Avoid claiming that ACM-CP is universally better for all multi-agent systems,
all tasks, or all model families until broader external validation exists.
