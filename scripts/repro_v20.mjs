// Reproduce the v20 review's six counterexamples against the CURRENT (fixed) kernel. Each must be BLOCKED.
// Pre-fix CE20-00..03 DEMONSTRATED the bug; CE20-04/05 were already blocked by v19. Retained as regressions
// (npm run regress:v18 chains repro_v19 -> this). The v20 thesis: the causal object is the WRITE EVENT (its
// monotonic position + full input frontier), NOT the re-usable source-message label.
//   CE20-00 late-write     -- a record written AFTER the reader claimed (re-using an old ancestor's id as its
//                             source) is NOT in the reader's causal past: write_seq must be <= the reader's
//                             claim cut, else write_after_active (post-hoc insertion is not laundered in).
//   CE20-01 hidden-input   -- a record binds its FULL input frontier (every attachContextInput); a reader who
//                             cannot reach a consumed input in its closure is denied (input_not_in_causal_graph).
//   CE20-02 adopt-future   -- adoption is RECORD-scoped: a record is adopted only if it existed when the adopt
//                             edge was created (write_seq <= adopt seq); a post-adopt record never inherits it.
//   CE20-03 ctx-rollback   -- a per-context monotonic version head in the kernel DB makes a restart reject a
//                             context row rolled back to a pre-taint version (authentic but stale -> aborted).
//   CE20-04 tamper-race    -- a PURE read fails closed on tracked store tamper, so the model is never exposed
//                             to a truncated view (v19 #4; the single-threaded read is snapshot-atomic).
//   CE20-05 resolution-set -- a certificate that does not cover EVERY current maximal member of the key cannot
//                             serve a winner: an uncovered co-visible record denies the whole key.
import { createSecureMemorySystem, ControlPlane } from "../benchmarks/coupled_memory/runtime.mjs";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHmac } from "node:crypto";

const env = (o) => ({ run_id: "R", task_id: "T", trace_id: "tr", intent: "produce_final_plan", state: "running",
  policy_context: "P", correlation_id: null, delegated_from: null, parent_message_id: null, ...o });
const R = [];
const rec = (id, reproduced, detail) => { R.push({ id, reproduced }); console.log(`  [${id}] ${reproduced ? "BUG-REPRODUCED" : "blocked"}  --  ${detail}`); };
const served = (facade, s, ctx) => { try { return facade.read(s, ctx, {}).map((m) => m.memory_id).sort(); } catch (e) { return `throw:${String(e.message).split(":")[0]}`; }; };
const dispatchedSend = (facade, s, ctx) => {
  try { const q = facade.queryMemory(s, ctx, {}, "send");
    const r = facade.executeAuthorizedAction(s, ctx, q.viewId, { effect: "send", tool: "notify", parameters: { to: "attacker@evil" } });
    return r && r.status === "dispatched"; } catch { return false; }
};

// ---------- CE20-00: late write laundered into causal history ----------
(() => {
  const cp = new ControlPlane();
  const sys = createSecureMemorySystem({ controlPlane: cp, destinationPolicy: () => true });
  const rt = sys.admin, facade = sys.runtime;
  rt.sendMessage(env({ message_id: "m0", sender: "p", receiver: "memory", sequence: 1 }), cp.registerPrincipal("p", {}));
  rt.sendMessage(env({ message_id: "mV", sender: "c", receiver: "executor", sequence: 2, parent_message_id: "m0" }), cp.registerPrincipal("c", {}));
  const w = cp.registerPrincipal("w", { queues: ["*"] }); const ex = cp.registerPrincipal("ex", { queues: ["executor"] });
  // The victim CLAIMS mV and reads FIRST (its causal "as-of" cut is fixed here, BEFORE the late write).
  const ctx = cp.contextTokenForLease(rt.claimSpecific(ex, "mV"));
  const before = served(facade, ex, ctx);
  // NOW the attacker re-claims the OLD ancestor m0 and writes a permissive record labelled source=m0.
  rt.writeMemory("late malicious", rt.claimSpecific(w, "m0"),
    { memory_id: "mem-late", logical_key: "K", memory_type: "constraint", allowed_readers: ["executor"], effect_ceiling: ["send"] });
  const after = served(facade, ex, ctx);
  const dispatched = dispatchedSend(facade, ex, ctx);
  const reproduced = (Array.isArray(after) && after.includes("mem-late")) || dispatched;
  rec("CE20-00-late-write", reproduced, `served before=${JSON.stringify(before)} after=${JSON.stringify(after)}; post-hoc send dispatched=${dispatched}`);
  rt.close();
})();

