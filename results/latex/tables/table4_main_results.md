<!-- Main Quantitative Results -->
| Evaluation | Best baseline | n | Baseline | MBM-Core | Δ [95% CI] |
|---|---|---|---|---|---|
| controlled protocol-swap (E1) | C4 (ungated control) | 270 | 87.8% | 100.0% (0 fail) | 0.122 [0.09, 0.16] ✓ |
| drop-in replacement (E2) | legacy shared-memory wrapper | 270 | 86.7% | 100.0% (0 fail) | 0.133 [0.09, 0.17] ✓ |
| SE-native workflow (E3) | C4 (ungated control) | 200 | 87.0% | 100.0% (0 fail) | 0.130 [0.09, 0.18] ✓ |
| strong-baseline rescue (E5) | best conventional-authorization baseline (static / FK / ABAC / ReBAC / capability / oracle) | 90 | 100.0% | 100.0% (0 fail) | 0.000 [0.00, 0.00] |
| aggregate (E6) | per-family best non-C5 baseline (ungated C4 on treatment-aligned families E1/E2/E3; best strong/oracle baseline on E5/E7) | 990 | 90.4% | 100.0% (0 fail) | 0.096 [0.08, 0.12] ✓ |
| mechanism-blind ETC (E13) | C4 (ETC metric) | 440 | 57.7% | 89.3% | 0.316 [0.26, 0.37] ✓ |
| best-effort meta-aware (E14) | metadata-aware self-check | 160 | 80.6% | 100.0% (0 fail) | 0.194 [0.13, 0.26] ✓ |
