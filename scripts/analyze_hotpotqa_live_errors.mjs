#!/usr/bin/env node

import { readFileSync, writeFileSync } from "node:fs";
import { parseArgs } from "node:util";

function load(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

function groupBy(items, keyFn) {
  const groups = new Map();
  for (const item of items) {
    const key = keyFn(item);
    if (!groups.has(key)) {
      groups.set(key, []);
    }
    groups.get(key).push(item);
  }
  return groups;
}

function avg(items, fn) {
  return items.length === 0 ? 0 : items.reduce((total, item) => total + fn(item), 0) / items.length;
}

function summarize(items) {
  return {
    n: items.length,
    success: items.filter((item) => item.success).length,
    success_rate: Number(avg(items, (item) => Number(item.success)).toFixed(3)),
    claim_accuracy: Number(avg(items, (item) => item.metrics?.claim_accuracy ?? 0).toFixed(3)),
    provenance: Number(avg(items, (item) => item.metrics?.claim_provenance_coverage ?? 0).toFixed(3)),
    unsupported_claim_rate: Number(avg(items, (item) => item.metrics?.unsupported_claim_rate ?? 0).toFixed(3)),
    decision_accuracy: Number(avg(items, (item) => item.metrics?.decision_accuracy ?? 0).toFixed(3)),
    missing_critical_fact_rate: Number(avg(items, (item) => item.metrics?.missing_critical_fact_rate ?? 0).toFixed(3)),
    avg_wire_bytes: Number(avg(items, (item) => item.wire_bytes ?? 0).toFixed(1)),
  };
}

function markdown(report) {
  const lines = [
    "# HotpotQA Live Error Analysis",
    "",
    `Input: \`${report.input}\``,
    "",
    "| Protocol | Scenario | N | Success | Success rate | Claim acc. | Provenance | Unsupported | Decision acc. | Missing facts | Avg wire bytes |",
    "|---|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|",
  ];
  for (const item of report.rows) {
    lines.push(`| ${item.protocol} | ${item.scenario} | ${item.n} | ${item.success} | ${item.success_rate} | ${item.claim_accuracy} | ${item.provenance} | ${item.unsupported_claim_rate} | ${item.decision_accuracy} | ${item.missing_critical_fact_rate} | ${item.avg_wire_bytes} |`);
  }
  lines.push("");
  lines.push("## Main Readout");
  lines.push("");
  lines.push("- API and parse health should be read from the companion API error summary.");
  lines.push("- Evidence failures are usually driven by answer mismatch or unsupported extra claims despite high provenance coverage.");
  lines.push("- Context failures are usually driven by missing critical fact ids or answer mismatch; wire-byte reductions can still be strong.");
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

const result = load(parsed.values.file);
const groups = groupBy(result.cases ?? [], (item) => `${item.protocol}:${item.scenario}`);
const rows = [...groups.entries()].map(([key, items]) => {
  const [protocol, scenario] = key.split(":");
  return { protocol, scenario, ...summarize(items) };
}).sort((a, b) => `${a.protocol}:${a.scenario}`.localeCompare(`${b.protocol}:${b.scenario}`));

const report = { input: parsed.values.file, rows };
if (parsed.values.json) {
  writeFileSync(parsed.values.json, `${JSON.stringify(report, null, 2)}\n`, "utf8");
}
if (parsed.values.md) {
  writeFileSync(parsed.values.md, markdown(report), "utf8");
}
if (!parsed.values.json && !parsed.values.md) {
  console.log(markdown(report));
}