// ---------- CE20-01: hidden attached input missing from provenance ----------
(() => {
  const cp = new ControlPlane();
  const sys = createSecureMemorySystem({ controlPlane: cp, destinationPolicy: () => true });
  const rt = sys.admin, facade = sys.runtime;
  const p = cp.registerPrincipal("p", {}); const w = cp.registerPrincipal("w", { queues: ["*"] }); const ex = cp.registerPrincipal("ex", { queues: ["executor"] });
  rt.sendMessage(env({ message_id: "m0", sender: "p", receiver: "memory", sequence: 1 }), p);
  rt.sendMessage(env({ message_id: "mA", sender: "p", receiver: "memory", sequence: 2, parent_message_id: "m0" }), p);
  rt.sendMessage(env({ message_id: "mB", sender: "p", receiver: "memory", sequence: 3, parent_message_id: "m0" }), p); // OFF the reader's branch
  rt.sendMessage(env({ message_id: "mV", sender: "p", receiver: "memory", sequence: 4, parent_message_id: "mA" }), p);
  rt.sendMessage(env({ message_id: "mM", sender: "p", receiver: "executor", sequence: 5,
    parents: [{ id: "mA", type: "depends" }, { id: "mV", type: "depends" }] }), p); // closure={m0,mA,mV}; NOT mB
  // Writer's context: primary input mA, ALSO attach mB (a hidden cross-branch dependency).
  const cA = rt.contextFor(rt.claimSpecific(w, "mA"));
  const cB = rt.contextFor(rt.claimSpecific(w, "mB"));
  facade.attachInput(w, cA, cB);
  facade.write(w, cA, "PLAN=combine(mA,mB)", { memory_id: "mem-hidden", logical_key: "K", memory_type: "constraint", allowed_readers: ["executor"], effect_ceiling: ["send"] });
  const ctxReader = cp.contextTokenForLease(rt.claimSpecific(ex, "mM"));
  const closure = rt.causalAncestry(rt.getMessage("mM"));
  const out = served(facade, ex, ctxReader);
  const reproduced = Array.isArray(out) && out.includes("mem-hidden");
  rec("CE20-01-hidden-input", reproduced, `closure.has(mB)=${closure.has("mB")}; reader served=${JSON.stringify(out)} (mem-hidden depended on mB, outside closure)`);
  rt.close();
})();

// ---------- CE20-02: message-level adoption inherits a future record ----------
(() => {
  const cp = new ControlPlane();
  const sys = createSecureMemorySystem({ controlPlane: cp, destinationPolicy: () => true });
  const rt = sys.admin, facade = sys.runtime;
  rt.sendMessage(env({ message_id: "mA", sender: "p", receiver: "memory", sequence: 1 }), cp.registerPrincipal("p", {}));
  rt.sendMessage(env({ message_id: "mB", sender: "p2", receiver: "memory", sequence: 2 }), cp.registerPrincipal("p2", {}));
  const w = cp.registerPrincipal("w", { queues: ["*"] }); const ex = cp.registerPrincipal("ex", { queues: ["executor"] });
  // A deny-all record A exists FIRST and is adopted by the merge (it existed at adopt time).
  rt.writeMemory("deny-all", rt.claimSpecific(w, "mA"), { memory_id: "A", logical_key: "K", memory_type: "constraint", allowed_readers: ["executor"], effect_ceiling: [] });
  // The merge ADOPTS branch B (authorized resolver) -- at this point B has NO record yet.
  rt.sendMessage(env({ message_id: "mExec", sender: "c", receiver: "executor", sequence: 5,
    parents: [{ id: "mA", type: "adopt" }, { id: "mB", type: "adopt" }] }), cp.registerPrincipal("c", { resolution: true }));
  // AFTER the adopt edge, a permissive record is written sourced at the adopted message mB.
  rt.writeMemory("allow-send (post-adopt)", rt.claimSpecific(w, "mB"),
    { memory_id: "B-future", logical_key: "K", memory_type: "constraint", allowed_readers: ["executor"], effect_ceiling: ["send"] });
  const ctx = cp.contextTokenForLease(rt.claimSpecific(ex, "mExec"));
  const out = served(facade, ex, ctx);
  const dispatched = dispatchedSend(facade, ex, ctx);
  // The post-adopt B-future must NOT be served as adopted-authoritative, and must NOT enable a send.
  const reproduced = (Array.isArray(out) && out.includes("B-future")) || dispatched;
  rec("CE20-02-adopt-future", reproduced, `served=${JSON.stringify(out)}; post-adopt send dispatched=${dispatched}`);
  rt.close();
})();

