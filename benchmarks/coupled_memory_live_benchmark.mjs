import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";

import { runCoupledMemoryLiveSuite } from "./coupled_memory/live_model.mjs";

function parseConditions(value) {
  const allowed = ["C4", "C5"];
  const items = value === "all" ? allowed : value.split(",").map((item) => item.trim().toUpperCase()).filter(Boolean);
  const unknown = items.filter((item) => !allowed.includes(item));
  if (items.length === 0 || unknown.length > 0) {
    throw new Error(`--condition must be all or one of: ${allowed.join(",")}`);
  }
  return items;
}

function printSummary(result) {
  const columns = ["condition", "cases", "api_errors", "deterministic_success_rate", "model_success_rate", "selected_forbidden_memory"];
  console.log(columns.join("\t"));
  for (const row of result.summary) {
    console.log(columns.map((column) => row[column]).join("\t"));
  }
}

export async function runCoupledMemoryLiveBenchmark(args = {}) {
  const provider = (args.provider ?? "openai").toLowerCase();
  return runCoupledMemoryLiveSuite({
    conditions: parseConditions(args.condition ?? "C4,C5"),
    split: args.split ?? "dev",
    scenarioLimit: Number.parseInt(args.scenarios ?? "4", 10),
    instancesPerFamily: Number.parseInt(args.instancesPerFamily ?? "0", 10),
    runs: Number.parseInt(args.runs ?? "1", 10),
    provider,
    // Default model depends on provider; only override when the caller passes --model.
    model: args.model ?? (provider === "gemini" ? "gemini-2.5-flash" : "gpt-5-nano"),
    timeoutMs: Number.parseInt(args.timeoutMs ?? "120000", 10),
    ...(args.requestDelayMs === undefined ? {} : { requestDelayMs: Number.parseInt(args.requestDelayMs, 10) }),
    jsonl: args.jsonl,
  });
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const parsed = parseArgs({
    options: {
      condition: { type: "string", default: "C4,C5" },
      split: { type: "string", default: "dev" },
      scenarios: { type: "string", default: "4" },
      "instances-per-family": { type: "string", default: "0" },
      runs: { type: "string", default: "1" },
      provider: { type: "string", default: "openai" },
      model: { type: "string" },
      "timeout-ms": { type: "string", default: "120000" },
      "request-delay-ms": { type: "string" },
      json: { type: "string" },
      jsonl: { type: "string" },
    },
  });
  const result = await runCoupledMemoryLiveBenchmark({
    ...parsed.values,
    instancesPerFamily: parsed.values["instances-per-family"],
    timeoutMs: parsed.values["timeout-ms"],
    requestDelayMs: parsed.values["request-delay-ms"],
  });
  printSummary(result);
  if (parsed.values.json) {
    mkdirSync(dirname(parsed.values.json), { recursive: true });
    writeFileSync(parsed.values.json, `${JSON.stringify(result, null, 2)}\n`, "utf8");
    console.log(`Wrote ${parsed.values.json}`);
  }
}
