// Gate 2.0: set-level coherent-view authority + read-to-use transactions. A TRUE branch merge makes BOTH
// conflicting memories' sources genuine ancestors, so per-record causal reachability admits both (ancestry);
// the coherent-view gate requires a signed resolution certificate before either is authoritative (authority).
// And a read decision can go stale before its effects commit (read-to-use serializability).
import test from "node:test";
import assert from "node:assert/strict";
import { SecureMemoryRuntime, ControlPlane } from "../benchmarks/coupled_memory/runtime.mjs";

const BASE = { run_id: "R", task_id: "deploy", trace_id: "tr", intent: "produce_final_plan",
  state: "running", policy_context: "P", correlation_id: null, delegated_from: null, parent_message_id: null };

// Seed branches A and B and a TRUE merge whose two parents are A and B (parent + delegated_from), then write
// two conflicting same-logical_key memories, one under each branch.
function seedMerge(rt, cp) {
  const send = (o, sender) => rt.sendMessage({ ...BASE, ...o, sender }, cp.registerPrincipal(sender, {}));
  send({ message_id: "mA", receiver: "memory", sequence: 1 }, "pa");
  send({ message_id: "mB", receiver: "memory", sequence: 2 }, "pb");
  const w = cp.registerPrincipal("w", { queues: ["*"], clearance: "system" });
  rt.writeMemory("retention = 7 days", rt.claimSpecific(w, "mA"), { memory_id: "mem-A", memory_type: "constraint", allowed_readers: ["executor"], logical_key: "retention" });
  rt.writeMemory("retention = 30 days", rt.claimSpecific(w, "mB"), { memory_id: "mem-B", memory_type: "constraint", allowed_readers: ["executor"], logical_key: "retention" });
  // TRUE multi-parent merge via TYPED parents[] (not a reuse of parent_message_id + delegated_from). Sent LAST,
  // as a leaf that sources no memory, with a sequence strictly greater than every prior message AND write so the
  // v20 creation-cut admits the records it reads.
  send({ message_id: "mMerge", receiver: "executor", sequence: 90, parents: [{ id: "mA", type: "depends" }, { id: "mB", type: "depends" }] }, "co");
}

test("merge-induced ancestry laundering: per-record gate admits both; coherent view requires resolution", () => {
  const cp = new ControlPlane(); const rt = new SecureMemoryRuntime({ controlPlane: cp });
  try {
    seedMerge(rt, cp);
    const active = rt.getMessage("mMerge"); const closure = rt.causalAncestry(active);
    assert.ok(closure.has("mA") && closure.has("mB"), "both branches are genuine ancestors of the merge");
    const perRecord = rt.findCandidateMemories({})
      .filter((m) => rt.evaluateSecureGate(m, active, { causalClosure: closure, retiredIds: rt.retiredMemoryIds() }).decision === "allow")
      .map((m) => m.memory_id).sort();
    assert.deepEqual(perRecord, ["mem-A", "mem-B"], "the per-record gate alone admits BOTH conflicting memories");
    const ex = cp.registerPrincipal("ex", { queues: ["executor"] });
    const admitted = rt.readMemory({}, rt.claimSpecific(ex, "mMerge")).map((m) => m.memory_id);
    assert.deepEqual(admitted, [], "the coherent-view gate denies the unresolved same-key conflict");
  } finally { rt.close(); }
});

test("resolution certificate: only the adopted record is authoritative; unauthorized/forged refused; replay reproduces", () => {
  const cp = new ControlPlane(); const rt = new SecureMemoryRuntime({ controlPlane: cp });
  try {
    seedMerge(rt, cp);
    const ex = cp.registerPrincipal("ex", { queues: ["executor"] });
    assert.throws(() => rt.resolveConflict(cp.registerPrincipal("nobody", {}), { logical_key: "retention", accepted: ["mem-A"] }), /not_authorized_to_resolve/);
    assert.equal(cp.verifyResolution({ logical_key: "retention", accepted: ["mem-A"], rejected: ["mem-B"], resolver: "x", authority: "policy-resolution", policy_epoch: 1, resolution_sig: "rsig:deadbeef" }), false);
    rt.resolveConflict(cp.registerPrincipal("owner", { queues: [], resolution: true }), { logical_key: "retention", accepted: ["mem-B"], rejected: ["mem-A"] });
    const admitted = rt.readMemory({}, rt.claimSpecific(ex, "mMerge")).map((m) => m.memory_id);
    assert.deepEqual(admitted, ["mem-B"], "only the adopted record is admitted");
    assert.ok(rt.replaySecureMemoryReads("R").ok, "replay reproduces the coherent-view decisions");
  } finally { rt.close(); }
});

