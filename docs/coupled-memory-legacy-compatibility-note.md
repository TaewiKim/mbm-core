# Coupled-Memory Compatibility Note

This note separates the legacy ACM-CP evidence from the final C0-C5
fixed-harness protocol-swap design.

## Legacy Evidence

Previous experiments in this repository evaluated ACM-CP-style protocol
features against protocol-inspired controls:

- typed envelopes
- A2A task artifacts
- AutoGen-style conversation
- MPAC-style coordination
- Mesh-memory-style memory routing
- Q-KVComm-style compressed communication
- ACM-CP core

Those experiments remain useful as background evidence for communication-memory
reliability and for motivating the protocol design. They should be cited as
preliminary simulator evidence, not as the final paper's main causal claim.

## Final Paper Evidence

The final paper uses a stricter design:

```text
fixed harness + fixed task + fixed model + fixed evaluator + swapped C0-C5 protocol layer
```

The primary causal contrast is:

```text
C4: strong but uncoupled shared memory
C5: governed message-bound shared memory
```

This means the main result should be read as a within-harness paired comparison,
not as a universal leaderboard over agent frameworks.

## Claim Boundary

Allowed for legacy evidence:

> ACM-CP-style protocol semantics improved communication-memory reliability over
> matched protocol-inspired controls in the repository simulator.

Allowed for final evidence after C0-C5 experiments:

> Within fixed long-running harnesses, C5 message-bound shared memory improves
> protocol-level reliability over C4 strong-but-uncoupled shared memory.

Not allowed:

> ACM-CP or C5 universally beats all agent frameworks, all memory systems, or
> all communication protocols under their native benchmarks.
