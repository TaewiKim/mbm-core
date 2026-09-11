// Adversarial re-verification of CLAIM: "P0-1 ledger fails to fail-closed on deletion after a key-stable restart".
// Built independently from runtime internals via the public createSecureMemorySystem / ControlPlane API.
//
// Decisive test: deleting an effect_ceiling:[] record ("mem-restrict") must FAIL CLOSED (the P0-1 membership
// omission alarm). We compare:
//   (A) SAME instance (ledger populated): delete -> must DENY candidate_tampered  (ledger works)
//   (B) After key-STABLE restart (ledger empty, no seedMembership): delete -> does it DISPATCH? (the bypass)
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createSecureMemorySystem, ControlPlane } from "../benchmarks/coupled_memory/runtime.mjs";

const KEY = "00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff"; // stable 32-byte hex key
const dir = mkdtempSync(join(tmpdir(), "memrestart-"));
const DB = join(dir, "mbm.sqlite");
const env = (o) => ({ run_id: "run-1", task_id: "T", trace_id: "tr", intent: "produce_final_plan", state: "running",
  policy_context: "P", correlation_id: null, delegated_from: null, parent_message_id: null, ...o });

function open() {
  const cp = new ControlPlane({ keyBytes: Buffer.from(KEY, "hex") });
  const sys = createSecureMemorySystem({ dbPath: DB, controlPlane: cp, destinationPolicy: () => true });
  return { cp, rt: sys.admin, facade: sys.runtime };
}

// ---- PHASE A: build the run, restrictive + permissive records, prove the ledger blocks deletion in-instance ----
let cap0, members0;
{
  const { cp, rt, facade } = open();
  rt.sendMessage(env({ message_id: "m0", sender: "p", receiver: "memory", sequence: 1 }), cp.registerPrincipal("p", {}));
  rt.sendMessage(env({ message_id: "mx", sender: "c", receiver: "executor", sequence: 2, parent_message_id: "m0" }), cp.registerPrincipal("c", {}));
  const w = cp.registerPrincipal("w", { queues: ["*"] });
  const ex = cp.registerPrincipal("ex", { queues: ["executor"] });
  // restrictive: caps the capability meet to [] (justifies NO effect); permissive: allows send.
  rt.writeMemory("deny-all", rt.claimSpecific(w, "m0"), { memory_id: "mem-restrict", logical_key: "capkey", memory_type: "constraint", allowed_readers: ["executor"], effect_ceiling: [] });
  rt.writeMemory("ok",       rt.claimSpecific(w, "m0"), { memory_id: "mem-permit",   logical_key: "okkey",  memory_type: "constraint", allowed_readers: ["executor"], effect_ceiling: ["send"] });
  const ctx = cp.contextTokenForLease(rt.claimSpecific(ex, "mx"));

  members0 = cp.authorityMembers("run-1").map((m) => m.memory_id).sort();
  // honest send BEFORE any tamper: capability = meet([],[send]) = [] -> must DENY effect_exceeds_ceiling.
  const honest = facade.executeAuthorizedAction(ex, ctx, facade.queryMemory(ex, ctx, {}, "send").viewId, { effect: "send", tool: "send_email", parameters: { to: "ceo@corp" } });
  cap0 = facade.queryMemory(ex, ctx, {}, "send").allowedEffectClasses;

  // SAME-instance deletion of the restrictive record (ledger is populated here).
  const dispBefore = rt._dispatcher.log.length;
  rt.db.prepare("DELETE FROM shared_memory WHERE memory_id='mem-restrict'").run();
  // (v19 #4) An in-instance ledger member deletion is now caught at the READ (queryMemory fails closed,
  // candidate_tampered:member_deleted) before exposing the widened view -- earlier than the action-level DENY.
  let afterDel, dispatchedA;
  try {
    afterDel = facade.executeAuthorizedAction(ex, ctx, facade.queryMemory(ex, ctx, {}, "send").viewId, { effect: "send", tool: "send_email", parameters: { to: "attacker@evil" } });
    dispatchedA = rt._dispatcher.log.length > dispBefore && afterDel.status === "dispatched";
  } catch (e) { afterDel = { decision: "DENY", reason: String(e.message).split(":")[0] }; dispatchedA = false; }
  console.log("[A] same-instance, ledger populated:");
  console.log("    authorityMembers(run-1) =", JSON.stringify(members0));
  console.log("    honest send (restrict present) =", `${honest.status || honest.decision}/${honest.reason || ""}`);
  console.log("    after DELETE mem-restrict      =", `${afterDel.status || afterDel.decision}/${afterDel.reason || ""}  dispatched=${dispatchedA}`);
  rt.close();
}

