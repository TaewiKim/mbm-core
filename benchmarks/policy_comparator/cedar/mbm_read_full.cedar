// MBM-Core memory-read authorization, expressed for a DEPLOYED policy engine (Cedar).
//
// This is the SAME contextual-authorization decision MBM-Core's gate enforces, written as an
// ordinary Cedar policy and evaluated by the production Cedar engine (the engine behind AWS
// Verified Permissions). It imports no MBM-Core code. Each `when` clause is one predicate; clauses
// are conjoined, so a memory is admitted iff every predicate holds -- the standard "complete
// mediation" shape. The point of the cross-check: if this stock engine reproduces the gate's
// admitted set on every scenario, MBM-Core is a systematic *application* of contextual
// authorization, not a new authorization primitive.
//
// Predicate map (1:1 with benchmarks/policy_comparator/conventional_policy_engine.mjs):
//   run        ABAC  resource.run_id == context.run_id
//   task       ABAC  same task, or run/global-scoped
//   status     ABAC  record is active
//   reader     ABAC  receiver is an allowed reader (or wildcard)
//   policy     ABAC  no policy context, or it matches the active one
//   intent     ABAC  intent imposes no type constraint, or the type is permitted
//   provenance ReBAC source message lies in the active message's causal-ancestor closure
permit(principal, action == Action::"ReadMemory", resource)
when { resource.run_id == context.run_id }                                              // run
when { resource.task_id == context.task_id || resource.scope == "run" || resource.scope == "global" } // task
when { resource.status == "active" }                                                    // status
when { resource.allowed_readers.contains("*") || resource.allowed_readers.contains(context.receiver) } // reader
when { resource.policy_context == "" || resource.policy_context == context.policy_context } // policy
when { !context.intent_constrained || context.allowed_memory_types.contains(resource.memory_type) } // intent
when { resource.source_message_id != "" && context.ancestors.contains(resource.source_message_id) }; // provenance (ReBAC)
