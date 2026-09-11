#!/usr/bin/env node

import { readFileSync, writeFileSync } from "node:fs";
import { parseArgs } from "node:util";

import {
  loadProtocolMemoryDataset,
  runProtocolMemoryCase,
} from "../benchmarks/protocol_memory_benchmark.mjs";

function load(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

function summarize(cases) {
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
    const avg = (field) => items.reduce((total, item) => total + Number(item[field] ?? item.metrics?.[field] ?? 0), 0) / items.length;
    return {
      protocol: first.protocol,
      scenario: first.scenario,
      runs: items.length,
      success_rate: Number(avg("success").toFixed(4)),
      avg_score: Number(avg("score").toFixed(4)),
      avg_wire_bytes: Number(avg("wire_bytes").toFixed(1)),
      secret_leak_events: items.reduce((total, item) => total + (item.metrics.secret_leak_events ?? 0), 0),
      avg_transcript_events: Number(avg("transcript_events").toFixed(1)),
      avg_api_calls: Number(avg("api_calls").toFixed(1)),
      api_errors: items.filter((item) => item.api_error).length,
    };
  });
}

const parsed = parseArgs({
  options: {
    file: { type: "string" },
    output: { type: "string" },
    data: { type: "string" },
  },
});

if (!parsed.values.file || !parsed.values.output) {
  throw new Error("--file and --output are required");
}

const result = load(parsed.values.file);
const dataset = loadProtocolMemoryDataset(parsed.values.data ?? result.dataset?.path);
const casesById = new Map(dataset.cases.map((item) => [item.id, item]));
const regradedCases = [];

for (const item of result.cases ?? []) {
  const caseRecord = casesById.get(item.case_id);
  if (!caseRecord) {
    throw new Error(`case not found in dataset: ${item.case_id}`);
  }
  const modelClient = {
    model: item.model ?? result.model,
    live: item.live ?? result.live,
    decide: async () => item.decision,
  };
  const regraded = await runProtocolMemoryCase({
    protocol: item.protocol,
    caseRecord,
    modelClient,
    seed: item.seed ?? result.seed,
    runIndex: item.run_index ?? 0,
  });
  regradedCases.push({
    ...item,
    ...regraded,
    benchmark: item.benchmark ?? result.benchmark,
    transcript_events: item.transcript_events ?? 0,
    api_calls: item.api_calls ?? 0,
    transcript: item.transcript ?? [],
    regraded_from: parsed.values.file,
  });
}

const regradedResult = {
  ...result,
  regraded_from: parsed.values.file,
  regraded_at: new Date().toISOString(),
  results: summarize(regradedCases),
  cases: regradedCases,
};

writeFileSync(parsed.values.output, `${JSON.stringify(regradedResult, null, 2)}\n`, "utf8");
