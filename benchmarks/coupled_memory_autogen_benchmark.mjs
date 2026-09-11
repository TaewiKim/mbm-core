import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";

import { COUPLED_MEMORY_CONDITIONS } from "./coupled_memory/constants.mjs";
import { runAutoGenNativeSuite } from "./coupled_memory/autogen_native.mjs";

function parseList(value, allowed, label) {
  const items = value === "all" ? allowed : String(value).split(",").map((item) => item.trim()).filter(Boolean);
  for (const item of items) {
    if (!allowed.includes(item)) {
      throw new Error(`unknown ${label}: ${item}`);
    }
  }
  return items;
}

function printSummary(result) {
  if (result.skipped) {
    console.log(`[autogen-native] skipped: ${result.reason}`);
    return;
  }
  const columns = [
    "harness_id",
    "scenario_id",
    "condition",
    "success",
    "wrong_scope_memory_use",
    "stale_memory_use",
    "forbidden_memory_use",
    "missing_critical_memory",
    "causal_memory_binding",
    "event_graph_reconstructability",
  ];
  console.log(columns.join("\t"));
  for (const row of result.summary) {
    console.log(columns.map((column) => row[column]).join("\t"));
  }
}

export function runCoupledMemoryAutoGenBenchmark({ condition = "all" } = {}) {
  return runAutoGenNativeSuite({
    conditions: parseList(condition, COUPLED_MEMORY_CONDITIONS, "condition"),
  });
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const parsed = parseArgs({
    options: {
      condition: { type: "string", default: "all" },
      json: { type: "string" },
    },
  });
  const result = runCoupledMemoryAutoGenBenchmark(parsed.values);
  printSummary(result);
  if (parsed.values.json) {
    mkdirSync(dirname(parsed.values.json), { recursive: true });
    writeFileSync(parsed.values.json, `${JSON.stringify(result, null, 2)}\n`, "utf8");
    console.log(`Wrote ${parsed.values.json}`);
  }
}
