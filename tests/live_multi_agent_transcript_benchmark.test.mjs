import test from "node:test";
import assert from "node:assert/strict";

import {
  FINAL_PROTOCOL,
  TIER2_PROTOCOLS,
  runTier2TranscriptBenchmark,
} from "../benchmarks/live_multi_agent_transcript_benchmark.mjs";

test("tier2 transcript dry-run compares final protocol with typed baseline", async () => {
  const result = await runTier2TranscriptBenchmark({
    protocols: ["typed-envelope", FINAL_PROTOCOL],
    scenarios: ["scoped_memory_privacy"],
    runs: 1,
    seed: 7,
    maxCasesPerScenario: 1,
    data: undefined,
    model: "dry-run-transcript",
    live: false,
  });
  assert.equal(result.final_protocol, FINAL_PROTOCOL);
  assert.equal(result.cases.length, 2);
  assert.ok(result.cases.every((item) => item.transcript_events > 0));
  const core = result.cases.find((item) => item.protocol === FINAL_PROTOCOL);
  const typed = result.cases.find((item) => item.protocol === "typed-envelope");
  assert.equal(core.metrics.secret_leak_events, 0);
  assert.ok(typed.metrics.secret_leak_events > 0);
});

test("tier2 frontier baselines are accepted in dry-run", async () => {
  const protocols = [
    "mpac-coordination",
    "mesh-memory",
    "q-kvcomm-compressed",
    FINAL_PROTOCOL,
  ];
  for (const protocol of protocols) {
    assert.ok(TIER2_PROTOCOLS.includes(protocol));
  }
  const result = await runTier2TranscriptBenchmark({
    protocols,
    scenarios: ["context_manifest_stress"],
    runs: 1,
    seed: 8,
    maxCasesPerScenario: 1,
    data: undefined,
    model: "dry-run-transcript",
    live: false,
  });
  assert.equal(result.cases.length, protocols.length);
  assert.ok(result.cases.every((item) => item.transcript_events > 0));
});
