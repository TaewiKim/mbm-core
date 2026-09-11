// Regression: a deployer destinationPolicy (or any callback) that performs a lifecycle/resolution authority
// mutation INSIDE executeAuthorizedAction must not desync the TCB head. Before the fix, admin.revoke called
// from the policy advanced ControlPlane's in-memory #lifecycleHead AND inserted a memory_lifecycle_events row
// in the same BEGIN IMMEDIATE txn; the action then aborted (coherent_view_changed) and ROLLBACKed, undoing the
// row but NOT the in-memory head -> head.count outran the persisted count -> every subsequent secure read threw
// "lifecycle_log_tampered: count mismatch", a self-inflicted permanent DoS for that kernel instance. The fix
// forbids head-advancing authority mutations while _inExec is set (mirroring the executeAuthorizedAction
// reentrancy guard), so the head can never advance inside the txn and there is nothing to roll back.
import test from "node:test";
import assert from "node:assert/strict";
import { createSecureMemorySystem, ControlPlane } from "../benchmarks/coupled_memory/runtime.mjs";

const env = (o) => ({ run_id: "R", task_id: "T", trace_id: "tr", intent: "produce_final_plan", state: "running",
  policy_context: "P", correlation_id: null, delegated_from: null, parent_message_id: null, ...o });

// Build a secure system whose destinationPolicy runs `onPolicy(admin, lcSession)` once, then authorizes.
// swallow=true models a policy that catches the mutation error and authorizes anyway; swallow=false lets the
// throw propagate out of the policy (so executeAuthorizedAction catches it and aborts fail-closed).
function buildSendScenario(onPolicy, { swallow = true } = {}) {
  const cp = new ControlPlane();
  const lc = cp.registerPrincipal("lc", { lifecycle: true });
  let admin = null, fired = 0, policyError = null;
  const destinationPolicy = () => {
    if (fired++ === 0) {
      if (swallow) { try { onPolicy(admin, lc); } catch (e) { policyError = e; } }
      else onPolicy(admin, lc); // propagate: the throw aborts the action
    }
    return true;
  };
  const sys = createSecureMemorySystem({ controlPlane: cp, destinationPolicy });
  admin = sys.admin;
  const facade = sys.runtime;
  admin.sendMessage(env({ message_id: "m0", sender: "p", receiver: "memory", sequence: 1 }), cp.registerPrincipal("p", {}));
  const w = cp.registerPrincipal("w", { queues: ["*"] });
  const alice = cp.registerPrincipal("alice", { queues: ["alice"] });
  // grant + restrictive record, both sourced at the shared root m0 (in alice's mx causal closure); the writer
  // claims m0 so mx is free for alice. (v20 CREATION-CUT: write these BEFORE sending the reader message mx so
  // their write_seq stays below mx's signed sequence.)
  admin.writeMemory("alice may send; effect send", admin.claimSpecific(w, "m0"),
    { memory_id: "mem-grant", memory_type: "constraint", allowed_readers: ["alice"], effect_ceiling: ["send"] });
  admin.writeMemory("restrictive note", admin.claimSpecific(w, "m0"),
    { memory_id: "mem-restrict", memory_type: "constraint", allowed_readers: ["alice"], effect_ceiling: ["send"] });
  // Send the reader/active message mx LAST, with a sequence strictly greater than every preceding message and
  // every write above, so the v20 read gate admits both records.
  admin.sendMessage(env({ message_id: "mx", sender: "c", receiver: "alice", sequence: 90, parent_message_id: "m0" }), cp.registerPrincipal("c", {}));
  const ctx = cp.contextTokenForLease(admin.claimSpecific(alice, "mx"));
  return { cp, admin, facade, alice, ctx, lc, getPolicyError: () => policyError };
}

const lifecycleRowCount = (admin) => admin.db.prepare("SELECT COUNT(*) AS n FROM memory_lifecycle_events").get().n;
const drive = (s) => s.facade.executeAuthorizedAction(s.alice, s.ctx, s.facade.queryMemory(s.alice, s.ctx, {}, "send").viewId,
  { effect: "send", tool: "send_email", parameters: { to: "x@partner.com", body: "hi" } });