// ---------- CE20-03: context snapshot rollback removes integrity taint ----------
(() => {
  const KEY = Buffer.alloc(32, 7);
  const dbPath = join(mkdtempSync(join(tmpdir(), "v20ce03-")), "mem.db");
  let execCtxId, savedRow, savedInputs;
  { // phase 1: taint, then roll the durable row back to the clean snapshot
    const cp = new ControlPlane({ keyBytes: KEY });
    const sys = createSecureMemorySystem({ controlPlane: cp, dbPath, destinationPolicy: () => true });
    const rt = sys.admin, facade = sys.runtime;
    const pSess = cp.registerPrincipal("p", { queues: ["*"], clearance: "system" });
    const exSess = cp.registerPrincipal("ex", { queues: ["executor"], clearance: "system" });
    rt.sendMessage(env({ message_id: "m0", sender: "p", receiver: "memory", sequence: 1, integrity: "system" }), pSess);
    rt.sendMessage(env({ message_id: "mExec", sender: "p", receiver: "executor", sequence: 2, parent_message_id: "m0", integrity: "system" }), pSess);
    rt.sendMessage(env({ message_id: "mLow", sender: "p", receiver: "executor", sequence: 3, parent_message_id: "m0", integrity: "untrusted" }), pSess);
    const exCtx = cp.contextTokenForLease(rt.claimSpecific(exSess, "mExec"));
    execCtxId = cp.contextSnapshot(exCtx).contextId;
    savedRow = { ...rt.db.prepare("SELECT * FROM execution_contexts WHERE context_id=?").get(execCtxId) };
    savedInputs = rt.db.prepare("SELECT * FROM execution_inputs WHERE context_id=?").all(execCtxId).map((r) => ({ ...r }));
    facade.attachInput(exSess, exCtx, cp.contextTokenForLease(rt.claimSpecific(exSess, "mLow"))); // taint -> integrity 0, version 2
    // store-write adversary restores the pre-taint (clean, validly-signed) row + manifest
    rt.db.prepare(`UPDATE execution_contexts SET integrity=@integrity, state=@state, version=@version,
      current_event_id=@current_event_id, context_mac=@context_mac WHERE context_id=@context_id`).run({
        integrity: savedRow.integrity, state: savedRow.state, version: savedRow.version,
        current_event_id: savedRow.current_event_id, context_mac: savedRow.context_mac, context_id: execCtxId });
    rt.db.prepare("DELETE FROM execution_inputs WHERE context_id=?").run(execCtxId);
    for (const ir of savedInputs) rt.db.prepare(`INSERT INTO execution_inputs (context_id, message_id, lease_id, claim_generation, envelope_digest, input_integrity, observed_at)
      VALUES (@context_id,@message_id,@lease_id,@claim_generation,@envelope_digest,@input_integrity,@observed_at)`).run(ir);
    rt.close();
  }
  let snap;
  { // phase 2: key-stable restart -> the rolled-back context must NOT come back as an ACTIVE clean execution
    const cp = new ControlPlane({ keyBytes: KEY });
    const sys = createSecureMemorySystem({ controlPlane: cp, dbPath, destinationPolicy: () => true });
    const rt = sys.admin;
    cp.registerPrincipal("ex", { queues: ["executor"], clearance: "system" });
    const ctxToken = `ctx-${execCtxId}-${createHmac("sha256", KEY).update(`ctxtok.${execCtxId}.ex`).digest("hex")}`;
    try { snap = cp.contextSnapshot(ctxToken); } catch (e) { snap = { error: e.message }; }
    rt.close();
  }
  // Reproduced iff the authentic pre-taint snapshot is restored as an ACTIVE clean (integrity=2, inputs=1) context.
  const reproduced = !!snap && !snap.error && snap.state === "active" && snap.integrity === 2 && snap.inputs === 1;
  rec("CE20-03-ctx-rollback", reproduced, `post-restart context state=${snap?.state} integrity=${snap?.integrity} inputs=${snap?.inputs} (rolled-back row must be aborted)`);
})();

