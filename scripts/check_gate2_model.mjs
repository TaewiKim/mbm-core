#!/usr/bin/env node
// Exhaustive bounded model-check of the two Gate 2.0 propositions against the ACTUAL implementation (so the
// model cannot drift from the code, unlike a separate TLA+/Alloy spec). It enumerates every small scenario /
// interleaving and asserts the proposition holds; exit non-zero on any violation.
//
//   Proposition 2 (coherent-view safety): for every logical key, the coherent view admits AT MOST ONE
//     authoritative same-key version, across all merge edge types (depends/adopt), lineage shapes, and
//     resolution choices.  -> assert: |admitted same-key| <= 1 in every reachable read state.
//   Proposition 3 (one-shot commit-time authorization): commit returns ALLOW only if the token verifies, is
//     unexpired and unconsumed, its effect matches the prepared intent, every exposed record is unrevoked and
//     unmutated, and the policy/resolution/per-key epochs are unchanged since prepare; a SUCCESSFUL commit is
//     never repeatable.  -> assert the ALLOW=>invariants implication and one-shot over all bounded schedules.
import { SecureMemoryRuntime, ControlPlane, memoryContentHash } from "../benchmarks/coupled_memory/runtime.mjs";

const env = (o) => ({ run_id: "R", task_id: "T", trace_id: "tr", intent: "produce_final_plan", state: "running",
  policy_context: "P", correlation_id: null, delegated_from: null, parent_message_id: null, ...o });
const fail = (m) => { console.error(`[gate2:model] VIOLATION: ${m}`); process.exitCode = 1; };

// ---- Proposition 2: exhaustive over merge edge types x lineage shape x resolution choice ----
let p2 = 0;
const EDGE = ["depends", "adopt"];
const RES = ["none", "A", "B"];
for (const lineage of [false, true]) {       // false: A,B concurrent under a merge; true: A is an ancestor of B
  for (const eA of EDGE) for (const eB of EDGE) {
    for (const res of RES) {
      // adopt edges require adoption authority; skip the lineage shape's irrelevant edge combos once.
      if (lineage && (eA !== "depends" || eB !== "depends")) continue;
      const cp = new ControlPlane(); const rt = new SecureMemoryRuntime({ controlPlane: cp });
      try {
        const merger = cp.registerPrincipal("c", { resolution: true }); // may create adopt edges + resolve
        if (lineage) {
          rt.sendMessage(env({ message_id: "mA", sender: "p", receiver: "memory", sequence: 1 }), cp.registerPrincipal("p", {}));
          rt.sendMessage(env({ message_id: "mB", sender: "p2", receiver: "memory", sequence: 2, parent_message_id: "mA" }), cp.registerPrincipal("p2", {}));
          rt.sendMessage(env({ message_id: "mAct", sender: "c", receiver: "executor", sequence: 3, parent_message_id: "mB" }), merger);
        } else {
          rt.sendMessage(env({ message_id: "mA", sender: "p", receiver: "memory", sequence: 1 }), cp.registerPrincipal("p", {}));
          rt.sendMessage(env({ message_id: "mB", sender: "p2", receiver: "memory", sequence: 2 }), cp.registerPrincipal("p2", {}));
          rt.sendMessage(env({ message_id: "mAct", sender: "c", receiver: "executor", sequence: 3, parents: [{ id: "mA", type: eA }, { id: "mB", type: eB }] }), merger);
        }
        const w = cp.registerPrincipal("w", { queues: ["*"] }); const ex = cp.registerPrincipal("ex", { queues: ["executor"] });
        rt.writeMemory("retain 7", rt.claimSpecific(w, "mA"), { memory_id: "rA", memory_type: "constraint", allowed_readers: ["executor"], logical_key: "K" });
        rt.writeMemory("retain 30", rt.claimSpecific(w, "mB"), { memory_id: "rB", memory_type: "constraint", allowed_readers: ["executor"], logical_key: "K" });
        if (res === "A") rt.resolveConflict(merger, { logical_key: "K", accepted: ["rA"], rejected: ["rB"] });
        if (res === "B") rt.resolveConflict(merger, { logical_key: "K", accepted: ["rB"], rejected: ["rA"] });
        const admitted = rt.readMemory({}, rt.claimSpecific(ex, "mAct")).filter((m) => m.logical_key === "K");
        p2 += 1;
        if (admitted.length > 1) fail(`P2 admitted ${admitted.length} authoritative for key K (lineage=${lineage}, eA=${eA}, eB=${eB}, res=${res})`);
      } finally { rt.close(); }
    }
  }
}

