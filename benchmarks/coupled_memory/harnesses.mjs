import { buildConditionMatrix, assertC4C5OnlyDifferByBinding } from "./conditions.mjs";
import { COUPLED_MEMORY_CONDITIONS } from "./constants.mjs";
import { PHASE4_SCENARIOS, runPhase4Scenario } from "./scenarios.mjs";

export const PHASE5_HARNESSES = [
  {
    harness_id: "sqlite-reference",
    harness_type: "reference-runtime",
    description: "Direct SQLite queue/shared-memory runtime substrate.",
  },
  {
    harness_id: "langgraph-checkpoint-shim",
    harness_type: "adapter-parity-shim",
    description: "LangGraph-shaped checkpoint/state-history adapter shim without external SDK dependency.",
  },
];

export function runHarnessScenario({ harness, scenario, condition }) {
  const item = runPhase4Scenario({ scenario, condition });
  return {
    ...item,
    harness_id: harness.harness_id,
    harness_type: harness.harness_type,
  };
}

export function runPhase5HarnessSuite({
  harnesses = PHASE5_HARNESSES,
  scenarios = PHASE4_SCENARIOS,
  conditions = COUPLED_MEMORY_CONDITIONS,
} = {}) {
  const cases = [];
  for (const harness of harnesses) {
    for (const scenario of scenarios) {
      for (const condition of conditions) {
        cases.push(runHarnessScenario({ harness, scenario, condition }));
      }
    }
  }
  return {
    benchmark: "coupled-memory-phase5-harness-adapter-suite",
    live: false,
    adapter_status: "parity-shim",
    harnesses,
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
