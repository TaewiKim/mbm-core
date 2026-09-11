// Hardening: an authorized action must dispatch AT MOST ONCE per (view, canonical-action), even if the
// one-shot replay state is reset out from under the kernel. The prepared view is one-shot -- the state CAS
// (prepared_views.state pending->consumed) plus the read-token consume (read_tokens.consumed 0->1) normally
// make a second executeAuthorizedAction stop at view_already_consumed. But a store-write adversary (or a buggy
// retry / crash-recovery path) could RESET that replay state; without an idempotency check the SAME canonical
// action would re-consume and dispatch a SECOND time -- e.g. two identical wire_transfers (a duplicate EFFECT).
//
// The kernel keys each authorized action by idempotency_key = sha256(view_id:action_digest), backed by a UNIQUE
// index (schema.mjs), and SELECTs it inside the BEGIN IMMEDIATE txn BEFORE consuming/inserting. We drive the
// real kernel path (createSecureMemorySystem -> facade.executeAuthorizedAction): execute once (one real
// dispatch), then RESET prepared_views.state + read_tokens.consumed via the admin db and execute the SAME action
// again -- asserting the trusted dispatcher log does NOT grow (no duplicate effect) and the replay is reported
// as an idempotent dedup of the prior action rather than re-dispatched.
//
// Note: the duplicate-dispatch does not WIDEN authority (the viewRoot recompute already aborts on any changed
// world), so this is defense-in-depth / idempotency hardening, not an authority fix.
import test from "node:test";
import assert from "node:assert/strict";
import { createSecureMemorySystem, ControlPlane } from "./runtime.mjs";

const env = (o) => ({ run_id: "R", task_id: "T", trace_id: "tr", intent: "produce_final_plan", state: "running",
  policy_context: "P", correlation_id: null, delegated_from: null, parent_message_id: null, ...o });
const ctxOf = (rt, s, m) => rt.controlPlane.contextTokenForLease(rt.claimSpecific(s, m));

test("a reset of the one-shot replay state does NOT let the same action dispatch twice (idempotency)", () => {
  const cp = new ControlPlane();
  // Deployer destination policy authorizes the (tool, target); the kernel still gates everything else.
  const sys = createSecureMemorySystem({ controlPlane: cp, destinationPolicy: () => true });
  const rt = sys.admin, facade = sys.runtime;

  rt.sendMessage(env({ message_id: "m0", sender: "p", receiver: "memory", sequence: 1 }), cp.registerPrincipal("p", {}));
  const w = cp.registerPrincipal("w", { queues: ["*"] });
  const ex = cp.registerPrincipal("ex", { queues: ["executor"] });
  // (v20 creation-cut) write the memory BEFORE creating the reader message, then send the reader LAST with a
  // sequence after the write, so the record's write_seq <= the reader's signed creation sequence.
  rt.writeMemory("ok", rt.claimSpecific(w, "m0"),
    { memory_id: "mem-ok", memory_type: "constraint", allowed_readers: ["executor"], effect_ceiling: ["transfer"] });
  rt.sendMessage(env({ message_id: "mx", sender: "c", receiver: "executor", sequence: 90, parent_message_id: "m0" }), cp.registerPrincipal("c", {}));
  const ctx = ctxOf(rt, ex, "mx");

  // Prepare a view for a consequential external effect and execute it ONCE: exactly one real dispatch.
  const action = { effect: "transfer", tool: "wire_transfer", parameters: { to: "acct-9", amount: 1000 } };
  const viewId = facade.queryMemory(ex, ctx, {}, "transfer").viewId;
  const dispBefore = rt._dispatcher.log.length;
  const r1 = facade.executeAuthorizedAction(ex, ctx, viewId, action);
  assert.equal(r1.status, "dispatched", "the first execution dispatched through the kernel");
  assert.equal(rt._dispatcher.log.length, dispBefore + 1, "exactly one action dispatched");
  const outboxBefore = rt.db.prepare("SELECT COUNT(*) AS n FROM action_outbox").get().n;

  // ADVERSARY / buggy crash-recovery: reset the one-shot replay state so a naive kernel would re-authorize and
  // dispatch the SAME canonical action a second time.
  rt.db.prepare("UPDATE prepared_views SET state='pending' WHERE view_id=?").run(viewId);
  rt.db.exec("UPDATE read_tokens SET consumed=0");
  assert.equal(rt.db.prepare("SELECT state FROM prepared_views WHERE view_id=?").get(viewId).state, "pending",
    "precondition: the replay state really was reset to pending (else the second call stops at view_already_consumed)");

  // Replay the SAME canonical action. The idempotency key already has a row, so the kernel short-circuits
  // inside its write-locked txn BEFORE consuming/inserting -- no second dispatch.
  const r2 = facade.executeAuthorizedAction(ex, ctx, viewId, action);
  assert.equal(rt._dispatcher.log.length, dispBefore + 1, "NO duplicate dispatch: the dispatcher log did not grow");
  assert.equal(r2.deduplicated, true, "the replay was reported as a deduplicated idempotent action");
  assert.equal(r2.reason, "duplicate_action", "the replay carries the duplicate_action reason");
  assert.equal(r2.actionId, r1.actionId, "the replay returns the PRIOR action's id (idempotent), not a fresh one");
  assert.equal(rt.db.prepare("SELECT COUNT(*) AS n FROM action_outbox").get().n, outboxBefore,
    "no second outbox row was recorded for the same idempotency_key");
  rt.close();
});