// ---- the documented case: policy revokes mid-authorization, swallows the error, authorizes anyway ----
test("a policy-side lifecycle mutation during authorization does not desync the TCB head (no self-DoS)", () => {
  const s = buildSendScenario((admin, lc) => admin.revoke(lc, "mem-restrict"));
  drive(s); // the action itself may dispatch or abort; what matters is what happens NEXT

  // The guard must have rejected the in-txn mutation (the policy captured the throw).
  assert.match(String(s.getPolicyError()?.message), /lifecycle_mutation_during_authorization/);
  // The head was never advanced, so it still matches the persisted event count (both 0 here).
  assert.equal(s.cp.lifecycleHead().count, lifecycleRowCount(s.admin));
  // The decisive anti-DoS invariant: subsequent secure reads still WORK (pre-fix they threw count mismatch).
  const admitted = s.facade.read(s.alice, s.ctx, {}).map((m) => m.memory_id);
  assert.deepEqual([...admitted].sort(), ["mem-grant", "mem-restrict"]);
  s.admin.close();
});

// ---- fail-closed even when the policy does NOT swallow the throw ----
test("an unswallowed policy-side mutation aborts the action fail-closed and still leaves reads working", () => {
  const s = buildSendScenario((admin, lc) => { admin.revoke(lc, "mem-restrict"); }, { swallow: false });
  const act = drive(s);
  // The throw propagates out of the policy and is caught inside executeAuthorizedAction -> DENY, not dispatched.
  assert.equal(act.status, undefined);
  assert.equal(act.decision, "DENY");
  // No desync, and the kernel remains usable.
  assert.equal(s.cp.lifecycleHead().count, lifecycleRowCount(s.admin));
  assert.doesNotThrow(() => s.facade.read(s.alice, s.ctx, {}));
  s.admin.close();
});

// ---- the same desync hazard exists for resolveConflict; the guard covers it too ----
test("a policy-side resolveConflict during authorization is forbidden and does not desync the resolution head", () => {
  const s = buildSendScenario((admin) => {
    const res = admin.controlPlane.registerPrincipal("res", { resolution: true });
    admin.resolveConflict(res, { logical_key: "k", accepted: ["mem-grant"], rejected: [] });
  });
  drive(s);
  assert.match(String(s.getPolicyError()?.message), /lifecycle_mutation_during_authorization/);
  assert.equal(s.cp.resolutionHead().count,
    s.admin.db.prepare("SELECT COUNT(*) AS n FROM merge_resolutions").get().n);
  assert.doesNotThrow(() => s.facade.read(s.alice, s.ctx, {}));
  s.admin.close();
});

// ---- unit guard: every head-advancing authority mutation is blocked while _inExec is set, head unchanged ----
test("the _inExec guard blocks all head-advancing authority mutations and leaves the heads untouched", () => {
  const cp = new ControlPlane();
  const { admin } = createSecureMemorySystem({ controlPlane: cp });
  const lc = cp.registerPrincipal("lc", { lifecycle: true });
  const res = cp.registerPrincipal("res", { resolution: true });
  const lh0 = cp.lifecycleHead().count, rh0 = cp.resolutionHead().count;
  admin._inExec = true; // simulate being inside executeAuthorizedAction
  try {
    for (const call of [
      () => admin.revoke(lc, "x"),
      () => admin.expire(lc, "x"),
      () => admin.supersede(lc, "x", "y"),
      () => admin.resolveConflict(res, { logical_key: "k", accepted: ["x"], rejected: [] }),
    ]) {
      assert.throws(call, /lifecycle_mutation_during_authorization/);
    }
  } finally { admin._inExec = false; }
  // No head moved (the guard runs before the control-plane append).
  assert.equal(cp.lifecycleHead().count, lh0);
  assert.equal(cp.resolutionHead().count, rh0);
  // Sanity: outside _inExec the same mutation still works and advances the head normally.
  admin.revoke(lc, "x");
  assert.equal(cp.lifecycleHead().count, lh0 + 1);
  admin.close();
});
