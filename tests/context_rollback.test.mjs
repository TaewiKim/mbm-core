// Regression (v20 CE20-03): an execution context's integrity taint must not be removable by a store-write
// adversary that rolls the (untrusted, main-DB) execution_contexts row back to a pre-taint but validly-signed
// snapshot across a key-stable restart. The row's own MAC proves it is an AUTHENTIC past state, not the FRESH
// one (authentic != fresh). The fix is a per-context monotonic version head in the TRUSTED kernel DB
// (kernel.context_anchor, which lives in a sibling file the memory-file adversary cannot write): at restart
// seedContexts cross-checks the row's (untrusted) version against the (trusted) head and loads a rolled-back
// context as 'aborted', so every context-bound op (send/write/attach) fails closed (context_not_active) and the
// pre-rollback taint cannot be laundered off downstream outputs. Like the lifecycle/membership anchors, the
// cross-restart guarantee rests on the head sitting in the protected kernel DB; a fully consistent adversary who
// also rewrites the kernel DB is out of scope.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHmac } from "node:crypto";
import { createSecureMemorySystem, ControlPlane } from "../benchmarks/coupled_memory/runtime.mjs";

const env = (o) => ({ run_id: "R", task_id: "T", trace_id: "tr", intent: "produce_final_plan", state: "running",
  policy_context: "P", correlation_id: null, delegated_from: null, parent_message_id: null, ...o });
const KEY = Buffer.alloc(32, 7); // stable attestation key across restart

test("v20 CE20-03: a context rolled back to a pre-taint version is aborted on restart (taint cannot be laundered)", () => {
  const dbPath = join(mkdtempSync(join(tmpdir(), "mbm-ctxrb-")), "mem.db");
  let execCtxId, savedRow, savedInputs;
  { // phase 1: open a clean context, taint it, then roll the durable row back to the clean snapshot
    const cp = new ControlPlane({ keyBytes: KEY });
    const sys = createSecureMemorySystem({ controlPlane: cp, dbPath, destinationPolicy: () => true });
    const rt = sys.admin, facade = sys.runtime;
    const pSess = cp.registerPrincipal("p", { queues: ["*"], clearance: "system" });
    const exSess = cp.registerPrincipal("ex", { queues: ["executor"], clearance: "system" });
    rt.sendMessage(env({ message_id: "m0", sender: "p", receiver: "memory", sequence: 1, integrity: "system" }), pSess);
    rt.sendMessage(env({ message_id: "mExec", sender: "p", receiver: "executor", sequence: 2, parent_message_id: "m0", integrity: "system" }), pSess);
    rt.sendMessage(env({ message_id: "mLow", sender: "p", receiver: "executor", sequence: 3, parent_message_id: "m0", integrity: "untrusted" }), pSess);
    const exCtx = cp.contextTokenForLease(rt.claimSpecific(exSess, "mExec"));
    const clean = cp.contextSnapshot(exCtx);
    execCtxId = clean.contextId;
    assert.equal(clean.integrity, 2, "clean context starts at system integrity");
    savedRow = { ...rt.db.prepare("SELECT * FROM execution_contexts WHERE context_id=?").get(execCtxId) };
    savedInputs = rt.db.prepare("SELECT * FROM execution_inputs WHERE context_id=?").all(execCtxId).map((r) => ({ ...r }));
    // taint: attach a low-integrity input -> integrity drops, version bumps, MAC + kernel anchor advance
    facade.attachInput(exSess, exCtx, cp.contextTokenForLease(rt.claimSpecific(exSess, "mLow")));
    assert.equal(cp.contextSnapshot(exCtx).integrity, 0, "context is tainted (untrusted) after attach");
    // store-write adversary restores the pre-taint clean row + input manifest (authentic, lower version)
    rt.db.prepare(`UPDATE execution_contexts SET integrity=@integrity, state=@state, version=@version,
      current_event_id=@current_event_id, context_mac=@context_mac WHERE context_id=@context_id`).run({
        integrity: savedRow.integrity, state: savedRow.state, version: savedRow.version,
        current_event_id: savedRow.current_event_id, context_mac: savedRow.context_mac, context_id: execCtxId });
    rt.db.prepare("DELETE FROM execution_inputs WHERE context_id=?").run(execCtxId);
    for (const ir of savedInputs) rt.db.prepare(`INSERT INTO execution_inputs (context_id, message_id, lease_id, claim_generation, envelope_digest, input_integrity, observed_at)
      VALUES (@context_id,@message_id,@lease_id,@claim_generation,@envelope_digest,@input_integrity,@observed_at)`).run(ir);
    rt.close();
  }
  { // phase 2: key-stable restart -- the rolled-back context must be aborted, not a usable clean execution
    const cp = new ControlPlane({ keyBytes: KEY });
    const sys = createSecureMemorySystem({ controlPlane: cp, dbPath, destinationPolicy: () => true });
    const rt = sys.admin, facade = sys.runtime;
    const exSess = cp.registerPrincipal("ex", { queues: ["executor"], clearance: "system" });
    const ctxToken = `ctx-${execCtxId}-${createHmac("sha256", KEY).update(`ctxtok.${execCtxId}.ex`).digest("hex")}`;
    const snap = cp.contextSnapshot(ctxToken);
    // The authentic-but-stale row is rejected: even though its MAC verifies for (version=1, integrity=2), the
    // trusted kernel head records version=2, so the context is loaded aborted.
    assert.equal(snap.state, "aborted", "rolled-back context is loaded aborted (anti-rollback head caught the stale version)");
    // operative property: an aborted context can produce NO output -> the taint cannot be laundered off a send.
    assert.throws(() => facade.send(exSess, ctxToken, { receiver: "memory", intent: "note", payload: { x: 1 }, state: "ready" }),
      /context_not_active/, "a context-bound send from the rolled-back context fails closed");
    rt.close();
  }
});
