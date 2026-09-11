import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";

import { runCoupledMemoryLiveSuite } from "./coupled_memory/live_model.mjs";

const SAME_AGENT_CONTROLS = {
  agent_app: "fixed-three-agent-deployment-workflow",
  agent_roles: ["planner", "memory", "executor"],
  task_policy: "deterministic-agent-policy-v1",
  model_policy: "same-live-model-policy",
  memory_backend: "node:sqlite",
  tools: ["message_queue", "shared_memory_read", "shared_memory_write"],
};

const WRAPPER_BY_CONDITION = {
  C4: "legacy-shared-memory",
  C5: "acmcp-message-bound",
};

function decorateCase(item) {
  return {
    ...item,
    protocol_wrapper: WRAPPER_BY_CONDITION[item.condition] ?? item.condition,
    same_agent_controls: SAME_AGENT_CONTROLS,
    protocol_only_change: {
      changed_component: "inter-agent protocol wrapper",
      underlying_condition: item.condition,
      unchanged_components: Object.keys(SAME_AGENT_CONTROLS),
    },
  };
}

function decorateSummary(summary) {
  return summary.map((item) => ({
    protocol_wrapper: WRAPPER_BY_CONDITION[item.condition] ?? item.condition,
    ...item,
  }));
}

export async function runDropInProtocolReplacementLiveBenchmark(args = {}) {
  const result = await runCoupledMemoryLiveSuite({
    conditions: ["C4", "C5"],
    split: args.split ?? "dev",
    scenarioLimit: Number.parseInt(args.scenarios ?? "24", 10),
    instancesPerFamily: Number.parseInt(args.instancesPerFamily ?? "0", 10),
    runs: Number.parseInt(args.runs ?? "1", 10),
    model: args.model ?? "gpt-5.4-nano",
    timeoutMs: Number.parseInt(args.timeoutMs ?? "120000", 10),
    jsonl: args.jsonl,
  });
  return {
    ...result,
    benchmark: args.benchmark ?? "dropin-protocol-replacement-live-dev24",
    purpose: "Live same-agent protocol replacement: same app/model/tools/memory backend, only wrapper changes.",
    same_agent_controls: SAME_AGENT_CONTROLS,
    protocol_wrappers: {
      "legacy-shared-memory": { condition: "C4" },
      "acmcp-message-bound": { condition: "C5" },
    },
    cases: result.cases.map(decorateCase),
    summary: decorateSummary(result.summary),
  };
}

function printSummary(result) {
  const columns = ["protocol_wrapper", "condition", "cases", "api_errors", "deterministic_success_rate", "model_success_rate", "selected_forbidden_memory"];
  console.log(columns.join("\t"));
  for (const row of result.summary) {
    console.log(columns.map((column) => row[column]).join("\t"));
  }
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const parsed = parseArgs({
    options: {
      split: { type: "string", default: "dev" },
      scenarios: { type: "string", default: "24" },
      "instances-per-family": { type: "string", default: "0" },
      runs: { type: "string", default: "1" },
      model: { type: "string", default: "gpt-5.4-nano" },
      "timeout-ms": { type: "string", default: "120000" },
      benchmark: { type: "string", default: "dropin-protocol-replacement-live-dev24" },
      json: { type: "string" },
      jsonl: { type: "string" },
    },
  });
  const result = await runDropInProtocolReplacementLiveBenchmark({
    ...parsed.values,
    instancesPerFamily: parsed.values["instances-per-family"],
    timeoutMs: parsed.values["timeout-ms"],
  });
  printSummary(result);
  if (parsed.values.json) {
    mkdirSync(dirname(parsed.values.json), { recursive: true });
    writeFileSync(parsed.values.json, `${JSON.stringify(result, null, 2)}\n`, "utf8");
    console.log(`Wrote ${parsed.values.json}`);
  }
}
