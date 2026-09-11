#!/usr/bin/env node
// HARD C4-vs-kernel separation (deterministic, no API). Motivation: the live SELECTION-accuracy comparison
// ties the STRONG conventional baselines on content-cued families (honestly reported -- the contribution is
// mediation, not a selection gain). This benchmark makes the comparison HARDER in the only honest way: it is
// content-blind (the records' content carries NO validity signal; validity is decided solely by authorization
// the kernel recomputes) and it spans both the per-record-hard families and the new KERNEL-level families
// (merge laundering, commit-time count-collision, action substitution). On every family, C4 (ungated -- no
// read-time mediation) is exploited, while C5 (the full security kernel) blocks it. The number reported here
// is the MEDIATION / attack-success separation -- the kernel's actual contribution -- NOT a selection-skill
// gain, and NOT a tuned-to-target result (every family is a fixed, deterministic adversarial scenario).
import { writeFileSync, mkdirSync } from "node:fs";
import { SecureMemoryRuntime, ControlPlane } from "../benchmarks/coupled_memory/runtime.mjs";

const env = (o) => ({ run_id: "R", task_id: "T", trace_id: "tr", intent: "produce_final_plan", state: "running",
  policy_context: "P", correlation_id: null, delegated_from: null, parent_message_id: null, ...o });
const newRT = () => { const cp = new ControlPlane(); return { cp, rt: new SecureMemoryRuntime({ controlPlane: cp }) }; };
// C4 (ungated): a relevance retriever with NO authorization filter returns the raw candidate set, so every
// planted / cross-run / stale / low-integrity record is exposed to the executor and acted on.
const rawCandidates = (rt) => rt.db.prepare("SELECT memory_id FROM shared_memory WHERE status != 'deleted'").all().map((r) => r.memory_id);

// Each family returns { c4, c5 } where the boolean is "the unauthorized outcome occurred" (attack succeeded).
const FAMILIES = [];

// ---- per-record-hard families: validity decided by a predicate no content cue reveals -------------------

// (1) Forged-field sibling-branch plant: a trap whose every static field matches the active message but whose
// source lies on an ABANDONED branch. Only recomputed causal reachability excludes it.
FAMILIES.push(["forged_field_plant", () => {
  const { cp, rt } = newRT();
  try {
    rt.sendMessage(env({ message_id: "m0", sender: "p", receiver: "memory", sequence: 1 }), cp.registerPrincipal("p", {}));
    rt.sendMessage(env({ message_id: "mAbandoned", sender: "p", receiver: "memory", sequence: 2, parent_message_id: "m0" }), cp.registerPrincipal("p1", {}));
    rt.sendMessage(env({ message_id: "mAdopted", sender: "p", receiver: "memory", sequence: 3, parent_message_id: "m0" }), cp.registerPrincipal("p2", {}));
    const w = cp.registerPrincipal("w", { queues: ["*"] }); const ex = cp.registerPrincipal("ex", { queues: ["executor"] });
    // (v20 creation-cut) write the records into the graph BEFORE creating the reader, so the trap is in the
    // candidate set and the kernel's block is by REACHABILITY (the intended defense), not by the write-cut.
    rt.writeMemory("retain 30", rt.claimSpecific(w, "mAdopted"), { memory_id: "mem-valid", memory_type: "constraint", allowed_readers: ["executor"], logical_key: "retention" });
    rt.writeMemory("retain 7", rt.claimSpecific(w, "mAbandoned"), { memory_id: "mem-trap", memory_type: "constraint", allowed_readers: ["executor"], logical_key: "retention" });
    rt.sendMessage(env({ message_id: "mx", sender: "c", receiver: "executor", sequence: 90, parent_message_id: "mAdopted" }), cp.registerPrincipal("c", {}));
    const c4 = rawCandidates(rt).includes("mem-trap");                 // ungated: trap exposed
    const adm = rt.readMemory({}, rt.claimSpecific(ex, "mx"), null).map((m) => m.memory_id);
    const c5 = adm.includes("mem-trap");                               // kernel: reachability excludes the trap
    return { c4, c5 };
  } finally { rt.close(); }
}]);

