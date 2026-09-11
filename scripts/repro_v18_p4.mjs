// Reproduce v18 P4: a resolution certificate issued for conflict {A,B} is reused to authoritatively resolve a
// DIFFERENT conflict {A,B,C} (new record C) without a fresh resolution. Before fix: C is silently denied and A
// served. After fix: adding C (not covered by the cert) -> REQUIRE_RESOLUTION (deny all) until re-resolved.
import { SecureMemoryRuntime, ControlPlane } from "../benchmarks/coupled_memory/runtime.mjs";
const env = (o) => ({ run_id: "R", task_id: "T", trace_id: "tr", intent: "produce_final_plan", state: "running",
  policy_context: "P", correlation_id: null, delegated_from: null, parent_message_id: null, ...o });
const cp = new ControlPlane(); const rt = new SecureMemoryRuntime({ controlPlane: cp });
const P = (id, o = {}) => cp.registerPrincipal(id, o);
// three concurrent sources off a common root, and a merge that has all three as parents.
rt.sendMessage(env({ message_id: "m0", sender: "p", receiver: "memory", sequence: 1 }), P("p"));
rt.sendMessage(env({ message_id: "mA", sender: "a", receiver: "memory", sequence: 2, parent_message_id: "m0" }), P("a"));
rt.sendMessage(env({ message_id: "mB", sender: "b", receiver: "memory", sequence: 3, parent_message_id: "m0" }), P("b"));
rt.sendMessage(env({ message_id: "mC", sender: "c2", receiver: "memory", sequence: 4, parent_message_id: "m0" }), P("c2"));
rt.sendMessage(env({ message_id: "mM", sender: "c", receiver: "executor", sequence: 5, parents: [{ id: "mA", type: "depends" }, { id: "mB", type: "depends" }, { id: "mC", type: "depends" }] }), P("c"));
const w = P("w", { queues: ["*"] }); const ex = P("ex", { queues: ["executor"] }); const resolver = P("res", { queues: ["*"], resolution: true });
rt.writeMemory("A", rt.claimSpecific(w, "mA"), { memory_id: "A", logical_key: "k", memory_type: "constraint", allowed_readers: ["executor"] });
rt.writeMemory("B", rt.claimSpecific(w, "mB"), { memory_id: "B", logical_key: "k", memory_type: "constraint", allowed_readers: ["executor"] });
// resolve the {A,B} conflict: adopt A, reject B.
rt.resolveConflict(resolver, { run_id: "R", logical_key: "k", accepted: ["A"], rejected: ["B"] });
const served1 = rt.readMemory({}, rt.claimSpecific(ex, "mM"), null).filter((m) => m.logical_key === "k").map((m) => m.memory_id).sort();
// NOW a NEW competing version C appears for the same key (a different, later decision) -- a NEW conflict {A,B,C}.
rt.writeMemory("C", rt.claimSpecific(w, "mC"), { memory_id: "C", logical_key: "k", memory_type: "constraint", allowed_readers: ["executor"] });
const served2 = rt.readMemory({}, rt.claimSpecific(ex, "mM"), null).filter((m) => m.logical_key === "k").map((m) => m.memory_id).sort();
// BUG: the stale {A,B} cert still makes A authoritative over the {A,B,C} conflict (serves A, denies C) with no
// fresh resolution. CORRECT: the cert no longer covers the conflict set -> serve NEITHER (require resolution).
const reused = served2.length > 0 && served2.includes("A");
console.log(`served after {A,B} resolution: ${JSON.stringify(served1)}`);
console.log(`served after C added (new conflict {A,B,C}): ${JSON.stringify(served2)}`);
console.log(`[P4] ${reused ? "BUG-REPRODUCED (stale cert reused for a new conflict set)" : "blocked (cert bound to its conflict set -> require resolution)"}`);
rt.close();
process.exit(reused ? 1 : 0);
