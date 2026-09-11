// Enforced trusted-write / caller-authentication / lifecycle tests (review M1, M2, M5, M6, M8).
// The previous revision tested an HMAC abstraction whose trusted boundary was assumed, not built, so
// the reviewer bypassed it with a public default key, an unauthenticated write, a self-asserted
// workerId, and an arbitrary claim. These tests drive the ENFORCED SecureMemoryRuntime, in which
// identity is possession of an unforgeable control-plane token and the key is ephemeral and never in
// the store. Each `assert.throws`/empty-admit below is one of the reviewer's counterexamples, now denied.
import test from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SecureMemoryRuntime, ControlPlane, memoryContentHash } from "../benchmarks/coupled_memory/runtime.mjs";

function env(o = {}) {
  return { message_id: "m", run_id: "R", task_id: "T", trace_id: "tr", sender: "planner", receiver: "memory",
    intent: "produce_final_plan", state: "running", sequence: 1, parent_message_id: null,
    correlation_id: null, delegated_from: null, policy_context: "P", ...o };
}

// Send a message through the SIGNED trusted path (sender authenticates; control plane signs envelope).
function send(rt, cp, e) {
  return rt.sendMessage(e, cp.registerPrincipal(e.sender, {}));
}

// Seed a run: m0 -> m2 (queue "memory") descending from m0. The reader/active message m3 (queue
// "executor") is NOT seeded here: under the v20 creation-cut, the reader's signed `sequence` is the
// causal "as-of" line and a record with write_seq > that sequence is denied write_after_active. m3 is
// therefore sent LAST (after the memory it reads is written) via sendReader(), with a sequence strictly
// greater than every preceding message and every write_seq. m3 sources no memory, so deferring it is safe.
function seed(rt, cp) {
  send(rt, cp, env({ message_id: "m0", sequence: 0 }));
  send(rt, cp, env({ message_id: "m2", parent_message_id: "m0", sequence: 2 }));
}

// Send the deferred reader/active message m3 LAST, after all writes, with a sequence strictly greater
// than the run's last-allocated sequence (which already covers every prior message and every write_seq).
function sendReader(rt, cp) {
  send(rt, cp, env({ message_id: "m3", parent_message_id: "m2", sequence: rt._currentSequence("R") + 1, sender: "coordinator", receiver: "executor" }));
}

// A control plane with a *known* key, only so tests can (a) assert the key never lands in the DB and
// (b) attempt forgeries. Production/benchmark code passes no keyBytes and gets an ephemeral key.
function setup(keyBytes) {
  const cp = new ControlPlane(keyBytes ? { keyBytes } : {});
  const rt = new SecureMemoryRuntime({ controlPlane: cp });
  seed(rt, cp);
  const memSess = cp.registerPrincipal("mem-worker", { queues: ["memory"] });
  const execSess = cp.registerPrincipal("exec-worker", { queues: ["executor"] });
  const lcSess = cp.registerPrincipal("lifecycle-controller", { queues: [], lifecycle: true });
  return { cp, rt, memSess, execSess, lcSess };
}

