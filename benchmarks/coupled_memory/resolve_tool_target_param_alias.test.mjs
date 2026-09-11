// Regression: resolveTool must extract the destination from the SAME merged source canonicalAction
// dispatches/audits, i.e. `parameters ?? params`. canonicalAction (runtime.mjs) accepts the `params`
// alias, so a caller that supplies the recipient under `params` (instead of `parameters`) still gets a
// real recipient canonicalized, dispatched, and hashed into the audit digest. Before the fix resolveTool
// read ONLY `frozenAction.parameters`, so tool.target was null while a live recipient was dispatched. The
// DEPLOYER WARNING in runtime.mjs tells destination policies to key on the resolved tool NAME and target,
// so a null tool.target sitting beside a dispatched recipient is a footgun: a target-keyed policy that
// permits a null target as a harmless no-op would authorize a send whose real recipient it never vetted.
//
// We drive the real kernel path (createSecureMemorySystem -> facade.executeAuthorizedAction) and capture
// the `tool` object the kernel hands the destination policy, then assert tool.target equals the
// params-supplied recipient AND the recipient that is actually dispatched/audited.
import test from "node:test";
import assert from "node:assert/strict";
import { createSecureMemorySystem, ControlPlane } from "./runtime.mjs";

const env = (o) => ({ run_id: "R", task_id: "T", trace_id: "tr", intent: "produce_final_plan", state: "running",
  policy_context: "P", correlation_id: null, delegated_from: null, parent_message_id: null, ...o });
const ctxOf = (rt, s, m) => rt.controlPlane.contextTokenForLease(rt.claimSpecific(s, m));

test("resolveTool surfaces a `params`-aliased recipient as tool.target (== the dispatched/audited target)", () => {
  const seenByPolicy = [];
  const cp = new ControlPlane();
  // The deployer destination policy is exactly the object the DEPLOYER WARNING addresses: it receives the
  // resolved tool (name/effect/externality/target) plus the full canonical action. Capture both, authorize.
  const sys = createSecureMemorySystem({
    controlPlane: cp,
    destinationPolicy: (tool, _ctx, canonical) => { seenByPolicy.push({ tool, canonical }); return true; },
  });
  const rt = sys.admin, facade = sys.runtime;
  rt.sendMessage(env({ message_id: "m0", sender: "p", receiver: "memory", sequence: 1 }), cp.registerPrincipal("p", {}));
  const w = cp.registerPrincipal("w", { queues: ["*"] });
  const ex = cp.registerPrincipal("ex", { queues: ["executor"] });
  // (v20 creation-cut) write before creating the reader message; send the reader LAST after the write.
  rt.writeMemory("ok", rt.claimSpecific(w, "m0"), { memory_id: "mem-ok", memory_type: "constraint", allowed_readers: ["executor"], effect_ceiling: ["send"] });
  rt.sendMessage(env({ message_id: "mx", sender: "c", receiver: "executor", sequence: 90, parent_message_id: "m0" }), cp.registerPrincipal("c", {}));
  const ctx = ctxOf(rt, ex, "mx");

  // The caller supplies the recipient under the `params` ALIAS, NOT `parameters`. send_email is a registry
  // tool whose destination parameter is "to"; canonicalAction reads `parameters ?? params`, so the recipient
  // that is dispatched and hashed into the audit digest is attacker@evil.com.
  const dispBefore = rt._dispatcher.log.length;
  const viewId = facade.queryMemory(ex, ctx, {}, "send").viewId;
  const r = facade.executeAuthorizedAction(ex, ctx, viewId, { effect: "send", tool: "send_email", params: { to: "attacker@evil.com" } });

  assert.equal(seenByPolicy.length, 1, "the destination policy ran exactly once");
  const { tool, canonical } = seenByPolicy[0];

  // What the kernel actually dispatches/audits: the params-supplied recipient.
  assert.equal(canonical.parameters.to, "attacker@evil.com", "canonicalAction dispatches/audits the params recipient");

  // The regression assertion: the convenience field the kernel hands the policy MUST reflect that same
  // recipient. Before the fix tool.target was null (resolveTool read only `parameters`).
  assert.equal(tool.target, "attacker@evil.com",
    "resolveTool must surface the params-supplied recipient as tool.target (was null before the fix)");

  // End-to-end sanity: the action did dispatch, and what hit the trusted dispatcher matches the policy's view.
  assert.equal(r.status, "dispatched", "the send dispatched through the kernel");
  const entry = rt._dispatcher.log[rt._dispatcher.log.length - 1];
  assert.equal(rt._dispatcher.log.length, dispBefore + 1, "exactly one action dispatched");
  assert.equal(entry.canonical.parameters.to, "attacker@evil.com", "dispatcher received the params recipient");
  rt.close();
});

// Sanity counterpart: the canonical `parameters` spelling is unaffected -- tool.target still resolves, so
// the merged-source read is purely additive (it does not change the `parameters` path's behavior).
test("resolveTool still surfaces tool.target for the canonical `parameters` spelling", () => {
  const seenByPolicy = [];
  const cp = new ControlPlane();
  const sys = createSecureMemorySystem({
    controlPlane: cp,
    destinationPolicy: (tool) => { seenByPolicy.push(tool); return true; },
  });
  const rt = sys.admin, facade = sys.runtime;
  rt.sendMessage(env({ message_id: "m0", sender: "p", receiver: "memory", sequence: 1 }), cp.registerPrincipal("p", {}));
  const w = cp.registerPrincipal("w", { queues: ["*"] });
  const ex = cp.registerPrincipal("ex", { queues: ["executor"] });
  // (v20 creation-cut) write before creating the reader message; send the reader LAST after the write.
  rt.writeMemory("ok", rt.claimSpecific(w, "m0"), { memory_id: "mem-ok", memory_type: "constraint", allowed_readers: ["executor"], effect_ceiling: ["send"] });
  rt.sendMessage(env({ message_id: "mx", sender: "c", receiver: "executor", sequence: 90, parent_message_id: "m0" }), cp.registerPrincipal("c", {}));
  const ctx = ctxOf(rt, ex, "mx");
  const viewId = facade.queryMemory(ex, ctx, {}, "send").viewId;
  facade.executeAuthorizedAction(ex, ctx, viewId, { effect: "send", tool: "send_email", parameters: { to: "ops@example.com" } });
  assert.equal(seenByPolicy.length, 1, "the destination policy ran exactly once");
  assert.equal(seenByPolicy[0].target, "ops@example.com", "the `parameters` recipient still resolves to tool.target");
  rt.close();
});
