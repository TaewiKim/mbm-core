#!/usr/bin/env node

import { readFileSync, writeFileSync } from "node:fs";
import { parseArgs } from "node:util";

const DEFAULT_CONTROLS = [
  "typed-envelope",
  "a2a-task-artifact",
  "autogen-conversation",
  "mpac-coordination",
  "mesh-memory",
  "q-kvcomm-compressed",
];

const DEFAULT_SCENARIOS = [
  "capability_deception",
  "evidence_conflict",
  "delegation_drift",
  "scoped_memory_privacy",
  "context_manifest_stress",
];

function load(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

function parseList(value, fallback) {
  if (!value) {
    return fallback;
  }
  return value.split(",").map((item) => item.trim()).filter(Boolean);
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

function mean(values) {
  return values.length === 0 ? 0 : values.reduce((total, value) => total + value, 0) / values.length;
}

function metricValue(item, metric) {
  if (metric in item) {
    return Number(item[metric]);
  }
  return Number(item.metrics?.[metric] ?? 0);
}

function scenarioCaseCounts(cases, scenarios) {
  const counts = new Map(scenarios.map((scenario) => [scenario, new Set()]));
  for (const item of cases) {
    if (counts.has(item.scenario)) {
      counts.get(item.scenario).add(item.case_id);
    }
  }
  return Object.fromEntries([...counts].map(([scenario, ids]) => [scenario, ids.size]));
}

function modelKey(item) {
  return item.model ?? "single-model";
}

function minRepeatCount(cases, protocols, scenarios) {
  const scenarioSet = new Set(scenarios);
  const protocolSet = new Set(protocols);
  const models = unique(cases.map(modelKey).filter(Boolean));
  const idsByScenario = new Map(scenarios.map((scenario) => [scenario, new Set()]));
  for (const item of cases) {
    if (scenarioSet.has(item.scenario)) {
      idsByScenario.get(item.scenario).add(item.case_id);
    }
  }
  const expected = new Set();
  for (const model of models) {
    for (const protocol of protocols) {
      for (const scenario of scenarios) {
        for (const id of idsByScenario.get(scenario) ?? []) {
          expected.add(`${model}:${protocol}:${scenario}:${id}`);
        }
      }
    }
  }
  if (expected.size === 0) {
    return 0;
  }
  const counts = countBy(
    cases.filter((item) => protocolSet.has(item.protocol) && scenarioSet.has(item.scenario)),
    (item) => `${modelKey(item)}:${item.protocol}:${item.scenario}:${item.case_id}`,
  );
  return Math.min(...[...expected].map((key) => counts.get(key) ?? 0));
}

function completeMatrix(cases, protocols, scenarios) {
  const observed = new Set(cases.map((item) => `${item.protocol}:${item.scenario}`));
  return protocols.every((protocol) => scenarios.every((scenario) => observed.has(`${protocol}:${scenario}`)));
}

function isSyntheticDataset(dataset) {
  const text = [
    dataset?.name,
    dataset?.version,
    dataset?.path,
    dataset?.fixture_policy,
  ].filter(Boolean).join(" ").toLowerCase();
  return text.includes("synthetic") || text.includes("fixture");
}

function findContrast(analysis, metric, control) {
  return (analysis.contrasts ?? []).find((item) => item.metric === metric && item.control?.protocol === control);
}

function ciLow(item) {
  return Number(item?.bootstrap_ci_95?.low ?? Number.NaN);
}

function check(name, pass, evidence, next) {
  return {
    name,
    status: pass ? "PASS" : "NEEDS_WORK",
    pass,
    evidence,
    next: pass ? "None." : next,
  };
}

function protocolMeans(cases, protocol) {
  const protocolCases = cases.filter((item) => item.protocol === protocol);
  return {
    protocol,
    success: Number(mean(protocolCases.map((item) => metricValue(item, "success"))).toFixed(4)),
    score: Number(mean(protocolCases.map((item) => metricValue(item, "score"))).toFixed(4)),
    secret_leak_events: Number(mean(protocolCases.map((item) => metricValue(item, "secret_leak_events"))).toFixed(4)),
    wire_bytes: Number(mean(protocolCases.map((item) => metricValue(item, "wire_bytes"))).toFixed(1)),
  };
}

function dominatedByReliability(cases, treatment, controls) {
  const t = protocolMeans(cases, treatment);
  return controls
    .map((control) => protocolMeans(cases, control))
    .filter((control) =>
      control.success >= t.success
      && control.score >= t.score
      && control.secret_leak_events <= t.secret_leak_events
      && (
        control.success > t.success
        || control.score > t.score
        || control.secret_leak_events < t.secret_leak_events
      ));
}

function wireByteCaveats(cases, treatment, controls) {
  const t = protocolMeans(cases, treatment);
  return controls
    .map((control) => protocolMeans(cases, control))
    .filter((control) => control.wire_bytes < t.wire_bytes)
    .map((control) => `${control.protocol} (${control.wire_bytes} < ${t.wire_bytes})`);
}

function buildReport({
  result,
  analysis,
  resultPath,
  analysisPath,
  treatment,
  controls,
  scenarios,
  minCases,
  minRepeats,
  minModels,
  minSuccessDelta,
  minScoreDelta,
  requirePositiveCi,
  requireLive,
  allowSynthetic,
}) {
  const cases = result.cases ?? [];
  const expectedProtocols = [...controls, treatment];
  const counts = scenarioCaseCounts(cases, scenarios);
  const minimumCases = Object.values(counts).length === 0 ? 0 : Math.min(...Object.values(counts));
  const repeats = minRepeatCount(cases, expectedProtocols, scenarios);
  const models = unique(cases.map((item) => item.model ?? result.model).filter(Boolean));
  const parseErrors = cases.reduce((total, item) => total + (item.parse_errors ?? 0), 0);
  const invalidDecisions = cases.reduce((total, item) => total + (item.invalid_decisions ?? 0), 0);
  const apiErrors = cases.filter((item) => item.api_error).length;
  const reliabilityDominators = dominatedByReliability(cases, treatment, controls);
  const wireCaveats = wireByteCaveats(cases, treatment, controls);

  const successContrasts = controls.map((control) => ({
    control,
    contrast: findContrast(analysis, "success", control),
  }));
  const scoreContrasts = controls.map((control) => ({
    control,
    contrast: findContrast(analysis, "score", control),
  }));
  const leakContrasts = controls.map((control) => ({
    control,
    contrast: findContrast(analysis, "secret_leak_events", control),
  }));
  const missingContrasts = [...successContrasts, ...scoreContrasts, ...leakContrasts].filter((item) => !item.contrast);
  const successPass = successContrasts.every(({ contrast }) =>
    contrast
    && contrast.delta >= minSuccessDelta
    && (!requirePositiveCi || ciLow(contrast) > 0));
  const scorePass = scoreContrasts.every(({ contrast }) =>
    contrast
    && contrast.delta >= minScoreDelta
    && (!requirePositiveCi || ciLow(contrast) > 0));
  const leakPass = leakContrasts.every(({ contrast }) =>
    contrast
    && contrast.treatment.mean === 0
    && contrast.treatment.mean <= contrast.control.mean);
  const checks = [
    check(
      "live transcript evidence",
      !requireLive || result.live === true,
      `result.live=${result.live}`,
      "Run the Tier 2 live transcript benchmark, not a deterministic or single-call proxy.",
    ),
    check(
      "complete protocol/scenario matrix",
      completeMatrix(cases, expectedProtocols, scenarios),
      `${unique(cases.map((item) => item.protocol)).length}/${expectedProtocols.length} protocols x ${unique(cases.map((item) => item.scenario)).length}/${scenarios.length} scenarios`,
      "Fill missing protocol/scenario cells before claiming a main result.",
    ),
    check(
      "minimum cases per scenario",
      minimumCases >= minCases,
      `minimum=${minimumCases}, target=${minCases}`,
      "Increase --max-cases-per-scenario or convert more raw cases.",
    ),
    check(
      "minimum repeats per case",
      repeats >= minRepeats,
      `minimum=${repeats}, target=${minRepeats}`,
      "Increase --runs for each live benchmark model setting.",
    ),
    check(
      "model-setting coverage",
      models.length >= minModels,
      `models=${models.join(", ") || "none"}, target=${minModels}`,
      "Repeat the headline table with additional model families or model settings.",
    ),
    check(
      "raw-derived data requirement",
      allowSynthetic || !isSyntheticDataset(result.dataset),
      `dataset=${result.dataset?.name ?? "missing"}`,
      "Convert and run raw-derived public dataset cases; keep synthetic cases as stress tests only.",
    ),
    check(
      "no execution errors",
      parseErrors === 0 && invalidDecisions === 0 && apiErrors === 0,
      `parse=${parseErrors}, invalid=${invalidDecisions}, api=${apiErrors}`,
      "Fix failed cells and rerun affected matrix slices.",
    ),
    check(
      "all reliability contrasts present",
      missingContrasts.length === 0,
      `missing=${missingContrasts.map((item) => `${item.control}:${item.metric}`).join(", ") || "none"}`,
      "Regenerate analysis with all controls and reliability metrics.",
    ),
    check(
      "success dominance with uncertainty",
      successPass,
      successContrasts.map(({ control, contrast }) => `${control}: delta=${contrast?.delta}, ci_low=${ciLow(contrast)}`).join("; "),
      "Increase sample size/repeats or improve protocol behavior until all success CIs clear zero.",
    ),
    check(
      "score dominance with uncertainty",
      scorePass,
      scoreContrasts.map(({ control, contrast }) => `${control}: delta=${contrast?.delta}, ci_low=${ciLow(contrast)}`).join("; "),
      "Increase sample size/repeats or improve protocol behavior until all score CIs clear zero.",
    ),
    check(
      "zero-leak reliability envelope",
      leakPass,
      leakContrasts.map(({ control, contrast }) => `${control}: treatment=${contrast?.treatment.mean}, control=${contrast?.control.mean}`).join("; "),
      "ACM-CP must preserve zero leakage and be no worse than every control.",
    ),
    check(
      "not reliability-dominated",
      reliabilityDominators.length === 0,
      `dominators=${reliabilityDominators.map((item) => item.protocol).join(", ") || "none"}`,
      "A control dominates ACM-CP on reliability metrics; narrow or improve the claim.",
    ),
  ];

  return {
    result_file: resultPath,
    analysis_file: analysisPath,
    treatment,
    controls,
    scenarios,
    headline_claim: "protocol-layer SOTA on communication-memory reliability, not pure wire-byte efficiency",
    summary: {
      cases: cases.length,
      protocols: unique(cases.map((item) => item.protocol)).length,
      scenarios: unique(cases.map((item) => item.scenario)).length,
      min_cases_per_scenario: minimumCases,
      min_repeats_per_case: repeats,
      models,
      parse_errors: parseErrors,
      invalid_decisions: invalidDecisions,
      api_errors: apiErrors,
      synthetic_dataset: isSyntheticDataset(result.dataset),
      wire_byte_caveats: wireCaveats,
    },
    checks,
    pass: checks.every((item) => item.pass),
  };
}

function markdown(report) {
  const lines = [
    "# Headline SOTA Readiness Check",
    "",
    `Result: \`${report.result_file}\``,
    `Analysis: \`${report.analysis_file}\``,
    `Claim: ${report.headline_claim}`,
    "",
    "## Summary",
    "",
    `- status: ${report.pass ? "PASS" : "NEEDS_WORK"}`,
    `- cases: ${report.summary.cases}`,
    `- protocols: ${report.summary.protocols}`,
    `- scenarios: ${report.summary.scenarios}`,
    `- minimum unique cases per scenario: ${report.summary.min_cases_per_scenario}`,
    `- minimum repeats per case: ${report.summary.min_repeats_per_case}`,
    `- models: ${report.summary.models.join(", ") || "none"}`,
    `- synthetic dataset: ${report.summary.synthetic_dataset}`,
    `- parse errors: ${report.summary.parse_errors}`,
    `- invalid decisions: ${report.summary.invalid_decisions}`,
    `- API errors: ${report.summary.api_errors}`,
    `- wire-byte caveats: ${report.summary.wire_byte_caveats.join("; ") || "none"}`,
    "",
    "## Checks",
    "",
    "| Check | Status | Evidence | Next action |",
    "| --- | --- | --- | --- |",
  ];
  for (const item of report.checks) {
    lines.push(`| ${item.name} | ${item.status} | ${item.evidence} | ${item.next} |`);
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
    treatment: { type: "string", default: "acmcp-core" },
    controls: { type: "string", default: DEFAULT_CONTROLS.join(",") },
    scenarios: { type: "string", default: DEFAULT_SCENARIOS.join(",") },
    "min-cases": { type: "string", default: "10" },
    "min-repeats": { type: "string", default: "5" },
    "min-models": { type: "string", default: "2" },
    "min-success-delta": { type: "string", default: "0.05" },
    "min-score-delta": { type: "string", default: "0.02" },
    "require-positive-ci": { type: "boolean", default: true },
    "require-live": { type: "boolean", default: true },
    "allow-synthetic": { type: "boolean", default: false },
    "fail-on-needs-work": { type: "boolean", default: false },
  },
});

if (!parsed.values.result || !parsed.values.analysis) {
  throw new Error("--result and --analysis are required");
}

const result = load(parsed.values.result);
const analysis = load(parsed.values.analysis);
const report = buildReport({
  result,
  analysis,
  resultPath: parsed.values.result,
  analysisPath: parsed.values.analysis,
  treatment: parsed.values.treatment,
  controls: parseList(parsed.values.controls, DEFAULT_CONTROLS),
  scenarios: parseList(parsed.values.scenarios, DEFAULT_SCENARIOS),
  minCases: Number.parseInt(parsed.values["min-cases"], 10),
  minRepeats: Number.parseInt(parsed.values["min-repeats"], 10),
  minModels: Number.parseInt(parsed.values["min-models"], 10),
  minSuccessDelta: Number.parseFloat(parsed.values["min-success-delta"]),
  minScoreDelta: Number.parseFloat(parsed.values["min-score-delta"]),
  requirePositiveCi: parsed.values["require-positive-ci"],
  requireLive: parsed.values["require-live"],
  allowSynthetic: parsed.values["allow-synthetic"],
});

if (parsed.values.json) {
  writeFileSync(parsed.values.json, `${JSON.stringify(report, null, 2)}\n`, "utf8");
}
if (parsed.values.md) {
  writeFileSync(parsed.values.md, markdown(report), "utf8");
}
if (!parsed.values.json && !parsed.values.md) {
  console.log(markdown(report));
}
if (!report.pass && parsed.values["fail-on-needs-work"]) {
  process.exitCode = 1;
}
