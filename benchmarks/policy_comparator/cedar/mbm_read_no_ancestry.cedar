// Ablation of mbm_read_full.cedar: the SAME policy with the ReBAC causal-ancestry (provenance)
// clause removed. Every ABAC attribute predicate is retained. We evaluate this with the production
// Cedar engine to show that a purely attribute-based contextual policy -- however complete its
// attribute set -- admits the graph-only sibling-branch trap that the ancestry predicate excludes.
// This isolates the causal relationship predicate as the load-bearing one, matching the separation
// matrix and the JS comparator's `ancestry_load_bearing` finding.
permit(principal, action == Action::"ReadMemory", resource)
when { resource.run_id == context.run_id }                                              // run
when { resource.task_id == context.task_id || resource.scope == "run" || resource.scope == "global" } // task
when { resource.status == "active" }                                                    // status
when { resource.allowed_readers.contains("*") || resource.allowed_readers.contains(context.receiver) } // reader
when { resource.policy_context == "" || resource.policy_context == context.policy_context } // policy
when { !context.intent_constrained || context.allowed_memory_types.contains(resource.memory_type) }; // intent
