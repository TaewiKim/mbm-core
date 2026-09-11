// PoC (no API): the ENFORCED trusted-write boundary rejects the reviewer's M1/M2/M3/M5/M6
// counterexamples. Earlier this PoC exercised an HMAC abstraction whose trusted path was assumed; the
// reviewer bypassed it (public default key, unauthenticated write, self-asserted workerId, arbitrary
// claim, no-gate hook). This version drives SecureMemoryRuntime, where identity is possession of an
// unforgeable control-plane lease and the key is ephemeral and never in the store. Run:
// node scripts/poc_attestation.mjs (exits non-zero on any unexpected outcome). Emits
// results/eval/poc-attestation.json
import { writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createHmac } from "node:crypto";
import { SecureMemoryRuntime, ControlPlane, memoryContentHash } from "../benchmarks/coupled_memory/runtime.mjs";

const REPO = join(dirname(fileURLToPath(import.meta.url)), "..");
const env = (o) => ({ message_id: "m", run_id: "R", task_id: "T", trace_id: "tr", sender: "planner",
  receiver: "memory", intent: "produce_final_plan", state: "running", sequence: 1, parent_message_id: null,
  correlation_id: null, delegated_from: null, policy_context: "P", ...o });

function injectRaw(rt, rec) {
  const full = { memory_id: rec.memory_id, run_id: "R", task_id: "T", trace_id: "tr",
    source_message_id: rec.source_message_id, writer: "mallory", memory_type: "constraint", scope: "task",
    status: "active", content: rec.content ?? "x", content_ref: null, allowed_readers: ["executor"], supersedes: [],
    valid_from_event: null, valid_until_event: null, policy_context: "P" };
  rt.db.prepare(`INSERT INTO shared_memory (memory_id,run_id,task_id,trace_id,source_message_id,writer,memory_type,scope,status,content,content_ref,allowed_readers_json,supersedes_json,valid_from_event,valid_until_event,policy_context,audit_hash,write_receipt,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
    .run(full.memory_id, full.run_id, full.task_id, full.trace_id, full.source_message_id, full.writer, full.memory_type, full.scope, full.status, full.content, full.content_ref, JSON.stringify(full.allowed_readers), "[]", null, null, full.policy_context, memoryContentHash(full), rec.write_receipt ?? null, "t", "t");
}
const threw = (fn) => { try { fn(); return false; } catch { return true; } };

const cp = new ControlPlane();
const rt = new SecureMemoryRuntime({ controlPlane: cp });
const ssend = (e) => rt.sendMessage(e, cp.registerPrincipal(e.sender, {})); // signed trusted-path send
// (v20 CREATION-CUT) Send the memory SOURCE messages first; the reader/active message (m3) is sent LAST,
// after every memory it reads has been written, with a signed `sequence` strictly greater than every write_seq.
ssend(env({ message_id: "m0", sequence: 0 }));
ssend(env({ message_id: "m2", parent_message_id: "m0", sequence: 2 }));
const memSess = cp.registerPrincipal("mem-worker", { queues: ["memory"] });
const execSess = cp.registerPrincipal("exec-worker", { queues: ["executor"] });
const lcSess = cp.registerPrincipal("lifecycle-controller", { queues: [], lifecycle: true });

// Legitimate attested write under m2 (a reachable ancestor of m3).
rt.claim(memSess, "memory"); const w = rt.claim(memSess, "memory").lease;
rt.writeMemory("retain 30 days (compliance)", w, { memory_id: "good", memory_type: "constraint", allowed_readers: ["executor"] });
// The newer record is a PRE-read write too (the post-supersede read serves it), so it is written before the
// reader/active message is sent; its lifecycle supersede event stays AFTER the first read (below) so that read
// still sees `good` active. Only the send-vs-write ordering moves; the supersede step is unchanged.
rt.writeMemory("retain 60 days (newer)", w, { memory_id: "good2", memory_type: "constraint", allowed_readers: ["executor"], supersedes: ["good"] });
// Compromised store injection: truthful source m2, valid content hash, NO receipt.
injectRaw(rt, { memory_id: "trap", source_message_id: "m2", content: "retain 7 days (malicious)" });
// Forge a receipt with the OLD public default key (and an all-zero key) -- must not match ephemeral K.
for (const guess of ["mbm-trusted-control-plane-key", "0".repeat(64)]) {
  injectRaw(rt, { memory_id: `forge-${guess.length}`, source_message_id: "m2", content: "x",
    write_receipt: `hmac:${createHmac("sha256", guess).update(memoryContentHash({ memory_id: `forge-${guess.length}`, run_id: "R", task_id: "T", trace_id: "tr", source_message_id: "m2", writer: "mallory", memory_type: "constraint", scope: "task", status: "active", content: "x", content_ref: null, allowed_readers: ["executor"], supersedes: [], valid_from_event: null, valid_until_event: null, policy_context: "P" })).digest("hex")}` });
}

// Reader/active message sent LAST, with a signed sequence strictly greater than every preceding message AND
// every write_seq (a large gap constant), so the CREATION-CUT admits the legitimately attested records.
ssend(env({ message_id: "m3", parent_message_id: "m2", sequence: 90, sender: "coordinator", receiver: "executor" }));
const rlease = rt.claim(execSess, "executor").lease;
const admitted = rt.readMemory({}, rlease).map((m) => m.memory_id);

// Adversary capabilities the enforced boundary must refuse.
const unauthWrite = threw(() => rt.writeMemory("x", "leaset-bogus", { memory_id: "z" }));         // no signing oracle
const arbitraryClaim = threw(() => rt.claim(execSess, "memory"));                                   // wrong queue
const stolenEnvelope = threw(() => rt.readMemory({}, "leaset-forged"));                             // not a bearer credential
const bypassAttempt = rt.readMemory({}, rlease, { controlNoGate: true, condition: "C4", gateOptions: { disabledChecks: ["attestation"] } })
  .every((m) => m.memory_id !== "trap");                                                            // no bypass surface

// Lifecycle: supersede `good` (written above, before the reader) and confirm it is then denied; a
// non-lifecycle principal cannot. The supersede event happens AFTER the first read, so that read saw `good`.
const lifecycleUnauthorized = threw(() => rt.supersede(memSess, "good", "good2"));
rt.supersede(lcSess, "good", "good2");
const afterSupersede = rt.claim(execSess, "executor"); // m3 already locked by exec-worker; re-claim returns null
const rlease2 = rt.leaseFor(execSess, "m3");
const admittedAfter = rt.readMemory({}, rlease2).map((m) => m.memory_id);

// Replay: clean run reproduces the denial; receipt mutation is caught.
const cleanReplay = rt.replaySecureMemoryReads("R");
rt.db.prepare("UPDATE shared_memory SET write_receipt='hmac:deadbeef' WHERE memory_id='good2'").run();
const tamperReplay = rt.replaySecureMemoryReads("R");
rt.close();

const checks = [
  ["attested record admitted", admitted.includes("good")],
  ["store-injected truthful-ancestor trap denied (no receipt)", !admitted.includes("trap")],
  ["public/zero-key forged receipts denied (ephemeral key)", !admitted.includes("forge-28") && !admitted.includes("forge-64")],
  ["unauthenticated write rejected (no signing oracle)", unauthWrite],
  ["arbitrary claim of another queue rejected", arbitraryClaim],
  ["stolen envelope without a lease cannot read", stolenEnvelope],
  ["no bypass surface (no-gate/disabled-check ignored)", bypassAttempt],
  ["lifecycle authority required to supersede", lifecycleUnauthorized],
  ["superseded record denied after authoritative supersede", !admittedAfter.includes("good") && admittedAfter.includes("good2")],
  ["attestation-aware replay clean", cleanReplay.ok],
  ["replay catches receipt tampering", !tamperReplay.ok && tamperReplay.issues.some((i) => i.kind === "receipt_tampered")],
];
const passed = checks.filter(([, ok]) => ok).length;
const ok = passed === checks.length;
const report = { scenario: "enforced trusted-write boundary (M1/M2/M3/M5/M6)", profile: "secure",
  admitted, admitted_after_supersede: admittedAfter, checks: checks.map(([name, v]) => ({ name, ok: v })), passed, total: checks.length, ok };
mkdirSync(join(REPO, "results", "eval"), { recursive: true });
writeFileSync(join(REPO, "results", "eval", "poc-attestation.json"), JSON.stringify(report, null, 2));

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  console.log("PoC: enforced trusted-write boundary (no API)");
  console.log(`  admitted: [${admitted.join(", ")}]`);
  for (const [name, v] of checks) console.log(`  [${v ? "PASS" : "FAIL"}] ${name}`);
  console.log(`${ok ? "OK" : "FAILED"} ${passed}/${checks.length}`);
  process.exit(ok ? 0 : 1);
}
export { report };
