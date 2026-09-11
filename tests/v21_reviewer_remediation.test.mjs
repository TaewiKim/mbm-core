import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createSecureMemorySystem, SecureMemoryRuntime, ControlPlane } from "../benchmarks/coupled_memory/runtime.mjs";
import { memoryContentHash } from "../benchmarks/coupled_memory/hash.mjs";

const KEY = Buffer.alloc(32, 21);
const env = (o) => ({ run_id: "R", task_id: "T", trace_id: "tr", intent: "produce_final_plan",
  state: "running", policy_context: "P", correlation_id: null, delegated_from: null,
  parent_message_id: null, ...o });

test("v21-1: signed message, queue, event, and run clocks commit atomically", () => {
  const cp = new ControlPlane();
  const rt = new SecureMemoryRuntime({ controlPlane: cp });
  const sender = cp.registerPrincipal("p", {});
  const orig = rt._insertSignedMessage.bind(rt);
  rt._insertSignedMessage = (...args) => { orig(...args); throw new Error("fault_after_message_insert"); };
  assert.throws(() => rt.sendMessage(env({ message_id: "mFault", sender: "p", receiver: "memory", sequence: 500 }), sender),
    /fault_after_message_insert/);
  assert.equal(rt.db.prepare("SELECT COUNT(*) AS n FROM messages WHERE message_id='mFault'").get().n, 0);
  assert.equal(rt.db.prepare("SELECT COUNT(*) AS n FROM message_queue WHERE message_id='mFault'").get().n, 0);
  assert.equal(rt.db.prepare("SELECT next_seq FROM kernel.run_clock WHERE run_id='R'").get(), undefined);
  rt.close();
});

test("v21-2: context-driven send rolls back message, context mirror, anchor, and output audit together", () => {
  const cp = new ControlPlane();
  const sys = createSecureMemorySystem({ controlPlane: cp });
  const rt = sys.admin;
  const p = cp.registerPrincipal("p", {});
  const ex = cp.registerPrincipal("ex", { queues: ["executor"] });
  rt.sendMessage(env({ message_id: "m0", sender: "p", receiver: "executor", sequence: 1 }), p);
  const ctx = cp.contextTokenForLease(rt.claimSpecific(ex, "m0"));
  const before = cp.contextSnapshot(ctx);
  const orig = rt._recordOutput.bind(rt);
  rt._recordOutput = (...args) => { orig(...args); throw new Error("fault_after_context_persist"); };
  assert.throws(() => sys.runtime.send(ex, ctx, { receiver: "memory", intent: "note", state: "ready" }),
    /fault_after_context_persist/);
  assert.equal(rt.db.prepare("SELECT COUNT(*) AS n FROM messages WHERE parent_message_id='m0'").get().n, 0);
  assert.equal(rt.db.prepare("SELECT version FROM execution_contexts WHERE context_id=?").get(before.contextId).version, before.version);
  assert.equal(rt.db.prepare("SELECT version FROM kernel.context_anchor WHERE context_id=?").get(before.contextId).version, before.version);
  assert.equal(rt.db.prepare("SELECT COUNT(*) AS n FROM execution_outputs WHERE context_id=?").get(before.contextId).n, 0);
  rt.close();
});

test("v21-3: deleting the context mirror cannot rebind a stale token to a new context", () => {
  const dbPath = join(mkdtempSync(join(tmpdir(), "mbm-v21ctx-")), "mem.db");
  let staleToken, staleContextId;
  {
    const cp = new ControlPlane({ keyBytes: KEY });
    const sys = createSecureMemorySystem({ controlPlane: cp, dbPath });
    const rt = sys.admin;
    const p = cp.registerPrincipal("p", {});
    const ex = cp.registerPrincipal("ex", { queues: ["executor"] });
    rt.sendMessage(env({ message_id: "m0", sender: "p", receiver: "executor", sequence: 1 }), p);
    staleToken = cp.contextTokenForLease(rt.claimSpecific(ex, "m0"));
    staleContextId = cp.contextSnapshot(staleToken).contextId;
    rt.db.prepare("DELETE FROM execution_inputs WHERE context_id=?").run(staleContextId);
    rt.db.prepare("DELETE FROM execution_contexts WHERE context_id=?").run(staleContextId);
    rt.close();
  }
  {
    const cp = new ControlPlane({ keyBytes: KEY });
    const sys = createSecureMemorySystem({ controlPlane: cp, dbPath });
    const rt = sys.admin;
    const p = cp.registerPrincipal("p", {});
    const ex = cp.registerPrincipal("ex", { queues: ["executor"] });
    rt.sendMessage(env({ message_id: "m1", sender: "p", receiver: "executor", sequence: 2 }), p);
    const freshToken = cp.contextTokenForLease(rt.claimSpecific(ex, "m1"));
    assert.notEqual(cp.contextSnapshot(freshToken).contextId, staleContextId);
    assert.throws(() => cp.contextSnapshot(staleToken), /context_unknown/);
    rt.close();
  }
});

