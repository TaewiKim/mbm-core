<!-- Failure Modes in Long-Running Agent Workflows -->
| Failure mode | Definition | Gate predicate |
|---|---|---|
| Wrong-run memory use | Read memory written under a different run | same-run |
| Wrong-task / scope leak | Read memory outside the active task scope | task/scope |
| Stale / superseded memory | Read memory invalidated by a later policy or event | active-status |
| Unauthorized access | Reader not permitted by the memory's allowed-reader set | receiver auth |
| Missing critical memory | Fail to retrieve a fact required for the decision | bounded admitted set |
| Unreconstructable decision | Final decision not justifiable from the event graph | provenance + audit |