// ---------- CE20-04: tamper-check / model-exposure race (pure read fails closed) ----------
(() => {
  const cp = new ControlPlane();
  const sys = createSecureMemorySystem({ controlPlane: cp, destinationPolicy: () => true });
  const rt = sys.admin, facade = sys.runtime;
  rt.sendMessage(env({ message_id: "m0", sender: "p", receiver: "memory", sequence: 1 }), cp.registerPrincipal("p", {}));
  rt.sendMessage(env({ message_id: "mx", sender: "c", receiver: "executor", sequence: 2, parent_message_id: "m0" }), cp.registerPrincipal("c", {}));
  const w = cp.registerPrincipal("w", { queues: ["*"] }); const ex = cp.registerPrincipal("ex", { queues: ["executor"] });
  rt.writeMemory("restrictive", rt.claimSpecific(w, "m0"), { memory_id: "mem-restrict", logical_key: "K", memory_type: "constraint", allowed_readers: ["executor"], effect_ceiling: [] });
  rt.writeMemory("benign", rt.claimSpecific(w, "m0"), { memory_id: "mem-ok", logical_key: "K2", memory_type: "constraint", allowed_readers: ["executor"], effect_ceiling: ["send"] });
  // Store-write adversary DELETES the restrictive record's row after it is on the ledger (omission).
  rt.db.prepare("DELETE FROM shared_memory WHERE memory_id=?").run("mem-restrict");
  const ctx = cp.contextTokenForLease(rt.claimSpecific(ex, "mx"));
  const out = served(facade, ex, ctx);
  // A pure read must FAIL CLOSED (throw candidate_tampered), never expose mem-ok from a tampered view.
  const reproduced = Array.isArray(out); // any non-throw exposure of records is the bug
  rec("CE20-04-tamper-race", reproduced, `pure read result=${JSON.stringify(out)} (must fail closed, not expose a truncated view)`);
  rt.close();
})();

// ---------- CE20-05: resolution not bound to the exact current conflict set ----------
(() => {
  const cp = new ControlPlane();
  const sys = createSecureMemorySystem({ controlPlane: cp, destinationPolicy: () => true });
  const rt = sys.admin, facade = sys.runtime;
  const p = cp.registerPrincipal("p", {});
  rt.sendMessage(env({ message_id: "m0", sender: "p", receiver: "memory", sequence: 1 }), p);
  rt.sendMessage(env({ message_id: "mA", sender: "p", receiver: "memory", sequence: 2, parent_message_id: "m0" }), p);
  rt.sendMessage(env({ message_id: "mB", sender: "p", receiver: "memory", sequence: 3, parent_message_id: "m0" }), p);
  rt.sendMessage(env({ message_id: "mC", sender: "p", receiver: "memory", sequence: 4, parent_message_id: "m0" }), p);
  rt.sendMessage(env({ message_id: "mExec", sender: "p", receiver: "executor", sequence: 5,
    parents: [{ id: "mA", type: "depends" }, { id: "mB", type: "depends" }, { id: "mC", type: "depends" }] }), p);
  const w = cp.registerPrincipal("w", { queues: ["*"] }); const ex = cp.registerPrincipal("ex", { queues: ["executor"] });
  const resolver = cp.registerPrincipal("res", { queues: ["*"], resolution: true });
  rt.writeMemory("A", rt.claimSpecific(w, "mA"), { memory_id: "A", logical_key: "K", memory_type: "constraint", allowed_readers: ["executor"], effect_ceiling: ["send"] });
  rt.writeMemory("B", rt.claimSpecific(w, "mB"), { memory_id: "B", logical_key: "K", memory_type: "constraint", allowed_readers: ["executor"], effect_ceiling: ["send"] });
  rt.writeMemory("C", rt.claimSpecific(w, "mC"), { memory_id: "C", logical_key: "K", memory_type: "constraint", allowed_readers: ["executor"], effect_ceiling: [] });
  let issue = "issued";
  try {
    rt.resolveConflict(resolver, { logical_key: "K", accepted: ["A"], rejected: ["B"] }); // subset cert: omits C
  } catch (e) {
    issue = String(e.message || e);
  }
  let out = null, dispatched = false;
  if (issue === "issued") {
    const ctx = cp.contextTokenForLease(rt.claimSpecific(ex, "mExec"));
    out = served(facade, ex, ctx);
    dispatched = dispatchedSend(facade, ex, ctx);
  }
  // v22 blocks this earlier: a partial certificate that omits C is refused at issuance. If a subset cert were
  // ever issued again, A must still not be served authoritative and no send may dispatch.
  const reproduced = issue === "issued" && ((Array.isArray(out) && out.includes("A")) || dispatched);
  rec("CE20-05-resolution-subset", reproduced, `issue=${issue}; served=${JSON.stringify(out)}; subset-cert send dispatched=${dispatched}`);
  rt.close();
})();