test("v21-4: queryMemory uses one secure read snapshot and does not call prepareMemoryRead", () => {
  const cp = new ControlPlane();
  const sys = createSecureMemorySystem({ controlPlane: cp, destinationPolicy: () => true });
  const rt = sys.admin;
  const p = cp.registerPrincipal("p", {});
  const w = cp.registerPrincipal("w", { queues: ["*"] });
  const ex = cp.registerPrincipal("ex", { queues: ["executor"] });
  rt.sendMessage(env({ message_id: "m0", sender: "p", receiver: "memory", sequence: 1 }), p);
  rt.writeMemory("send authority", rt.claimSpecific(w, "m0"),
    { memory_id: "mem-send", memory_type: "constraint", allowed_readers: ["executor"], effect_ceiling: ["send"] });
  rt.sendMessage(env({ message_id: "mx", sender: "p", receiver: "executor", sequence: 90, parent_message_id: "m0" }), p);
  const ctx = cp.contextTokenForLease(rt.claimSpecific(ex, "mx"));
  let reads = 0;
  const origRead = rt.readMemory.bind(rt);
  rt.readMemory = (...args) => { reads += 1; return origRead(...args); };
  rt.prepareMemoryRead = () => { throw new Error("prepareMemoryRead_must_not_be_used_by_queryMemory"); };
  const q = sys.runtime.queryMemory(ex, ctx, {}, "send");
  assert.equal(reads, 1);
  assert.deepEqual(q.records.map((m) => m.memory_id), ["mem-send"]);
  rt.close();
});

test("v21-5: a nonempty ordinary view gives no positive authority for an external action", () => {
  const cp = new ControlPlane();
  const sys = createSecureMemorySystem({ controlPlane: cp, destinationPolicy: () => true });
  const rt = sys.admin;
  const p = cp.registerPrincipal("p", {});
  const w = cp.registerPrincipal("w", { queues: ["*"] });
  const ex = cp.registerPrincipal("ex", { queues: ["executor"] });
  rt.sendMessage(env({ message_id: "m0", sender: "p", receiver: "memory", sequence: 1 }), p);
  rt.writeMemory("ordinary note", rt.claimSpecific(w, "m0"), { memory_id: "mem-note", memory_type: "summary", allowed_readers: ["executor"] });
  rt.sendMessage(env({ message_id: "mx", sender: "p", receiver: "executor", sequence: 90, parent_message_id: "m0" }), p);
  const ctx = cp.contextTokenForLease(rt.claimSpecific(ex, "mx"));
  const q = sys.runtime.queryMemory(ex, ctx, {}, "send");
  assert.deepEqual(q.records.map((m) => m.memory_id), ["mem-note"]);
  const r = sys.runtime.executeAuthorizedAction(ex, ctx, q.viewId, { effect: "send", tool: "notify", parameters: { to: "ops" } });
  assert.deepEqual({ decision: r.decision, reason: r.reason }, { decision: "DENY", reason: "effect_exceeds_ceiling" });
  rt.close();
});

