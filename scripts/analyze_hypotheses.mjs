#!/usr/bin/env node

import { readFileSync, writeFileSync } from "node:fs";
import { parseArgs } from "node:util";

function load(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

function mean(values) {
  return values.length === 0 ? 0 : values.reduce((total, value) => total + value, 0) / values.length;
}

function makeRng(seed) {
  let state = seed >>> 0;
  return () => {
    state = (1664525 * state + 1013904223) >>> 0;
    return state / 0x100000000;
  };
}

function quantile(values, q) {
  if (values.length === 0) {
    return 0;
  }
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.floor(q * (sorted.length - 1))));
  return sorted[index];
}

function byProtocolScenario(cases) {
  const groups = new Map();
  for (const item of cases) {
    const key = `${item.protocol}:${item.scenario}`;
    if (!groups.has(key)) {
      groups.set(key, []);
    }
    groups.get(key).push(item);
  }
  return groups;
}

function metricValue(item, metric) {
  if (metric in item) {
    return Number(item[metric]);
  }
  return Number(item.metrics?.[metric] ?? 0);
}

function pairKey(item) {
  return `${item.model ?? "model"}::${item.case_id ?? "case"}::${item.run_index ?? item.seed ?? 0}`;
}

function metricValues(groups, protocol, scenario, metric) {
  return (groups.get(`${protocol}:${scenario}`) ?? []).map((item) => {
    return metricValue(item, metric);
  });
}

function summarize(groups, protocol, scenario, metric) {
  const values = metricValues(groups, protocol, scenario, metric);
  return {
    protocol,
    scenario,
    metric,
    n: values.length,
    mean: Number(mean(values).toFixed(4)),
  };
}

function pairedDeltas(groups, treatment, control, scenario, metric, direction) {
  const treatmentItems = groups.get(`${treatment}:${scenario}`) ?? [];
  const controlItems = groups.get(`${control}:${scenario}`) ?? [];
  const treatmentByKey = new Map(treatmentItems.map((item) => [pairKey(item), metricValue(item, metric)]));
  const controlByKey = new Map(controlItems.map((item) => [pairKey(item), metricValue(item, metric)]));
  const commonKeys = [...treatmentByKey.keys()]
    .filter((key) => controlByKey.has(key))
    .sort();
  return commonKeys.map((key) => {
    const tValue = treatmentByKey.get(key);
    const cValue = controlByKey.get(key);
    return direction === "lower" ? cValue - tValue : tValue - cValue;
  });
}

function bootstrapMeanDelta(deltas, iterations, seed) {
  if (deltas.length === 0 || iterations < 1) {
    return { low: 0, high: 0 };
  }
  const rng = makeRng(seed);
  const sampledMeans = [];
  for (let i = 0; i < iterations; i += 1) {
    const sample = [];
    for (let j = 0; j < deltas.length; j += 1) {
      const index = Math.floor(rng() * deltas.length);
      sample.push(deltas[index]);
    }
    sampledMeans.push(mean(sample));
  }
  return {
    low: Number(quantile(sampledMeans, 0.025).toFixed(4)),
    high: Number(quantile(sampledMeans, 0.975).toFixed(4)),
  };
}

function signTestPValue(deltas) {
  const nonZero = deltas.filter((value) => value !== 0);
  if (nonZero.length === 0) {
    return 1;
  }
  const positives = nonZero.filter((value) => value > 0).length;
  const negatives = nonZero.length - positives;
  const k = Math.min(positives, negatives);
  let probability = Math.pow(0.5, nonZero.length);
  let tail = probability;
  for (let i = 1; i <= k; i += 1) {
    probability *= (nonZero.length - i + 1) / i;
    tail += probability;
  }
  return Number(Math.min(1, 2 * tail).toExponential(4));
}

function contrast(groups, name, treatment, control, scenario, metric, direction = "higher", bootstrap = 1000, seed = 1) {
  const t = summarize(groups, treatment, scenario, metric);
  const c = summarize(groups, control, scenario, metric);
  const deltas = pairedDeltas(groups, treatment, control, scenario, metric, direction);
  const delta = mean(deltas);
  return {
    name,
    scenario,
    metric,
    direction,
    treatment: t,
    control: c,
    delta: Number(delta.toFixed(4)),
    paired_n: deltas.length,
    bootstrap_ci_95: bootstrapMeanDelta(deltas, bootstrap, seed),
    sign_test_p_value: signTestPValue(deltas),
    available: t.n > 0 && c.n > 0 && deltas.length > 0,
  };
}