// ========================= Red-team round-11 & round-12 findings (regressions) =========================

// ---------- CE20-06 (r12): the write-event clock must be anti-rollback (kernel.run_clock), not the untrusted main counter ----------
(() => {
  const cp = new ControlPlane();
  const sys = createSecureMemorySystem({ controlPlane: cp, destinationPolicy: () => true });
  const rt = sys.admin, facade = sys.runtime;
  const pSess = cp.registerPrincipal("p", { queues: ["*"], clearance: "system" });
  const w = cp.registerPrincipal("w", { queues: ["*"], clearance: "system" }); const ex = cp.registerPrincipal("ex", { queues: ["executor"], clearance: "system" });
  rt.sendMessage(env({ message_id: "m0", sender: "p", receiver: "memory", sequence: 1, integrity: "system" }), pSess);
  // a FIXED, trusted, attacker-uncontrolled victim message with signed sequence 500
  rt.sendMessage(env({ message_id: "mV", sender: "p", receiver: "executor", sequence: 500, parent_message_id: "m0", integrity: "system" }), pSess);
  const ctx = cp.contextTokenForLease(rt.claimSpecific(ex, "mV"));
  const before = served(facade, ex, ctx);
  // store-write adversary rolls the UNTRUSTED main counter back below the victim's cut
  rt.db.prepare("UPDATE runs SET next_sequence = 5 WHERE run_id = 'R'").run();
  // same-trust (system) writer writes a post-hoc record sourced at ancestor m0 with a send ceiling
  rt.writeMemory("post-hoc via rolled-back clock", rt.claimSpecific(w, "m0"),
    { memory_id: "mem-posthoc", logical_key: "K", memory_type: "constraint", allowed_readers: ["executor"], effect_ceiling: ["send"] });
  const after = served(facade, ex, ctx);
  const dispatched = dispatchedSend(facade, ex, ctx);
  const reproduced = (Array.isArray(after) && after.includes("mem-posthoc")) || dispatched;
  rec("CE20-06-clock-rollback", reproduced, `before=${JSON.stringify(before)} after=${JSON.stringify(after)}; post-hoc dispatched=${dispatched} (kernel clock dominates the rolled-back main counter)`);
  rt.close();
})();

