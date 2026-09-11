import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { parseArgs } from "node:util";

import {
  DEFAULT_DATASET_PATH,
  DEFAULT_OPENAI_MODEL,
  MEMORY_PROTOCOLS,
  MEMORY_SCENARIOS,
} from "./constants.mjs";
import { HeuristicProtocolMemoryClient, OpenAIProtocolMemoryClient } from "./clients.mjs";
import { loadProtocolMemoryDataset, parseSelection, selectCases } from "./dataset.mjs";
import { runProtocolMemoryCase } from "./evaluation.mjs";
import { average } from "./utils.mjs";

export function summarizeProtocolMemoryCases(cases) {
  const groups = new Map();
  for (const item of cases) {
    const key = `${item.protocol}:${item.scenario}`;
    if (!groups.has(key)) {
      groups.set(key, []);
    }
    groups.get(key).push(item);
  }
  return [...groups.values()].map((items) => {
    const first = items[0];
    return {
      protocol: first.protocol,
      scenario: first.scenario,
      model: first.model,
      live: first.live,
      runs: items.length,
      success_rate: average(items, "success"),
      avg_score: Number(average(items, "score").toFixed(4)),
      avg_latency_ms: Number((items.reduce((total, item) => total + item.latency_ms, 0) / items.length).toFixed(3)),
      avg_wire_bytes: Number((items.reduce((total, item) => total + item.wire_bytes, 0) / items.length).toFixed(1)),
      avg_prompt_tokens_estimate: Number(
        (items.reduce((total, item) => total + item.prompt_tokens_estimate, 0) / items.length).toFixed(1),
      ),
      invalid_decisions: items.reduce((total, item) => total + item.invalid_decisions, 0),
      parse_errors: items.reduce((total, item) => total + item.parse_errors, 0),
      secret_leak_events: items.reduce((total, item) => total + (item.metrics.secret_leak_events ?? 0), 0),
      claim_provenance_coverage: Number(average(items, "claim_provenance_coverage").toFixed(3)),
      unsupported_claim_rate: Number(average(items, "unsupported_claim_rate").toFixed(3)),
      unauthorized_memory_access_rate: Number(average(items, "unauthorized_memory_access_rate").toFixed(3)),
      conflict_resolution_accuracy: Number(average(items, "conflict_resolution_accuracy").toFixed(3)),
      useful_recall_rate: Number(average(items, "useful_recall_rate").toFixed(3)),
      invalid_recall_rate: Number(average(items, "invalid_recall_rate").toFixed(3)),
      missing_critical_fact_rate: Number(average(items, "missing_critical_fact_rate").toFixed(3)),
      context_redundancy_rate: Number(average(items, "context_redundancy_rate").toFixed(4)),
      replayability: Number(average(items, "replayability").toFixed(3)),
    };
  });
}

export async function runProtocolMemoryBenchmark(args) {
  const dataset = loadProtocolMemoryDataset(args.data);
  const protocols = args.protocols ?? (args.protocol === "all" ? MEMORY_PROTOCOLS : [args.protocol]);
  const scenarios = args.scenarios ?? (args.scenario === "all" ? MEMORY_SCENARIOS : [args.scenario]);
  const selectedCases = selectCases(dataset, scenarios, args.maxCasesPerScenario ?? 0);
  const requestedConcurrency = args.concurrency ?? 1;
  const repairAttempts = args.repairAttempts ?? 0;
  const modelClient = args.live
    ? new OpenAIProtocolMemoryClient({ model: args.model, timeoutMs: args.timeoutMs })
    : new HeuristicProtocolMemoryClient({ model: args.model });
  const cases = [];
  const totalCases = protocols.length * selectedCases.length * args.runs;
  if (args.jsonl) {
    mkdirSync(dirname(args.jsonl), { recursive: true });
    writeFileSync(args.jsonl, "", "utf8");
  }
  const tasks = [];
  for (const protocol of protocols) {
    for (const caseRecord of selectedCases) {
      for (let runIndex = 0; runIndex < args.runs; runIndex += 1) {
        tasks.push({ protocol, caseRecord, runIndex });
      }
    }
  }
  let nextTask = 0;
  async function worker() {
    while (nextTask < tasks.length) {
      const task = tasks[nextTask];
      nextTask += 1;
      const row = await runProtocolMemoryCase({
        protocol: task.protocol,
        caseRecord: task.caseRecord,
        modelClient,
        seed: args.seed,
        runIndex: task.runIndex,
        repairAttempts,
      });
      cases.push(row);
      if (args.jsonl) {
        appendFileSync(args.jsonl, `${JSON.stringify(row)}\n`, "utf8");
      }
      if (args.progressEvery > 0 && cases.length % args.progressEvery === 0) {
        console.error(`progress ${cases.length}/${totalCases}`);
      }
    }
  }
  const concurrency = Math.max(1, Math.min(requestedConcurrency, tasks.length || 1));
  await Promise.all(Array.from({ length: concurrency }, () => worker()));
  return {
    benchmark: "protocol-memory",
    dataset: {
      name: dataset.name,
      version: dataset.version,
      path: args.data,
      sources: dataset.sources,
    },
    model: args.model,
    live: args.live,
    seed: args.seed,
    runs_per_case: args.runs,
    case_count: cases.length,
    results: summarizeProtocolMemoryCases(cases),
    cases: args.summaryOnly ? undefined : cases,
  };
}

