// Independent conventional contextual-authorization engine (review M1).
//
// This is a GENERIC, declarative ABAC + ReBAC policy evaluator written from scratch -- it does NOT
// import or reuse benchmarks/coupled_memory/runtime.mjs::evaluateMemoryGate. Its purpose is to test
// the reviewer's central objection: that MBM-Core is not a new authorization primitive but an
// instance of conventional contextual authorization (NIST ABAC + relationship/ancestry predicates +
// request-scoped context), expressible as one ordinary policy. A policy here is just a list of
// boolean predicates over (memory, requestContext, relationships); admit iff every enabled predicate
// holds. The same shape a Cedar / OPA-Rego / OpenFGA-with-contextual-tuples policy would encode.
//
// requestContext: { run_id, task_id, trace_id, receiver, intent, policy_context, message_id }
// relationships:  { ancestors: Set<message_id> }  // directed causal ancestor closure of the message
// intentTypes:    { [intent]: Set<memory_type> }   // optional attribute constraint

export const ABAC_REBAC_PREDICATES = {
  // --- ABAC: attribute equality / membership against the request context ---
  run: (m, ctx) => m.run_id === ctx.run_id,
  task: (m, ctx) => m.task_id === ctx.task_id || ["run", "global"].includes(m.scope),
  status: (m) => m.status === "active",
  reader: (m, ctx) => {
    const readers = new Set(m.allowed_readers ?? []);
    return readers.has("*") || readers.has(ctx.receiver);
  },
  policy: (m, ctx) => !m.policy_context || m.policy_context === ctx.policy_context,
  intent: (m, ctx, _rel, intentTypes) => {
    const allowed = intentTypes && intentTypes[ctx.intent];
    return !allowed || allowed.has(m.memory_type);
  },
  // --- ReBAC: relationship reachability (source message in the request's ancestor closure) ---
  provenance: (m, _ctx, rel) =>
    m.source_message_id != null && rel.ancestors instanceof Set && rel.ancestors.has(m.source_message_id),
};

// Evaluate one declarative policy (set of predicate keys) over a candidate.
export function evaluatePolicy(memory, ctx, relationships, { enabled, intentTypes } = {}) {
  const keys = enabled ?? Object.keys(ABAC_REBAC_PREDICATES);
  for (const key of keys) {
    const pred = ABAC_REBAC_PREDICATES[key];
    if (!pred) throw new Error(`unknown predicate: ${key}`);
    if (!pred(memory, ctx, relationships, intentTypes)) {
      return { decision: "deny", reason: `policy:${key}` };
    }
  }
  return { decision: "allow", reason: "policy:all" };
}

// Filter a candidate set by a conventional policy. With the full predicate set (all ABAC attributes
// + the ReBAC ancestry predicate + request context) this expresses exactly what MBM-Core's gate
// enforces -- the comparison script confirms the admitted sets are identical.
export function admitByPolicy(candidates, ctx, relationships, opts = {}) {
  const admitted = [];
  const audit = [];
  for (const m of candidates) {
    const r = evaluatePolicy(m, ctx, relationships, opts);
    audit.push({ memory_id: m.memory_id, ...r });
    if (r.decision === "allow") admitted.push(m);
  }
  return { admitted, audit };
}