// ---------- CE20-07 (r12): input frontier must be folded TRANSITIVELY across chained context merges ----------
(() => {
  const cp = new ControlPlane();
  const sys = createSecureMemorySystem({ controlPlane: cp, destinationPolicy: () => true });
  const rt = sys.admin, facade = sys.runtime;
  const p = cp.registerPrincipal("p", { queues: ["*"], clearance: "system" });
  const w = cp.registerPrincipal("w", { queues: ["*"], clearance: "system" }); const ex = cp.registerPrincipal("ex", { queues: ["executor"], clearance: "system" });
  rt.sendMessage(env({ message_id: "m0", sender: "p", receiver: "memory", sequence: 1, integrity: "system" }), p);
  rt.sendMessage(env({ message_id: "mX", sender: "p", receiver: "memory", sequence: 2, parent_message_id: "m0", integrity: "untrusted" }), p); // OFF-branch, untrusted
  rt.sendMessage(env({ message_id: "mA", sender: "p", receiver: "memory", sequence: 3, parent_message_id: "m0", integrity: "system" }), p);
  rt.sendMessage(env({ message_id: "mB", sender: "p", receiver: "memory", sequence: 4, parent_message_id: "m0", integrity: "system" }), p);
  // chain: cB consumes mX (untrusted); cA attaches cB -> must fold mX transitively into cA's frontier + integrity
  const cX = rt.contextFor(rt.claimSpecific(w, "mX"));
  const cB = rt.contextFor(rt.claimSpecific(w, "mB"));
  facade.attachInput(w, cB, cX);
  const cA = rt.contextFor(rt.claimSpecific(w, "mA"));
  facade.attachInput(w, cA, cB);
  facade.write(w, cA, "PLAN=combine(mA,mB,mX-hidden)", { memory_id: "mem-chain", logical_key: "K", memory_type: "constraint", allowed_readers: ["executor"], effect_ceiling: ["send"] });
  // reader on a branch that reaches mA,mB but NOT mX
  rt.sendMessage(env({ message_id: "mM", sender: "p", receiver: "executor", sequence: 90, integrity: "system",
    parents: [{ id: "mA", type: "depends" }, { id: "mB", type: "depends" }] }), p);
  const ctxReader = cp.contextTokenForLease(rt.claimSpecific(ex, "mM"));
  const closure = rt.causalAncestry(rt.getMessage("mM"));
  const out = served(facade, ex, ctxReader);
  const reproduced = Array.isArray(out) && out.includes("mem-chain");
  rec("CE20-07-input-frontier-transitive", reproduced, `closure.has(mX)=${closure.has("mX")}; served=${JSON.stringify(out)} (mem-chain transitively depended on untrusted off-branch mX)`);
  rt.close();
})();

// ---------- CE20-08 (r12): an OFF-BRANCH cert winner must not WIDEN a reader's capability meet ----------
(() => {
  const cp = new ControlPlane();
  const sys = createSecureMemorySystem({ controlPlane: cp, destinationPolicy: () => true });
  const rt = sys.admin, facade = sys.runtime;
  const p = cp.registerPrincipal("p", {});
  rt.sendMessage(env({ message_id: "m0", sender: "p", receiver: "memory", sequence: 1 }), p);
  rt.sendMessage(env({ message_id: "mA", sender: "p", receiver: "memory", sequence: 2, parent_message_id: "m0" }), p); // A's source (off the reader's branch)
  rt.sendMessage(env({ message_id: "mB", sender: "p", receiver: "memory", sequence: 3, parent_message_id: "m0" }), p); // reader's branch
  const w = cp.registerPrincipal("w", { queues: ["*"] }); const ex = cp.registerPrincipal("ex", { queues: ["executor"] });
  const resolver = cp.registerPrincipal("res", { queues: ["*"], resolution: true });
  rt.writeMemory("A permissive", rt.claimSpecific(w, "mA"), { memory_id: "A", logical_key: "K", memory_type: "constraint", allowed_readers: ["executor"], effect_ceiling: ["send"] });
  rt.writeMemory("B restrictive", rt.claimSpecific(w, "mB"), { memory_id: "B", logical_key: "K", memory_type: "constraint", allowed_readers: ["executor"], effect_ceiling: [] });
  rt.resolveConflict(resolver, { logical_key: "K", accepted: ["A"], rejected: ["B"] }); // cert accepts A (off the reader's branch)
  // reader descends from mB only -> cannot causally reach A's source mA
  rt.sendMessage(env({ message_id: "mExec", sender: "p", receiver: "executor", sequence: 90, parent_message_id: "mB" }), p);
  const ctx = cp.contextTokenForLease(rt.claimSpecific(ex, "mExec"));
  const dispatched = dispatchedSend(facade, ex, ctx);
  let cap = null; try { cap = facade.queryMemory(ex, ctx, {}, "send").allowedEffectClasses; } catch { cap = "throw"; }
  // A's [send] ceiling must NOT widen the off-branch reader's meet; no send may dispatch.
  const reproduced = dispatched || (Array.isArray(cap) && cap.includes("send"));
  rec("CE20-08-offbranch-cert-winner", reproduced, `capability=${JSON.stringify(cap)}; off-branch-winner send dispatched=${dispatched}`);
  rt.close();
})();