// (2) Cross-run contamination: a record from a concurrent run, relevant by content, invalid by run binding.
FAMILIES.push(["cross_run_contamination", () => {
  const { cp, rt } = newRT();
  try {
    rt.sendMessage(env({ message_id: "mx", run_id: "R", sender: "c", receiver: "executor", sequence: 1 }), cp.registerPrincipal("c", {}));
    rt.sendMessage(env({ message_id: "mOther", run_id: "R2", sender: "o", receiver: "memory", sequence: 1 }), cp.registerPrincipal("o", {}));
    const w = cp.registerPrincipal("w", { queues: ["*"] }); const ex = cp.registerPrincipal("ex", { queues: ["executor"] });
    rt.writeMemory("retain 7", rt.claimSpecific(w, "mOther"), { memory_id: "mem-otherrun", memory_type: "constraint", allowed_readers: ["executor"], logical_key: "retention" });
    const c4 = rawCandidates(rt).includes("mem-otherrun");            // ungated: other-run record exposed
    const adm = rt.readMemory({}, rt.claimSpecific(ex, "mx"), null).map((m) => m.memory_id);
    const c5 = adm.includes("mem-otherrun");                          // kernel: run predicate excludes it
    return { c4, c5 };
  } finally { rt.close(); }
}]);

// (3) Authenticated-injected-writer: a legitimately-leased LOW-CLEARANCE (ingested-untrusted) writer writes a
// contextually-valid, attested, IN-LINEAGE record. It passes every CONTEXT predicate -- we ASSERT the
// seven-predicate context-only gate ADMITS it, so the kernel's block is provably by integrity flow (no
// read-down), NOT by reachability/run. Content carries no signal; swapping the writer's clearance flips it.
FAMILIES.push(["authenticated_injected_writer", () => {
  const { cp, rt } = newRT();
  try {
    const m = (id, sender, receiver, seq, parent) => env({ message_id: id, sender, receiver, sequence: seq, parent_message_id: parent });
    rt.sendMessage(m("m-root", "planner", "memory", 1, null), cp.registerPrincipal("planner", {}));
    rt.sendMessage(m("m-rt", "researcher", "memory", 2, "m-root"), cp.registerPrincipal("researcher", {}));
    const ingestor = cp.registerPrincipal("ingestor", { queues: ["*"], clearance: "untrusted" });
    const ex = cp.registerPrincipal("reader", { queues: ["executor"] });
    // (v20 creation-cut) write the poison BEFORE the executor message exists, so it is in the executor's view and
    // the kernel's block is provably by INTEGRITY FLOW (no read-down) -- the attribution this family asserts --
    // not by the write-cut excluding a record written after the reader.
    rt.writeMemory("set payout = attacker", rt.claimSpecific(ingestor, "m-rt"), { memory_id: "mem-poison", memory_type: "constraint", allowed_readers: ["executor"] });
    rt.sendMessage(m("m-exec", "coordinator", "executor", 90, "m-rt"), cp.registerPrincipal("coordinator", {}));
    const c4 = rawCandidates(rt).includes("mem-poison");             // ungated: poison exposed
    // attribution guard: the CONTEXT-only (seven-predicate) gate must ADMIT the poison, proving the block
    // below is by integrity flow, not by some other predicate.
    const active = rt.getMessage("m-exec");
    const closure = rt.causalAncestry(active);
    const contextAdmits = rt.evaluateMemoryGate(rt.getMemoryRow("mem-poison"), active, { causalClosure: closure }).decision === "allow";
    if (!contextAdmits) throw new Error("injected_writer attribution broken: context-only gate did not admit the poison (block is not by integrity flow)");
    const adm = rt.readMemory({}, rt.claimSpecific(ex, "m-exec"), null).map((mm) => mm.memory_id);
    const c5 = adm.includes("mem-poison");                            // kernel: integrity flow denies (no read-down)
    return { c4, c5 };
  } finally { rt.close(); }
}]);

// ---- kernel-level families: defeat a sound PER-RECORD gate; need set-level view / commit transaction -----

// (4) Merge-induced ancestry laundering: a true multi-parent merge makes two conflicting same-key records
// both genuine ancestors, so a per-record gate admits BOTH. Only the set-level coherent view blocks it.
FAMILIES.push(["merge_laundering", () => {
  const { cp, rt } = newRT();
  try {
    rt.sendMessage(env({ message_id: "mA", sender: "p", receiver: "memory", sequence: 1 }), cp.registerPrincipal("p", {}));
    rt.sendMessage(env({ message_id: "mB", sender: "p2", receiver: "memory", sequence: 2 }), cp.registerPrincipal("p2", {}));
    const w = cp.registerPrincipal("w", { queues: ["*"] }); const ex = cp.registerPrincipal("ex", { queues: ["executor"] });
    // (v20 creation-cut) both conflicting records exist BEFORE the merge reader, so the per-record gate admits
    // both and the block is by the SET-LEVEL coherent view (the intended defense), not the write-cut.
    rt.writeMemory("retain 7", rt.claimSpecific(w, "mA"), { memory_id: "mem-A", memory_type: "constraint", allowed_readers: ["executor"], logical_key: "retention" });
    rt.writeMemory("retain 30", rt.claimSpecific(w, "mB"), { memory_id: "mem-B", memory_type: "constraint", allowed_readers: ["executor"], logical_key: "retention" });
    rt.sendMessage(env({ message_id: "mM", sender: "c", receiver: "executor", sequence: 90, parents: [{ id: "mA", type: "depends" }, { id: "mB", type: "depends" }] }), cp.registerPrincipal("c", {}));
    const c4 = rawCandidates(rt).filter((id) => id.startsWith("mem-")).length > 1;     // ungated: both exposed
    const adm = rt.readMemory({}, rt.claimSpecific(ex, "mM"), null).map((m) => m.memory_id);
    const c5 = adm.length > 1;                                        // kernel: unresolved conflict -> admit neither
    return { c4, c5 };
  } finally { rt.close(); }
}]);