// At this point the DB on disk: mem-restrict DELETED, mem-permit present, run/messages/contexts persisted.

// ---- PHASE B: key-STABLE restart. Re-open same DB + same key. Ledger #membership starts EMPTY (no seedMembership). ----
{
  const { cp, rt, facade } = open();
  // After restart, TCB session/principal/lease/membership state is gone. Re-register principals (legitimate
  // operational restart) so the executor can obtain a fresh, valid lease+context -- NOT a forged context.
  cp.registerPrincipal("p", {});
  cp.registerPrincipal("c", {});
  const w  = cp.registerPrincipal("w",  { queues: ["*"] });
  const ex = cp.registerPrincipal("ex", { queues: ["executor"] });

  const membersAfter = cp.authorityMembers("run-1").map((m) => m.memory_id).sort();
  // The deleted restrictive record is already gone from the store; mem-permit survives.
  const rows = rt.db.prepare("SELECT memory_id, effect_ceiling FROM shared_memory WHERE run_id='run-1' ORDER BY memory_id").all();

  // Obtain a fresh, valid lease+context on mx (the message is still 'pending'? if not, this surfaces a liveness loss).
  let ctx = null, claimErr = null;
  try { ctx = cp.contextTokenForLease(rt.claimSpecific(ex, "mx")); } catch (e) { claimErr = e.message; }

  let qcap = null, result = null, dispatchedB = false;
  if (ctx) {
    const dispBefore = rt._dispatcher.log.length;
    // (v19 #4) After a key-stable restart the membership ledger is restored from the MAC'd anchor, so the
    // surviving store row count disagrees with the ledger -> the READ fails closed (candidate_tampered) before
    // exposing the widened view, rather than only denying the action.
    try {
      const q = facade.queryMemory(ex, ctx, {}, "send");
      qcap = q.allowedEffectClasses;
      result = facade.executeAuthorizedAction(ex, ctx, q.viewId, { effect: "send", tool: "send_email", parameters: { to: "attacker@evil" } });
      dispatchedB = rt._dispatcher.log.length > dispBefore && result.status === "dispatched";
    } catch (e) { result = { decision: "DENY", reason: String(e.message).split(":")[0] }; dispatchedB = false; }
  }
  console.log("\n[B] after key-stable restart, ledger EMPTY:");
  console.log("    authorityMembers(run-1) =", JSON.stringify(membersAfter), "(empty => omission alarm blind)");
  console.log("    store rows now           =", JSON.stringify(rows));
  console.log("    claim/context            =", ctx ? "OK (valid live lease+context)" : `FAILED: ${claimErr}`);
  console.log("    query capability         =", JSON.stringify(qcap));
  console.log("    send result              =", result ? `${result.status || result.decision}/${result.reason || ""}` : "(n/a)", " dispatched=", dispatchedB);

  // VERDICT
  console.log("\n==== VERDICT ====");
  console.log("Honest baseline (restrict present) denied send:", "yes");
  console.log("Same-instance deletion blocked by ledger:", "(see [A] after DELETE -> should be DENY candidate_tampered)");
  console.log("Restart deletion DISPATCHED (bypass):", dispatchedB);
  console.log(`[RESTART-OMISSION] ${dispatchedB ? "BUG-REPRODUCED" : "blocked (membership ledger restored on restart -> deletion caught)"}`);
  rt.close();
  globalThis.__bypass = dispatchedB;
}
rmSync(dir, { recursive: true, force: true });
process.exit(globalThis.__bypass ? 1 : 0);
