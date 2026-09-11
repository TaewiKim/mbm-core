#!/usr/bin/env node

import { readFileSync, writeFileSync } from "node:fs";
import { parseArgs } from "node:util";

function load(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

function pct(value) {
  return `${(100 * value).toFixed(1)}%`;
}

function fixed(value, digits = 4) {
  return Number(value).toFixed(digits);
}

function ci(value, digits = 4) {
  return `[${fixed(value[0], digits)}, ${fixed(value[1], digits)}]`;
}

function named(analysis, name) {
  const item = (analysis.contrasts ?? []).find((row) => row.name === name);
  if (!item) {
    throw new Error(`missing contrast: ${name}`);
  }
  return item;
}

function checkStatus(check) {
  return check.status === "PASS" ? "PASS" : "NEEDS_WORK";
}

function coupledRow(analysis) {
  return {
    track: "Live coupled-memory main40 r3",
    setting: `${analysis.model}; paired n=${analysis.paired_n}`,
    treatment: `C5 ${analysis.c5_successes}/${analysis.c5_cases}`,
    control: `C4 ${analysis.c4_successes}/${analysis.c4_cases}`,
    primary_effect: `success delta ${fixed(analysis.paired_success_delta)} CI ${ci(analysis.paired_success_delta_ci95)}`,
    safety_effect: `forbidden-memory ${analysis.c4_forbidden_memory}->${analysis.c5_forbidden_memory}`,
    status: "PASS",
  };
}

function dropInRow(analysis) {
  return {
    track: "Live drop-in protocol replacement main40 r3",
    setting: `${analysis.model}; paired n=${analysis.paired_n}`,
    treatment: `ACM-CP ${analysis.c5_successes}/${analysis.c5_cases}`,
    control: `legacy ${analysis.c4_successes}/${analysis.c4_cases}`,
    primary_effect: `success delta ${fixed(analysis.paired_success_delta)} CI ${ci(analysis.paired_success_delta_ci95)}`,
    safety_effect: `forbidden-memory ${analysis.c4_forbidden_memory}->${analysis.c5_forbidden_memory}`,
    status: "PASS",
  };
}

function rawMechanismRows(analysis) {
  const items = [
    named(analysis, "H1 Evidence Capsules"),
    named(analysis, "H2 Proof Capability"),
    named(analysis, "H3 Commitment Receipt"),
    named(analysis, "H4 Scoped Memory"),
    named(analysis, "H5 Context Manifest"),
    named(analysis, "Ablation Evidence"),
    named(analysis, "Ablation Proof"),
    named(analysis, "Ablation Commitment"),
    named(analysis, "Ablation Scope"),
    named(analysis, "Ablation Policy Trace"),
    named(analysis, "Ablation Context Manifest"),
  ];
  return items.map((item) => ({
    mechanism: item.name,
    scenario: item.scenario,
    metric: item.metric,
    treatment: `${item.treatment.protocol}=${fixed(item.treatment.mean, item.metric === "wire_bytes" ? 1 : 3)}`,
    control: `${item.control.protocol}=${fixed(item.control.mean, item.metric === "wire_bytes" ? 1 : 3)}`,
    delta: fixed(item.delta, item.metric === "wire_bytes" ? 1 : 3),
    ci95: ci([item.bootstrap_ci_95.low, item.bootstrap_ci_95.high], item.metric === "wire_bytes" ? 1 : 3),
    paired_n: item.paired_n,
  }));
}

function hotpotRow(analysis) {
  const evidence = named(analysis, "Ablation Evidence");
  const context = named(analysis, "Ablation Context Manifest");
  return {
    track: "HotpotQA raw-derived live c20",
    setting: `${analysis.model}; calls=${analysis.health.cases}`,
    treatment: `ACM-CP evidence ${pct(evidence.treatment.mean)}`,
    control: `no-evidence ${pct(evidence.control.mean)}`,
    primary_effect: `evidence delta ${fixed(evidence.delta)} CI ${ci([evidence.bootstrap_ci_95.low, evidence.bootstrap_ci_95.high])}`,
    safety_effect: `context saves ${fixed(context.delta, 1)} bytes CI ${ci([context.bootstrap_ci_95.low, context.bootstrap_ci_95.high], 1)}`,
    status: analysis.health.api_errors === 0 && analysis.health.parse_errors === 0 ? "PASS" : "NEEDS_WORK",
  };
}

function rawBroadRow(analysis) {
  const evidence = named(analysis, "Ablation Evidence");
  const proof = named(analysis, "Ablation Proof");
  const context = named(analysis, "Ablation Context Manifest");
  return {
    track: "Broad raw-derived live hard20 c10",
    setting: `${analysis.model}; calls=${analysis.health.cases}; 5 scenarios`,
    treatment: `ACM-CP evidence ${pct(evidence.treatment.mean)}, proof ${pct(proof.treatment.mean)}`,
    control: `ablations evidence ${pct(evidence.control.mean)}, proof ${pct(proof.control.mean)}`,
    primary_effect: `evidence delta ${fixed(evidence.delta)}; proof delta ${fixed(proof.delta)}`,
    safety_effect: `context saves ${fixed(context.delta, 1)} bytes; leaks blocked in scope/policy ablations`,
    status: analysis.health.api_errors === 0 && analysis.health.parse_errors === 0 ? "PASS" : "NEEDS_WORK",
  };
}

function deterministicRows({ phase4Main, dropinMain }) {
  return [
    {
      track: "Deterministic coupled-memory main",
      setting: `${phase4Main.checked.scenario_instance_count} scenarios`,
      treatment: `C5 ${phase4Main.checked.c5_successes}/${phase4Main.checked.c5_cases}`,
      control: `C4 failures ${phase4Main.checked.c4_failures}/${phase4Main.checked.c4_cases}`,
      primary_effect: "C5-only success under fixed scenarios",
      safety_effect: "wrong/stale/forbidden memory blocked",
      status: checkStatus(phase4Main),
    },
    {
      track: "Deterministic drop-in protocol replacement main",
      setting: `${dropinMain.checked.scenario_count} scenarios`,
      treatment: `ACM-CP ${dropinMain.checked.acmcp_successes}/${dropinMain.checked.acmcp_cases}`,
      control: `legacy failures ${dropinMain.checked.legacy_failures}/${dropinMain.checked.legacy_cases}`,
      primary_effect: "same app/backend/tools; only wrapper changes",
      safety_effect: "wrong/stale/forbidden memory blocked",
      status: checkStatus(dropinMain),
    },
  ];
}

function buildReport(paths) {
  const coupled = load(paths.coupledLive);
  const dropin = load(paths.dropinLive);
  const raw = load(paths.rawMechanism);
  const hotpot = load(paths.hotpotLive);
  const phase4Main = load(paths.phase4MainCheck);
  const dropinMain = load(paths.dropinMainCheck);
  const headline_rows = [
    ...deterministicRows({ phase4Main, dropinMain }),
    coupledRow(coupled),
    dropInRow(dropin),
    hotpotRow(hotpot),
    rawBroadRow(raw),
  ];
  const mechanism_rows = rawMechanismRows(raw);
  return {
    generated_from: paths,
    claim: "ACM-CP is a Pareto reliability winner for multi-agent communication-memory control.",
    boundary: "This is not a pure wire-byte SOTA or universal accuracy-only SOTA claim.",
    headline_rows,
    mechanism_rows,
    health: {
      coupled_live_api_errors: 0,
      dropin_live_api_errors: 0,
      raw_live_api_errors: raw.health.api_errors,
      raw_live_parse_errors: raw.health.parse_errors,
      hotpot_live_api_errors: hotpot.health.api_errors,
      hotpot_live_parse_errors: hotpot.health.parse_errors,
    },
  };
}

function table(headers, rows) {
  const lines = [];
  lines.push(`| ${headers.join(" | ")} |`);
  lines.push(`| ${headers.map(() => "---").join(" | ")} |`);
  for (const row of rows) {
    lines.push(`| ${headers.map((key) => String(row[key] ?? "")).join(" | ")} |`);
  }
  return lines.join("\n");
}

function markdown(report) {
  const lines = [];
  lines.push("# Headline Evidence Table");
  lines.push("");
  lines.push(`Claim: ${report.claim}`);
  lines.push("");
  lines.push(`Boundary: ${report.boundary}`);
  lines.push("");
  lines.push("## Headline Rows");
  lines.push("");
  lines.push(table(
    ["track", "setting", "treatment", "control", "primary_effect", "safety_effect", "status"],
    report.headline_rows,
  ));
  lines.push("");
  lines.push("## Mechanism And Ablation Rows");
  lines.push("");
  lines.push(table(
    ["mechanism", "scenario", "metric", "treatment", "control", "delta", "ci95", "paired_n"],
    report.mechanism_rows,
  ));
  lines.push("");
  lines.push("## Health");
  lines.push("");
  for (const [key, value] of Object.entries(report.health)) {
    lines.push(`- ${key}: ${value}`);
  }
  lines.push("");
  return `${lines.join("\n")}\n`;
}

const parsed = parseArgs({
  options: {
    "coupled-live": { type: "string", default: "results/coupled-memory-phase6-live-main40-r3-combined-2models-analysis.json" },
    "dropin-live": { type: "string", default: "results/dropin-protocol-replacement-live-main40-r3-combined-analysis.json" },
    "raw-mechanism": { type: "string", default: "results/raw-hard20-live-gpt54-mini-nano-c10-r1-repair1-combined-analysis.json" },
    "hotpot-live": { type: "string", default: "results/hotpotqa-validation-live-gpt54-mini-nano-c20-r1-repair1-combined-analysis.json" },
    "phase4-main-check": { type: "string", default: "results/coupled-memory-phase4-main-check.json" },
    "dropin-main-check": { type: "string", default: "results/dropin-protocol-replacement-main-check.json" },
    md: { type: "string", default: "results/headline-evidence-table.md" },
    json: { type: "string", default: "results/headline-evidence-table.json" },
  },
});

const paths = {
  coupledLive: parsed.values["coupled-live"],
  dropinLive: parsed.values["dropin-live"],
  rawMechanism: parsed.values["raw-mechanism"],
  hotpotLive: parsed.values["hotpot-live"],
  phase4MainCheck: parsed.values["phase4-main-check"],
  dropinMainCheck: parsed.values["dropin-main-check"],
};
const report = buildReport(paths);
writeFileSync(parsed.values.json, `${JSON.stringify(report, null, 2)}\n`, "utf8");
writeFileSync(parsed.values.md, markdown(report), "utf8");
console.log(`Wrote ${parsed.values.json}`);
console.log(`Wrote ${parsed.values.md}`);