function formatValue(value) {
  if (typeof value === "number") {
    return Number.isInteger(value) ? String(value) : value.toFixed(3);
  }
  return String(value);
}

export function printProtocolMemorySummary(result) {
  const columns = [
    "protocol",
    "scenario",
    "success_rate",
    "avg_score",
    "avg_wire_bytes",
    "secret_leak_events",
    "claim_provenance_coverage",
    "unauthorized_memory_access_rate",
    "conflict_resolution_accuracy",
    "useful_recall_rate",
    "missing_critical_fact_rate",
  ];
  const widths = Object.fromEntries(
    columns.map((column) => [
      column,
      Math.max(column.length, ...result.results.map((row) => formatValue(row[column]).length)),
    ]),
  );
  console.log(columns.map((column) => column.padEnd(widths[column])).join("  "));
  console.log(columns.map((column) => "-".repeat(widths[column])).join("  "));
  for (const row of result.results) {
    console.log(columns.map((column) => formatValue(row[column]).padEnd(widths[column])).join("  "));
  }
}

export function cliArgs(argv = process.argv.slice(2)) {
  const parsed = parseArgs({
    args: argv,
    options: {
      scenario: { type: "string", default: "all" },
      protocol: { type: "string", default: "all" },
      runs: { type: "string", default: "1" },
      seed: { type: "string", default: "1" },
      data: { type: "string", default: DEFAULT_DATASET_PATH },
      model: { type: "string", default: DEFAULT_OPENAI_MODEL },
      "max-cases-per-scenario": { type: "string", default: "0" },
      live: { type: "boolean", default: false },
      json: { type: "string" },
      jsonl: { type: "string" },
      compact: { type: "boolean", default: false },
      "summary-only": { type: "boolean", default: false },
      "progress-every": { type: "string", default: "0" },
      "timeout-ms": { type: "string", default: "120000" },
      concurrency: { type: "string", default: "1" },
      "repair-attempts": { type: "string", default: "0" },
    },
  });
  const protocol = parsed.values.protocol;
  const scenario = parsed.values.scenario;
  const protocols = parseSelection(protocol, MEMORY_PROTOCOLS, "protocol");
  const scenarios = parseSelection(scenario, MEMORY_SCENARIOS, "scenario");
  const runs = Number.parseInt(parsed.values.runs, 10);
  const seed = Number.parseInt(parsed.values.seed, 10);
  const maxCasesPerScenario = Number.parseInt(parsed.values["max-cases-per-scenario"], 10);
  const progressEvery = Number.parseInt(parsed.values["progress-every"], 10);
  const timeoutMs = Number.parseInt(parsed.values["timeout-ms"], 10);
  const concurrency = Number.parseInt(parsed.values.concurrency, 10);
  const repairAttempts = Number.parseInt(parsed.values["repair-attempts"], 10);
  if (!Number.isInteger(runs) || runs < 1) {
    throw new Error("--runs must be an integer greater than zero");
  }
  if (!Number.isInteger(seed)) {
    throw new Error("--seed must be an integer");
  }
  if (!Number.isInteger(maxCasesPerScenario) || maxCasesPerScenario < 0) {
    throw new Error("--max-cases-per-scenario must be a non-negative integer");
  }
  if (!Number.isInteger(progressEvery) || progressEvery < 0) {
    throw new Error("--progress-every must be a non-negative integer");
  }
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1000) {
    throw new Error("--timeout-ms must be at least 1000");
  }
  if (!Number.isInteger(concurrency) || concurrency < 1) {
    throw new Error("--concurrency must be an integer greater than zero");
  }
  if (!Number.isInteger(repairAttempts) || repairAttempts < 0) {
    throw new Error("--repair-attempts must be a non-negative integer");
  }
  return {
    scenario,
    protocol,
    scenarios,
    protocols,
    runs,
    seed,
    maxCasesPerScenario,
    data: resolve(parsed.values.data),
    model: parsed.values.model,
    live: parsed.values.live,
    json: parsed.values.json,
    jsonl: parsed.values.jsonl,
    compact: parsed.values.compact,
    summaryOnly: parsed.values["summary-only"],
    progressEvery,
    timeoutMs,
    concurrency,
    repairAttempts,
  };
}

export async function main() {
  const args = cliArgs();
  const result = await runProtocolMemoryBenchmark(args);
  printProtocolMemorySummary(result);
  if (args.json) {
    const spacing = args.compact ? 0 : 2;
    writeFileSync(args.json, `${JSON.stringify(result, null, spacing)}\n`, "utf8");
  }
}
