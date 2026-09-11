// Reproduce the red-team's membership-omission(b) bypass: an ordinary agent WIDENS its effect capability from
// deny-all to unrestricted by writing ONE extra same-key record, which puts the RESTRICTIVE effect_ceiling
// record into an UNRESOLVED conflict so the coherent view evicts it -- and the capability meet (computed over
// the post-coherent-view set) loses the restriction. The restrictive row stays present/receipt-valid, so the
// P0-1 ledger scan passes. FIX: a contested restriction still caps; before fix this DISPATCHES.
import { createSecureMemorySystem, ControlPlane } from "../benchmarks/coupled_memory/runtime.mjs";
const env = (o) => ({ run_id: "R", task_id: "T", trace_id: "tr", intent: "produce_final_plan", state: "running",
  policy_context: "P", correlation_id: null, delegated_from: null, parent_message_id: null, ...o });
const cp = new ControlPlane();
const sys = createSecureMemorySystem({ controlPlane: cp, destinationPolicy: () => true });
const rt = sys.admin, facade = sys.runtime;
rt.sendMessage(env({ message_id: "m0", sender: "p", receiver: "memory", sequence: 1 }), cp.registerPrincipal("p", {}));
rt.sendMessage(env({ message_id: "mx", sender: "c", receiver: "executor", sequence: 2, parent_message_id: "m0" }), cp.registerPrincipal("c", {}));
const w = cp.registerPrincipal("w", { queues: ["*"] });
const ex = cp.registerPrincipal("ex", { queues: ["executor"] });
// R1: restrictive deny-all ceiling on key K.  R2: a plain keep-alive record (no ceiling) so the view is non-empty.
rt.writeMemory("deny-all", rt.claimSpecific(w, "m0"), { memory_id: "R1", logical_key: "K", memory_type: "constraint", allowed_readers: ["executor"], effect_ceiling: [] });
rt.writeMemory("keep-alive", rt.claimSpecific(w, "m0"), { memory_id: "R2", memory_type: "constraint", allowed_readers: ["executor"] });
const ctx = cp.contextTokenForLease(rt.claimSpecific(ex, "mx"));
// HONEST: meet([], <none>) = [] -> external send denied.
const honest = facade.executeAuthorizedAction(ex, ctx, facade.queryMemory(ex, ctx, {}, "send").viewId, { effect: "send", tool: "notify", parameters: { to: "bob" } });
const dispBefore = rt._dispatcher.log.length;
// ATTACK: the agent writes a SECOND key-K record (its own context) -> K now has 2 concurrent versions ->
// coherent view denies both (unresolved_conflict) -> R1 evicted from the view -> capability meet loses [].
facade.write(ex, ctx, "competing K version", { memory_id: "R3", logical_key: "K", memory_type: "constraint", allowed_readers: ["executor"] });
const attack = facade.executeAuthorizedAction(ex, ctx, facade.queryMemory(ex, ctx, {}, "send").viewId, { effect: "send", tool: "notify", parameters: { to: "bob" } });
const dispatched = rt._dispatcher.log.length > dispBefore && attack.status === "dispatched";
console.log(`honest: ${honest.decision || honest.status}/${honest.reason || ""}`);
console.log(`attack (write a 2nd same-key record): ${attack.decision || attack.status}/${attack.reason || ""} dispatched=${dispatched}`);
console.log(`[CAPWIDEN] ${dispatched ? "BUG-REPRODUCED (conflict evicts the restriction -> capability widened)" : "blocked (contested restriction still caps)"}`);
rt.close();
process.exit(dispatched ? 1 : 0);
