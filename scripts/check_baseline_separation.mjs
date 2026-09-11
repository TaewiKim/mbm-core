#!/usr/bin/env node
// Baseline-separation check (review response to M1 / reviewer Q2).
//
// Runs the deterministic Phase-4 main suite under the treatment (C5, the full active-message
// gate) and under a panel of conventional-authorization baselines, and asserts:
//
//   (1) No baseline reproduces C5: every baseline misses at least one trap family that C5 clears.
//   (2) The static-filter + source-message-existence baseline (the reviewer's exact counter-
//       baseline) is defeated specifically by the graph-only sibling-branch family, proving the
//       benefit of causal event-graph reachability over referential integrity.
//   (3) C5 clears every family (perfect separation).
//
// Emits a JSON/Markdown matrix and exits non-zero if any property fails.
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { parseArgs } from "node:util";
import { PHASE4_MAIN_SCENARIOS, runPhase4ScenarioBaseline } from "../benchmarks/coupled_memory/scenarios.mjs";

const TREATMENT = "C5";
const BASELINES = [
  "C4+all-static-filters",
  "C4+all-static-filters+source-exists",
  "C4+abac",
  "C4+rebac-provenance-graph",
  "C4+capability-token",
];
const GRAPH_ONLY_FAMILY = "graph_only_sibling_branch_provenance";

function evaluate() {
  const conditions = [TREATMENT, ...BASELINES];
  const byType = new Map();
  for (const scenario of PHASE4_MAIN_SCENARIOS) {
    const t = scenario.scenario_type;
    if (!byType.has(t)) byType.set(t, { total: 0, pass: Object.fromEntries(conditions.map((c) => [c, 0])) });
    const entry = byType.get(t);
    entry.total += 1;
    for (const cond of conditions) {
      const r = runPhase4ScenarioBaseline({ scenario, baseline: cond });
      if (r.success) entry.pass[cond] += 1;
    }
  }
  return { conditions, byType };
}

function check({ conditions, byType }) {
  const failures = [];
  const families = [...byType.keys()];
  const total = [...byType.values()].reduce((s, e) => s + e.total, 0);
  const totals = Object.fromEntries(conditions.map((c) => [c, families.reduce((s, f) => s + byType.get(f).pass[c], 0)]));

  // (3) C5 clears every family.
  for (const f of families) {
    if (byType.get(f).pass[TREATMENT] !== byType.get(f).total) {
      failures.push(`C5 did not clear family ${f}: ${byType.get(f).pass[TREATMENT]}/${byType.get(f).total}`);
    }
  }
  // (1) No baseline reproduces C5.
  for (const b of BASELINES) {
    if (totals[b] >= totals[TREATMENT]) {
      failures.push(`baseline ${b} reproduces or exceeds C5 (${totals[b]} vs ${totals[TREATMENT]})`);
    }
  }
  // (2) static+source-exists is defeated by the graph-only family.
  const g = byType.get(GRAPH_ONLY_FAMILY);
  if (!g) {
    failures.push(`missing graph-only family ${GRAPH_ONLY_FAMILY}`);
  } else {
    if (g.pass["C4+all-static-filters+source-exists"] !== 0) {
      failures.push(`source-exists baseline unexpectedly cleared graph-only family (${g.pass["C4+all-static-filters+source-exists"]}/${g.total})`);
    }
    if (g.pass[TREATMENT] !== g.total) {
      failures.push(`C5 failed graph-only family (${g.pass[TREATMENT]}/${g.total})`);
    }
  }

  return {
    status: failures.length === 0 ? "PASS" : "FAIL",
    failures,
    checked: {
      total_cases: total,
      treatment: TREATMENT,
      treatment_passed: totals[TREATMENT],
      baseline_totals: Object.fromEntries(BASELINES.map((b) => [b, totals[b]])),
      per_family: Object.fromEntries(families.map((f) => [f, { total: byType.get(f).total, pass: byType.get(f).pass }])),
    },
  };
}

function toMarkdown({ conditions, byType }, check) {
  const lines = [];
  lines.push("# Baseline-separation check\n");
  lines.push(`Status: **${check.status}**\n`);
  lines.push(`| scenario_type | ${conditions.join(" | ")} |`);
  lines.push(`| --- | ${conditions.map(() => "---").join(" | ")} |`);
  for (const [t, entry] of byType) {
    lines.push(`| ${t} | ${conditions.map((c) => `${entry.pass[c]}/${entry.total}`).join(" | ")} |`);
  }
  const total = [...byType.values()].reduce((s, e) => s + e.total, 0);
  const totals = conditions.map((c) => `${[...byType.values()].reduce((s, e) => s + e.pass[c], 0)}/${total}`);
  lines.push(`| **TOTAL** | ${totals.join(" | ")} |`);
  return `${lines.join("\n")}\n`;
}

function main() {
  const { values } = parseArgs({ options: { json: { type: "string" }, md: { type: "string" } } });
  const data = evaluate();
  const result = check(data);
  if (values.json) {
    mkdirSync(dirname(values.json), { recursive: true });
    writeFileSync(values.json, `${JSON.stringify(result, null, 2)}\n`);
  }
  if (values.md) {
    mkdirSync(dirname(values.md), { recursive: true });
    writeFileSync(values.md, toMarkdown(data, result));
  }
  process.stdout.write(toMarkdown(data, result));
  process.stdout.write(`\n${result.status}: ${result.failures.length} failure(s)\n`);
  if (result.status !== "PASS") {
    for (const f of result.failures) process.stderr.write(`  - ${f}\n`);
    process.exit(1);
  }
}

main();
