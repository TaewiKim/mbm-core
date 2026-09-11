import assert from "node:assert/strict";
import test from "node:test";

import {
  DEFAULT_OPENAI_MODEL,
  HeuristicModelClient,
  LLM_SCENARIOS,
  OpenAIResponsesClient,
  PROTOCOLS,
  runLlmSimulator,
  runSimulatorCase,
} from "../benchmarks/llm_agent_simulator.mjs";

test("default model is GPT-5.4 mini", () => {
  assert.equal(DEFAULT_OPENAI_MODEL, "gpt-5.4-mini");
});

test("dry-run simulator covers every protocol and scenario", async () => {
  const result = await runLlmSimulator({
    scenario: "all",
    protocol: "all",
    runs: 1,
    seed: 1,
    model: DEFAULT_OPENAI_MODEL,
    live: false,
    reasoningEffort: "",
  });
  assert.equal(result.results.length, PROTOCOLS.length * LLM_SCENARIOS.length);
  for (const row of result.results) {
    assert.equal(row.invalid_messages, 0);
  }
});

test("causal-reliable covers recovery metadata", async () => {
  const item = await runSimulatorCase({
    scenario: "causal_recovery",
    protocol: "causal-reliable",
    modelClient: new HeuristicModelClient({ model: DEFAULT_OPENAI_MODEL }),
    runIndex: 3,
  });
  assert.equal(item.success, true);
  assert.equal(item.trace_coverage, 1);
  assert.equal(item.idempotency_coverage, 1);
});

test("context-budgeted reduces wire bytes versus baseline", async () => {
  const modelClient = new HeuristicModelClient({ model: DEFAULT_OPENAI_MODEL });
  const baseline = await runSimulatorCase({
    scenario: "context_budget",
    protocol: "baseline",
    modelClient,
    runIndex: 4,
  });
  const budgeted = await runSimulatorCase({
    scenario: "context_budget",
    protocol: "context-budgeted",
    modelClient,
    runIndex: 4,
  });
  assert.equal(budgeted.success, true);
  assert.ok(budgeted.wire_bytes < baseline.wire_bytes);
});

test("live OpenAI client requires an API key", () => {
  assert.throws(
    () => new OpenAIResponsesClient({ apiKey: "", model: DEFAULT_OPENAI_MODEL }),
    /OPENAI_API_KEY/,
  );
});
