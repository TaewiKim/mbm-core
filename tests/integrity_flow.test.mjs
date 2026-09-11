// Integrity-flow predicate (the second discriminating axis). The content-trust residual the prior
// monitor scoped out -- a legitimately-leased agent that ingested untrusted input writing a
// contextually-valid, attested, in-lineage record -- is now confined by information-flow integrity:
// a high-integrity active context will not ingest a record whose PROVENANCE is less trusted. The record
// carries no integrity label to forge; the gate derives it from the signed source envelope and the
// writer's control-plane clearance, exactly as it recomputes causal reachability from the graph.
import test from "node:test";
import assert from "node:assert/strict";
import { runSecureCoverage, INTEGRITY_FLOW_SCENARIOS } from "../benchmarks/coupled_memory/secure_coverage.mjs";
import { SecureMemoryRuntime, ControlPlane } from "../benchmarks/coupled_memory/runtime.mjs";
import { integrityMeet, integrityLevel } from "../benchmarks/coupled_memory/control_plane.mjs";

test("integrity lattice meet and fail-closed default", () => {
  assert.equal(integrityLevel("system"), 2);
  assert.equal(integrityLevel("untrusted"), 0);
  assert.equal(integrityLevel(undefined), 0, "unknown/absent integrity is untrusted (fail-closed low)");
  assert.equal(integrityMeet("system", "untrusted"), 0, "meet of trusted and tainted is tainted");
  assert.equal(integrityMeet("system", "system"), 2);
});

test("secure profile mediates the integrity-flow family (20-case suite)", () => {
  const r = runSecureCoverage({ scenarios: INTEGRITY_FLOW_SCENARIOS });
  assert.equal(r.cases, 20);
  assert.equal(r.total_invalid_admissions, 0, "no tainted-provenance plant may be admitted");
  assert.ok(r.full_selection, "the benign high-integrity record must still be admitted (no over-blocking)");
  assert.ok(r.full_reconstructable, "every integrity decision must be reproduced on replay");
  const fam = r.families.find((f) => f.family === "authenticated_injected_writer");
  assert.equal(fam.passed, 20);
});

const BASE = { run_id: "R", task_id: "T", trace_id: "tr", intent: "produce_final_plan",
  state: "running", policy_context: "P", correlation_id: null, delegated_from: null };

test("provenance (writer trust), not content, decides: swapping the writer flips the verdict", () => {
  const cp = new ControlPlane();
  const rt = new SecureMemoryRuntime({ controlPlane: cp });
  try {
    const send = (id, sender, receiver, seq, parent) =>
      rt.sendMessage({ ...BASE, message_id: id, sender, receiver, sequence: seq, parent_message_id: parent },
        cp.registerPrincipal(sender, {}));
    send("m0", "planner", "memory", 1, null);
    send("m-a", "researcher", "memory", 2, "m0");          // reachable source for the trusted writer
    send("m-b", "researcher", "memory", 3, "m-a");         // reachable source for the untrusted writer
    const trusted = cp.registerPrincipal("trusted", { queues: ["*"], clearance: "system" });
    const ingestor = cp.registerPrincipal("ingestor", { queues: ["*"], clearance: "untrusted" });
    const SAME = "retain backups 7 days"; // identical content; only the WRITER differs
    const w = (sess, src, id) => rt.writeMemory(SAME, rt.claimSpecific(sess, src),
      { memory_id: id, memory_type: "constraint", allowed_readers: ["executor"] });
    w(trusted, "m-a", "by-trusted");
    w(ingestor, "m-b", "by-untrusted");
    // v20 CREATION-CUT: the reader/active message must be sent AFTER the writes it should read, with a
    // sequence strictly greater than every preceding message AND write. m-exec is a leaf (sources nothing),
    // so deferring it is safe.
    send("m-exec", "coordinator", "executor", rt._currentSequence("R") + 1, "m-b"); // system decision context (derived)
    const reader = cp.registerPrincipal("reader", { queues: ["executor"] });
    const admitted = new Set(rt.readMemory({}, rt.claimSpecific(reader, "m-exec")).map((m) => m.memory_id));
    assert.ok(admitted.has("by-trusted"), "same content by a system-clearance writer is admitted");
    assert.ok(!admitted.has("by-untrusted"), "same content by an untrusted-clearance writer is denied (integrity)");
  } finally {
    rt.close();
  }
});

// Re-review regression: integrity is DERIVED by the control plane, never the caller's value.
test("integrity laundering blocked: a relabelled child cannot raise integrity", () => {
  const cp = new ControlPlane();
  const rt = new SecureMemoryRuntime({ controlPlane: cp });
  try {
    const agent = cp.registerPrincipal("agent", { queues: ["*"], clearance: "system" });
    const send = (id, parent, seq, integrity) => rt.sendMessage(
      { ...BASE, message_id: id, sender: "agent", receiver: "memory", sequence: seq,
        parent_message_id: parent, ...(integrity ? { integrity } : {}) }, agent);
    send("m0", null, 0);
    send("m-low", "m0", 1, "untrusted");      // the agent ingests untrusted input
    send("m-launder", "m-low", 2, "system");  // ...and tries to launder it back to system
    assert.equal(integrityLevel(rt.getMessage("m-launder").integrity), 0,
      "a child of an untrusted message derives untrusted despite claiming system");
    assert.equal(integrityLevel(rt.getMessage("m0").integrity), 2, "a clean root remains system");
    assert.equal(cp.verifyEnvelope({ ...rt.getMessage("m-launder"), integrity: "system" }), false,
      "a hand-forged system-integrity envelope is not validly signed");
    assert.equal(cp.verifyEnvelope(rt.getMessage("m-launder")), true, "the derived envelope is signed");
  } finally {
    rt.close();
  }
});

// Re-review regression: the control plane is not a public signing oracle, and leases require auth.
test("no public signing oracle: no mint/sign; issueLease needs auth; attestWrite needs a valid lease", () => {
  const cp = new ControlPlane();
  const rt = new SecureMemoryRuntime({ controlPlane: cp });
  try {
    assert.equal(typeof cp.mintReceipt, "undefined", "no public mintReceipt");
    assert.equal(typeof cp.signEnvelope, "undefined", "no public signEnvelope");
    // issueLease takes a SESSION token, not a caller-named principal: a forged principal id fails auth.
    assert.throws(() => cp.issueLease("trusted-writer", "m"), /authentication_failed/);
    // session/principal/lease state and the key are private (#fields); only non-secret ids are public
    for (const f of ["_sessions", "_principals", "_leases", "_leaseSeq", "_key"]) {
      assert.ok(!(f in cp), `private state ${f} must not be a public field`);
    }
    const forged = { memory_id: "f", run_id: "R", task_id: "T", trace_id: "tr", source_message_id: "m",
      writer: "mallory", memory_type: "constraint", scope: "task", status: "active", content: "x",
      content_ref: null, allowed_readers: ["e"], supersedes: [], valid_from_event: null,
      valid_until_event: null, policy_context: "P", integrity: 0 };
    assert.throws(() => cp.attestWrite("leaset-bogus", forged), /lease_invalid/);
  } finally {
    rt.close();
  }
});