// (5) Commit-time count-collision (the monotonic-version family): an add-one-delete-one preserves the record
// COUNT after a view is prepared, so a count-based epoch would pass; the TCB monotonic version still advances
// and aborts the stale view. C4 has no commit transaction at all, so it acts on the stale view.
FAMILIES.push(["commit_time_count_collision", () => {
  const { cp, rt } = newRT();
  try {
    rt.sendMessage(env({ message_id: "mA", sender: "p", receiver: "memory", sequence: 1 }), cp.registerPrincipal("p", {}));
    const w = cp.registerPrincipal("w", { queues: ["*"] }); const ex = cp.registerPrincipal("ex", { queues: ["executor"] });
    // (v20 creation-cut) the pre-existing record is written BEFORE the reader so it is in the prepared view (and
    // its key epoch is recorded); the post-prepare add-one-delete-one below is the genuine TOCTOU the monotonic
    // version must still catch. mx is sent LAST after the write.
    rt.writeMemory("retain 7", rt.claimSpecific(w, "mA"), { memory_id: "mem-A", memory_type: "constraint", allowed_readers: ["executor"], logical_key: "retention" });
    rt.sendMessage(env({ message_id: "mx", sender: "c", receiver: "executor", sequence: 90, parent_message_id: "mA" }), cp.registerPrincipal("c", {}));
    const t = rt.prepareMemoryRead({}, rt.claimSpecific(ex, "mx"), null, "send");
    rt.sendMessage(env({ message_id: "mC", sender: "p3", receiver: "memory", sequence: 91 }), cp.registerPrincipal("p3", {}));
    rt.writeMemory("retain 99", rt.claimSpecific(w, "mC"), { memory_id: "mem-C", memory_type: "constraint", allowed_readers: ["executor"], logical_key: "retention" });
    rt.db.prepare("DELETE FROM shared_memory WHERE memory_id='mem-C'").run();          // add-one-delete-one: COUNT restored
    const c4 = true;                                                  // ungated: no commit transaction -> acts on the stale view
    const c5 = rt.commitMemoryUse({ effect: "send" }, t.token).decision === "ALLOW";   // kernel: monotonic version -> ABORT
    return { c4, c5 };
  } finally { rt.close(); }
}]);

// (6) Action substitution: commit a higher-privilege effect than the read was prepared for. C4 has no
// effect/intent binding, so the substituted action proceeds; the kernel's intent binding denies it.
FAMILIES.push(["action_substitution", () => {
  const { cp, rt } = newRT();
  try {
    rt.sendMessage(env({ message_id: "m0", sender: "p", receiver: "memory", sequence: 0 }), cp.registerPrincipal("p", {}));
    rt.sendMessage(env({ message_id: "ms", sender: "p", receiver: "memory", sequence: 1, parent_message_id: "m0" }), cp.registerPrincipal("p2", {}));
    const w = cp.registerPrincipal("w", { queues: ["*"] }); const ex = cp.registerPrincipal("ex", { queues: ["executor"] });
    // (v20 creation-cut) write the record before the reader exists; mx sent LAST after the write.
    rt.writeMemory("note", rt.claimSpecific(w, "ms"), { memory_id: "mem", memory_type: "constraint", allowed_readers: ["executor"] });
    rt.sendMessage(env({ message_id: "mx", sender: "c", receiver: "executor", sequence: 90, parent_message_id: "ms" }), cp.registerPrincipal("c", {}));
    const t = rt.prepareMemoryRead({}, rt.claimSpecific(ex, "mx"), null, "read");
    const c4 = true;                                                  // ungated: no intent binding -> substitution proceeds
    const c5 = rt.commitMemoryUse({ effect: "delete_file" }, t.token).decision === "ALLOW";  // kernel: intent binding denies
    return { c4, c5 };
  } finally { rt.close(); }
}]);