test("read-to-use serializability: a revoked exposed record aborts the commit; a forged token is denied", () => {
  const cp = new ControlPlane(); const rt = new SecureMemoryRuntime({ controlPlane: cp });
  try {
    const send = (o, sender) => rt.sendMessage({ ...BASE, ...o, sender }, cp.registerPrincipal(sender, {}));
    send({ message_id: "m0", receiver: "memory", sequence: 0 }, "p0");
    send({ message_id: "ms", receiver: "memory", sequence: 1, parent_message_id: "m0" }, "p1");
    const w = cp.registerPrincipal("w", { queues: ["*"] });
    const ex = cp.registerPrincipal("ex", { queues: ["executor"] });
    const lc = cp.registerPrincipal("lc", { queues: ["*"], lifecycle: true });
    rt.writeMemory("retain 30 days", rt.claimSpecific(w, "ms"), { memory_id: "mem", memory_type: "constraint", allowed_readers: ["executor"] });
    // Reader sent LAST with a sequence strictly greater than every prior message AND write (creation-cut).
    send({ message_id: "mx", receiver: "executor", sequence: 90, parent_message_id: "ms" }, "c0");
    const prep = rt.prepareMemoryRead({}, rt.claimSpecific(ex, "mx"), null, "produce_plan");
    assert.ok(prep.view.map((m) => m.memory_id).includes("mem"));
    assert.equal(rt.commitMemoryUse({ effect: "produce_plan" }, prep.token).decision, "ALLOW", "a fresh view commits");
    assert.equal(rt.commitMemoryUse({ effect: "produce_plan" }, "rtok.garbage.bad").decision, "DENY", "a forged token is denied");
    rt.revoke(lc, "mem");
    const after = rt.commitMemoryUse({ effect: "produce_plan" }, prep.token);
    assert.equal(after.decision, "ABORT_AND_RETRY");
    assert.equal(after.reason, "exposed_record_revoked");
  } finally { rt.close(); }
});

// Gate 2.0 #4 (effect ceiling) is fail-CLOSED on a writer type error: a non-array effect_ceiling is a
// RESTRICTION the writer asked for but mistyped. It must be REJECTED at write time, never silently dropped --
// dropping it persists effect_ceiling=null (UNRESTRICTED = the universe capability), so a view of only such
// records would carry no cap and a non-high-risk external effect (send/notify) would dispatch. That is the
// fail-OPEN this test pins shut.
test("malformed effect_ceiling is rejected at write time, not silently treated as unrestricted (fail-closed)", () => {
  const cp = new ControlPlane(); const rt = new SecureMemoryRuntime({ controlPlane: cp });
  try {
    const send = (o, sender) => rt.sendMessage({ ...BASE, ...o, sender }, cp.registerPrincipal(sender, {}));
    send({ message_id: "m0", receiver: "memory", sequence: 0 }, "p0");
    send({ message_id: "ms", receiver: "memory", sequence: 1, parent_message_id: "m0" }, "p1");
    const w = cp.registerPrincipal("w", { queues: ["*"] });
    const ex = cp.registerPrincipal("ex", { queues: ["executor"] });

    // The writer MEANT to restrict the record to read-only but mistyped the ceiling as a string. The old code
    // silently dropped it (-> effect_ceiling=null = UNRESTRICTED); it must now throw.
    assert.throws(
      () => rt.writeMemory("read-only fact", rt.claimSpecific(w, "ms"),
        { memory_id: "mem-bad", memory_type: "constraint", allowed_readers: ["executor"], effect_ceiling: "read" }),
      /effect_ceiling must be an array/,
      "a non-array effect_ceiling must be rejected, not silently dropped",
    );
    // The rejected write left NO record behind, so it cannot resurface as an unrestricted (universe) record.
    assert.equal(rt.getMemoryRow("mem-bad"), null, "the rejected malformed write persisted no record");

    // Positive control: the SAME restriction expressed correctly as an array DOES bound the action -- proving
    // the malformed input would otherwise have bypassed a real ceiling. capability = ["read"] excludes "send".
    rt.writeMemory("read-only fact", rt.claimSpecific(w, "ms"),
      { memory_id: "mem-ok", memory_type: "constraint", allowed_readers: ["executor"], effect_ceiling: ["read"] });
    // Reader sent LAST with a sequence strictly greater than every prior message AND write (creation-cut).
    send({ message_id: "mx", receiver: "executor", sequence: 90, parent_message_id: "ms" }, "c0");
    const prep = rt.prepareMemoryRead({}, rt.claimSpecific(ex, "mx"), null, "send");
    assert.deepEqual(prep.capability, ["read"], "a well-formed ceiling caps the view capability to read");
    const commit = rt.commitMemoryUse({ effect: "send" }, prep.token);
    assert.equal(commit.decision, "DENY");
    assert.equal(commit.reason, "effect_exceeds_ceiling", "a send beyond the ceiling is denied");
  } finally { rt.close(); }
});
