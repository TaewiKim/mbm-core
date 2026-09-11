#!/usr/bin/env node

import { createHash } from "node:crypto";
import { existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { parseArgs } from "node:util";

const DEFAULT_ARTIFACTS = [
  ["headline_table_json", "results/headline-evidence-table.json"],
  ["headline_table_md", "results/headline-evidence-table.md"],
  ["cost_call_accounting_json", "results/cost-call-accounting.json"],
  ["cost_call_accounting_md", "results/cost-call-accounting.md"],
  ["coupled_live_main40_r3_analysis", "results/coupled-memory-phase6-live-main40-r3-combined-2models-analysis.json"],
  ["dropin_live_main40_r3_result", "results/dropin-protocol-replacement-live-main40-r3-combined.json"],
  ["dropin_live_main40_r3_analysis", "results/dropin-protocol-replacement-live-main40-r3-combined-analysis.json"],
  ["raw_broad_live_result", "results/raw-hard20-live-gpt54-mini-nano-c10-r1-repair1-combined.json"],
  ["raw_broad_live_analysis", "results/raw-hard20-live-gpt54-mini-nano-c10-r1-repair1-combined-analysis.json"],
  ["hotpotqa_live_result", "results/hotpotqa-validation-live-gpt54-mini-nano-c20-r1-repair1-combined.json"],
  ["hotpotqa_live_analysis", "results/hotpotqa-validation-live-gpt54-mini-nano-c20-r1-repair1-combined-analysis.json"],
  ["dropin_deterministic_main_check", "results/dropin-protocol-replacement-main-check.json"],
  ["coupled_deterministic_main_check", "results/coupled-memory-phase4-main-check.json"],
];

function sha256(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function inferKind(path) {
  if (path.endsWith(".json")) return "json";
  if (path.endsWith(".jsonl")) return "jsonl";
  if (path.endsWith(".md")) return "markdown";
  return "file";
}

function buildIndex(artifacts = DEFAULT_ARTIFACTS) {
  const rows = artifacts.map(([id, path]) => {
    const exists = existsSync(path);
    const stat = exists ? statSync(path) : null;
    return {
      id,
      path,
      kind: inferKind(path),
      exists,
      bytes: stat?.size ?? 0,
      sha256: exists ? sha256(path) : "",
    };
  });
  return {
    generated_for: "ACM-CP supplementary artifact trace",
    artifacts: rows,
    missing: rows.filter((item) => !item.exists).map((item) => item.path),
  };
}

function markdown(index) {
  const lines = [];
  lines.push("# Supplementary Artifact Index");
  lines.push("");
  lines.push(index.generated_for);
  lines.push("");
  lines.push("| ID | Kind | Exists | Bytes | SHA-256 | Path |");
  lines.push("| --- | --- | --- | ---: | --- | --- |");
  for (const item of index.artifacts) {
    lines.push(`| ${item.id} | ${item.kind} | ${item.exists} | ${item.bytes} | ${item.sha256} | \`${item.path}\` |`);
  }
  lines.push("");
  lines.push("## Missing Artifacts");
  lines.push("");
  if (index.missing.length === 0) {
    lines.push("- None.");
  } else {
    for (const path of index.missing) {
      lines.push(`- \`${path}\``);
    }
  }
  lines.push("");
  return `${lines.join("\n")}\n`;
}

const parsed = parseArgs({
  options: {
    json: { type: "string", default: "results/supplementary-artifact-index.json" },
    md: { type: "string", default: "results/supplementary-artifact-index.md" },
  },
});

const index = buildIndex();
writeFileSync(parsed.values.json, `${JSON.stringify(index, null, 2)}\n`, "utf8");
writeFileSync(parsed.values.md, markdown(index), "utf8");
console.log(`Wrote ${parsed.values.json}`);
console.log(`Wrote ${parsed.values.md}`);
if (index.missing.length > 0) {
  process.exitCode = 1;
}
