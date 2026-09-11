# Headline Evidence Table

Claim: ACM-CP is a Pareto reliability winner for multi-agent communication-memory control.

Boundary: This is not a pure wire-byte SOTA or universal accuracy-only SOTA claim.

## Headline Rows

| track | setting | treatment | control | primary_effect | safety_effect | status |
| --- | --- | --- | --- | --- | --- | --- |
| Deterministic coupled-memory main | 160 scenarios | C5 160/160 | C4 failures 160/160 | C5-only success under fixed scenarios | wrong/stale/forbidden memory blocked | PASS |
| Deterministic drop-in protocol replacement main | 160 scenarios | ACM-CP 160/160 | legacy failures 160/160 | same app/backend/tools; only wrapper changes | wrong/stale/forbidden memory blocked | PASS |
| Live coupled-memory main40 r3 | gpt-5-mini, gpt-5-nano; paired n=240 | C5 233/240 | C4 64/240 | success delta 0.7042 CI [0.6458, 0.7625] | forbidden-memory 175->0 | PASS |
| Live drop-in protocol replacement main40 r3 | gpt-5.4-mini, gpt-5.4-nano; paired n=240 | ACM-CP 240/240 | legacy 101/240 | success delta 0.5792 CI [0.5125, 0.6417] | forbidden-memory 139->0 | PASS |
| HotpotQA raw-derived live c20 | gpt-5.4-mini, gpt-5.4-nano; calls=480 | ACM-CP evidence 82.5% | no-evidence 0.0% | evidence delta 0.8250 CI [0.7000, 0.9250] | context saves 48111.0 bytes CI [48079.8, 48143.8] | PASS |
| Broad raw-derived live hard20 c10 | gpt-5.4-mini, gpt-5.4-nano; calls=1200; 5 scenarios | ACM-CP evidence 80.0%, proof 65.0% | ablations evidence 0.0%, proof 0.0% | evidence delta 0.8000; proof delta 0.6500 | context saves 48107.9 bytes; leaks blocked in scope/policy ablations | PASS |

## Mechanism And Ablation Rows

| mechanism | scenario | metric | treatment | control | delta | ci95 | paired_n |
| --- | --- | --- | --- | --- | --- | --- | --- |
| H1 Evidence Capsules | evidence_conflict | success | evidence-capsule=0.800 | typed-envelope=0.000 | 0.800 | [0.600, 0.950] | 20 |
| H2 Proof Capability | capability_deception | success | proof-capability=0.500 | typed-envelope=0.000 | 0.500 | [0.300, 0.700] | 20 |
| H3 Commitment Receipt | delegation_drift | success | commitment-receipt=0.700 | proof-capability=0.000 | 0.700 | [0.500, 0.900] | 20 |
| H4 Scoped Memory | scoped_memory_privacy | secret_leak_events | scoped-memory=0.000 | commitment-receipt=1.000 | 1.000 | [1.000, 1.000] | 20 |
| H5 Context Manifest | context_manifest_stress | wire_bytes | acmcp-full=2728.3 | evidence-capsule=50754.5 | 48026.2 | [47986.4, 48065.7] | 20 |
| Ablation Evidence | evidence_conflict | success | acmcp-full=0.800 | acmcp-no-evidence=0.000 | 0.800 | [0.600, 0.950] | 20 |
| Ablation Proof | capability_deception | success | acmcp-full=0.650 | acmcp-no-proof=0.000 | 0.650 | [0.450, 0.850] | 20 |
| Ablation Commitment | delegation_drift | success | acmcp-full=0.450 | acmcp-no-commitment=0.000 | 0.450 | [0.250, 0.650] | 20 |
| Ablation Scope | scoped_memory_privacy | secret_leak_events | acmcp-full=0.000 | acmcp-no-scope=1.000 | 1.000 | [1.000, 1.000] | 20 |
| Ablation Policy Trace | scoped_memory_privacy | secret_leak_events | acmcp-full=0.000 | acmcp-no-policy-trace=1.000 | 1.000 | [1.000, 1.000] | 20 |
| Ablation Context Manifest | context_manifest_stress | wire_bytes | acmcp-full=2728.3 | acmcp-no-context-manifest=50836.3 | 48107.9 | [48075.2, 48137.4] | 20 |

## Health

- coupled_live_api_errors: 0
- dropin_live_api_errors: 0
- raw_live_api_errors: 0
- raw_live_parse_errors: 0
- hotpot_live_api_errors: 0
- hotpot_live_parse_errors: 0