// ---- Proposition 3: exhaustive over intended effect x two interleaved ops x committed effect ----
let p3 = 0, allows = 0;
const INTENDED = ["read", "send"];
const OPS = ["none", "add_same_key", "revoke_exposed", "mutate_exposed", "resolve_other", "advance_policy"];
const EFFECTS = ["read", "send", "delete"];
for (const intended of INTENDED) for (const op1 of OPS) for (const op2 of OPS) for (const eff of EFFECTS) {
  const cp = new ControlPlane(); const rt = new SecureMemoryRuntime({ controlPlane: cp });
  try {
    rt.sendMessage(env({ message_id: "m0", sender: "p", receiver: "memory", sequence: 0 }), cp.registerPrincipal("p", {}));
    rt.sendMessage(env({ message_id: "ms", sender: "p", receiver: "memory", sequence: 1, parent_message_id: "m0" }), cp.registerPrincipal("p2", {}));
    rt.sendMessage(env({ message_id: "mx", sender: "c", receiver: "executor", sequence: 2, parent_message_id: "ms" }), cp.registerPrincipal("c", {}));
    const w = cp.registerPrincipal("w", { queues: ["*"] }); const ex = cp.registerPrincipal("ex", { queues: ["executor"] });
    const lc = cp.registerPrincipal("lc", { queues: ["*"], lifecycle: true });
    const owner = cp.registerPrincipal("owner", { resolution: true });
    rt.writeMemory("v1", rt.claimSpecific(w, "ms"), { memory_id: "mem", memory_type: "constraint", allowed_readers: ["executor"], logical_key: "K" });
    const t = rt.prepareMemoryRead({}, rt.claimSpecific(ex, "mx"), null, intended);
    const bound = cp.verifyReadToken(t.token); // the snapshot the token binds
    const applyOp = (op) => {
      if (op === "add_same_key") rt.writeMemory("v2", rt.claimSpecific(w, "ms"), { memory_id: `m2-${op1}-${op2}-${eff}`, memory_type: "constraint", allowed_readers: ["executor"], logical_key: "K" });
      else if (op === "revoke_exposed") { try { rt.revoke(lc, "mem"); } catch { /* already revoked */ } }
      else if (op === "mutate_exposed") rt.db.prepare("UPDATE shared_memory SET content=? WHERE memory_id='mem'").run(`mutated-${op1}-${op2}-${eff}`);
      else if (op === "resolve_other") {
        // A resolution on an UNRELATED key during the prepared-read window (advances the resolution epoch).
        // A cert may only name a record that exists with that key (v19 #2), so seed a real one first.
        const ok = `other-${op1}-${op2}-${eff}`; const oid = `oz-${op1}-${op2}-${eff}`;
        rt.writeMemory("o", rt.claimSpecific(w, "ms"), { memory_id: oid, memory_type: "constraint", allowed_readers: ["executor"], logical_key: ok });
        rt.resolveConflict(owner, { logical_key: ok, accepted: [oid], rejected: [] });
      }
      else if (op === "advance_policy") cp.policyVersion += 1;
    };
    applyOp(op1); if (op2 !== op1 || op1 === "none") applyOp(op2); // avoid duplicate same-id writes
    const d = rt.commitMemoryUse({ effect: eff }, t.token);
    p3 += 1;
    if (d.decision === "ALLOW") {
      allows += 1;
      // ALLOW => every invariant the proposition requires must hold.
      const inv = [];
      const effOk = bound.intended === "read" ? eff === "read" : eff === bound.intended;
      if (!effOk) inv.push("effect!=intent");
      let retired = new Set(); try { retired = rt.retiredMemoryIds(); } catch {}
      for (const e of bound.exposed) {
        if (retired.has(e.id)) inv.push(`exposed_revoked:${e.id}`);
        const row = rt.getMemoryRow(e.id);
        if (!row || memoryContentHash(row) !== e.hash) inv.push(`exposed_mutated:${e.id}`);
      }
      if (bound.policy_epoch !== cp.policyEpoch()) inv.push("policy_epoch_changed");
      let curRes; try { curRes = rt._resolutionEpoch(); } catch { curRes = "ERR"; }
      if (bound.resolution_epoch !== curRes) inv.push("resolution_epoch_changed");
      const active = rt.getMessage(bound.active_message_id);
      for (const [k, epk] of Object.entries(bound.key_epochs ?? {})) {
        if (rt._keyEpoch(active ? active.run_id : null, k) !== epk) inv.push(`key_epoch_changed:${k}`);
      }
      if (inv.length) fail(`P3 ALLOW with violated invariants [${inv.join(",")}] (intended=${intended}, op1=${op1}, op2=${op2}, eff=${eff})`);
      // one-shot: a successful commit must not be repeatable.
      if (rt.commitMemoryUse({ effect: eff }, t.token).decision === "ALLOW") fail(`P3 one-shot violated: token re-committed (intended=${intended}, op1=${op1}, op2=${op2}, eff=${eff})`);
    }
  } finally { rt.close(); }
}

console.log(`[gate2:model] Proposition 2 (coherent-view safety): ${p2} scenarios, all admit <=1 authoritative per key.`);
console.log(`[gate2:model] Proposition 3 (one-shot commit-time authorization): ${p3} schedules (${allows} ALLOW), ALLOW=>invariants and one-shot hold.`);
if (process.exitCode === 1) { console.error("[gate2:model] FAIL: a proposition was violated."); }
else console.log("[gate2:model] OK: both propositions hold exhaustively over the bounded state space.");
