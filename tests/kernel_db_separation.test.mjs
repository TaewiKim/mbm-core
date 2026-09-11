// (v19 P1) Trusted/untrusted store separation is now ENFORCED, not merely assumed. The reviewer noted that the
// one-shot, omission, and anti-rollback guarantees rest on the kernel-state DB being integrity-protected and
// inaccessible to the memory-store adversary, but the single-DB prototype did not enforce that split. These tests
// demonstrate that with a two-file deployment the consumption/anchor state lives in a separate `kernel` DB that a
// store-write adversary holding ONLY the untrusted memory DB file cannot read, delete, or roll back.
import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createSecureMemorySystem, ControlPlane } from "../benchmarks/coupled_memory/runtime.mjs";

const KEY = Buffer.alloc(32, 13);
const env = (o) => ({ run_id: "R", task_id: "T", trace_id: "tr", intent: "produce_final_plan", state: "running",
  policy_context: "P", correlation_id: null, delegated_from: null, parent_message_id: null, ...o });
const KERNEL = ["read_tokens", "security_versions", "resolution_anchor", "lifecycle_anchor", "membership_anchor", "audit_anchor", "prepared_views", "action_outbox"];

test("kernel-state tables are absent from the untrusted memory DB and present in the protected kernel DB", () => {
  const dir = mkdtempSync(join(tmpdir(), "mbm-split-"));
  const memFile = join(dir, "memory.db"); const kernFile = join(dir, "kernel.db");
  const cp = new ControlPlane({ keyBytes: KEY });
  const sys = createSecureMemorySystem({ dbPath: memFile, kernelDbPath: kernFile, controlPlane: cp, destinationPolicy: () => true });
  const rt = sys.admin, facade = sys.runtime;
  rt.sendMessage(env({ message_id: "m0", sender: "p", receiver: "memory", sequence: 1 }), cp.registerPrincipal("p", {}));
  const cPrin = cp.registerPrincipal("c", {});
  const w = cp.registerPrincipal("w", { queues: ["*"] }); const ex = cp.registerPrincipal("ex", { queues: ["executor"] });
  rt.writeMemory("ok", rt.claimSpecific(w, "m0"), { memory_id: "mem-ok", logical_key: "K", memory_type: "constraint", allowed_readers: ["executor"], effect_ceiling: ["send"] });
  rt.sendMessage(env({ message_id: "mx", sender: "c", receiver: "executor", sequence: 90, parent_message_id: "m0" }), cPrin);
  const ctx = cp.contextTokenForLease(rt.claimSpecific(ex, "mx"));
  facade.executeAuthorizedAction(ex, ctx, facade.queryMemory(ex, ctx, {}, "send").viewId, { effect: "send", tool: "notify", parameters: { to: "ops@corp" } }); // populates kernel tables
  rt.close();

  // The store-write adversary opens a connection on ONLY the untrusted memory file.
  const adv = new DatabaseSync(memFile);
  const advTables = new Set(adv.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map((r) => r.name));
  for (const t of KERNEL) {
    assert.ok(!advTables.has(t), `kernel table ${t} must NOT exist in the untrusted memory DB`);
    assert.throws(() => adv.prepare(`SELECT * FROM ${t}`).all(), new RegExp("no such table"), `adversary must not be able to read kernel table ${t}`);
  }
  assert.ok(advTables.has("shared_memory"), "the memory DB still holds the (untrusted) content");
  adv.close();

  // The protected kernel file separately holds the consumption + anchor state.
  const kern = new DatabaseSync(kernFile);
  const kernTables = new Set(kern.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map((r) => r.name));
  for (const t of KERNEL) assert.ok(kernTables.has(t), `kernel table ${t} must exist in the protected kernel DB`);
  assert.equal(kern.prepare("SELECT COUNT(*) AS n FROM membership_anchor").get().n, 1, "the membership anchor head lives in the protected kernel DB");
  assert.ok(kern.prepare("SELECT COUNT(*) AS n FROM action_outbox").get().n >= 1, "the consumed action outbox lives in the protected kernel DB");
  kern.close();
});

test("a memory-file adversary cannot delete or roll back the MAC-chain anchor head (omission stays caught across restart)", () => {
  const dir = mkdtempSync(join(tmpdir(), "mbm-split2-"));
  const memFile = join(dir, "memory.db"); const kernFile = join(dir, "kernel.db");
  // Seed: two authority records; the restrictive one caps the meet to []. (Same closure as repro_v18_mirror.)
  { const cp = new ControlPlane({ keyBytes: KEY });
    const sys = createSecureMemorySystem({ dbPath: memFile, kernelDbPath: kernFile, controlPlane: cp, destinationPolicy: () => true });
    const rt = sys.admin;
    rt.sendMessage(env({ message_id: "m0", sender: "p", receiver: "memory", sequence: 1 }), cp.registerPrincipal("p", {}));
    const cPrin = cp.registerPrincipal("c", {});
    const w = cp.registerPrincipal("w", { queues: ["*"] });
    rt.writeMemory("deny-all", rt.claimSpecific(w, "m0"), { memory_id: "mem-restrict", logical_key: "K", memory_type: "constraint", allowed_readers: ["executor"], effect_ceiling: [] });
    rt.writeMemory("permit", rt.claimSpecific(w, "m0"), { memory_id: "mem-permit", logical_key: "OK", memory_type: "constraint", allowed_readers: ["executor"], effect_ceiling: ["send"] });
    rt.sendMessage(env({ message_id: "mx", sender: "c", receiver: "executor", sequence: 90, parent_message_id: "m0" }), cPrin);
    rt.close(); }

  // Adversary with raw write to the MEMORY file deletes the restrictive row AND its membership mirror, then TRIES
  // to cover the omission by deleting the anchor head -- which lives in the kernel file it cannot reach.
  const adv = new DatabaseSync(memFile);
  adv.exec("DELETE FROM shared_memory WHERE memory_id='mem-restrict'");
  adv.exec("DELETE FROM authority_membership WHERE memory_id='mem-restrict'");
  assert.throws(() => adv.exec("DELETE FROM membership_anchor"), new RegExp("no such table"), "the anchor head is NOT in the memory DB the adversary controls");
  adv.close();

  // Key-stable restart: the anchor (kernel file, count=2, intact) disagrees with the surviving mirror (1) -> the
  // omission is caught and FAILS CLOSED; the adversary could not erase the evidence.
  const cp2 = new ControlPlane({ keyBytes: KEY });
  const sys2 = createSecureMemorySystem({ dbPath: memFile, kernelDbPath: kernFile, controlPlane: cp2, destinationPolicy: () => true });
  const ex = cp2.registerPrincipal("ex", { queues: ["executor"] });
  cp2.registerPrincipal("p", {}); cp2.registerPrincipal("c", {});
  const ctx = cp2.contextTokenForLease(sys2.admin.claimSpecific(ex, "mx"));
  let reason = "exposed";
  try { sys2.runtime.read(ex, ctx, {}); } catch (e) { reason = String(e.message).split(":")[0]; }
  assert.equal(reason, "candidate_tampered", "omission via the memory-file adversary fails closed on restart (anchor protected in kernel DB)");
  sys2.admin.close();
});
