import test from "node:test";
import assert from "node:assert/strict";

import {
  assertC4C5OnlyDifferByBinding,
  buildConditionMatrix,
  getConditionSpec,
  normalizeCondition,
} from "../benchmarks/coupled_memory/conditions.mjs";
import { checkCoupledMemoryPhase3 } from "../scripts/check_coupled_memory_phase3.mjs";
import { checkCoupledMemoryPhase4 } from "../scripts/check_coupled_memory_phase4.mjs";
import { checkCoupledMemoryPhase5 } from "../scripts/check_coupled_memory_phase5.mjs";
import { checkCoupledMemoryPhase6Live } from "../scripts/check_coupled_memory_phase6_live.mjs";
import { checkAutoGenNative } from "../scripts/check_coupled_memory_autogen_native.mjs";
import { checkLangGraphNative } from "../scripts/check_coupled_memory_langgraph_native.mjs";
import { checkDropInProtocolReplacement } from "../scripts/check_dropin_protocol_replacement.mjs";
import { CoupledMemoryRuntime, memoryContentHash } from "../benchmarks/coupled_memory/runtime.mjs";
import {
  runTwinRunContaminationProof,
  runTwinRunMatrix,
  seedTwinRunFixture,
  twinRunMessages,
} from "../benchmarks/coupled_memory/twin_run.mjs";

