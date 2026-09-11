// Reproduce the v18 review's three P0 counterexamples against the CURRENT kernel, BEFORE fixing.
// Each should presently DEMONSTRATE the bug (print BUG-REPRODUCED). After the fix, re-run: each must be BLOCKED.
import { createSecureMemorySystem, ControlPlane } from "../benchmarks/coupled_memory/runtime.mjs";

const env = (o) => ({ run_id: "R", task_id: "T", trace_id: "tr", intent: "produce_final_plan", state: "running",
  policy_context: "P", correlation_id: null, delegated_from: null, parent_message_id: null, ...o });
const ctxOf = (rt, s, m) => rt.controlPlane.contextTokenForLease(rt.claimSpecific(s, m));
const R = [];
const rec = (id, reproduced, detail) => { R.push({ id, reproduced, detail }); console.log(`  [${id}] ${reproduced ? "BUG-REPRODUCED" : "blocked"}  --  ${detail}`); };

// ---------- P0-1: receipt stripping -> authority WIDENING (authenticated omission) ----------
(() => {
  const cp = new ControlPlane();
  const sys = createSecureMemorySystem({ controlPlane: cp, destinationPolicy: () => true });
  const rt = sys.admin, facade = sys.runtime;
  rt.sendMessage(env({ message_id: "m0", sender: "p", receiver: "memory", sequence: 1 }), cp.registerPrincipal("p", {}));
  rt.sendMessage(env({ message_id: "mx", sender: "c", receiver: "executor", sequence: 2, parent_message_id: "m0" }), cp.registerPrincipal("c", {}));
  const w = cp.registerPrincipal("w", { queues: ["*"] }); const ex = cp.registerPrincipal("ex", { queues: ["executor"] });
  // restrictive record caps the capability meet to [] (permits NO effect); permissive record allows send.
  rt.writeMemory("deny-all", rt.claimSpecific(w, "m0"), { memory_id: "mem-cap", logical_key: "capkey", memory_type: "constraint", allowed_readers: ["executor"], effect_ceiling: [] });
  rt.writeMemory("ok", rt.claimSpecific(w, "m0"), { memory_id: "mem-ok", logical_key: "okkey", memory_type: "constraint", allowed_readers: ["executor"], effect_ceiling: ["send"] });
  const ctx = ctxOf(rt, ex, "mx");
  // BEFORE tamper: capability = meet([],[send]) = [] -> notify denied.
  const before = facade.executeAuthorizedAction(ex, ctx, facade.queryMemory(ex, ctx, {}, "send").viewId, { effect: "send", tool: "notify", parameters: { to: "x" } });
  // ATTACK: strip the restrictive record's receipt (store-write adversary).
  rt.db.prepare("UPDATE shared_memory SET write_receipt=NULL WHERE memory_id='mem-cap'").run();
  const dispBefore = rt._dispatcher.log.length;
  // (v19 #4) Stripping an authority-bearing record's receipt is now caught at the READ: queryMemory fails closed
  // (candidate_tampered:receipt_stripped) before any view is exposed, strictly earlier than the prior
  // action-level DENY. Capture that throw as the block it represents.
  let after;
  try { after = facade.executeAuthorizedAction(ex, ctx, facade.queryMemory(ex, ctx, {}, "send").viewId, { effect: "send", tool: "notify", parameters: { to: "attacker" } }); }
  catch (e) { after = { decision: "DENY", reason: String(e.message).split(":")[0] }; }
  const dispatched = rt._dispatcher.log.length > dispBefore && after.status === "dispatched";
  rec("P0-1", dispatched, `before=${before.decision}/${before.reason}; after receipt-strip=${after.status || after.decision}/${after.reason || ""} dispatched=${dispatched}`);
  rt.close();
})();

