<!-- Evaluation Matrix -->
| RQ | Question | Exp. | Dataset | Models | Metrics |
|---|---|---|---|---|---|
| RQ1 | Mechanism effect (C4 vs C5) | E1 | phase4 main, 9 families | 5.4-mini/nano | selection acc., forbidden-mem |
| RQ2 | Drop-in protocol replacement | E2 | fixed 3-agent app | 5.4-mini/nano | selection-acc. delta |
| RQ3 | SE-native synthetic workflows | E3 | se_native_100 | 5.4-mini/nano | selection-acc. delta |
| RQ4 | Best evaluated baseline | E5/E6 | E1/E2/E3/E5/E7 | 5.4-mini/nano | selection acc. + full FFCR |
| RQ5 | Holdout + negative controls | E7/E9 | holdout_80, controls | 5.4-mini/nano | selection acc., control gap |
| RQ6 | Long-horizon stress + cost | E10/E12 | stress grid | 5.4-mini/nano | success vs length, Pareto |
| RQ7 | Mechanism-blind outcome | E13 | E1/E3 traces | 5.4-mini/nano | End-task correctness |
| RQ8 | Best-effort non-binding baselines | E14 | holdout_80 | 5.4-mini/nano | selection acc., self-verify gap |
| RQ9 | Independent taxonomy (MAST) | E15b | SE-native + constructed | 5.4-mini/nano | Mismatch recurrence |
| RQ10 | Long-running multi-agent | E16/E17/E18 | longrun, LangGraph, LoCoMo | 5.4-mini/nano | End-to-end success |
