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

function metricValue(item, metric) {
  if (metric in item) {
    return Number(item[metric]);
  }
  return Number(item.metrics?.[metric] ?? 0);
}

function modelKey(item) {
  return item.model ?? item.model_setting ?? item.metadata?.model ?? "single-model";
}

function pairKey(item) {
  return `${modelKey(item)}:${item.scenario}:${item.case_id}:${item.run_index ?? 0}`;
}

function byProtocol(cases, protocol) {
  return new Map(cases.filter((item) => item.protocol === protocol).map((item) => [pairKey(item), item]));
}

function pairedDeltas(cases, treatment, control, metric, direction) {
  const treatmentByKey = byProtocol(cases, treatment);
  const controlByKey = byProtocol(cases, control);
  const keys = [...treatmentByKey.keys()].filter((key) => controlByKey.has(key)).sort();
  return keys.map((key) => {
    const tValue = metricValue(treatmentByKey.get(key), metric);
    const cValue = metricValue(controlByKey.get(key), metric);
    return direction === "lower" ? cValue - tValue : tValue - cValue;
  });
}

function bootstrap(deltas, iterations, seed) {
  if (deltas.length === 0) {
    return { low: 0, high: 0 };
  }
  const rng = makeRng(seed);
  const means = [];
  for (let i = 0; i < iterations; i += 1) {
    const sample = [];
    for (let j = 0; j < deltas.length; j += 1) {
      sample.push(deltas[Math.floor(rng() * deltas.length)]);
    }
    means.push(mean(sample));
  }
  return {
    low: Number(quantile(means, 0.025).toFixed(4)),
    high: Number(quantile(means, 0.975).toFixed(4)),
  };
}

function summarize(cases, protocol, metric) {
  const values = cases.filter((item) => item.protocol === protocol).map((item) => metricValue(item, metric));
  return {
    n: values.length,
    mean: Number(mean(values).toFixed(4)),
  };
}

function contrast(cases, name, metric, direction, treatment, control, bootstrapIterations, seed) {
  const deltas = pairedDeltas(cases, treatment, control, metric, direction);
  return {
    name,
    metric,
    direction,
    treatment: {
      protocol: treatment,
      ...summarize(cases, treatment, metric),
    },
    control: {
      protocol: control,
      ...summarize(cases, control, metric),
    },
    paired_n: deltas.length,
    delta: Number(mean(deltas).toFixed(4)),
    bootstrap_ci_95: bootstrap(deltas, bootstrapIterations, seed),
  };
}

function parseControls(value) {
  return value.split(",").map((item) => item.trim()).filter(Boolean);
}

function markdown(analysis) {
  const lines = [
    "# Tier 2 Transcript Analysis",
    "",
    `Input: \`${analysis.input}\``,
    `Final protocol: \`${analysis.final_protocol}\``,
    "",
    "## Health",
    "",
    `- transcript cases: ${analysis.health.cases}`,
    `- api calls: ${analysis.health.api_calls}`,
    `- api errors: ${analysis.health.api_errors}`,
    `- parse/validation errors: ${analysis.health.invalid_or_parse_errors}`,
    "",
    "## Final Protocol Contrasts",
    "",
    "| Contrast | Metric | Treatment | Control | Paired n | Delta | 95% paired bootstrap CI | Direction |",
    "| --- | --- | --- | --- | ---: | ---: | --- | --- |",
  ];
  for (const item of analysis.contrasts) {
    lines.push(`| ${[
      item.name,
      item.metric,
      `${item.treatment.protocol}=${item.treatment.mean}`,
      `${item.control.protocol}=${item.control.mean}`,
      item.paired_n,
      item.delta,
      `[${item.bootstrap_ci_95.low}, ${item.bootstrap_ci_95.high}]`,
      item.direction,
    ].join(" | ")} |`);
  }
  lines.push("");
  lines.push("## Interpretation Boundary");
  lines.push("");
  lines.push("- This is Tier 2 only if the input result was produced by the live multi-agent transcript runner.");
  lines.push("- Paired n in pilot runs is small; use as evidence-gathering, not final submission statistics.");
  lines.push("- The final protocol is compared against the control protocol(s) specified by `--control`.");
  lines.push("");
  return `${lines.join("\n")}\n`;
}

const parsed = parseArgs({
  options: {
    file: { type: "string" },
    json: { type: "string" },
    md: { type: "string" },
    treatment: { type: "string", default: "acmcp-core" },
    control: { type: "string", default: "typed-envelope" },
    bootstrap: { type: "string", default: "1000" },
    seed: { type: "string", default: "2027" },
  },
});

if (!parsed.values.file) {
  throw new Error("--file is required");
}

const result = load(parsed.values.file);
const cases = result.cases ?? [];
const treatment = parsed.values.treatment;
const controls = parseControls(parsed.values.control);
const bootstrapIterations = Number.parseInt(parsed.values.bootstrap, 10);
const seed = Number.parseInt(parsed.values.seed, 10);
const analysis = {
  input: parsed.values.file,
  benchmark: result.benchmark,
  final_protocol: result.final_protocol ?? treatment,
  model: result.model,
  live: result.live,
  health: {
    cases: cases.length,
    api_calls: cases.reduce((total, item) => total + (item.api_calls ?? 0), 0),
    api_errors: cases.filter((item) => item.api_error).length,
    invalid_or_parse_errors: cases.reduce((total, item) => total + (item.invalid_decisions ?? 0) + (item.parse_errors ?? 0), 0),
  },
  contrasts: controls.flatMap((control, index) => [
    contrast(cases, `Task success vs ${control}`, "success", "higher", treatment, control, bootstrapIterations, seed + 10 * index + 1),
    contrast(cases, `Score vs ${control}`, "score", "higher", treatment, control, bootstrapIterations, seed + 10 * index + 2),
    contrast(cases, `Secret leakage vs ${control}`, "secret_leak_events", "lower", treatment, control, bootstrapIterations, seed + 10 * index + 3),
    contrast(cases, `Wire bytes vs ${control}`, "wire_bytes", "lower", treatment, control, bootstrapIterations, seed + 10 * index + 4),
  ]),
};

if (parsed.values.json) {
  writeFileSync(parsed.values.json, `${JSON.stringify(analysis, null, 2)}\n`, "utf8");
}
if (parsed.values.md) {
  writeFileSync(parsed.values.md, markdown(analysis), "utf8");
}
if (!parsed.values.json && !parsed.values.md) {
  console.log(markdown(analysis));
}