// ---------- P0-2: TOCTOU -- a restrictive record made live between view recompute and consume ----------
(() => {
  const cp = new ControlPlane();
  let S = null, fired = false, kernelRefused = null;
  // Attacker-influenced destination policy runs AFTER _computeView, BEFORE the consume txn. Two adversary vectors:
  //  (1) the kernel WRITE API is REFUSED inside the auth txn (v19 #1 _assertNotInExec): it can neither smuggle a
  //      late authority record into the window nor desync the membership head;
  //  (2) a raw STORE-WRITE adversary directly inserts a live restrictive record -- the consume-time recompute must
  //      catch it. A directly-inserted authority record cannot carry a valid receipt, so the recompute fails
  //      closed (candidate_tampered) rather than dispatching on the stale (pre-insert) view snapshot.
  const COLS = "memory_id,run_id,task_id,trace_id,source_message_id,writer,memory_type,scope,status,content,content_ref,allowed_readers_json,supersedes_json,valid_from_event,valid_until_event,policy_context,integrity,logical_key,effect_ceiling,audit_hash,write_receipt,created_at,updated_at";
  const destinationPolicy = () => {
    if (!fired && S) { fired = true;
      try { S.rt.writeMemory("deny-all", S.rt.claimSpecific(S.w, "m0"), { memory_id: "mem-late-api", logical_key: "latekey", memory_type: "constraint", allowed_readers: ["executor"], effect_ceiling: [] }); }
      catch (e) { kernelRefused = e.message; }
      const ts = new Date().toISOString();
      S.rt.db.prepare(`INSERT INTO shared_memory (${COLS}) VALUES (${COLS.split(",").map((c) => "@" + c).join(",")})`).run({
        memory_id: "mem-late", run_id: "R", task_id: "T", trace_id: "tr", source_message_id: "m0", writer: "w",
        memory_type: "constraint", scope: "task", status: "active", content: "deny-all", content_ref: null,
        allowed_readers_json: JSON.stringify(["executor"]), supersedes_json: "[]", valid_from_event: null,
        valid_until_event: null, policy_context: "P", integrity: "system", logical_key: "latekey",
        effect_ceiling: JSON.stringify([]), audit_hash: "deadbeef", write_receipt: null, created_at: ts, updated_at: ts });
    }
    return true;
  };
  const sys = createSecureMemorySystem({ controlPlane: cp, destinationPolicy });
  const rt = sys.admin, facade = sys.runtime;
  rt.sendMessage(env({ message_id: "m0", sender: "p", receiver: "memory", sequence: 1 }), cp.registerPrincipal("p", {}));
  rt.sendMessage(env({ message_id: "mx", sender: "c", receiver: "executor", sequence: 2, parent_message_id: "m0" }), cp.registerPrincipal("c", {}));
  const w = cp.registerPrincipal("w", { queues: ["*"] }); const ex = cp.registerPrincipal("ex", { queues: ["executor"] });
  rt.writeMemory("ok", rt.claimSpecific(w, "m0"), { memory_id: "mem-ok", logical_key: "okkey", memory_type: "constraint", allowed_readers: ["executor"], effect_ceiling: ["send"] });
  const ctx = ctxOf(rt, ex, "mx");
  S = { rt, w };
  const dispBefore = rt._dispatcher.log.length;
  let r; try { r = facade.executeAuthorizedAction(ex, ctx, facade.queryMemory(ex, ctx, {}, "send").viewId, { effect: "send", tool: "notify", parameters: { to: "attacker" } }); }
  catch (e) { r = { decision: "DENY", reason: String(e.message).split(":")[0] }; }
  // The restrictive record made live in the window must NOT be bypassed; a dispatch despite it is the TOCTOU bug.
  const dispatched = rt._dispatcher.log.length > dispBefore && r.status === "dispatched";
  rec("P0-2", dispatched && fired, `kernelWriteRefused=${kernelRefused ? kernelRefused.split(":")[0] : "NO"} rawInserted=${!!rt.getMemoryRow("mem-late")} result=${r.status || r.decision}/${r.reason || ""} dispatched=${dispatched}`);
  rt.close();
})();

// ---------- P0-3: canonical digest != effective dispatched action (prototype pollution) ----------
(() => {
  const cp = new ControlPlane();
  const sys = createSecureMemorySystem({ controlPlane: cp, destinationPolicy: () => true });
  const rt = sys.admin, facade = sys.runtime;
  rt.sendMessage(env({ message_id: "m0", sender: "p", receiver: "memory", sequence: 1 }), cp.registerPrincipal("p", {}));
  rt.sendMessage(env({ message_id: "mx", sender: "c", receiver: "executor", sequence: 2, parent_message_id: "m0" }), cp.registerPrincipal("c", {}));
  const w = cp.registerPrincipal("w", { queues: ["*"] }); const ex = cp.registerPrincipal("ex", { queues: ["executor"] });
  rt.writeMemory("ok", rt.claimSpecific(w, "m0"), { memory_id: "mem-ok", memory_type: "constraint", allowed_readers: ["executor"] });
  const ctx = ctxOf(rt, ex, "mx");
  // parameters carry an OWN "__proto__" data property (survives JSON round-trip) whose .body is inherited after canonicalize.
  const params = JSON.parse('{"to":"approved","__proto__":{"body":"SECRET-EXFIL-NOT-IN-DIGEST"}}');
  const dispBefore = rt._dispatcher.log.length;
  const r = facade.executeAuthorizedAction(ex, ctx, facade.queryMemory(ex, ctx, {}, "send").viewId, { effect: "send", tool: "notify", parameters: params });
  const entry = rt._dispatcher.log[rt._dispatcher.log.length - 1];
  const dispatchedBody = entry && entry.canonical && entry.canonical.parameters ? entry.canonical.parameters.body : undefined;
  // the hashed json (audit) -- does it contain the body? recompute what was logged.
  const loggedJson = JSON.stringify(entry ? entry.canonical : {});
  const bodyInDigest = loggedJson.includes("SECRET-EXFIL");
  const mismatch = rt._dispatcher.log.length > dispBefore && dispatchedBody === "SECRET-EXFIL-NOT-IN-DIGEST" && !bodyInDigest;
  rec("P0-3", mismatch, `dispatcher.body=${JSON.stringify(dispatchedBody)} bodyInDigestJSON=${bodyInDigest} (mismatch H(logged)!=H(dispatched)=${mismatch})`);
  rt.close();
})();