// ---------- CE20-09 (r11): a delegation cert must NOT waive the input-frontier reachability check ----------
(() => {
  const cp = new ControlPlane();
  const sys = createSecureMemorySystem({ controlPlane: cp, destinationPolicy: () => true });
  const rt = sys.admin, facade = sys.runtime;
  const p = cp.registerPrincipal("p", { queues: ["*"] }); const w = cp.registerPrincipal("w", { queues: ["*"] });
  const ex = cp.registerPrincipal("ex", { queues: ["executor"] }); const del = cp.registerPrincipal("del", { queues: ["*"], delegation: true });
  rt.sendMessage(env({ task_id: "TW", message_id: "m0", sender: "p", receiver: "memory", sequence: 1 }), p);
  rt.sendMessage(env({ task_id: "TW", message_id: "wSrc", sender: "p", receiver: "memory", sequence: 2, parent_message_id: "m0" }), p);
  rt.sendMessage(env({ task_id: "TW", message_id: "wHidden", sender: "p", receiver: "memory", sequence: 3, parent_message_id: "m0" }), p); // off-branch input
  const cSrc = rt.contextFor(rt.claimSpecific(w, "wSrc"));
  const cHid = rt.contextFor(rt.claimSpecific(w, "wHidden"));
  facade.attachInput(w, cSrc, cHid);
  facade.write(w, cSrc, "P depends on wHidden", { memory_id: "P", memory_type: "constraint", allowed_readers: ["executor"], effect_ceiling: ["send"] });
  rt.sendMessage(env({ task_id: "TR", message_id: "rExec", sender: "p", receiver: "executor", sequence: 90, parent_message_id: "wSrc" }), p); // reader off wHidden
  rt.delegate(del, { memory_ids: ["P"], target_task: "TR", target_receiver: "executor" }); // cross-task READ grant for P
  const ctx = cp.contextTokenForLease(rt.claimSpecific(ex, "rExec"));
  const out = served(facade, ex, ctx);
  // delegation grants cross-task read of P, but must NOT waive that P's hidden input wHidden is unreachable.
  const reproduced = Array.isArray(out) && out.includes("P");
  rec("CE20-09-delegation-input-waiver", reproduced, `served=${JSON.stringify(out)} (delegated P still has unreachable input wHidden)`);
  rt.close();
})();

// ---------- CE20-10 (r11): a non-numeric envelope sequence is rejected (cannot poison adoption / edge ordering) ----------
(() => {
  const cp = new ControlPlane();
  const sys = createSecureMemorySystem({ controlPlane: cp, destinationPolicy: () => true });
  const rt = sys.admin;
  let rejected = false;
  try { rt.sendMessage(env({ message_id: "mZ", sender: "p", receiver: "memory", sequence: "zzz" }), cp.registerPrincipal("p", {})); }
  catch { rejected = true; }
  // a non-numeric sequence must be refused at the source (so Number(seq)=NaN cannot map an adopt bound to Infinity).
  const reproduced = !rejected;
  rec("CE20-10-nonnumeric-sequence", reproduced, `non-numeric sequence rejected=${rejected}`);
  rt.close();
})();

