// Round-5 low finding (privileged integrity-floor gap): a principal that HOLDS lifecycle authority but only
// TASK integrity can supersede a SYSTEM-integrity restriction, dropping it from the capability meet -> widen.
// Supersession must respect Biba: the superseding record's integrity must be >= the superseded record's.
import { createSecureMemorySystem, ControlPlane } from "../benchmarks/coupled_memory/runtime.mjs";
const env = (o) => ({ run_id: "R", task_id: "T", trace_id: "tr", intent: "produce_final_plan", state: "running",
  policy_context: "P", correlation_id: null, delegated_from: null, parent_message_id: null, integrity: 2, ...o });
const cp = new ControlPlane();
const sys = createSecureMemorySystem({ controlPlane: cp, destinationPolicy: () => true });
const rt = sys.admin, facade = sys.runtime;
// m0 at SYSTEM integrity (so the restriction sourced there is system); mA/mx at TASK integrity so the
// consuming executor context is task-integrity and can read BOTH the system restriction (read-up) and the
// task override.
rt.sendMessage(env({ message_id: "m0", sender: "p", receiver: "memory", sequence: 1, integrity: 2 }), cp.registerPrincipal("p", { clearance: "system" }));
rt.sendMessage(env({ message_id: "mA", sender: "a", receiver: "memory", sequence: 2, parent_message_id: "m0", integrity: 1 }), cp.registerPrincipal("a", { clearance: "task" }));
rt.sendMessage(env({ message_id: "mx", sender: "c", receiver: "executor", sequence: 3, parent_message_id: "mA", integrity: 1 }), cp.registerPrincipal("c", { clearance: "task" }));
const sysw = cp.registerPrincipal("sysw", { queues: ["*"], clearance: "system" });           // system writer
const taskSup = cp.registerPrincipal("tasksup", { queues: ["*"], lifecycle: true, clearance: "task" }); // lifecycle but TASK integrity
const ex = cp.registerPrincipal("ex", { queues: ["executor"], clearance: "task" });          // task-integrity consumer
// R1: SYSTEM-integrity restriction (effect_ceiling caps to summarize only).
rt.writeMemory("system restriction", rt.claimSpecific(sysw, "m0"), { memory_id: "R1", logical_key: "K", memory_type: "constraint", allowed_readers: ["executor"], effect_ceiling: ["summarize"], requested_integrity: 2 });
const ctx = cp.contextTokenForLease(rt.claimSpecific(ex, "mx"));
const honest = facade.executeAuthorizedAction(ex, ctx, facade.queryMemory(ex, ctx, {}, "send").viewId, { effect: "send", tool: "send_email", parameters: { to: "ops" } });
const dispBefore = rt._dispatcher.log.length;
// ATTACK: a TASK-integrity (but lifecycle-holding) principal supersedes the SYSTEM restriction.
rt.writeMemory("task override", rt.claimSpecific(taskSup, "mA"), { memory_id: "R2", logical_key: "K", memory_type: "constraint", allowed_readers: ["executor"], supersedes: ["R1"], requested_integrity: 1 });
const attack = facade.executeAuthorizedAction(ex, ctx, facade.queryMemory(ex, ctx, {}, "send").viewId, { effect: "send", tool: "send_email", parameters: { to: "ops" } });
const dispatched = rt._dispatcher.log.length > dispBefore && attack.status === "dispatched";
console.log(`honest: ${honest.decision || honest.status}/${honest.reason || ""}`);
console.log(`R1 integrity=${rt.getMemoryRow("R1").integrity} R2 integrity=${(rt.getMemoryRow("R2")||{}).integrity}`);
console.log(`attack (task-integrity supersedes system restriction): ${attack.decision || attack.status}/${attack.reason || ""} dispatched=${dispatched}`);
console.log(`[INTFLOOR] ${dispatched ? "BUG-REPRODUCED (low-integrity supersession drops a high-integrity restriction)" : "blocked (supersession respects the integrity floor)"}`);
rt.close();
process.exit(dispatched ? 1 : 0);
