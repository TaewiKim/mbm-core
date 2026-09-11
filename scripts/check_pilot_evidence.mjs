#!/usr/bin/env node

import { readFileSync, writeFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { MEMORY_PROTOCOLS, MEMORY_SCENARIOS } from "../benchmarks/protocol_memory_benchmark.mjs";

const CHECK_PROTOCOLS = [
  ...MEMORY_PROTOCOLS,
  "acmcp-core",
  "a2a-task-artifact",
  "autogen-conversation",
  "mpac-coordination",
  "mesh-memory",
  "q-kvcomm-compressed",
];

function load(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

function unique(values) {
  return [...new Set(values)].sort();
}

function countBy(items, keyFn) {
  const counts = new Map();
  for (const item of items) {
    const key = keyFn(item);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return counts;
}

function passFail(pass) {
  return pass ? "PASS" : "NEEDS_WORK";
}

function makeCheck({ id, criterion, pass, evidence, next }) {
  return {
    id,
    criterion,
    status: passFail(pass),
    pass,
    evidence,
    next: pass ? "None for this gate." : next,
  };
}

function parseList(value, allowed) {
  if (!value || value === "all") {
    return allowed;
  }
  const selected = value.split(",").map((item) => item.trim()).filter(Boolean);
  const unknown = selected.filter((item) => !allowed.includes(item));
  if (selected.length === 0 || unknown.length > 0) {
    throw new Error(`unknown expected values: ${unknown.join(", ")}`);
  }
  return selected;
}

function scenarioCaseCounts(cases, expectedScenarios) {
  const byScenario = new Map();
  for (const scenario of expectedScenarios) {
    byScenario.set(scenario, new Set());
  }
  for (const item of cases) {
    if (byScenario.has(item.scenario)) {
      byScenario.get(item.scenario).add(item.case_id);
    }
  }
  return Object.fromEntries(
    [...byScenario.entries()].map(([scenario, ids]) => [scenario, ids.size]),
  );
}

function minRepeatCount(cases) {
  const counts = countBy(cases, (item) => `${item.protocol}:${item.scenario}:${item.case_id}`);
  if (counts.size === 0) {
    return 0;
  }
  return Math.min(...counts.values());
}

function completeProtocolScenarioMatrix(cases, expectedProtocols, expectedScenarios) {
  const observed = new Set(cases.map((item) => `${item.protocol}:${item.scenario}`));
  return expectedProtocols.every((protocol) =>
    expectedScenarios.every((scenario) => observed.has(`${protocol}:${scenario}`)));
}

function markdown(report) {
  const lines = [
    "# Pilot Evidence Check",
    "",
    `Result: \`${report.result_file}\``,
    `Analysis: \`${report.analysis_file}\``,
    "",
    "## Summary",
    "",
    `- cases: ${report.summary.cases}`,
    `- protocols: ${report.summary.protocols}`,
    `- scenarios: ${report.summary.scenarios}`,
    `- minimum unique cases per scenario: ${report.summary.min_cases_per_scenario}`,
    `- minimum repeats per protocol/scenario/case: ${report.summary.min_repeats_per_case}`,
    `- parse errors: ${report.summary.parse_errors}`,
    `- invalid decisions: ${report.summary.invalid_decisions}`,
    `- API errors: ${report.summary.api_errors}`,
    "",
    "## Checks",
    "",
    "| ID | Criterion | Status | Evidence | Next action |",
    "| --- | --- | --- | --- | --- |",
  ];
  for (const check of report.checks) {
    lines.push(`| ${check.id} | ${check.criterion} | ${check.status} | ${check.evidence} | ${check.next} |`);
  }
  lines.push("");
  lines.push("## Scenario Case Counts");
  lines.push("");
  lines.push("| Scenario | Unique cases |");
  lines.push("| --- | ---: |");
  for (const [scenario, count] of Object.entries(report.scenario_case_counts)) {
    lines.push(`| ${scenario} | ${count} |`);
  }
  lines.push("");
  return `${lines.join("\n")}\n`;
}

const parsed = parseArgs({
  options: {
    result: { type: "string" },
    analysis: { type: "string" },
    md: { type: "string" },
    json: { type: "string" },
    min_cases: { type: "string", default: "50" },
    min_repeats: { type: "string", default: "5" },
    "expected-protocols": { type: "string", default: "all" },
    "expected-scenarios": { type: "string", default: "all" },
    "expected-live": { type: "string", default: "false" },
  },
});

if (!parsed.values.result || !parsed.values.analysis) {
  throw new Error("--result and --analysis are required");
}

const result = load(parsed.values.result);
const analysis = load(parsed.values.analysis);
const cases = result.cases ?? [];
const minCases = Number.parseInt(parsed.values.min_cases, 10);
const minRepeats = Number.parseInt(parsed.values.min_repeats, 10);
const expectedProtocols = parseList(parsed.values["expected-protocols"], CHECK_PROTOCOLS);
const expectedScenarios = parseList(parsed.values["expected-scenarios"], MEMORY_SCENARIOS);
const expectedLive = parsed.values["expected-live"] === "true";
const protocols = unique(cases.map((item) => item.protocol));
const scenarios = unique(cases.map((item) => item.scenario));
const counts = scenarioCaseCounts(cases, expectedScenarios);
const minimumCases = Math.min(...Object.values(counts));
const repeats = minRepeatCount(cases);
const parseErrors = cases.reduce((total, item) => total + (item.parse_errors ?? 0), 0);
const invalidDecisions = cases.reduce((total, item) => total + (item.invalid_decisions ?? 0), 0);
const apiErrors = cases.filter((item) => item.api_error).length;
const availableContrasts = (analysis.contrasts ?? []).filter((item) => item.available ?? item.paired_n > 0);
const allContrastsPaired = availableContrasts.length > 0
  && availableContrasts.every((item) =>
    item.paired_n > 0
    && item.bootstrap_ci_95
    && Number.isFinite(item.delta)
    && (item.sign_test_p_value === undefined || Number.isFinite(item.sign_test_p_value)));

const report = {
  result_file: parsed.values.result,
  analysis_file: parsed.values.analysis,
  summary: {
    cases: cases.length,
    protocols: protocols.length,
    scenarios: scenarios.length,
    min_cases_per_scenario: minimumCases,
    min_repeats_per_case: repeats,
    parse_errors: parseErrors,
    invalid_decisions: invalidDecisions,
    api_errors: apiErrors,
  },
  scenario_case_counts: counts,
  checks: [
    makeCheck({
      id: "C1",
      criterion: "Expected protocol/scenario matrix",
      pass: completeProtocolScenarioMatrix(cases, expectedProtocols, expectedScenarios),
      evidence: `${protocols.length}/${expectedProtocols.length} protocols x ${scenarios.length}/${expectedScenarios.length} scenarios`,
      next: "Add missing protocol/scenario cells before using as a main table.",
    }),
    makeCheck({
      id: "C2",
      criterion: "Minimum cases per expected scenario family",
      pass: minimumCases >= minCases,
      evidence: `minimum=${minimumCases}, target=${minCases}`,
      next: "Generate or convert more cases for low-coverage scenarios.",
    }),
    makeCheck({
      id: "C3",
      criterion: "Minimum repeats per protocol/scenario/case",
      pass: repeats >= minRepeats,
      evidence: `minimum=${repeats}, target=${minRepeats}`,
      next: "Rerun with a larger --runs value.",
    }),
    makeCheck({
      id: "C4",
      criterion: "No parse, validation, or API errors",
      pass: parseErrors === 0 && invalidDecisions === 0 && apiErrors === 0,
      evidence: `parse=${parseErrors}, invalid=${invalidDecisions}, api=${apiErrors}`,
      next: "Fix failed cells and rerun affected matrix slices.",
    }),
    makeCheck({
      id: "C5",
      criterion: "Paired effect sizes and uncertainty reported",
      pass: allContrastsPaired,
      evidence: `${availableContrasts.length} available contrasts with paired deltas and confidence intervals`,
      next: "Run analyze_hypotheses.mjs on the complete matrix.",
    }),
    makeCheck({
      id: "C6",
      criterion: "Raw result and analysis artifacts recorded",
      pass: Boolean(result.dataset?.path && analysis.input),
      evidence: `dataset=${result.dataset?.path ?? "missing"}, analysis_input=${analysis.input ?? "missing"}`,
      next: "Record exact commands, seeds, and dataset paths in the research note.",
    }),
    makeCheck({
      id: "C7",
      criterion: "Evidence type matches expected live/deterministic mode",
      pass: result.live === expectedLive,
      evidence: `result.live=${result.live}, expected_live=${expectedLive}`,
      next: "Use separate result files and checks for deterministic gates and live pilots.",
    }),
  ],
};

if (parsed.values.json) {
  writeFileSync(parsed.values.json, `${JSON.stringify(report, null, 2)}\n`, "utf8");
}
if (parsed.values.md) {
  writeFileSync(parsed.values.md, markdown(report), "utf8");
}
if (!parsed.values.json && !parsed.values.md) {
  console.log(markdown(report));
}