// ---------- CE20-11 (r13): a POST-HOC cert winner (written after the reader) must not widen the meet ----------
(() => {
  const cp = new ControlPlane();
  const sys = createSecureMemorySystem({ controlPlane: cp, destinationPolicy: () => true });
  const rt = sys.admin, facade = sys.runtime;
  const p = cp.registerPrincipal("p", {}); const w = cp.registerPrincipal("w", { queues: ["*"] });
  const ex = cp.registerPrincipal("ex", { queues: ["executor"] }); const resolver = cp.registerPrincipal("res", { queues: ["*"], resolution: true });
  rt.sendMessage(env({ message_id: "m0", sender: "p", receiver: "memory", sequence: 1 }), p);
  rt.sendMessage(env({ message_id: "mShared", sender: "p", receiver: "memory", sequence: 2, parent_message_id: "m0" }), p);
  rt.writeMemory("B restrictive", rt.claimSpecific(w, "mShared"), { memory_id: "B", logical_key: "K", memory_type: "constraint", allowed_readers: ["executor"], effect_ceiling: [] });
  // reader's active message created NOW (B is in its past); A will be written AFTER -> post-hoc.
  rt.sendMessage(env({ message_id: "mExec", sender: "p", receiver: "executor", sequence: 50, parent_message_id: "mShared" }), p);
  rt.writeMemory("A permissive (post-hoc)", rt.claimSpecific(w, "mShared"), { memory_id: "A", logical_key: "K", memory_type: "constraint", allowed_readers: ["executor"], effect_ceiling: ["send"] });
  rt.resolveConflict(resolver, { logical_key: "K", accepted: ["A"], rejected: ["B"] }); // cert accepts the post-hoc winner A
  const ctx = cp.contextTokenForLease(rt.claimSpecific(ex, "mExec"));
  const dispatched = dispatchedSend(facade, ex, ctx);
  let cap = null; try { cap = facade.queryMemory(ex, ctx, {}, "send").allowedEffectClasses; } catch { cap = "throw"; }
  // A's write happened-AFTER mExec was created, so A is not admissible to this reader and its [send] ceiling must not widen the meet.
  const reproduced = dispatched || (Array.isArray(cap) && cap.includes("send"));
  rec("CE20-11-posthoc-cert-winner", reproduced, `capability=${JSON.stringify(cap)}; post-hoc-winner send dispatched=${dispatched}`);
  rt.close();
})();

// ---------- CE20-12 (r13): a context already attached as an input is FROZEN (attach-then-mutate cannot launder) ----------
(() => {
  const cp = new ControlPlane();
  const sys = createSecureMemorySystem({ controlPlane: cp, destinationPolicy: () => true });
  const rt = sys.admin, facade = sys.runtime;
  const p = cp.registerPrincipal("p", { queues: ["*"], clearance: "system" }); const w = cp.registerPrincipal("w", { queues: ["*"], clearance: "system" });
  rt.sendMessage(env({ message_id: "m0", sender: "p", receiver: "memory", sequence: 1, integrity: "system" }), p);
  rt.sendMessage(env({ message_id: "mA", sender: "p", receiver: "memory", sequence: 2, parent_message_id: "m0", integrity: "system" }), p);
  rt.sendMessage(env({ message_id: "mB", sender: "p", receiver: "memory", sequence: 3, parent_message_id: "m0", integrity: "system" }), p);
  rt.sendMessage(env({ message_id: "mD", sender: "p", receiver: "memory", sequence: 4, parent_message_id: "m0", integrity: "untrusted" }), p);
  const cA = rt.contextFor(rt.claimSpecific(w, "mA"));
  const cB = rt.contextFor(rt.claimSpecific(w, "mB"));
  const cD = rt.contextFor(rt.claimSpecific(w, "mD"));
  facade.attachInput(w, cA, cB); // attach cB (clean) to cA -> cB is now frozen
  // the attack: mutate cB AFTER it was attached (attach untrusted cD to cB) -> must be refused.
  let frozen = false;
  try { facade.attachInput(w, cB, cD); } catch (e) { frozen = /context_frozen_after_attach/.test(String(e.message)); }
  const reproduced = !frozen; // BUG if cB could be mutated after being attached (stale snapshot in cA)
  rec("CE20-12-attach-then-mutate-freeze", reproduced, `attach-after-attach refused=${frozen}`);
  rt.close();
})();

const bugs = R.filter((r) => r.reproduced).map((r) => r.id);
console.log(`\n${bugs.length}/${R.length} v20 counterexamples reproduced: ${JSON.stringify(bugs)}`);
if (bugs.length) { console.log("FAIL: v20 counterexample(s) still reproduce"); process.exit(1); }
console.log("PASS: all v20 counterexamples are blocked.");
