# Experiment catalog

Every experiment is **paired** (same task/model/runner/evaluator for treatment and baseline) and
**live** unless noted. Treatment `C5` = MBM-Core (message-bound shared memory); baseline `C4` =
scoped memory without active-message binding. Subject models: `gpt-5.4-nano`, `gpt-5.4-mini`
(judge/evaluator is a separate model from the subject). Commands below run from the repository root.

All result files are committed, so the **no-API replay** (`npm run eval:artifact:check`) reproduces
every table/figure/gate without re-running any live experiment. The live commands are listed for
full from-scratch reproduction and require `OPENAI_API_KEY`.

## Headline reliability evidence (Figure 3 / Table S1, aggregate G1–G10)

| Exp | What it isolates | Live run | Analysis → result file |
|-----|------------------|----------|------------------------|
| E1 | Controlled C4-vs-C5 protocol swap (mechanism effect) | `coupled:phase6:live:main40-r3:*` (2 models) | `coupled:analyze:phase6:live:main40-r3:combined` → `results/coupled-memory-phase6-live-main40-r3-combined-2models-analysis.json` |
| E2 | Same-agent drop-in wrapper replacement | `dropin:bench:live:main40-r3:*` | `dropin:analyze:live:main40-r3` → `results/dropin-protocol-replacement-live-main40-r3-combined-analysis.json` |
| E3 | SE-native GitHub-derived workflows | `node scripts/run_e3*.mjs` after `npm run eval:se:build` | feeds `results/eval/e3-*` |
| E5 | Strong-baseline rescue (per-family best static filter / oracle) | `npm run eval:e5:nano` / `eval:e5:mini` → `eval:e5:combine` | `results/eval/e5-strong-baseline-combined.json` |
| E6 | Aggregate over E1/E2/E3/E5/E7 | — | `npm run eval:analyze:best-baseline` → `results/eval/best-baseline-analysis.json` |
| E7 | Blinded adversarial holdout (content-blind compound traps, frozen hash) | `npm run eval:holdout:build` → `eval:e7:nano` | `results/eval/e7-holdout-combined.json` |

## Robustness & mechanism validation (Figure 4)

| Exp | What it isolates | Live run | Analysis → result file |
|-----|------------------|----------|------------------------|
| E9 | Negative / no-op controls (binding-corruption vs single-check ablation) | `npm run eval:e9:nano` | `eval:e9:analyze` → `results/eval/negative-controls-analysis.json` |
| E10 | Long-horizon stress (distractor sweep 0→200) | `npm run eval:e10:nano` | `eval:e10:analyze` → `results/eval/stress-scaling-analysis.json` |
| E12 | Cost vs. reliability Pareto (prompt tokens est. from candidate-set size) | derived from E10 | `eval:e12:analyze` → `results/eval/cost-pareto-analysis.json` |

## Treatment-design rebuttal & ecological validity (§V-H)

These address the "the benchmark is treatment-designed" objection by testing on blind scoring,
best-effort baselines, an external dataset, and real multi-agent frameworks. The analyzers default
to combining `nano + mini`.

| Exp | What it isolates | Live run | Analysis → result file |
|-----|------------------|----------|------------------------|
| E13 | Blind end-task-correctness re-scoring (judge blind to run/task/provenance/ids/condition) | `node scripts/rescore_blind_outcome.mjs` | `results/eval/e13-etc-analysis.json` |
| E14 | Best-effort self-verifying baselines (content-only vs metadata-aware) | `node scripts/run_e14_best_effort.mjs --model gpt-5.4-nano` (and `--model gpt-5.4-mini`) | `results/eval/e14-best-effort-analysis.json` |
| E15 | Failure-mode prevalence on SE-native vs constructed (MAST mapping) | `node scripts/analyze_failure_prevalence.mjs` | `results/eval/failure-prevalence-analysis.json` |
| E16 | External LoCoMo transcript QA (out-of-domain boundary; NULL by design) | `node scripts/run_e16_locomo.mjs --model gpt-5.4-nano --out results/eval/e16-locomo.jsonl` (and `--model gpt-5.4-mini --out results/eval/e16-locomo-mini.jsonl`) | `node scripts/analyze_e16.mjs` → `results/eval/e16-locomo-analysis.json` |
| E17 | Live multi-agent **LangGraph** workflow — **WITHDRAWN** (the earlier success number was an oracle-fallback artifact; fail-closed code retained, but the result is not reported pending a properly task-bound fixture) | `node scripts/run_e17_langgraph_live.mjs ...` (runner retained for the future task-bound re-run) | not reported |
| E18 | Long-running multi-turn multi-agent workflow, end-to-end (**main Figure 5**) | `node scripts/run_e18_longrun.mjs --model gpt-5.4-nano --out results/eval/e18-longrun.jsonl` (and `--model gpt-5.4-mini --out ...-mini.jsonl`) | `node scripts/validate_longrun_episodes.mjs` then `node scripts/analyze_e18.mjs` → `results/eval/e18-longrun-analysis.json` |

## Notes

- **Determinism.** All bootstrap CIs use a seeded `mulberry32` (10,000 resamples; per-row seeds in
  `scripts/analyze_sota_best_baseline.mjs`). Holdout/SE-native datasets are seeded, hash-frozen
  templates verified by the runner.
- **Judge ≠ subject.** Every LLM-graded experiment uses a judge model distinct from the subject,
  blind to binding metadata where the design requires it.
- **Two-model coverage.** E13/E14/E16/E17/E18 each run on both `gpt-5.4-nano` and `gpt-5.4-mini`;
  the analyzers pair within model and report a combined effect plus a per-model breakdown.
- **E16 is intentionally NULL.** LoCoMo is passive single-agent transcript QA, which lacks the
  gate's precondition (a stamped shared-memory read inside an active-message context). It is
  reported as a boundary of the contribution, not a failure.