// Direct store injection bypassing the trusted write path (a compromised store writer). Valid content
// hash so integrity passes; the missing/forged receipt is what must stop it.
function injectRaw(rt, rec) {
  const full = { memory_id: rec.memory_id, run_id: "R", task_id: "T", trace_id: "tr",
    source_message_id: rec.source_message_id, writer: "mallory", memory_type: "constraint", scope: "task",
    status: "active", content: rec.content ?? "x", content_ref: null, allowed_readers: ["executor"], supersedes: [],
    valid_from_event: null, valid_until_event: null, policy_context: "P" };
  const hash = memoryContentHash(full);
  rt.db.prepare(`INSERT INTO shared_memory (memory_id, run_id, task_id, trace_id, source_message_id,
    writer, memory_type, scope, status, content, content_ref, allowed_readers_json, supersedes_json,
    valid_from_event, valid_until_event, policy_context, audit_hash, write_receipt, created_at, updated_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
    full.memory_id, full.run_id, full.task_id, full.trace_id, full.source_message_id, full.writer,
    full.memory_type, full.scope, full.status, full.content, full.content_ref,
    JSON.stringify(full.allowed_readers), "[]", null, null, full.policy_context, hash,
    rec.write_receipt ?? null, new Date().toISOString(), new Date().toISOString());
}

test("attested write through the trusted path is admitted", () => {
  const { cp, rt, memSess, execSess } = setup();
  try {
    const wlease = rt.claim(memSess, "memory").lease;           // claims m0
    const wlease2 = rt.claim(memSess, "memory").lease;          // claims m2
    rt.writeMemory("retain 30 days", wlease2, { memory_id: "good", memory_type: "constraint", allowed_readers: ["executor"] });
    sendReader(rt, cp);                                         // reader m3 sent LAST, after the write
    const rlease = rt.claim(execSess, "executor").lease;        // claims m3
    const admitted = rt.readMemory({}, rlease);
    assert.deepEqual(admitted.map((m) => m.memory_id), ["good"]);
  } finally { rt.close(); }
});

test("M1: store-injected record naming a genuine ancestor is DENIED (no receipt)", () => {
  const { cp, rt, execSess } = setup();
  try {
    injectRaw(rt, { memory_id: "trap", source_message_id: "m2", content: "retain 7 days (malicious)" });
    sendReader(rt, cp);
    const rlease = rt.claim(execSess, "executor").lease;
    assert.deepEqual(rt.readMemory({}, rlease).map((m) => m.memory_id), []);
  } finally { rt.close(); }
});

test("M1.2: forging a receipt with ANY guessed key fails (key is ephemeral, not a public default)", () => {
  const { cp, rt, execSess } = setup(Buffer.alloc(32, 7));
  try {
    // Attacker computes a receipt under guesses incl. the old public default and an all-zero key.
    for (const guess of ["mbm-trusted-control-plane-key", "", "0".repeat(64), "secret"]) {
      const full = { memory_id: `f-${guess.length}`, run_id: "R", task_id: "T", trace_id: "tr",
        source_message_id: "m2", writer: "mallory", memory_type: "constraint", scope: "task", status: "active",
        content: "x", content_ref: null, allowed_readers: ["executor"], supersedes: [], valid_from_event: null,
        valid_until_event: null, policy_context: "P" };
      const forged = `hmac:${createHmac("sha256", guess).update(memoryContentHash(full)).digest("hex")}`;
      injectRaw(rt, { memory_id: full.memory_id, source_message_id: "m2", content: "x", write_receipt: forged });
    }
    sendReader(rt, cp);
    const rlease = rt.claim(execSess, "executor").lease;
    assert.deepEqual(rt.readMemory({}, rlease).map((m) => m.memory_id), []);
  } finally { rt.close(); }
});

test("M1: re-pointing an attested record's source by tampering breaks the receipt", () => {
  const { cp, rt, memSess, execSess } = setup();
  try {
    rt.claim(memSess, "memory"); const w = rt.claim(memSess, "memory").lease;
    rt.writeMemory("retain 30 days", w, { memory_id: "good", memory_type: "constraint", allowed_readers: ["executor"] });
    rt.db.prepare("UPDATE shared_memory SET source_message_id='m0', content='retain 7 days' WHERE memory_id='good'").run();
    sendReader(rt, cp);
    const rlease = rt.claim(execSess, "executor").lease;
    assert.deepEqual(rt.readMemory({}, rlease).map((m) => m.memory_id), []);
  } finally { rt.close(); }
});

test("M2: writeMemory without a valid lease is rejected (no signing oracle)", () => {
  const { rt } = setup();
  try {
    assert.throws(() => rt.writeMemory("x", "leaset-bogus", { memory_id: "z" }), /lease_invalid/);
  } finally { rt.close(); }
});

test("M2: a principal cannot lease/serve a queue it is not authorized for, nor a message it does not lock", () => {
  const { cp, rt, memSess, execSess } = setup();
  try {
    sendReader(rt, cp);
    // exec-worker may not claim the "memory" queue.
    assert.throws(() => rt.claim(execSess, "memory"), /not_authorized_for_queue/);
    // mem-worker has not locked m3, so it cannot lease it.
    assert.throws(() => rt.leaseFor(memSess, "m3"), /not_authorized_for_queue|not_lock_owner/);
  } finally { rt.close(); }
});

test("M2: read identity is lease possession; a stolen envelope is not a bearer credential", () => {
  const { cp, rt, memSess, execSess } = setup();
  try {
    rt.claim(memSess, "memory"); const w = rt.claim(memSess, "memory").lease;
    rt.writeMemory("retain 30 days", w, { memory_id: "good", memory_type: "constraint", allowed_readers: ["executor"] });
    sendReader(rt, cp);
    rt.claim(execSess, "executor"); // exec-worker locks m3 but we discard its lease
    // An attacker who knows m3 but holds no lease has no way to call readMemory: there is no
    // workerId/condition parameter, and a forged lease token is rejected.
    assert.throws(() => rt.readMemory({}, "leaset-forged"), /lease_invalid/);
  } finally { rt.close(); }
});

test("M3: there is no bypass surface (no condition/controlNoGate/disabledChecks)", () => {
  const { cp, rt, execSess } = setup();
  try {
    injectRaw(rt, { memory_id: "trap", source_message_id: "m2", content: "malicious" });
    sendReader(rt, cp);
    const rlease = rt.claim(execSess, "executor").lease;
    // readMemory takes only (query, leaseToken); extra args are ignored, the trap stays denied.
    assert.deepEqual(rt.readMemory({}, rlease, { controlNoGate: true, condition: "C4",
      gateOptions: { disabledChecks: ["attestation", "provenance"] } }).map((m) => m.memory_id), []);
  } finally { rt.close(); }
});

test("M5: supersession is authoritative -- a superseded record is denied, the writer cannot keep it live", () => {
  const { cp, rt, memSess, execSess, lcSess } = setup();
  try {
    rt.claim(memSess, "memory"); const w = rt.claim(memSess, "memory").lease;
    rt.writeMemory("retain 7 days (old)", w, { memory_id: "old", memory_type: "constraint", allowed_readers: ["executor"] });
    rt.writeMemory("retain 30 days (new)", w, { memory_id: "new", memory_type: "constraint", allowed_readers: ["executor"], supersedes: ["old"] });
    // A non-lifecycle principal cannot retire a record.
    assert.throws(() => rt.supersede(memSess, "old", "new"), /not_authorized_for_lifecycle/);
    rt.supersede(lcSess, "old", "new");
    sendReader(rt, cp);
    const rlease = rt.claim(execSess, "executor").lease;
    assert.deepEqual(rt.readMemory({}, rlease).map((m) => m.memory_id), ["new"]);
  } finally { rt.close(); }
});

test("M8: the attestation key never appears in the store", () => {
  const keyHex = Buffer.alloc(32, 7).toString("hex");
  const { rt, memSess } = setup(Buffer.alloc(32, 7));
  try {
    rt.claim(memSess, "memory"); const w = rt.claim(memSess, "memory").lease;
    rt.writeMemory("retain 30 days", w, { memory_id: "good", memory_type: "constraint", allowed_readers: ["executor"] });
    const rows = rt.db.prepare("SELECT * FROM shared_memory").all();
    const dump = JSON.stringify(rows);
    assert.ok(!dump.includes(keyHex), "raw key must not be persisted");
    assert.ok(dump.includes("hmac:"), "receipt (HMAC output, not the key) is persisted");
  } finally { rt.close(); }
});

test("M6: attestation-aware replay reproduces clean denials and catches receipt tampering", () => {
  const { cp, rt, memSess, execSess } = setup();
  let dbPath;
  try {
    rt.claim(memSess, "memory"); const w = rt.claim(memSess, "memory").lease;
    rt.writeMemory("retain 30 days", w, { memory_id: "good", memory_type: "constraint", allowed_readers: ["executor"] });
    injectRaw(rt, { memory_id: "trap", source_message_id: "m2", content: "malicious" }); // denied at read
    sendReader(rt, cp);
    const rlease = rt.claim(execSess, "executor").lease;
    rt.readMemory({}, rlease);
    // Clean run: the denial of `trap` is reproduced as a denial (the reviewer's "valid denial replayed
    // as allow" counterexample is gone because replay uses the same strict gate + control plane).
    const clean = rt.replaySecureMemoryReads("R");
    assert.ok(clean.ok, `clean replay should pass: ${JSON.stringify(clean.issues)}`);
    // Mutate the admitted record's receipt: replay must flag it.
    rt.db.prepare("UPDATE shared_memory SET write_receipt='hmac:deadbeef' WHERE memory_id='good'").run();
    const tampered = rt.replaySecureMemoryReads("R");
    assert.ok(!tampered.ok && tampered.issues.some((i) => i.kind === "receipt_tampered"), JSON.stringify(tampered.issues));
  } finally { rt.close(); }
});

test("M1.1: claimSpecific cannot lease a message another principal already locked", () => {
  const { cp, rt } = setup();
  try {
    const a = cp.registerPrincipal("A", { queues: ["memory"] });
    const b = cp.registerPrincipal("B", { queues: ["memory"] });
    rt.claim(a, "memory"); rt.claim(a, "memory");          // A locks m0 then m2
    assert.equal(rt.lockOwnerOf("m2"), "A");
    assert.throws(() => rt.claimSpecific(b, "m2"), /not_lock_owner/); // B cannot lease A's message
  } finally { rt.close(); }
});

test("M1.2: a writer cannot forge authorization metadata (task_id/scope) to target another task", () => {
  const cp = new ControlPlane();
  const rt = new SecureMemoryRuntime({ controlPlane: cp });
  try {
    send(rt, cp, env({ message_id: "n0", sequence: 0 }));
    send(rt, cp, env({ message_id: "n1", parent_message_id: "n0", sequence: 1 }));        // task T
    send(rt, cp, env({ message_id: "nB", parent_message_id: "n1", sequence: 2, task_id: "OTHER", sender: "coordinator", receiver: "victim" }));
    const w = cp.registerPrincipal("w", { queues: ["memory"] });
    const v = cp.registerPrincipal("v", { queues: ["victim"] });
    const wlease = rt.claimSpecific(w, "n1");
    // Writer (leased for task T) tries to plant a record for task OTHER aimed at the victim.
    const rec = rt.writeMemory("malicious", wlease, { memory_id: "x", memory_type: "constraint", task_id: "OTHER", scope: "global", allowed_readers: ["victim"] });
    assert.equal(rec.task_id, "T");     // forced from the canonical message, not the writer's "OTHER"
    assert.equal(rec.scope, "task");    // writer cannot widen scope to bypass the task gate
    const admitted = rt.readMemory({}, rt.claimSpecific(v, "nB")).map((m) => m.memory_id);
    assert.deepEqual(admitted, []);     // the cross-task confused-deputy record is denied
  } finally { rt.close(); }
});

test("M1.3: receipts verify across a restart only with the SAME durable key", () => {
  const dir = mkdtempSync(join(tmpdir(), "mbm-restart-"));
  const dbPath = join(dir, "t.db");
  const key = Buffer.alloc(32, 9);
  // First process: durable key, write an attested record, close.
  { const cp = new ControlPlane({ keyBytes: key }); const rt = new SecureMemoryRuntime({ dbPath, controlPlane: cp });
    send(rt, cp, env({ message_id: "m0", sequence: 0 })); send(rt, cp, env({ message_id: "m2", parent_message_id: "m0", sequence: 2 }));
    const ms = cp.registerPrincipal("mem", { queues: ["memory"] });
    rt.claim(ms, "memory"); rt.writeMemory("retain 30 days", rt.claim(ms, "memory").lease, { memory_id: "good", memory_type: "constraint", allowed_readers: ["executor"] });
    // Reader m3 sent LAST (after the write), sequence strictly above the run's last-allocated sequence.
    send(rt, cp, env({ message_id: "m3", parent_message_id: "m2", sequence: rt._currentSequence("R") + 1, sender: "coordinator", receiver: "executor" }));
    rt.close(); }
  // Restart with the SAME key: the durable profile reloads BOTH the key and the principal-clearance
  // policy (the integrity gate reads the writer's clearance), so prior receipts and envelope signatures
  // verify and the record is admitted.
  { const cp = new ControlPlane({ keyBytes: key }); const rt = new SecureMemoryRuntime({ dbPath, controlPlane: cp });
    cp.registerPrincipal("mem", { queues: ["memory"] }); // durable clearance policy reloaded on restart
    const ex = cp.registerPrincipal("exec", { queues: ["executor"] });
    assert.deepEqual(rt.readMemory({}, rt.claimSpecific(ex, "m3")).map((m) => m.memory_id), ["good"]);
    rt.close(); }
  // Restart with a DIFFERENT key: the envelope signature no longer verifies, so the read fails closed.
  { const cp = new ControlPlane({ keyBytes: Buffer.alloc(32, 1) }); const rt = new SecureMemoryRuntime({ dbPath, controlPlane: cp });
    const ex = cp.registerPrincipal("exec", { queues: ["executor"] });
    assert.throws(() => rt.readMemory({}, rt.claimSpecific(ex, "m3")), /envelope_not_attested/);
    rt.close(); }
});

test("M1.4: replay detects a wiped read manifest (not mistaken for inactivity)", () => {
  const { cp, rt, memSess, execSess } = setup();
  try {
    rt.claim(memSess, "memory"); const w = rt.claim(memSess, "memory").lease;
    rt.writeMemory("retain 30 days", w, { memory_id: "good", memory_type: "constraint", allowed_readers: ["executor"] });
    sendReader(rt, cp);
    rt.readMemory({}, rt.claim(execSess, "executor").lease);
    assert.ok(rt.replaySecureMemoryReads("R").ok);
    // Adversary deletes the ENTIRE read manifest + decisions (the case that previously replayed ok=true).
    rt.db.prepare("DELETE FROM memory_reads WHERE run_id='R'").run();
    rt.db.prepare("DELETE FROM memory_access_decisions WHERE run_id='R'").run();
    const r = rt.replaySecureMemoryReads("R");
    assert.ok(!r.ok && r.issues.some((i) => i.kind === "read_manifest_deleted"), JSON.stringify(r.issues));
  } finally { rt.close(); }
});

test("envelope attestation: a tampered/forged envelope label is rejected (authority is a signature, not text)", () => {
  const { cp, rt, memSess, execSess } = setup();
  try {
    rt.claim(memSess, "memory"); const w = rt.claim(memSess, "memory").lease;
    rt.writeMemory("retain 30 days", w, { memory_id: "good", memory_type: "constraint", allowed_readers: ["executor"] });
    sendReader(rt, cp);
    // A store-write adversary rewrites the active message's authorization label (task_id) in the DB.
    // The envelope signature was computed over the original fields, so it no longer verifies.
    const row = rt.db.prepare("SELECT envelope_json FROM messages WHERE message_id='m3'").get();
    const forged = { ...JSON.parse(row.envelope_json), task_id: "HIJACK" };
    rt.db.prepare("UPDATE messages SET envelope_json=?, task_id='HIJACK' WHERE message_id='m3'").run(JSON.stringify(forged));
    assert.throws(() => rt.readMemory({}, rt.claim(execSess, "executor").lease), /envelope_not_attested/);
  } finally { rt.close(); }
});