function insertRawMemory(runtime, overrides = {}) {
  const row = {
    memory_id: "mem-raw",
    run_id: "run-B",
    task_id: "deploy",
    trace_id: "trace-B",
    source_message_id: "msg-B-planner-constraint",
    writer: "planner",
    memory_type: "constraint",
    scope: "task",
    status: "active",
    content: "Raw deployment constraint.",
    content_ref: null,
    allowed_readers_json: JSON.stringify(["executor"]),
    supersedes_json: "[]",
    valid_from_event: null,
    valid_until_event: null,
    policy_context: "policy-003",
    audit_hash: "sha256:test",
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    ...overrides,
  };
  // Stamp a valid canonical content hash (matching writeMemory) so the gate's integrity check
  // passes and the test exercises the INTENDED predicate (task/status/reader/...), not a spurious
  // integrity_mismatch from a placeholder hash.
  // Hash the CLEAN canonical shape (exactly what memoryFromRow yields at read time): no raw *_json
  // columns, no audit_hash/timestamps. The integrity hash is now generic over all content fields
  // (review M4), so stray keys would change it.
  row.audit_hash = memoryContentHash({
    memory_id: row.memory_id, run_id: row.run_id, task_id: row.task_id, trace_id: row.trace_id,
    source_message_id: row.source_message_id, writer: row.writer, memory_type: row.memory_type,
    scope: row.scope, status: row.status, content: row.content, content_ref: row.content_ref,
    allowed_readers: JSON.parse(row.allowed_readers_json), supersedes: JSON.parse(row.supersedes_json),
    valid_from_event: row.valid_from_event, valid_until_event: row.valid_until_event,
    policy_context: row.policy_context,
  });
  runtime.db.prepare(`
    INSERT INTO shared_memory (
      memory_id, run_id, task_id, trace_id, source_message_id, writer,
      memory_type, scope, status, content, content_ref, allowed_readers_json,
      supersedes_json, valid_from_event, valid_until_event, policy_context,
      audit_hash, created_at, updated_at
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    row.memory_id,
    row.run_id,
    row.task_id,
    row.trace_id,
    row.source_message_id,
    row.writer,
    row.memory_type,
    row.scope,
    row.status,
    row.content,
    row.content_ref,
    row.allowed_readers_json,
    row.supersedes_json,
    row.valid_from_event,
    row.valid_until_event,
    row.policy_context,
    row.audit_hash,
    row.created_at,
    row.updated_at,
  );
}

test("C0-C5 condition matrix has explicit protocol-swap feature flags", () => {
  const matrix = buildConditionMatrix();
  assert.equal(matrix.length, 6);
  assert.deepEqual(matrix.map((item) => item.id), ["C0", "C1", "C2", "C3", "C4", "C5"]);
  for (const condition of matrix) {
    assert.equal(typeof condition.communication, "string");
    assert.equal(typeof condition.shared_memory, "string");
    assert.equal(typeof condition.coupling, "string");
    assert.equal(typeof condition.purpose, "string");
    for (const key of ["typedEnvelope", "sharedMemory", "scopedMemory", "causalEnvelope", "messageBoundMemory"]) {
      assert.equal(typeof condition.features[key], "boolean", `${condition.id}.${key}`);
    }
  }
});

test("condition ids normalize predictably and reject unknown variants", () => {
  assert.equal(normalizeCondition("c5"), "C5");
  assert.equal(getConditionSpec("C4").coupling, "uncoupled");
  assert.throws(() => normalizeCondition("C6"), /unknown condition/);
});

test("C4 and C5 differ only by message-bound memory access", () => {
  const parity = assertC4C5OnlyDifferByBinding();
  assert.equal(parity.differing_feature, "messageBoundMemory");
  const c4 = getConditionSpec("C4").features;
  const c5 = getConditionSpec("C5").features;
  assert.equal(c4.typedEnvelope, c5.typedEnvelope);
  assert.equal(c4.sharedMemory, c5.sharedMemory);
  assert.equal(c4.scopedMemory, c5.scopedMemory);
  assert.equal(c4.causalEnvelope, c5.causalEnvelope);
  assert.equal(c4.messageBoundMemory, false);
  assert.equal(c5.messageBoundMemory, true);
});

test("C5 memory reads require an active message context", () => {
  const runtime = new CoupledMemoryRuntime();
  try {
    assert.throws(
      () => runtime.readMemory({ text: "deployment constraint" }, null, { condition: "C5" }),
      /requires currentMessage/,
    );
  } finally {
    runtime.close();
  }
});

test("C5 memory reads require the current message to exist in the event graph", () => {
  const runtime = new CoupledMemoryRuntime();
  try {
    const { executorB } = twinRunMessages();
    assert.throws(
      () => runtime.readMemory({ text: "deployment constraint" }, executorB, { condition: "C5" }),
      /active message not found/,
    );
  } finally {
    runtime.close();
  }
});

test("C5 filters wrong-run memory and records access decisions", () => {
  const runtime = new CoupledMemoryRuntime();
  try {
    const messages = seedTwinRunFixture(runtime);
    const injected = runtime.readMemory(
      { text: "deployment storage constraint", memory_type: "constraint" },
      messages.executorB,
      { condition: "C5" },
    );
    assert.deepEqual(injected.map((memory) => memory.memory_id), ["mem-B-constraint"]);
    const audit = runtime.auditRun("run-B");
    assert.equal(audit.memory_access_decisions.length, 2);
    assert.ok(audit.memory_access_decisions.some((item) => item.memory_id === "mem-A-constraint" && item.decision === "deny"));
    assert.ok(audit.memory_access_decisions.some((item) => item.memory_id === "mem-B-constraint" && item.decision === "allow"));
  } finally {
    runtime.close();
  }
});

test("C5 gates prove task, status, reader, provenance, intent, and policy checks", () => {
  const runtime = new CoupledMemoryRuntime();
  try {
    const messages = seedTwinRunFixture(runtime);
    insertRawMemory(runtime, {
      memory_id: "mem-wrong-task",
      task_id: "other-task",
      content: "Wrong task deployment constraint.",
    });
    insertRawMemory(runtime, {
      memory_id: "mem-inactive",
      status: "superseded",
      content: "Superseded deployment constraint.",
    });
    insertRawMemory(runtime, {
      memory_id: "mem-wrong-reader",
      allowed_readers_json: JSON.stringify(["verifier"]),
      content: "Unauthorized reader deployment constraint.",
    });
    insertRawMemory(runtime, {
      memory_id: "mem-missing-provenance",
      source_message_id: "msg-missing-source",
      content: "Missing provenance deployment constraint.",
    });
    insertRawMemory(runtime, {
      memory_id: "mem-wrong-intent-type",
      memory_type: "private_note",
      content: "Intent-incompatible deployment constraint.",
    });
    insertRawMemory(runtime, {
      memory_id: "mem-wrong-policy",
      policy_context: "policy-999",
      content: "Wrong policy deployment constraint.",
    });
    const injected = runtime.readMemory(
      { text: "deployment constraint" },
      messages.executorB,
      { condition: "C5" },
    );
    assert.deepEqual(injected.map((memory) => memory.memory_id), ["mem-B-constraint"]);
    const decisions = runtime.auditRun("run-B").memory_access_decisions;
    const byMemory = new Map(decisions.map((item) => [item.memory_id, item.reason]));
    assert.equal(byMemory.get("mem-A-constraint"), "run_id_mismatch");
    assert.equal(byMemory.get("mem-wrong-task"), "task_scope_mismatch");
    assert.equal(byMemory.get("mem-inactive"), "inactive_memory");
    assert.equal(byMemory.get("mem-wrong-reader"), "reader_not_authorized");
    assert.equal(byMemory.get("mem-missing-provenance"), "missing_provenance_message");
    assert.equal(byMemory.get("mem-wrong-intent-type"), "intent_memory_type_mismatch");
    assert.equal(byMemory.get("mem-wrong-policy"), "policy_context_mismatch");
    assert.equal(byMemory.get("mem-B-constraint"), "message_bound_access_granted");
  } finally {
    runtime.close();
  }
});

test("Twin-Run proof isolates C4 versus C5 message-bound memory", () => {
  const c4 = runTwinRunContaminationProof({ condition: "C4" });
  const c5 = runTwinRunContaminationProof({ condition: "C5" });
  assert.equal(c4.success, false);
  assert.equal(c4.wrong_scope_memory_use, 1);
  assert.deepEqual(c4.injected_memory_ids, ["mem-A-constraint", "mem-B-constraint"]);
  assert.equal(c5.success, true);
  assert.equal(c5.wrong_scope_memory_use, 0);
  assert.deepEqual(c5.injected_memory_ids, ["mem-B-constraint"]);
});

test("Twin-Run matrix makes only C5 pass the deterministic contamination proof", () => {
  const result = runTwinRunMatrix();
  assert.equal(result.cases.length, 6);
  const successes = result.cases.filter((item) => item.success).map((item) => item.condition);
  assert.deepEqual(successes, ["C5"]);
});

test("coupled benchmark result carries condition matrix and C4-C5 parity metadata", async () => {
  const { runCoupledMemoryBenchmark } = await import("../benchmarks/coupled_memory_benchmark.mjs");
  const result = runCoupledMemoryBenchmark({ scenario: "twin_run", condition: "C4,C5" });
  assert.deepEqual(result.condition_matrix.map((item) => item.id), ["C4", "C5"]);
  assert.equal(result.c4_c5_parity.differing_feature, "messageBoundMemory");
  assert.deepEqual(result.summary.map((item) => item.condition), ["C4", "C5"]);
});

test("Phase 3 checker accepts the deterministic Twin-Run proof artifact shape", async () => {
  const { runCoupledMemoryBenchmark } = await import("../benchmarks/coupled_memory_benchmark.mjs");
  const result = runCoupledMemoryBenchmark({ scenario: "twin_run", condition: "all" });
  const check = checkCoupledMemoryPhase3(result);
  assert.equal(check.status, "PASS");
  assert.deepEqual(check.failures, []);
  assert.equal(check.checked.c4_wrong_scope_memory_use, 1);
  assert.equal(check.checked.c5_wrong_scope_memory_use, 0);
});

test("Phase 4 dev suite covers full 9x3 deterministic split with C5-only success", async () => {
  const { runCoupledMemoryBenchmark } = await import("../benchmarks/coupled_memory_benchmark.mjs");
  const result = runCoupledMemoryBenchmark({ scenario: "phase4_dev", condition: "all" });
  assert.equal(result.scenarios.length, 27);
  assert.equal(result.cases.length, 162);
  const check = checkCoupledMemoryPhase4(result);
  assert.equal(check.status, "PASS");
  assert.deepEqual(check.failures, []);
  assert.equal(check.checked.scenario_family_count, 9);
  assert.equal(check.checked.scenario_instance_count, 27);
  for (const scenario of result.scenarios) {
    const cases = result.cases.filter((item) => item.scenario_id === scenario.scenario_id);
    assert.deepEqual(cases.filter((item) => item.success).map((item) => item.condition), ["C5"]);
  }
});

test("Phase 4 main suite covers full 9x20 deterministic split with C5-only success", async () => {
  const { runCoupledMemoryBenchmark } = await import("../benchmarks/coupled_memory_benchmark.mjs");
  const result = runCoupledMemoryBenchmark({ scenario: "phase4_main", condition: "all" });
  const check = checkCoupledMemoryPhase4(result, {
    benchmark: "coupled-memory-phase4-main-suite",
    instancesPerType: 20,
  });
  assert.equal(check.status, "PASS");
  assert.equal(check.checked.scenario_family_count, 9);
  assert.equal(check.checked.scenario_instance_count, 180);
  assert.equal(check.checked.case_count, 1080);
  assert.equal(check.checked.c5_successes, 180);
  assert.equal(check.checked.c4_failures, 180);
});

test("Phase 5 harness adapter parity suite preserves C5-only success across adapters", async () => {
  const { runCoupledMemoryBenchmark } = await import("../benchmarks/coupled_memory_benchmark.mjs");
  const result = runCoupledMemoryBenchmark({ scenario: "phase5_harness", condition: "all" });
  const check = checkCoupledMemoryPhase5(result);
  assert.equal(check.status, "PASS");
  assert.deepEqual(check.failures, []);
  assert.equal(check.checked.harness_count, 2);
  assert.equal(check.checked.scenario_count, 27);
  assert.equal(check.checked.case_count, 324);
  assert.equal(check.checked.c5_successes, 54);
  assert.equal(check.checked.c4_failures, 54);
});

test("Phase 5 native LangGraph adapter preserves C5-only success", async (t) => {
  const { runCoupledMemoryLangGraphBenchmark } = await import("../benchmarks/coupled_memory_langgraph_benchmark.mjs");
  const result = await runCoupledMemoryLangGraphBenchmark({ condition: "all" });
  if (result?.skipped) { t.skip(result.reason); return; }
  const check = checkLangGraphNative(result);
  assert.equal(check.status, "PASS");
  assert.deepEqual(check.failures, []);
  assert.equal(check.checked.scenario_count, 27);
  assert.equal(check.checked.case_count, 162);
  assert.equal(check.checked.c5_successes, 27);
  assert.equal(check.checked.c4_failures, 27);
});

test("Phase 5 native AutoGen adapter preserves C5-only success", async (t) => {
  const { runCoupledMemoryAutoGenBenchmark } = await import("../benchmarks/coupled_memory_autogen_benchmark.mjs");
  const result = runCoupledMemoryAutoGenBenchmark({ condition: "all" });
  if (result?.skipped) { t.skip(result.reason); return; }
  const check = checkAutoGenNative(result);
  assert.equal(check.status, "PASS");
  assert.deepEqual(check.failures, []);
  assert.equal(check.checked.autogen_agentchat, "0.7.5");
  assert.equal(check.checked.autogen_core, "0.7.5");
  assert.equal(check.checked.scenario_count, 27);
  assert.equal(check.checked.case_count, 162);
  assert.equal(check.checked.c5_successes, 27);
  assert.equal(check.checked.c4_failures, 27);
});

test("drop-in protocol replacement changes only the protocol wrapper", async () => {
  const { runDropInProtocolReplacementBenchmark } = await import("../benchmarks/coupled_memory_dropin_benchmark.mjs");
  const result = runDropInProtocolReplacementBenchmark({ instancesPerFamily: 3 });
  const check = checkDropInProtocolReplacement(result);
  assert.equal(check.status, "PASS");
  assert.equal(check.checked.same_agent_controls, true);
  assert.equal(check.checked.scenario_count, 27);
  assert.equal(check.checked.case_count, 54);
  assert.equal(check.checked.legacy_failures, 27);
  assert.equal(check.checked.acmcp_successes, 27);
});

test("Phase 6 live checker accepts paired C4/C5 live artifact shape", () => {
  const fixture = {
    benchmark: "coupled-memory-phase6-live-model",
    live: true,
    model: "gpt-5-nano",
    c4_c5_parity: { differing_feature: "messageBoundMemory" },
    cases: [
      {
        scenario_id: "s1",
        condition: "C4",
        run_index: 0,
        api_error: "",
        model_success: false,
      },
      {
        scenario_id: "s1",
        condition: "C5",
        run_index: 0,
        api_error: "",
        model_success: true,
      },
    ],
  };
  const check = checkCoupledMemoryPhase6Live(fixture);
  assert.equal(check.status, "PASS");
  assert.equal(check.checked.paired_cases, 1);
  assert.equal(check.checked.paired_delta_success_rate, 1);
});
