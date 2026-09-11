import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";

import {
  assertC4C5OnlyDifferByBinding,
  buildConditionMatrix,
} from "./coupled_memory/conditions.mjs";
import { COUPLED_MEMORY_CONDITIONS } from "./coupled_memory/constants.mjs";
import { runPhase5HarnessSuite } from "./coupled_memory/harnesses.mjs";
import { runPhase4DevSuite, runPhase4MainSuite } from "./coupled_memory/scenarios.mjs";
import { runTwinRunMatrix } from "./coupled_memory/twin_run.mjs";

function parseList(value, allowed, label) {
  const items = value === "all" ? allowed : String(value).split(",").map((item) => item.trim()).filter(Boolean);
  for (const item of items) {
    if (!allowed.includes(item)) {
      throw new Error(`unknown ${label}: ${item}`);
    }
  }
  return items;
}

export function runCoupledMemoryBenchmark({ scenario = "twin_run", condition = "all" } = {}) {
  const conditions = parseList(condition, COUPLED_MEMORY_CONDITIONS, "condition");
  const metadata = {
    conditionMatrix: buildConditionMatrix(conditions),
    c4c5Parity: assertC4C5OnlyDifferByBinding(),
  };
  if (scenario === "twin_run") {
    return runTwinRunMatrix({ conditions, ...metadata });
  }
  if (scenario === "phase4_dev") {
    const result = runPhase4DevSuite({ conditions });
    return {
      ...result,
      condition_matrix: metadata.conditionMatrix,
      c4_c5_parity: metadata.c4c5Parity,
    };
  }
  if (scenario === "phase4_main") {
    const result = runPhase4MainSuite({ conditions });
    return {
      ...result,
      condition_matrix: metadata.conditionMatrix,
      c4_c5_parity: metadata.c4c5Parity,
    };
  }
  if (scenario === "phase5_harness") {
    return runPhase5HarnessSuite({ conditions });
  }
  throw new Error(`unknown scenario: ${scenario}`);
}

function printSummary(result) {
  const hasScenario = result.summary.some((row) => row.scenario_id);
  const hasHarness = result.summary.some((row) => row.harness_id);
  const columns = [
    ...(hasHarness ? ["harness_id"] : []),
    ...(hasScenario ? ["scenario_id"] : []),
    "condition",
    "success",
    "wrong_scope_memory_use",
    ...(hasScenario ? ["stale_memory_use", "forbidden_memory_use"] : []),
    "missing_critical_memory",
    "causal_memory_binding",
    "event_graph_reconstructability",
  ];
  console.log(columns.join("\t"));
  for (const row of result.summary) {
    console.log(columns.map((column) => row[column]).join("\t"));
  }
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const parsed = parseArgs({
    options: {
      scenario: { type: "string", default: "twin_run" },
      condition: { type: "string", default: "all" },
      json: { type: "string" },
    },
  });
  const result = runCoupledMemoryBenchmark(parsed.values);
  printSummary(result);
  if (parsed.values.json) {
    mkdirSync(dirname(parsed.values.json), { recursive: true });
    writeFileSync(parsed.values.json, `${JSON.stringify(result, null, 2)}\n`, "utf8");
    console.log(`Wrote ${parsed.values.json}`);
  }
}
