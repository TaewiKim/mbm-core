// Reproduce v18 P8: a same-key record B whose source merely DESCENDS from A's source automatically supersedes
// A ("latest-in-lineage"), even though B may only cite/review/critique A, not replace it -- no explicit
// signed supersedes edge. Current: only B served (A silently dropped). Reviewer: supersession must be explicit.
import { SecureMemoryRuntime, ControlPlane } from "../benchmarks/coupled_memory/runtime.mjs";
const env = (o) => ({ run_id: "R", task_id: "T", trace_id: "tr", intent: "produce_final_plan", state: "running",
  policy_context: "P", correlation_id: null, delegated_from: null, parent_message_id: null, ...o });
const cp = new ControlPlane(); const rt = new SecureMemoryRuntime({ controlPlane: cp });
const P = (id, o = {}) => cp.registerPrincipal(id, o);
// linear lineage m0 -> mA -> mB -> mx; A written at mA, B at mB (mB descends from mA), same key, NO supersede.
rt.sendMessage(env({ message_id: "m0", sender: "p", receiver: "memory", sequence: 1 }), P("p"));
rt.sendMessage(env({ message_id: "mA", sender: "a", receiver: "memory", sequence: 2, parent_message_id: "m0" }), P("a"));
rt.sendMessage(env({ message_id: "mB", sender: "b", receiver: "memory", sequence: 3, parent_message_id: "mA" }), P("b"));
rt.sendMessage(env({ message_id: "mx", sender: "c", receiver: "executor", sequence: 4, parent_message_id: "mB" }), P("c"));
const w = P("w", { queues: ["*"] }); const ex = P("ex", { queues: ["executor"] });
rt.writeMemory("retain-30 (authoritative)", rt.claimSpecific(w, "mA"), { memory_id: "A", logical_key: "k", memory_type: "constraint", allowed_readers: ["executor"] });
rt.writeMemory("note: see prior retention rule", rt.claimSpecific(w, "mB"), { memory_id: "B", logical_key: "k", memory_type: "constraint", allowed_readers: ["executor"] });
const served = rt.readMemory({}, rt.claimSpecific(ex, "mx"), null).filter((m) => m.logical_key === "k").map((m) => m.memory_id).sort();
// BUG (reviewer's view): A silently dropped purely by ancestry, with no explicit supersedes edge -> served=[B].
// "explicit" behavior: ancestry alone does NOT supersede -> A and B concurrent -> require resolution -> served=[].
const autoSuperseded = JSON.stringify(served) === JSON.stringify(["B"]);
console.log(`served for key k: ${JSON.stringify(served)}`);
console.log(`[P8] ${autoSuperseded ? "ancestry auto-supersedes (A dropped with no explicit edge)" : "ancestry does NOT auto-supersede"}`);
rt.close();
process.exit(autoSuperseded ? 1 : 0);
