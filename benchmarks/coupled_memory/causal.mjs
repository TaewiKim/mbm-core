// Shared causal-ancestry computation (review M4/M7). One implementation is used by BOTH the SQLite
// runtime (benchmarks/coupled_memory/runtime.mjs) and the standalone/external gate so the central
// mechanism and the framework wrappers compute provenance identically -- not a Set-membership proxy.
//
// happens-before is DIRECTED *and TEMPORALLY VALIDATED*: we follow parent_message_id (reply/
// continuation) and delegated_from (delegation grant), but an edge to a candidate ancestor is
// admitted ONLY IF that ancestor strictly precedes the child in logical order (sequence; created_at
// as a fallback clock). A shared correlation_id is NOT a causal edge -- it labels an undirected
// workflow group, so expanding it would pull in siblings and future branches (the graph-only
// sibling-branch trap). We FAIL CLOSED: a self-loop, a referenced parent absent from the graph, or
// an unorderable / non-preceding edge is not traversed, so a "future" message wired as a parent can
// never enter the closure. The returned set is the active message's validated ancestors (inclusive
// of itself); a memory is valid iff its source_message_id lies in this set.

// Logical clock for ordering: prefer the monotonic per-run `sequence`, fall back to `created_at`.
// Returns null when neither is available (the edge is then unorderable and refused).
function clockOf(node) {
  if (node == null) return null;
  if (node.sequence != null && Number.isFinite(Number(node.sequence))) return Number(node.sequence);
  if (node.created_at) {
    const t = Date.parse(node.created_at);
    if (!Number.isNaN(t)) return t;
  }
  return null;
}

// Single authoritative causal-edge validator (review: one verified traversal shared by send, live read,
// audit replay, and the external adapter). A directed edge parent->child is valid ONLY IF the parent is a
// distinct, same-run message that STRICTLY precedes the child in logical order. Unlike the lenient helper
// below (which skips bad edges when ranking ancestors offline), this THROWS, so the secure paths fail
// closed: a self-loop, cross-run edge, or future/unorderable parent aborts the whole authorization.
// Parent message ids of a node (Gate 2.0): the typed multi-parent `parents[]` -- a true merge has several,
// each {id, type: depends|adopt|delegate|resolve} -- when present, else the legacy single parent + delegation
// slots. Edge TYPE governs AUTHORITY (adopt vs depends) at the set-level gate, not reachability, so every
// typed parent contributes to the causal closure here.
export function parentIdsOf(node) {
  if (node && Array.isArray(node.parents) && node.parents.length) {
    return node.parents.map((p) => (typeof p === "string" ? p : (p && p.id))).filter(Boolean);
  }
  return [node?.parent_message_id ?? null, node?.delegated_from ?? null].filter((x) => x != null);
}

export function verifyCausalEdge(parent, child) {
  if (!parent || !child) throw new Error("causal_edge_missing");
  if (parent.message_id === child.message_id) throw new Error("causal_self_loop");
  if ((parent.run_id ?? null) !== (child.run_id ?? null)) throw new Error("causal_run_mismatch");
  const ps = clockOf(parent), cs = clockOf(child);
  if (ps == null || cs == null || !(ps < cs)) throw new Error("causal_order_invalid");
}

// THE single fail-closed causal-closure verifier (review S21). One strict traversal shared by the secure
// live read, the audit replay, and the external/Cedar adapter, so there is no second, more-lenient
// security path. Starting from `activeId` it follows ONLY signed parent/delegation edges; every referenced
// node must exist, verify its signature, and form a temporally valid edge (verifyCausalEdge), else the
// WHOLE closure throws (a claimed-but-unattestable lineage aborts authorization rather than dropping the
// bad node). `lookupMessage(id)` returns the identity-bound signed envelope or null; `verifyEnvelope(env)`
// returns whether its signature verifies. Returns the validated ancestor set (inclusive of the active id).
export function verifiedCausalClosure({ activeId, lookupMessage, verifyEnvelope }) {
  const closure = new Set();
  const visiting = new Set();
  const visit = (messageId) => {
    if (closure.has(messageId)) return;
    if (visiting.has(messageId)) throw new Error(`causal_cycle:${messageId}`);
    visiting.add(messageId);
    const child = lookupMessage(messageId);
    if (!child) throw new Error(`causal_message_missing:${messageId}`);
    if (!verifyEnvelope(child)) throw new Error(`causal_message_unattested:${messageId}`);
    for (const parentId of parentIdsOf(child)) {
      if (parentId == null) continue;
      const parent = lookupMessage(parentId);
      if (!parent) throw new Error(`causal_parent_missing:${parentId}`);
      if (!verifyEnvelope(parent)) throw new Error(`causal_parent_unattested:${parentId}`);
      verifyCausalEdge(parent, child); // same-run, strictly-precedes, no self-loop (throws)
      visit(parentId);
    }
    visiting.delete(messageId);
    closure.add(messageId);
  };
  visit(activeId);
  return closure;
}

export function causalAncestryFromMessages(messages, activeMessage) {
  const byId = new Map();
  for (const m of messages || []) byId.set(m.message_id, m);
  if (!byId.has(activeMessage.message_id)) byId.set(activeMessage.message_id, activeMessage);

  const closure = new Set();
  const stack = [activeMessage.message_id];
  while (stack.length) {
    const id = stack.pop();
    if (id == null || closure.has(id)) continue;
    closure.add(id);
    const node = byId.get(id);
    if (!node) continue; // referenced id with no record: include it, but cannot traverse further
    const childClock = clockOf(node);
    for (const parentId of parentIdsOf(node)) {
      if (parentId == null || parentId === id) continue; // ignore missing edges and self-loops
      const parent = byId.get(parentId);
      if (parent == null) continue; // parent not in the graph: cannot validate the edge -> refuse
      if ((parent.run_id ?? null) !== (node.run_id ?? null)) continue; // cross-run edge: not a valid ancestor (M7)
      const parentClock = clockOf(parent);
      // happens-before: the parent must STRICTLY precede the child. If either side is unorderable,
      // we refuse the edge rather than risk admitting a future or cyclic ancestor (fail closed).
      if (childClock == null || parentClock == null) continue;
      if (!(parentClock < childClock)) continue;
      stack.push(parentId);
    }
  }
  return closure;
}
