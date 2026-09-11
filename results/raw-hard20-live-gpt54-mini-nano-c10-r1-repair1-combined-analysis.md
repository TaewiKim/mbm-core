# Hypothesis Analysis

Input: `results/raw-hard20-live-gpt54-mini-nano-c10-r1-repair1-combined.json`

## Health

- cases: 1200
- parse errors: 0
- invalid decisions: 0
- API errors: 0

## Contrasts

| Hypothesis | Scenario | Metric | Treatment | Control | Paired n | Delta | 95% paired bootstrap CI | Sign-test p | Direction |
| --- | --- | --- | --- | --- | ---: | ---: | --- | ---: | --- |
| H1 Evidence Capsules | evidence_conflict | success | evidence-capsule=0.8 | typed-envelope=0 | 20 | 0.8 | [0.6, 0.95] | 0.000030518 | higher |
| H1 Provenance | evidence_conflict | claim_provenance_coverage | evidence-capsule=1 | typed-envelope=0.95 | 20 | 0.05 | [0, 0.125] | 0.5 | higher |
| H2 Proof Capability | capability_deception | success | proof-capability=0.5 | typed-envelope=0 | 20 | 0.5 | [0.3, 0.7] | 0.0019531 | higher |
| H3 Commitment Receipt | delegation_drift | success | commitment-receipt=0.7 | proof-capability=0 | 20 | 0.7 | [0.5, 0.9] | 0.00012207 | higher |
| H4 Scoped Memory | scoped_memory_privacy | secret_leak_events | scoped-memory=0 | commitment-receipt=1 | 20 | 1 | [1, 1] | 0.0000019073 | lower |
| H4 Full Policy Trace | scoped_memory_privacy | secret_leak_events | acmcp-full=0 | scoped-memory=0 | 20 | 0 | [0, 0] | 1 | lower |
| H5 Context Manifest | context_manifest_stress | wire_bytes | acmcp-full=2728.35 | evidence-capsule=50754.5 | 20 | 48026.15 | [47986.45, 48065.7] | 0.0000019073 | lower |
| Ablation Evidence | evidence_conflict | success | acmcp-full=0.8 | acmcp-no-evidence=0 | 20 | 0.8 | [0.6, 0.95] | 0.000030518 | higher |
| Ablation Proof | capability_deception | success | acmcp-full=0.65 | acmcp-no-proof=0 | 20 | 0.65 | [0.45, 0.85] | 0.00024414 | higher |
| Ablation Commitment | delegation_drift | success | acmcp-full=0.45 | acmcp-no-commitment=0 | 20 | 0.45 | [0.25, 0.65] | 0.0039063 | higher |
| Ablation Scope | scoped_memory_privacy | secret_leak_events | acmcp-full=0 | acmcp-no-scope=1 | 20 | 1 | [1, 1] | 0.0000019073 | lower |
| Ablation Policy Trace | scoped_memory_privacy | secret_leak_events | acmcp-full=0 | acmcp-no-policy-trace=1 | 20 | 1 | [1, 1] | 0.0000019073 | lower |
| Ablation Context Manifest | context_manifest_stress | wire_bytes | acmcp-full=2728.35 | acmcp-no-context-manifest=50836.25 | 20 | 48107.9 | [48075.2, 48137.45] | 0.0000019073 | lower |

## Interpretation Notes

- Bootstrap intervals are paired by case_id and run_index.
- Sign-test p-values are nonparametric diagnostics over paired deltas, not a substitute for preregistered confirmatory testing.
- A positive delta means the treatment improved the metric in the requested direction.
- For leak and wire-byte metrics, lower is better and delta is computed as control minus treatment.