test("v21-6: tainted contexts cannot execute tools above their integrity floor", () => {
  const cp = new ControlPlane();
  const sys = createSecureMemorySystem({ controlPlane: cp, destinationPolicy: () => true });
  const rt = sys.admin;
  const p = cp.registerPrincipal("p", { clearance: "system" });
  const w = cp.registerPrincipal("w", { queues: ["*"], clearance: "system" });
  const ex = cp.registerPrincipal("ex", { queues: ["executor"], clearance: "system" });
  rt.sendMessage(env({ message_id: "m0", sender: "p", receiver: "memory", sequence: 1, integrity: "system" }), p);
  rt.writeMemory("send authority", rt.claimSpecific(w, "m0"),
    { memory_id: "mem-send", memory_type: "constraint", allowed_readers: ["executor"], effect_ceiling: ["send"] });
  rt.sendMessage(env({ message_id: "mx", sender: "p", receiver: "executor", sequence: 90, parent_message_id: "m0", integrity: "system" }), p);
  rt.sendMessage(env({ message_id: "mLow", sender: "p", receiver: "executor", sequence: 91, parent_message_id: "m0", integrity: "untrusted" }), p);
  const ctx = cp.contextTokenForLease(rt.claimSpecific(ex, "mx"));
  sys.runtime.attachInput(ex, ctx, cp.contextTokenForLease(rt.claimSpecific(ex, "mLow")));
  assert.equal(cp.contextSnapshot(ctx).integrity, 0);
  const q = sys.runtime.queryMemory(ex, ctx, {}, "send");
  const r = sys.runtime.executeAuthorizedAction(ex, ctx, q.viewId, { effect: "send", tool: "notify", parameters: { to: "ops" } });
  assert.deepEqual({ decision: r.decision, reason: r.reason }, { decision: "DENY", reason: "context_integrity_below_tool_minimum" });
  rt.close();
});

test("v21-7: adoption is bound to one record digest, not the whole source message", () => {
  const cp = new ControlPlane();
  const rt = new SecureMemoryRuntime({ controlPlane: cp });
  const p = cp.registerPrincipal("p", {});
  const w = cp.registerPrincipal("w", { queues: ["*"] });
  const ex = cp.registerPrincipal("ex", { queues: ["executor"] });
  rt.sendMessage(env({ message_id: "mA", sender: "p", receiver: "memory", sequence: 1 }), p);
  rt.writeMemory("A1", rt.claimSpecific(w, "mA"), { memory_id: "mem-A1", memory_type: "constraint", allowed_readers: ["executor"], logical_key: "K", effect_ceiling: ["send"] });
  rt.writeMemory("A2", rt.claimSpecific(w, "mA"), { memory_id: "mem-A2", memory_type: "constraint", allowed_readers: ["executor"], logical_key: "K", effect_ceiling: ["transfer"] });
  const a1 = rt.getMemoryRow("mem-A1");
  rt.sendMessage(env({ message_id: "mBare", sender: "p", receiver: "executor", sequence: 90,
    parents: [{ id: "mA", type: "adopt" }] }), cp.registerPrincipal("p", { resolution: true }));
  assert.deepEqual(rt.readMemory({}, rt.claimSpecific(ex, "mBare")).map((m) => m.memory_id), []);
  rt.sendMessage(env({ message_id: "mRecord", sender: "p", receiver: "executor", sequence: 91,
    parents: [{ id: "mA", type: "adopt", record_id: "mem-A1", record_digest: memoryContentHash(a1),
      logical_key: "K", write_seq: a1.write_seq }] }), cp.registerPrincipal("p", { resolution: true }));
  assert.deepEqual(rt.readMemory({}, rt.claimSpecific(ex, "mRecord")).map((m) => m.memory_id), ["mem-A1"]);
  rt.close();
});

test("v21-8: resolution certificates must cover the exact same-run conflict set", () => {
  const cp = new ControlPlane();
  const rt = new SecureMemoryRuntime({ controlPlane: cp });
  const p = cp.registerPrincipal("p", {});
  const w = cp.registerPrincipal("w", { queues: ["*"] });
  const owner = cp.registerPrincipal("owner", { resolution: true });
  rt.sendMessage(env({ message_id: "m0", sender: "p", receiver: "memory", sequence: 1 }), p);
  for (const id of ["A", "B", "C"]) {
    rt.writeMemory(id, rt.claimSpecific(w, "m0"),
      { memory_id: `mem-${id}`, memory_type: "constraint", allowed_readers: ["executor"], logical_key: "K" });
  }
  assert.throws(() => rt.resolveConflict(owner, { logical_key: "K", accepted: ["mem-A"], rejected: ["mem-B"] }),
    /resolution_conflict_set_mismatch/);
  const cert = rt.resolveConflict(owner, { logical_key: "K", accepted: ["mem-A"], rejected: ["mem-B", "mem-C"] });
  assert.deepEqual(cert.conflict_set, ["mem-A", "mem-B", "mem-C"]);
  assert.match(cert.conflict_set_digest, /^[0-9a-f]{64}$/);
  rt.close();
});