function markdownReport(analysis) {
  const lines = [
    "# Hypothesis Analysis",
    "",
    `Input: \`${analysis.input}\``,
    "",
    "## Health",
    "",
    `- cases: ${analysis.health.cases}`,
    `- parse errors: ${analysis.health.parse_errors}`,
    `- invalid decisions: ${analysis.health.invalid}`,
    `- API errors: ${analysis.health.api_errors}`,
    "",
    "## Contrasts",
    "",
    "| Hypothesis | Scenario | Metric | Treatment | Control | Paired n | Delta | 95% paired bootstrap CI | Sign-test p | Direction |",
    "| --- | --- | --- | --- | --- | ---: | ---: | --- | ---: | --- |",
  ];
  for (const item of analysis.contrasts) {
    if (!item.available) {
      continue;
    }
    lines.push(`| ${[
      item.name,
      item.scenario,
      item.metric,
      `${item.treatment.protocol}=${item.treatment.mean}`,
      `${item.control.protocol}=${item.control.mean}`,
      item.paired_n,
      item.delta,
      `[${item.bootstrap_ci_95.low}, ${item.bootstrap_ci_95.high}]`,
      item.sign_test_p_value,
      item.direction,
    ].join(" | ")} |`);
  }
  lines.push("");
  lines.push("## Interpretation Notes");
  lines.push("");
  for (const note of analysis.notes) {
    lines.push(`- ${note}`);
  }
  const skipped = analysis.contrasts.filter((item) => !item.available);
  if (skipped.length > 0) {
    lines.push("- Skipped unavailable contrasts: "
      + skipped.map((item) => `${item.name}/${item.scenario}`).join(", "));
  }
  lines.push("");
  return `${lines.join("\n")}\n`;
}

const parsed = parseArgs({
  options: {
    file: { type: "string" },
    json: { type: "string" },
    md: { type: "string" },
    bootstrap: { type: "string", default: "1000" },
    seed: { type: "string", default: "123" },
  },
});

if (!parsed.values.file) {
  throw new Error("--file is required");
}

const result = load(parsed.values.file);
const cases = result.cases ?? [];
const groups = byProtocolScenario(cases);
const bootstrap = Number.parseInt(parsed.values.bootstrap, 10);
const seed = Number.parseInt(parsed.values.seed, 10);
const health = {
  cases: cases.length,
  parse_errors: cases.reduce((total, item) => total + (item.parse_errors ?? 0), 0),
  invalid: cases.reduce((total, item) => total + (item.invalid_decisions ?? item.invalid_messages ?? 0), 0),
  api_errors: cases.filter((item) => item.api_error).length,
};

const contrasts = [
  contrast(groups, "H1 Evidence Capsules", "evidence-capsule", "typed-envelope", "evidence_conflict", "success", "higher", bootstrap, seed + 1),
  contrast(groups, "H1 Provenance", "evidence-capsule", "typed-envelope", "evidence_conflict", "claim_provenance_coverage", "higher", bootstrap, seed + 2),
  contrast(groups, "H2 Proof Capability", "proof-capability", "typed-envelope", "capability_deception", "success", "higher", bootstrap, seed + 3),
  contrast(groups, "H3 Commitment Receipt", "commitment-receipt", "proof-capability", "delegation_drift", "success", "higher", bootstrap, seed + 4),
  contrast(groups, "H4 Scoped Memory", "scoped-memory", "commitment-receipt", "scoped_memory_privacy", "secret_leak_events", "lower", bootstrap, seed + 5),
  contrast(groups, "H4 Full Policy Trace", "acmcp-full", "scoped-memory", "scoped_memory_privacy", "secret_leak_events", "lower", bootstrap, seed + 6),
  contrast(groups, "H5 Context Manifest", "acmcp-full", "evidence-capsule", "context_manifest_stress", "wire_bytes", "lower", bootstrap, seed + 7),
  contrast(groups, "Ablation Evidence", "acmcp-full", "acmcp-no-evidence", "evidence_conflict", "success", "higher", bootstrap, seed + 8),
  contrast(groups, "Ablation Proof", "acmcp-full", "acmcp-no-proof", "capability_deception", "success", "higher", bootstrap, seed + 9),
  contrast(groups, "Ablation Commitment", "acmcp-full", "acmcp-no-commitment", "delegation_drift", "success", "higher", bootstrap, seed + 10),
  contrast(groups, "Ablation Scope", "acmcp-full", "acmcp-no-scope", "scoped_memory_privacy", "secret_leak_events", "lower", bootstrap, seed + 11),
  contrast(groups, "Ablation Policy Trace", "acmcp-full", "acmcp-no-policy-trace", "scoped_memory_privacy", "secret_leak_events", "lower", bootstrap, seed + 12),
  contrast(groups, "Ablation Context Manifest", "acmcp-full", "acmcp-no-context-manifest", "context_manifest_stress", "wire_bytes", "lower", bootstrap, seed + 13),
];

const analysis = {
  input: parsed.values.file,
  benchmark: result.benchmark,
  model: result.model,
  live: result.live,
  health,
  contrasts,
  notes: [
    "Bootstrap intervals are paired by case_id and run_index.",
    "Sign-test p-values are nonparametric diagnostics over paired deltas, not a substitute for preregistered confirmatory testing.",
    "A positive delta means the treatment improved the metric in the requested direction.",
    "For leak and wire-byte metrics, lower is better and delta is computed as control minus treatment.",
  ],
};

if (parsed.values.json) {
  writeFileSync(parsed.values.json, `${JSON.stringify(analysis, null, 2)}\n`, "utf8");
}
if (parsed.values.md) {
  writeFileSync(parsed.values.md, markdownReport(analysis), "utf8");
}
if (!parsed.values.json && !parsed.values.md) {
  console.log(markdownReport(analysis));
}
