import assert from "node:assert/strict";
import test from "node:test";

import {
  AGENTPROTOCOLS_RUNNERS,
  ALIGNMENT_STATUS,
  LITERATURE_TARGET,
  runOfficialCommunicationBenchmark,
} from "../benchmarks/official_comm_benchmark_adapter.mjs";
import { OFFICIAL_BENCHMARK_REPOS } from "../scripts/download_official_benchmarks.mjs";

test("official AgentProtocols adapter declares literature alignment metadata", () => {
  assert.equal(ALIGNMENT_STATUS, "official-adapter");
  assert.match(LITERATURE_TARGET, /ProtocolBench|AgentProtocols/);
  assert.equal(OFFICIAL_BENCHMARK_REPOS.agentprotocols.url, "https://github.com/ulab-uiuc/AgentProtocols.git");
  assert.equal(OFFICIAL_BENCHMARK_REPOS.agentprotocols.license, "MIT");
});

test("dry-run builds official routerbench command", () => {
  const result = runOfficialCommunicationBenchmark({
    scenario: "routerbench",
    protocol: "router",
    officialRepoPath: "external/official/AgentProtocols",
    outputDir: "results/official_comm",
    python: "python",
    limit: 1,
    timeoutMs: 1_000,
    dryRun: true,
  });

  assert.equal(result.alignment_status, "official-adapter");
  assert.equal(result.results.length, 1);
  const row = result.results[0];
  assert.equal(row.uses_official_runner, true);
  assert.equal(row.uses_official_dataset, true);
  assert.deepEqual(row.args.slice(0, 1), ["routerbench/run_benchmark.py"]);
  assert.ok(row.args.includes("--limit"));
});

test("dry-run skips unsupported protocol and scenario pairs", () => {
  const result = runOfficialCommunicationBenchmark({
    scenario: "routerbench",
    protocol: "all",
    officialRepoPath: "external/official/AgentProtocols",
    outputDir: "results/official_comm",
    python: "python",
    limit: 1,
    timeoutMs: 1_000,
    dryRun: true,
  });

  assert.equal(result.results.length, 1);
  assert.equal(result.results[0].protocol, "router");
});

test("known official AgentProtocols runners are registered", () => {
  assert.deepEqual(AGENTPROTOCOLS_RUNNERS.gaia.a2a, ["-m", "scenarios.gaia.runners.run_a2a"]);
  assert.deepEqual(AGENTPROTOCOLS_RUNNERS.safety_tech.anp, [
    "-m",
    "scenarios.safety_tech.runners.run_unified_security_test_anp",
  ]);
});
