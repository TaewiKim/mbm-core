// Reproduce round-3 effect-ceiling-widen: an UNPRIVILEGED agent (no lifecycle/resolution authority) escalates
// its effect capability from deny-all ([]) to TOP by writing a same-key record that SELF-DECLARES
// supersedes:[restrictive], which marks the restriction superseded_in_lineage and drops it from the capability
// meet. FIX: a self-declared supersedes is advisory; only an AUTHORIZED retire/adopt/resolution supersedes, so
// the restriction stays in the (contested) meet and still caps.
import { createSecureMemorySystem, ControlPlane } from "../benchmarks/coupled_memory/runtime.mjs";
const env = (o) => ({ run_id: "R", task_id: "T", trace_id: "tr", intent: "produce_final_plan", state: "running",
  policy_context: "P", correlation_id: null, delegated_from: null, parent_message_id: null, ...o });
const cp = new ControlPlane();
const sys = createSecureMemorySystem({ controlPlane: cp, destinationPolicy: () => true });
const rt = sys.admin, facade = sys.runtime;
// linear lineage so R2's source descends R1's source.
rt.sendMessage(env({ message_id: "m0", sender: "p", receiver: "memory", sequence: 1 }), cp.registerPrincipal("p", {}));
rt.sendMessage(env({ message_id: "mA", sender: "a", receiver: "memory", sequence: 2, parent_message_id: "m0" }), cp.registerPrincipal("a", {}));
rt.sendMessage(env({ message_id: "mx", sender: "c", receiver: "executor", sequence: 3, parent_message_id: "mA" }), cp.registerPrincipal("c", {}));
const w = cp.registerPrincipal("w", { queues: ["*"] });           // ordinary writer: NO lifecycle/resolution authority
const ex = cp.registerPrincipal("ex", { queues: ["executor"] });
rt.writeMemory("deny-all", rt.claimSpecific(w, "m0"), { memory_id: "R1", logical_key: "K", memory_type: "constraint", allowed_readers: ["executor"], effect_ceiling: [] });
const ctx = cp.contextTokenForLease(rt.claimSpecific(ex, "mx"));
const honest = facade.executeAuthorizedAction(ex, ctx, facade.queryMemory(ex, ctx, {}, "transfer").viewId, { effect: "transfer", tool: "wire_transfer", parameters: { to: "attacker", amount: 1000000 } });
const dispBefore = rt._dispatcher.log.length;
// ATTACK: an unprivileged writer self-declares supersedes:[R1] on a same-key descendant record.
rt.writeMemory("override", rt.claimSpecific(w, "mA"), { memory_id: "R2", logical_key: "K", memory_type: "constraint", allowed_readers: ["executor"], supersedes: ["R1"] });
const attack = facade.executeAuthorizedAction(ex, ctx, facade.queryMemory(ex, ctx, {}, "transfer").viewId, { effect: "transfer", tool: "wire_transfer", parameters: { to: "attacker", amount: 1000000 } });
const dispatched = rt._dispatcher.log.length > dispBefore && attack.status === "dispatched";
console.log(`honest: ${honest.decision || honest.status}/${honest.reason || ""}`);
console.log(`attack (self-declared supersedes:[R1]): ${attack.decision || attack.status}/${attack.reason || ""} dispatched=${dispatched}`);
console.log(`[SUPERSEDE] ${dispatched ? "BUG-REPRODUCED (self-declared supersession evicts the restriction)" : "blocked (self-declared supersession is advisory; restriction still caps)"}`);
rt.close();
process.exit(dispatched ? 1 : 0);