// ---------- P9: unknown tool fails closed EVEN with a permissive deployment policy ----------
(() => {
  const cp = new ControlPlane();
  const sys = createSecureMemorySystem({ controlPlane: cp, destinationPolicy: () => true }); // permissive
  const rt = sys.admin, facade = sys.runtime;
  rt.sendMessage(env({ message_id: "m0", sender: "p", receiver: "memory", sequence: 1 }), cp.registerPrincipal("p", {}));
  rt.sendMessage(env({ message_id: "mx", sender: "c", receiver: "executor", sequence: 2, parent_message_id: "m0" }), cp.registerPrincipal("c", {}));
  const w = cp.registerPrincipal("w", { queues: ["*"] }); const ex = cp.registerPrincipal("ex", { queues: ["executor"] });
  rt.writeMemory("ok", rt.claimSpecific(w, "m0"), { memory_id: "mem-ok", memory_type: "constraint", allowed_readers: ["executor"] });
  const ctx = ctxOf(rt, ex, "mx");
  const dispBefore = rt._dispatcher.log.length;
  const r = facade.executeAuthorizedAction(ex, ctx, facade.queryMemory(ex, ctx, {}, "send").viewId, { effect: "send", tool: "exfiltrate_http", parameters: { to: "evil" } });
  const dispatched = rt._dispatcher.log.length > dispBefore && r.status === "dispatched";
  rec("P9", dispatched, `unknown tool under permissive policy -> ${r.decision || r.status}/${r.reason || ""} dispatched=${dispatched}`);
  rt.close();
})();

// ---------- P6: an async (Promise) dispatch is NOT recorded as success ----------
(() => {
  const cp = new ControlPlane();
  let rejecter;
  const dispatcher = { log: [], dispatch() { return new Promise((_res, rej) => { rejecter = rej; }); } }; // never resolves synchronously
  const sys = createSecureMemorySystem({ controlPlane: cp, destinationPolicy: () => true, dispatcher });
  const rt = sys.admin, facade = sys.runtime;
  rt.sendMessage(env({ message_id: "m0", sender: "p", receiver: "memory", sequence: 1 }), cp.registerPrincipal("p", {}));
  rt.sendMessage(env({ message_id: "mx", sender: "c", receiver: "executor", sequence: 2, parent_message_id: "m0" }), cp.registerPrincipal("c", {}));
  const w = cp.registerPrincipal("w", { queues: ["*"] }); const ex = cp.registerPrincipal("ex", { queues: ["executor"] });
  rt.writeMemory("ok", rt.claimSpecific(w, "m0"), { memory_id: "mem-ok", memory_type: "constraint", allowed_readers: ["executor"] });
  const ctx = ctxOf(rt, ex, "mx");
  const r = facade.executeAuthorizedAction(ex, ctx, facade.queryMemory(ex, ctx, {}, "send").viewId, { effect: "send", tool: "notify", parameters: { to: "x" } });
  // BUG would be: status === "dispatched" while the promise is still pending. Correct: "pending_dispatch".
  const falselyDispatched = r.status === "dispatched";
  rec("P6", falselyDispatched, `async dispatch result status=${r.status} (must be pending_dispatch, not dispatched)`);
  rt.close();
})();

const reproduced = R.filter((r) => r.reproduced).map((r) => r.id);
console.log(`\n${reproduced.length}/${R.length} v18 counterexamples reproduced: [${reproduced.join(", ")}]`);
if (reproduced.length > 0) { console.error("FAIL: v18 counterexample(s) still reproduce"); process.exit(1); }
console.log("PASS: all v18 P0/major counterexamples are blocked.");
process.exit(0);
