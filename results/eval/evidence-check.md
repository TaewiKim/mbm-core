#  Evidence Check

Generated: 2026-09-11T00:51:08.469Z
Overall: **PASS** — pass 4, warn 0, fail 0, pending 2

| Check | Status | Detail |
|---|---|---|
| figure_hashes | pass | 25 figures hash-verified |
| paper_figure_coverage | pending | paper not found |
| forbidden_claims | pending | no .tex files yet |
| anonymization | pass | no local-path/institution markers across 192 paper/results/data files |
| evidence_gates | pass | 10/10 gates evaluable now |
| result_metadata_convention | pass | result-metadata convention defines all required fields |

## Scoped-claim evidence gates
| Gate | Status |
|---|---|
| G1 aggregate memory-selection accuracy exceeds best deployable baseline | pass |
| G2 cluster (family) bootstrap CI lower bound > 0 | pass |
| G3 win/tie >= 80% of families | pass |
| G4 full FFCR (auditability) exceeds best conventional baseline | pass |
| G5 graph-only causal separation holds (deterministic) | pass |
| G6 blinded holdout: MBM-Core reaches selection ceiling | pass |
| G7 negative controls fail to reproduce | pass |
| G8 SE-native direction agrees | pass |
| G9 selection gain robust to dropping any single family (LOFO>0 + cluster CI>0) | pass |
| G10 figure/table/result hashes pass | see figure_hashes check |
