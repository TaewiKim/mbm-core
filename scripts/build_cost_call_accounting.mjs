#!/usr/bin/env node

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { parseArgs } from "node:util";

const DEFAULT_TRACKS = [
  {
    id: "coupled_live_main40_r3",
    path: "results/coupled-memory-phase6-live-main40-r3-combined-2models.json",
    command: "npm run coupled:combine:phase6:live:main40-r3",
  },
  {
    id: "dropin_live_main40_r3",
    path: "results/dropin-protocol-replacement-live-main40-r3-combined.json",
    command: "npm run dropin:combine:live:main40-r3",
  },
  {
    id: "raw_broad_live_hard20_c10",
    path: "results/raw-hard20-live-gpt54-mini-nano-c10-r1-repair1-combined.json",
    command: "npm run raw:combine:hard20:live:gpt54:c10",
  },
  {
    id: "hotpotqa_live_c20",
    path: "results/hotpotqa-validation-live-gpt54-mini-nano-c20-r1-repair1-combined.json",
    command: "npm run raw:combine:hotpotqa:validation:live:gpt54:c20",
  },
];

function load(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

function number(value) {
  return Number.isFinite(Number(value)) ? Number(value) : 0;
}

function sum(cases, field) {
  return cases.reduce((total, item) => total + number(item[field]), 0);
}

function mean(total, count) {
  return count === 0 ? 0 : total / count;
}

function unique(values) {
  return [...new Set(values.filter(Boolean))].sort();
}

function modelCounts(cases, fallbackModels = []) {
  const counts = new Map();
  const models = cases.length > 0 ? cases.map((item) => item.model).filter(Boolean) : fallbackModels;
  for (const model of models) {
    counts.set(model, (counts.get(model) ?? 0) + 1);
  }
  return Object.fromEntries([...counts.entries()].sort());
}

function summarizeTrack(track) {
  const result = load(track.path);
  const cases = result.cases ?? [];
  const calls = cases.length;
  const apiErrors = cases.filter((item) => item.api_error).length;
  const parseErrors = sum(cases, "parse_errors");
  const invalidDecisions = sum(cases, "invalid_decisions");
  const promptTokens = sum(cases, "prompt_tokens_estimate");
  const wireBytes = sum(cases, "wire_bytes");
  const latencyMs = sum(cases, "latency_ms");
  const repairs = sum(cases, "repairs_used");
  const models = unique([
    ...(result.models ?? []),
    ...String(result.model ?? "").split(",").map((item) => item.trim()),
    ...cases.map((item) => item.model),
  ]);
  return {
    id: track.id,
    path: track.path,
    command: track.command,
    benchmark: result.benchmark,
    models,
    model_call_counts: modelCounts(cases, models),
    live: result.live === true || cases.some((item) => item.live === true),
    calls,
    successful_api_calls: calls - apiErrors,
    api_errors: apiErrors,
    parse_errors: parseErrors,
    invalid_decisions: invalidDecisions,
    repairs_used: repairs,
    prompt_tokens_estimate_total: promptTokens,
    prompt_tokens_estimate_mean: mean(promptTokens, calls),
    wire_bytes_total: wireBytes,
    wire_bytes_mean: mean(wireBytes, calls),
    latency_ms_total: latencyMs,
    latency_ms_mean: mean(latencyMs, calls),
  };
}

function loadPricing(path) {
  if (!path || !existsSync(path)) {
    return null;
  }
  return load(path);
}

function attachPricing(rows, pricing) {
  if (!pricing) {
    return rows.map((row) => ({
      ...row,
      cost_usd_estimate: null,
      cost_note: "No pricing file supplied; call/token accounting only.",
    }));
  }
  return rows.map((row) => {
    let inputCost = 0;
    for (const [model, calls] of Object.entries(row.model_call_counts)) {
      const price = pricing[model];
      if (!price?.input_per_1m || row.prompt_tokens_estimate_total === 0) {
        continue;
      }
      const modelShare = calls / Math.max(1, row.calls);
      inputCost += (row.prompt_tokens_estimate_total * modelShare / 1_000_000) * Number(price.input_per_1m);
    }
    return {
      ...row,
      cost_usd_estimate: Number(inputCost.toFixed(6)),
      cost_note: "Input-token-only estimate from prompt_tokens_estimate; output tokens are not available in current artifacts.",
    };
  });
}

function totals(rows) {
  const fields = [
    "calls",
    "successful_api_calls",
    "api_errors",
    "parse_errors",
    "invalid_decisions",
    "repairs_used",
    "prompt_tokens_estimate_total",
    "wire_bytes_total",
    "latency_ms_total",
  ];
  const output = {};
  for (const field of fields) {
    output[field] = rows.reduce((total, row) => total + number(row[field]), 0);
  }
  output.cost_usd_estimate = rows.some((row) => row.cost_usd_estimate != null)
    ? Number(rows.reduce((total, row) => total + number(row.cost_usd_estimate), 0).toFixed(6))
    : null;
  return output;
}

function buildReport({ pricingPath = "" } = {}) {
  const pricing = loadPricing(pricingPath);
  const tracks = attachPricing(DEFAULT_TRACKS.map(summarizeTrack), pricing);
  return {
    generated_for: "ACM-CP live experiment cost/call accounting",
    pricing_file: pricingPath || null,
    pricing_note: pricing
      ? "USD is input-token-only when prompt token estimates are present."
      : "USD not computed because no pricing file was supplied.",
    tracks,
    totals: totals(tracks),
  };
}

function fmt(value, digits = 2) {
  if (value == null) return "N/A";
  if (!Number.isFinite(Number(value))) return String(value);
  return Number(value).toFixed(digits);
}

function markdown(report) {
  const lines = [];
  lines.push("# Cost And Call Accounting");
  lines.push("");
  lines.push(report.generated_for);
  lines.push("");
  lines.push(`Pricing note: ${report.pricing_note}`);
  lines.push("");
  lines.push("| Track | Models | Calls | API errors | Parse errors | Invalid | Repairs | Prompt tokens est. | Wire bytes | Mean latency ms | USD est. |");
  lines.push("| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |");
  for (const row of report.tracks) {
    lines.push([
      `| ${row.id}`,
      row.models.join(", "),
      row.calls,
      row.api_errors,
      row.parse_errors,
      row.invalid_decisions,
      row.repairs_used,
      Math.round(row.prompt_tokens_estimate_total),
      Math.round(row.wire_bytes_total),
      fmt(row.latency_ms_mean, 1),
      row.cost_usd_estimate == null ? "N/A" : fmt(row.cost_usd_estimate, 6),
    ].join(" | ") + " |");
  }
  lines.push("");
  lines.push("## Totals");
  lines.push("");
  for (const [key, value] of Object.entries(report.totals)) {
    lines.push(`- ${key}: ${value == null ? "N/A" : value}`);
  }
  lines.push("");
  lines.push("## Commands");
  lines.push("");
  for (const row of report.tracks) {
    lines.push(`- ${row.id}: \`${row.command}\``);
  }
  lines.push("");
  return `${lines.join("\n")}\n`;
}

const parsed = parseArgs({
  options: {
    pricing: { type: "string", default: "" },
    json: { type: "string", default: "results/cost-call-accounting.json" },
    md: { type: "string", default: "results/cost-call-accounting.md" },
  },
});

const report = buildReport({ pricingPath: parsed.values.pricing });
writeFileSync(parsed.values.json, `${JSON.stringify(report, null, 2)}\n`, "utf8");
writeFileSync(parsed.values.md, markdown(report), "utf8");
console.log(`Wrote ${parsed.values.json}`);
console.log(`Wrote ${parsed.values.md}`);
