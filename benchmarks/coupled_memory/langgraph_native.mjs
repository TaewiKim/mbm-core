import {
  Annotation,
  END,
  MemorySaver,
  START,
  StateGraph,
} from "@langchain/langgraph";

import { buildConditionMatrix, assertC4C5OnlyDifferByBinding } from "./conditions.mjs";
import { COUPLED_MEMORY_CONDITIONS } from "./constants.mjs";
import { PHASE4_SCENARIOS, runPhase4Scenario } from "./scenarios.mjs";

const LangGraphState = Annotation.Root({
  scenario: Annotation(),
  condition: Annotation(),
  result: Annotation(),
});

export async function runLangGraphNativeCase({ scenario, condition }) {
  const graph = new StateGraph(LangGraphState)
    .addNode("run_protocol_condition", async (state) => ({
      result: runPhase4Scenario({
        scenario: state.scenario,
        condition: state.condition,
      }),
    }))
    .addEdge(START, "run_protocol_condition")
    .addEdge("run_protocol_condition", END)
    .compile({
      checkpointer: new MemorySaver(),
      name: "coupled-memory-langgraph-native-adapter",
    });

  const output = await graph.invoke(
    { scenario, condition },
    { configurable: { thread_id: `${scenario.scenario_id}:${condition}` } },
  );
  return {
    ...output.result,
    harness_id: "langgraph-native",
    harness_type: "native-sdk",
  };
}

export async function runLangGraphNativeSuite({
  scenarios = PHASE4_SCENARIOS,
  conditions = COUPLED_MEMORY_CONDITIONS,
} = {}) {
  const cases = [];
  for (const scenario of scenarios) {
    for (const condition of conditions) {
      cases.push(await runLangGraphNativeCase({ scenario, condition }));
    }
  }
  return {
    benchmark: "coupled-memory-phase5-langgraph-native-suite",
    live: false,
    adapter_status: "native-sdk",
    harnesses: [{
      harness_id: "langgraph-native",
      harness_type: "native-sdk",
      package: "@langchain/langgraph",
      sdk_features: ["StateGraph", "MemorySaver", "thread_id"],
    }],
    scenarios: scenarios.map((item) => ({
      scenario_id: item.scenario_id,
      scenario_type: item.scenario_type,
    })),
    condition_matrix: buildConditionMatrix(conditions),
    c4_c5_parity: assertC4C5OnlyDifferByBinding(),
    cases,
    summary: cases.map((item) => ({
      harness_id: item.harness_id,
      scenario_id: item.scenario_id,
      scenario_type: item.scenario_type,
      condition: item.condition,
      success: item.success,
      wrong_scope_memory_use: item.wrong_scope_memory_use,
      stale_memory_use: item.stale_memory_use,
      missing_critical_memory: item.missing_critical_memory,
      forbidden_memory_use: item.forbidden_memory_use,
      causal_memory_binding: item.causal_memory_binding,
      event_graph_reconstructability: item.event_graph_reconstructability,
    })),
  };
}
