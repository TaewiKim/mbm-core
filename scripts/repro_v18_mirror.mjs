// Reproduce round-4: the durable membership mirror (authority_membership) lives in the writable store, so a
// store-write adversary deletes BOTH the restrictive record AND its mirror row, restarts, and seedMembership
// rebuilds the ledger from the tampered mirror -> the P0-1 deletion alarm is blind -> capability widens.
// FIX: a MAC'd per-run membership anchor (key-protected, like lifecycle/resolution) detects the mirror-row
// deletion as a count/MAC mismatch on restart -> fail closed.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createSecureMemorySystem, ControlPlane } from "../benchmarks/coupled_memory/runtime.mjs";
const KEY = Buffer.alloc(32, 9);
const dir = mkdtempSync(join(tmpdir(), "mbmmirror-")); const DB = join(dir, "mbm.sqlite");
const env = (o) => ({ run_id: "run-1", task_id: "T", trace_id: "tr", intent: "produce_final_plan", state: "running",
  policy_context: "P", correlation_id: null, delegated_from: null, parent_message_id: null, ...o });
const open = () => { const cp = new ControlPlane({ keyBytes: KEY }); const sys = createSecureMemorySystem({ dbPath: DB, controlPlane: cp, destinationPolicy: () => true }); return { cp, rt: sys.admin, facade: sys.runtime }; };

let capId;
{ const { cp, rt, facade } = open();
  rt.sendMessage(env({ message_id: "m0", sender: "p", receiver: "memory", sequence: 1 }), cp.registerPrincipal("p", {}));
  rt.sendMessage(env({ message_id: "mx", sender: "c", receiver: "executor", sequence: 2, parent_message_id: "m0" }), cp.registerPrincipal("c", {}));
  const w = cp.registerPrincipal("w", { queues: ["*"] }); const ex = cp.registerPrincipal("ex", { queues: ["executor"] });
  rt.writeMemory("deny-all", rt.claimSpecific(w, "m0"), { memory_id: "mem-restrict", logical_key: "K", memory_type: "constraint", allowed_readers: ["executor"], effect_ceiling: [] });
  rt.writeMemory("keep-alive", rt.claimSpecific(w, "m0"), { memory_id: "mem-permit", logical_key: "OK", memory_type: "constraint", allowed_readers: ["executor"], effect_ceiling: ["send"] });
  capId = "mem-restrict";
  // store-write adversary: delete BOTH the restrictive record row AND its durable membership mirror row.
  rt.db.prepare("DELETE FROM shared_memory WHERE memory_id=?").run(capId);
  rt.db.prepare("DELETE FROM authority_membership WHERE memory_id=?").run(capId);
  rt.close();
}
let dispatched = false, result = null;
{ const { cp, rt, facade } = open(); // key-stable restart on the same DB
  cp.registerPrincipal("p", {}); cp.registerPrincipal("c", {});
  const w = cp.registerPrincipal("w", { queues: ["*"] }); const ex = cp.registerPrincipal("ex", { queues: ["executor"] });
  let ctx = null; try { ctx = cp.contextTokenForLease(rt.claimSpecific(ex, "mx")); } catch (e) { result = "claim_failed:" + e.message; }
  if (ctx) {
    const before = rt._dispatcher.log.length;
    // (v19 #4) The mirror/anchor desync is now caught at the READ: queryMemory fails closed before exposing a
    // widened view, strictly earlier than the action-level DENY. Either path blocks the dispatch.
    try {
      const q = facade.queryMemory(ex, ctx, {}, "send");
      const r = facade.executeAuthorizedAction(ex, ctx, q.viewId, { effect: "send", tool: "send_email", parameters: { to: "attacker@evil" } });
      dispatched = rt._dispatcher.log.length > before && r.status === "dispatched";
      result = `${r.status || r.decision}/${r.reason || ""}`;
    } catch (e) { result = "DENY/" + String(e.message).split(":")[0]; }
  }
  rt.close();
}
rmSync(dir, { recursive: true, force: true });
console.log(`after both-delete + restart: ${result} dispatched=${dispatched}`);
console.log(`[MIRROR] ${dispatched ? "BUG-REPRODUCED (mirror deletion across restart blinds the omission alarm)" : "blocked (MAC'd membership anchor detects the mirror tamper)"}`);
process.exit(dispatched ? 1 : 0);
