# Hypothesis Analysis

Input: `results/hotpotqa-validation-live-gpt54-mini-nano-c20-r1-repair1-combined.json`

## Health

- cases: 480
- parse errors: 0
- invalid decisions: 0
- API errors: 0

## Contrasts

| Hypothesis | Scenario | Metric | Treatment | Control | Paired n | Delta | 95% paired bootstrap CI | Sign-test p | Direction |
| --- | --- | --- | --- | --- | ---: | ---: | --- | ---: | --- |
| H1 Evidence Capsules | evidence_conflict | success | evidence-capsule=0.85 | typed-envelope=0 | 40 | 0.85 | [0.725, 0.95] | 1.1642e-10 | higher |
| H1 Provenance | evidence_conflict | claim_provenance_coverage | evidence-capsule=1 | typed-envelope=0.95 | 40 | 0.05 | [0, 0.1125] | 0.25 | higher |
| H5 Context Manifest | context_manifest_stress | wire_bytes | acmcp-full=2771.5 | evidence-capsule=50764.2 | 40 | 47992.7 | [47965.3, 48024.025] | 1.819e-12 | lower |
| Ablation Evidence | evidence_conflict | success | acmcp-full=0.825 | acmcp-no-evidence=0 | 40 | 0.825 | [0.7, 0.925] | 2.3283e-10 | higher |
| Ablation Context Manifest | context_manifest_stress | wire_bytes | acmcp-full=2771.5 | acmcp-no-context-manifest=50882.525 | 40 | 48111.025 | [48079.775, 48143.825] | 1.819e-12 | lower |

## Interpretation Notes

- Bootstrap intervals are paired by case_id and run_index.
- Sign-test p-values are nonparametric diagnostics over paired deltas, not a substitute for preregistered confirmatory testing.
- A positive delta means the treatment improved the metric in the requested direction.
- For leak and wire-byte metrics, lower is better and delta is computed as control minus treatment.
- Skipped unavailable contrasts: H2 Proof Capability/capability_deception, H3 Commitment Receipt/delegation_drift, H4 Scoped Memory/scoped_memory_privacy, H4 Full Policy Trace/scoped_memory_privacy, Ablation Proof/capability_deception, Ablation Commitment/delegation_drift, Ablation Scope/scoped_memory_privacy, Ablation Policy Trace/scoped_memory_privacy

