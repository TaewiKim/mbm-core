// Review M1 (active-message principal substitution): the gate must treat the CANONICAL persisted
// envelope as the authorization context. Knowing one message_id must not let a caller forge
// run/task/receiver/policy/causal-parent and read another principal's memory, and audit replay must
// not certify such a forged access as clean.
import test from "node:test";
import assert from "node:assert/strict";
import { CoupledMemoryRuntime } from "../benchmarks/coupled_memory/runtime.mjs";

function envelope(over = {}) {
  return {
    message_id: "m", run_id: "R1", task_id: "T1", trace_id: "tr1",
    sender: "alice", receiver: "alice", intent: "produce_final_plan", state: "active",
    sequence: 1, parent_message_id: null, correlation_id: null, delegated_from: null,
    policy_context: "P1", ...over,
  };
}

// A victim principal (victim@R2) legitimately owns a secret; an attacker (mallory@R1) knows the
// attacker message_id and tries to read the secret by forging the active message's fields.
function setup() {
  const rt = new CoupledMemoryRuntime();
  const victimMsg = envelope({ message_id: "m-victim", run_id: "R2", task_id: "T2",
    trace_id: "trV", sender: "victim", receiver: "victim", policy_context: "P2", sequence: 1 });
  const attackerMsg = envelope({ message_id: "m-attacker", run_id: "R1", task_id: "T1",
    trace_id: "trA", sender: "mallory", receiver: "mallory", policy_context: "P1", sequence: 1 });
  rt.sendMessage(victimMsg);
  rt.sendMessage(attackerMsg);
  // Secret written under the victim's message: run R2, readable only by victim.
  rt.writeMemory("the secret", victimMsg, { memory_id: "secret", allowed_readers: ["victim"] });
  return { rt, victimMsg, attackerMsg };
}

test("honest read with the canonical victim envelope admits the secret", () => {
  const { rt, victimMsg } = setup();
  try {
    const admitted = rt.readMemory({ text: "secret" }, victimMsg, { condition: "C5" });
    assert.deepEqual(admitted.map((m) => m.memory_id), ["secret"]);
  } finally { rt.close(); }
});

test("forged active message (existing id, swapped run/receiver/policy/parent) fails closed", () => {
  const { rt } = setup();
  try {
    // Same existing message_id as the attacker's real message, but every security field forged to
    // impersonate victim@R2 and point provenance at the victim's message.
    const forged = envelope({ message_id: "m-attacker", run_id: "R2", task_id: "T2",
      receiver: "victim", policy_context: "P2", parent_message_id: "m-victim" });
    assert.throws(
      () => rt.readMemory({ text: "secret" }, forged, { condition: "C5" }),
      /active_message_envelope_mismatch/,
    );
  } finally { rt.close(); }
});

test("each individual forged security field is rejected", () => {
  const { rt } = setup();
  try {
    const fields = {
      run_id: "R2", task_id: "T2", trace_id: "trV", receiver: "victim",
      intent: "confirm_constraint", policy_context: "P2",
      parent_message_id: "m-victim", delegated_from: "m-victim", sequence: 999,
    };
    for (const [field, value] of Object.entries(fields)) {
      const forged = envelope({ message_id: "m-attacker", [field]: value });
      assert.throws(
        () => rt.readMemory({ text: "secret" }, forged, { condition: "C5" }),
        new RegExp(`active_message_envelope_mismatch.*${field}`),
        `forged ${field} should fail closed`,
      );
    }
  } finally { rt.close(); }
});

test("write-time source-envelope substitution cannot forge provenance", () => {
  const { rt } = setup();
  try {
    const forged = envelope({ message_id: "m-attacker", run_id: "R2", task_id: "T2", receiver: "victim" });
    assert.throws(
      () => rt.writeMemory("planted", forged, { memory_id: "planted" }),
      /active_message_envelope_mismatch/,
    );
  } finally { rt.close(); }
});

test("audit replay does not certify a forged active snapshot as clean", () => {
  const { rt, victimMsg } = setup();
  try {
    // Perform an honest read so a read manifest exists, then tamper the stored active snapshot to a
    // forged principal and confirm replay flags it (it re-runs against the canonical envelope).
    rt.readMemory({ text: "secret" }, victimMsg, { condition: "C5" });
    rt.db.prepare("UPDATE memory_reads SET active_message_json = ? WHERE run_id = 'R2'")
      .run(JSON.stringify({ message_id: "m-victim", run_id: "R2", task_id: "T2", trace_id: "trV",
        receiver: "mallory", intent: "produce_final_plan", policy_context: "P9",
        parent_message_id: null, delegated_from: null, sequence: 1 }));
    const replay = rt.replayMemoryReads("R2");
    assert.equal(replay.ok, false);
    assert.ok(replay.issues.some((i) => i.kind === "active_message_envelope_mismatch"),
      `expected envelope mismatch, got ${JSON.stringify(replay.issues)}`);
  } finally { rt.close(); }
});