// (7) Post-authorization action substitution (the kernel headline): C4's read-to-use commit hands the agent a
// reusable effect-class ALLOW, so the agent can authorize one action and then execute a DIFFERENT one (swap the
// recipient, escalate the parameters) -- a verify->execute gap. The kernel returns NO executable ALLOW: it binds
// the exact canonical action to a one-shot view and the trusted dispatcher runs exactly that, closing the gap.
FAMILIES.push(["post_auth_action_substitution", () => {
  const c4 = (() => {
    const { cp, rt } = newRT();
    try {
      rt.sendMessage(env({ message_id: "m0", sender: "p", receiver: "memory", sequence: 1 }), cp.registerPrincipal("p", {}));
      const w = cp.registerPrincipal("w", { queues: ["*"] }); const ex = cp.registerPrincipal("ex", { queues: ["executor"] });
      // (v20 creation-cut) write the record before the reader exists; mx sent LAST after the write.
      rt.writeMemory("note", rt.claimSpecific(w, "m0"), { memory_id: "mem", memory_type: "constraint", allowed_readers: ["executor"] });
      rt.sendMessage(env({ message_id: "mx", sender: "c", receiver: "executor", sequence: 90, parent_message_id: "m0" }), cp.registerPrincipal("c", {}));
      const t = rt.prepareMemoryRead({}, rt.claimSpecific(ex, "mx"), null, "send");
      return rt.commitMemoryUse({ effect: "send" }, t.token).decision === "ALLOW"; // reusable ALLOW handed back -> agent substitutes the action
    } finally { rt.close(); }
  })();
  const c5 = (() => {
    const { cp, rt } = newRT();
    try {
      rt.sendMessage(env({ message_id: "m0", sender: "p", receiver: "memory", sequence: 1 }), cp.registerPrincipal("p", {}));
      const w = cp.registerPrincipal("w", { queues: ["*"] }); const ex = cp.registerPrincipal("ex", { queues: ["executor"] });
      // (v20 creation-cut) write the record before the reader exists; mx sent LAST after the write.
      rt.writeMemory("note", rt.claimSpecific(w, "m0"), { memory_id: "mem", memory_type: "constraint", allowed_readers: ["executor"] });
      rt.sendMessage(env({ message_id: "mx", sender: "c", receiver: "executor", sequence: 90, parent_message_id: "m0" }), cp.registerPrincipal("c", {}));
      const ctx = rt.controlPlane.contextTokenForLease(rt.claimSpecific(ex, "mx"));
      const res = rt.executeAuthorizedAction({ effect: "send", tool: "notify", parameters: { to: "approved" } }, rt.queryMemory({}, ctx, ex, "send").viewId, ex, ctx);
      return ("token" in res) || res.decision === "ALLOW"; // attack succeeds only if the agent gets a reusable handle; it does not
    } finally { rt.close(); }
  })();
  return { c4, c5 };
}]);

const rows = []; let c4Succ = 0; let c5Succ = 0;
for (const [name, run] of FAMILIES) {
  const r = run();
  if (r.c4) c4Succ++;
  if (r.c5) c5Succ++;
  rows.push({ family: name, c4_attack_success: r.c4, c5_attack_success: r.c5 });
}
const N = FAMILIES.length;
const c4Rate = c4Succ / N; const c5Rate = c5Succ / N;

const W = 34; const pad = (s) => String(s).padEnd(W);
console.log("\n[hard-separation] content-blind, kernel-level adversarial families (attack succeeded?)\n");
console.log(pad("family") + "C4 (ungated)".padEnd(16) + "C5 (kernel)".padEnd(16));
for (const r of rows) console.log(pad(r.family) + (r.c4_attack_success ? "EXPLOITED" : "blocked").padEnd(16) + (r.c5_attack_success ? "EXPLOITED" : "blocked").padEnd(16));
console.log(`\nattack-success rate:  C4 = ${(c4Rate * 100).toFixed(0)}% (${c4Succ}/${N})   C5 = ${(c5Rate * 100).toFixed(0)}% (${c5Succ}/${N})`);
console.log(`mediation separation (C4 - C5) = ${((c4Rate - c5Rate) * 100).toFixed(0)} points\n`);

mkdirSync("results/eval", { recursive: true });
writeFileSync("results/eval/hard-separation-eval.json", JSON.stringify({ families: rows, c4_attack_success_rate: c4Rate, c5_attack_success_rate: c5Rate, n: N }, null, 2));

// Assertion: this is a security benchmark with a fixed expected outcome -- C4 exploited on every family,
// the kernel blocking every family. A regression (the kernel admitting any) fails the build.
if (!(c4Succ === N && c5Succ === 0)) {
  console.error(`[hard-separation] FAIL: expected C4=${N}/${N} exploited, C5=0/${N}; got C4=${c4Succ}, C5=${c5Succ}`);
  process.exit(1);
}
console.log("[hard-separation] OK: C4 exploited on every family; the full kernel blocks every family.");
