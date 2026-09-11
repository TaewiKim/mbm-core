# Expected Results

A clean no-API replay (`npm run eval:artifact:check`) reproduces the following from the committed
live result files. The headline metric is **memory-selection accuracy** (does the model act on the
valid memory set); the **full FFCR** additionally requires an independently reconstructable decision.
Values are recomputed by paired bootstrap (10,000 resamples; seeds fixed per row in
`scripts/analyze_sota_best_baseline.mjs`). The best non-C5 baseline is chosen per family by selection
accuracy, ties broken by the measured full FFCR.

> **Re-run under the parity-fixed runner (review M3).** The strong-baseline live runner's
> prompt-parity confound and the nominal oracle retriever were fixed in code and **E3/E5/E7 were
> re-run** (both models). Fixing the confound shrank the headline aggregate (giving every condition
> the same active-message context strengthened the baselines): selection Δ **0.149 → 0.096**, with E3
> dropping 0.395 → 0.130. E3/E5/E7 were additionally re-run under the **condition-neutral** payload
> (no treatment/baseline label in the model input, review M2); the effect was robust to removing the
> label. The live-LangGraph (E17) accuracy number is **withdrawn** (oracle-fallback artifact)
> and is not reported.

## Best-baseline aggregate (selection accuracy; Table 4 / Fig. 8)

Live models: `gpt-5.4-nano` + `gpt-5.4-mini` (both for E1/E2/E3/E5/E7; E9 nano+mini).

| Evaluation | n | Baseline MSA | MBM-Core MSA | Delta selection [95% CI] |
|---|---|---|---|---|
| Controlled protocol-swap (E1) | 270 | 87.8% | 100.0% | 0.122 [0.085, 0.163] ✓ |
| Drop-in replacement (E2) | 270 | 86.7% | 100.0% | 0.133 [0.093, 0.174] ✓ |
| SE-native workflow (E3) | 200 | 87.0% | 100.0% | 0.130 [0.085, 0.180] ✓ |
| Strong-baseline rescue (E5) | 90 | 100.0% | 100.0% | 0.000 [0.00, 0.00] |
| Blinded adversarial holdout (E7) | 160 | 100.0% | 100.0% | 0.000 [0.00, 0.00] |
| Aggregate (E6) | 990 | 90.4% | 100.0% | 0.096 [0.078, 0.115] ✓ |

`✓` = 95% CI lower bound > 0. The selection gain is carried by the weaker-control rows (E1/E2/E3);
on the strong-baseline and blinded-holdout rows the best conventional baseline (incl. source-existence
on the holdout) ties C5 (Δ = 0). The cluster (family) bootstrap widens the aggregate interval to
[0.018, 0.223] (still > 0); leave-one-family-out stays in [0.040, 0.103]. The gain is **concentrated**
— one family (branch-merge-with-conflicting-memories) is ≈61% of it — so we rest the contribution on
coverage and auditability, not on this selection delta.

## Full FFCR (selection + reconstructable audit; architectural)

Full FFCR is measured **only on the runners that record reconstructability** (E1/E2, 540 paired
units): baseline 0.0% → MBM-Core 100.0%. E3/E5/E7 use a runner that does **not** log decisions, so
they are **excluded** from this aggregate rather than coded as failures — counting "not recorded" as
"not reconstructable" was a reporting bug (review M4) and is fixed. This is an **architectural**
property, not a sampled superiority: an ungated read keeps no decision log (so it is not
reconstructable). We make no full-FFCR claim on the strong-baseline/holdout runners; the auditability
of a *gated* conventional baseline is argued architecturally, not measured there. Audit
reconstructability is verified by an independent replay that re-runs the gate from persisted state
(`scripts/audit_replay.mjs --self-test`).

## E9 negative / no-op controls

`gpt-5.4-nano`, 40 cases/control: real MBM-Core 100%, vs binding-corruption controls C5-label-only
37.5%, C5-shuffled-binding 37.5%, C5-wrong-message 50%, C5-random-gate 60% (refuting the
label/structure explanation). The single-check ablations C5-no-policy / C5-no-provenance stay near
100% because the affected families' content reveals validity; reported as a nuance, not a headline.

## E10 long-horizon stress / E12 cost-Pareto (Fig. 4 B/C)

`gpt-5.4-nano`, distractor sweep {0,10,50,200}. MBM-Core holds FFCR = 1.00 at every distractor level;
C4+all-static-filters falls from 0.875 to 0.00 once near-duplicate distractors appear; C4 stays ~0.

## Native-framework integration (E11)

LangGraph native adapter (API-free, verified here): C5 27/27, C4 fails 27/27 over the 9-family dev
split. AutoGen (agentchat) reproduces the identical separation when its SDK is installed; skipped
gracefully otherwise. On machines without the Python `autogen-agentchat` package, `npm test` reports
one expected optional skip rather than a failure.

## Gates and artifact integrity

- `npm run secure:verify` runs the full enforced-boundary battery: the secure-runtime unit tests, the
  77 review gates (incl. the security-kernel gates RG73 monotonic decision version, RG74 opaque view handle,
  RG75 kernel-mediated dispatch + exact-action binding, RG76 full context re-validation, RG77 empty-view
  bottom), the secure-profile coverage suite (`npm run secure:coverage`: 180/180, 0 invalid
  admissions across all 9 families, all reconstructable), the Gate 2.0 concurrent-schedule ablation (RQ4/RQ5),
  the hard C4-vs-kernel separation (`npm run hard:separation`: C4 exploited 7/7, the kernel blocks 7/7),
  the three exploit PoCs, and the audit-replay self-test. Gates RG17–RG19 deny every reviewer counterexample (public-key forge, unauthenticated
  write, arbitrary cross-queue claim, stolen envelope, no-gate bypass, superseded-record resurrection,
  receipt tampering); the attestation key is ephemeral and never written to the store. The
  **ExecutionContext** invariant suite (RG39, RG45–RG46, RG49–RG55) replaces the earlier
  principal×run consumed-input floor: a context is opened on claim and bounds every output; the gates
  check integrity monotonicity, output bound + send/write symmetry, context isolation, completion,
  same-key restart durability (different-key invalidation), no cross-run laundering, a fail-closed input
  snapshot, and the replay orphan-decision bijection.
- `npm run review:gates` exercises behavioral counterexamples (future-ancestor rejection, audit-replay
  tamper/deletion, external/central parity, prompt parity, deployed-Cedar equivalence).
- `npm run eval:check` reports the scoped-claim evidence gates plus figure-hash integrity.
- The figure manifest (`results/eval/figure_manifest.json`) SHA-256-verifies **22 committed figures**
  (`npm run eval:check`), and every figure included in the paper appears in the manifest; the paper's
  inline numbers derive from generated macros.
- The forbidden-claim and anonymization audits pass on all paper sources.
