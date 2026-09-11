// Locks the review-3 soundness fixes into `npm test` so a regression fails CI, not just the gates.
import test from "node:test";
import assert from "node:assert/strict";

import { causalAncestryFromMessages } from "../benchmarks/coupled_memory/causal.mjs";
import { CoupledMemoryRuntime } from "../benchmarks/coupled_memory/runtime.mjs";
import { evaluateMemoryGateStandalone, ancestorClosureFor } from "../benchmarks/external/mbm_gate.mjs";
import { INTENT_MEMORY_TYPES } from "../benchmarks/coupled_memory/constants.mjs";
import { replayRun } from "../scripts/audit_replay.mjs";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// ---- M4: temporally validated happens-before ----
test("M4: a future event cannot be a causal ancestor", () => {
  const closure = causalAncestryFromMessages(
    [{ message_id: "active", parent_message_id: "future", sequence: 1 }, { message_id: "future", sequence: 99 }],
    { message_id: "active", parent_message_id: "future", sequence: 1 });
  assert.equal(closure.has("future"), false, "future (seq 99) must not be an ancestor of active (seq 1)");
});

test("M4: a genuine prior ancestor is still included", () => {
  const closure = causalAncestryFromMessages(
    [{ message_id: "child", parent_message_id: "root", sequence: 5 }, { message_id: "root", sequence: 2 }],
    { message_id: "child", parent_message_id: "root", sequence: 5 });
  assert.ok(closure.has("root") && closure.has("child"));
});

// ---- M7: external gate matches the central runtime, incl. metadata-light records ----
test("M7: external gate verdicts match the central runtime", () => {
  const rt = new CoupledMemoryRuntime({});
  rt.ensureRun("R");
  const active = rt.sendMessage({ message_id: "msgA", run_id: "R", task_id: "T", trace_id: "tr", sender: "s", receiver: "reader", intent: "share", state: "active", sequence: 1, policy_context: "P" });
  const msgs = rt.db.prepare("SELECT message_id,parent_message_id,delegated_from,sequence,created_at FROM messages WHERE run_id='R'").all();
  const closure = ancestorClosureFor(msgs, active);
  const known = new Set(msgs.map((m) => m.message_id));
  const base = { memory_id: "m", run_id: "R", task_id: "T", trace_id: "tr", source_message_id: "msgA", writer: "w", memory_type: "summary", scope: "task", status: "active", content: "x", allowed_readers: ["*"], policy_context: "P" };
  const battery = [base, { ...base, status: undefined }, { ...base, allowed_readers: undefined }, { ...base, run_id: "OTHER" }, { ...base, allowed_readers: ["x"] }, { ...base, policy_context: "Q" }];
  for (const mem of battery) {
    const c = rt.evaluateMemoryGate(mem, active, { causalClosure: closure });
    const e = evaluateMemoryGateStandalone(mem, active, { eventGraph: closure, knownMessageIds: known, intentMemoryTypes: INTENT_MEMORY_TYPES });
    assert.deepEqual({ d: e.decision, r: e.reason }, { d: c.decision, r: c.reason }, `divergence on ${JSON.stringify(mem)}`);
  }
  rt.close();
});

// ---- M2: independent audit replay catches a deleted decision log ----
test("M2: replay flags a wiped decision log (no silent ok)", () => {
  const dbPath = join(mkdtempSync(join(tmpdir(), "rr-")), "t.db");
  const rt = new CoupledMemoryRuntime({ dbPath });
  rt.ensureRun("run1");
  const msg = rt.sendMessage({ message_id: "m1", run_id: "run1", task_id: "t1", trace_id: "tr", sender: "a", receiver: "b", intent: "share", state: "active", sequence: 1, policy_context: "P" });
  rt.writeMemory("ADMIT", msg, { memory_id: "mem-ok", allowed_readers: ["*"] });
  const admitted = rt.readMemory({}, msg, { condition: "C5" });
  rt.close();
  assert.equal(admitted.length, 1);
  assert.equal(replayRun(dbPath, "run1").ok, true, "clean run replays ok");
  const db = new DatabaseSync(dbPath);
  db.prepare("DELETE FROM memory_access_decisions WHERE run_id='run1'").run();
  db.close();
  const r = replayRun(dbPath, "run1");
  assert.equal(r.ok, false, "wiped decision log must not pass");
  assert.ok(r.issues.some((i) => i.kind === "missing_decision"));
});
