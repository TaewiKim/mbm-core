import { readFileSync } from "node:fs";

import { DEFAULT_DATASET_PATH, MEMORY_SCENARIOS } from "./constants.mjs";

export function loadProtocolMemoryDataset(path = DEFAULT_DATASET_PATH) {
  const dataset = JSON.parse(readFileSync(path, "utf8"));
  if (!Array.isArray(dataset.cases)) {
    throw new Error(`dataset ${path} must contain a cases array`);
  }
  const unknown = dataset.cases.filter((item) => !MEMORY_SCENARIOS.includes(item.scenario));
  if (unknown.length > 0) {
    throw new Error(`dataset ${path} contains unknown scenarios: ${unknown.map((item) => item.scenario).join(", ")}`);
  }
  return dataset;
}

export function selectCases(dataset, scenarios, maxCasesPerScenario = 0) {
  const scenarioSet = new Set(scenarios);
  const counts = new Map();
  return dataset.cases.filter((item) => {
    if (!scenarioSet.has(item.scenario)) {
      return false;
    }
    if (maxCasesPerScenario < 1) {
      return true;
    }
    const count = counts.get(item.scenario) ?? 0;
    if (count >= maxCasesPerScenario) {
      return false;
    }
    counts.set(item.scenario, count + 1);
    return true;
  });
}

export function parseSelection(value, allowed, flagName) {
  if (value === "all") {
    return allowed;
  }
  const selected = value.split(",").map((item) => item.trim()).filter(Boolean);
  const unknown = selected.filter((item) => !allowed.includes(item));
  if (selected.length === 0 || unknown.length > 0) {
    throw new Error(`--${flagName} must be all or comma-separated values from: ${allowed.join(", ")}`);
  }
  return selected;
}
