// A plausible "starter" policy a practitioner might write first: scope memory to the active run and
// require it to be active. This is the obvious default ("same run, not stale") and omits reader,
// policy-context, intent-type, and causal-ancestry checks. We evaluate it with the production Cedar
// engine to quantify how many records this default FALSE-ADMITS across the failure families --
// evidence that the necessary predicate set is non-obvious, not that Cedar is deficient.
permit(principal, action == Action::"ReadMemory", resource)
when { resource.run_id == context.run_id }      // run
when { resource.status == "active" };           // status
