import assert from "node:assert/strict";
import test from "node:test";

import {
  ReferenceJsonProtocol,
  SCENARIOS,
  runBenchmark,
  runOne,
} from "../benchmarks/agent_comm_benchmark.mjs";

test("all scenarios succeed without loss", () => {
  const protocol = new ReferenceJsonProtocol();
  SCENARIOS.forEach((scenarioName, index) => {
    const metrics = runOne({
      scenarioName,
      protocol,
      seed: 100 + index,
      lossRate: 0,
      duplicateRate: 0,
    });
    assert.equal(metrics.completed_tasks, 1, scenarioName);
    assert.equal(metrics.invalid_envelopes, 0, scenarioName);
    assert.equal(metrics.decode_errors, 0, scenarioName);
  });
});

test("summary contains core metrics", () => {
  const result = runBenchmark({
    scenario: "all",
    runs: 2,
    seed: 10,
    lossRate: 0,
    duplicateRate: 0,
  });
  assert.equal(result.runs_per_scenario, 2);
  assert.equal(result.results.length, SCENARIOS.length);
  for (const row of result.results) {
    assert.equal(row.success_rate, 1);
    assert.ok(row.trace_coverage > 0.99);
    assert.equal(row.invalid_envelopes, 0);
    assert.equal(Number.isNaN(row.p50_latency_ms), false);
  }
});

test("recovery timeout records retry", () => {
  const metrics = runOne({
    scenarioName: "recovery_timeout",
    protocol: new ReferenceJsonProtocol(),
    seed: 33,
    lossRate: 0,
    duplicateRate: 0,
  });
  assert.equal(metrics.completed_tasks, 1);
  assert.equal(metrics.retries, 1);
  assert.ok(metrics.timeouts >= 1);
});

test("duplicate transport events are observed", () => {
  const metrics = runOne({
    scenarioName: "policy_boundary",
    protocol: new ReferenceJsonProtocol(),
    seed: 44,
    lossRate: 0,
    duplicateRate: 1,
  });
  assert.equal(metrics.completed_tasks, 1);
  assert.ok(metrics.duplicates_seen > 0);
});
