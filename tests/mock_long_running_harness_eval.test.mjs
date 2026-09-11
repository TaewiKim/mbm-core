import assert from "node:assert/strict";
import test from "node:test";

import {
  LONG_RUNNING_SCENARIOS,
  MOCK_HARNESSES,
  PROTOCOL_CONDITIONS,
  runMockBenchmark,
  runMockOne,
} from "../benchmarks/mock_long_running_harness_eval.mjs";

test("mock benchmark covers the expected harnesses, conditions, and scenarios", () => {
  assert.deepEqual(MOCK_HARNESSES, ["langgraph", "autogen", "crewai", "openhands"]);
  assert.deepEqual(PROTOCOL_CONDITIONS, ["C0", "C1", "C2", "C3", "C4", "C5"]);
  assert.ok(LONG_RUNNING_SCENARIOS.includes("pause_resume_deferred_constraint"));
  assert.ok(LONG_RUNNING_SCENARIOS.includes("audit_reconstruction"));
});

test("coupled condition beats uncoupled strong condition in each harness on average", () => {
  for (const harness of MOCK_HARNESSES) {
    const c4 = runMockBenchmark({
      harness,
      condition: "C4",
      scenario: "all",
      runs: 3,
      seed: 10,
      includeRaw: false,
    });
    const c5 = runMockBenchmark({
      harness,
      condition: "C5",
      scenario: "all",
      runs: 3,
      seed: 10,
      includeRaw: false,
    });
    const mean = (result) =>
      result.results.reduce((total, row) => total + row.long_running_harness_protocol_score, 0) /
      result.results.length;
    assert.ok(mean(c5) > mean(c4), `${harness} C5 should beat C4`);
  }
});

test("memory-only retrieves better memory signal but has weak causal binding", () => {
  const row = runMockOne({
    harness: "langgraph",
    condition: "C2",
    scenario: "long_horizon_drift",
    seed: 7,
  });
  assert.ok(row.memory_protocol_integrity > 0.2);
  assert.ok(row.causal_memory_binding < 0.55);
  assert.equal(row.coupling, "uncoupled");
});

test("mock rows are explicitly marked as non-LLM performance", () => {
  const row = runMockOne({
    harness: "autogen",
    condition: "C5",
    scenario: "private_memory_summary",
    seed: 3,
  });
  assert.equal(row.api_key_required, false);
  assert.equal(row.not_llm_performance, true);
  assert.equal(row.alignment_status, "mock-validation");
});
