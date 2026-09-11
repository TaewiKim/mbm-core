#!/usr/bin/env node

import { readFileSync, writeFileSync } from "node:fs";
import { parseArgs } from "node:util";

function load(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

function shortError(value) {
  if (!value) {
    return "";
  }
  if (value.includes("billing_not_active")) {
    return "billing_not_active";
  }
  if (value.includes("rate_limit")) {
    return "rate_limit";
  }
  if (value.includes("AbortError")) {
    return "timeout";
  }
  return value.slice(0, 160);
}

function increment(map, key) {
  map.set(key, (map.get(key) ?? 0) + 1);
}

function summarize(result) {
  const byError = new Map();
  const byProtocolScenario = new Map();
  for (const item of result.cases ?? []) {
    if (!item.api_error) {
      continue;
    }
    increment(byError, shortError(item.api_error));
    increment(byProtocolScenario, `${item.protocol}:${item.scenario}`);
  }
  return {
    input_cases: result.cases?.length ?? 0,
    api_error_cases: [...byError.values()].reduce((total, count) => total + count, 0),
    by_error: Object.fromEntries([...byError.entries()].sort()),
    by_protocol_scenario: Object.fromEntries([...byProtocolScenario.entries()].sort()),
  };
}

function markdown(report, input) {
  const lines = [
    "# API Error Summary",
    "",
    `Input: \`${input}\``,
    `Cases: ${report.input_cases}`,
    `API error cases: ${report.api_error_cases}`,
    "",
    "## By Error",
    "",
    "| Error | Count |",
    "| --- | ---: |",
  ];
  for (const [error, count] of Object.entries(report.by_error)) {
    lines.push(`| ${error} | ${count} |`);
  }
  lines.push("");
  lines.push("## By Protocol/Scenario");
  lines.push("");
  lines.push("| Protocol/Scenario | Count |");
  lines.push("| --- | ---: |");
  for (const [key, count] of Object.entries(report.by_protocol_scenario)) {
    lines.push(`| ${key} | ${count} |`);
  }
  lines.push("");
  return `${lines.join("\n")}\n`;
}

const parsed = parseArgs({
  options: {
    file: { type: "string" },
    json: { type: "string" },
    md: { type: "string" },
  },
});

if (!parsed.values.file) {
  throw new Error("--file is required");
}

const report = summarize(load(parsed.values.file));
if (parsed.values.json) {
  writeFileSync(parsed.values.json, `${JSON.stringify(report, null, 2)}\n`, "utf8");
}
if (parsed.values.md) {
  writeFileSync(parsed.values.md, markdown(report, parsed.values.file), "utf8");
}
if (!parsed.values.json && !parsed.values.md) {
  console.log(markdown(report, parsed.values.file));
}
