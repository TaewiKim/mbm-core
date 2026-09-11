#!/usr/bin/env node

import { readFileSync, writeFileSync } from "node:fs";
import { parseArgs } from "node:util";

function load(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

function unique(values) {
  return [...new Set(values)].sort();
}

function resultModels(input) {
  const caseModels = (input.cases ?? []).map((item) => item.model ?? input.model).filter(Boolean);
  return caseModels.length > 0 ? caseModels : [input.model].filter(Boolean);
}

const parsed = parseArgs({
  allowPositionals: true,
  options: {
    out: { type: "string" },
    compact: { type: "boolean", default: false },
  },
});

if (!parsed.values.out) {
  throw new Error("--out is required");
}
if (parsed.positionals.length < 1) {
  throw new Error("at least one result file is required");
}

const inputs = parsed.positionals.map(load);
const first = inputs[0];
const models = unique(inputs.flatMap(resultModels));
const combined = {
  benchmark: first.benchmark,
  combined_from: parsed.positionals,
  dataset: first.dataset,
  model: models.length === 1 ? models[0] : models.join(", "),
  models,
  live: inputs.some((item) => item.live),
  seed: first.seed,
  runs_per_case: first.runs_per_case,
  results: [],
  cases: inputs.flatMap((item) => item.cases ?? []),
};

const spacing = parsed.values.compact ? undefined : 2;
writeFileSync(parsed.values.out, `${JSON.stringify(combined, null, spacing)}\n`, "utf8");
