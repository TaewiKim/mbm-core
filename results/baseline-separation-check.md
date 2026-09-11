# Baseline-separation check

Status: **PASS**

| scenario_type | C5 | C4+all-static-filters | C4+all-static-filters+source-exists | C4+abac | C4+rebac-provenance-graph | C4+capability-token |
| --- | --- | --- | --- | --- | --- | --- |
| twin_run_shared_memory_contamination | 20/20 | 20/20 | 20/20 | 20/20 | 20/20 | 0/20 |
| pause_resume_deferred_constraint | 20/20 | 20/20 | 20/20 | 20/20 | 20/20 | 0/20 |
| crash_retry_with_superseded_policy | 20/20 | 20/20 | 20/20 | 20/20 | 0/20 | 0/20 |
| branch_merge_with_conflicting_memories | 20/20 | 20/20 | 20/20 | 20/20 | 20/20 | 0/20 |
| artifact_dependent_handoff | 20/20 | 20/20 | 20/20 | 20/20 | 20/20 | 0/20 |
| private_memory_summary | 20/20 | 20/20 | 20/20 | 20/20 | 20/20 | 20/20 |
| long_horizon_drift | 20/20 | 20/20 | 20/20 | 20/20 | 0/20 | 0/20 |
| audit_reconstruction | 20/20 | 0/20 | 20/20 | 20/20 | 20/20 | 0/20 |
| graph_only_sibling_branch_provenance | 20/20 | 0/20 | 0/20 | 0/20 | 20/20 | 0/20 |
| **TOTAL** | 180/180 | 140/180 | 160/180 | 160/180 | 140/180 | 20/180 |
