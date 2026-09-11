#!/usr/bin/env node

import { readFileSync, writeFileSync } from "node:fs";
import { parseArgs } from "node:util";

const RELIABILITY_CONTROLS = [
  "typed-envelope",
  "a2a-task-artifact",
  "autogen-conversation",
  "mpac-coordination",
  "mesh-memory",
  "q-kvcomm-compressed",
];

const ABLATION_NAMES = [
  "Ablation Evidence",
  "Ablation Proof",
  "Ablation Commitment",
  "Ablation Scope",
  "Ablation Policy Trace",
  "Ablation Context Manifest",
];

function load(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

function contrast(analysis, metric, control) {
  return (analysis.contrasts ?? []).find((item) =>
    item.metric === metric
    && item.control?.protocol === control);
}

function namedContrast(analysis, name) {
  return (analysis.contrasts ?? []).find((item) => item.name === name);
}

function ciLow(item) {
  return Number(item?.bootstrap_ci_95?.low ?? Number.NaN);
}

function allControlsPass(analysis, metric, predicate) {
  return RELIABILITY_CONTROLS.every((control) => {
    const item = contrast(analysis, metric, control);
    return item && predicate(item);
  });
}

function minDelta(analysis, metric) {
  const values = RELIABILITY_CONTROLS
    .map((control) => contrast(analysis, metric, control)?.delta)
    .filter((value) => Number.isFinite(value));
  return values.length === 0 ? 0 : Math.min(...values);
}

function worstCiLow(analysis, metric) {
  const values = RELIABILITY_CONTROLS
    .map((control) => ciLow(contrast(analysis, metric, control)))
    .filter((value) => Number.isFinite(value));
  return values.length === 0 ? 0 : Math.min(...values);
}

function wireCaveats(analysis) {
  return RELIABILITY_CONTROLS
    .map((control) => contrast(analysis, "wire_bytes", control))
    .filter((item) => item && item.delta < 0)
    .map((item) => ({
      control: item.control.protocol,
      delta: item.delta,
      treatment_mean: item.treatment.mean,
      control_mean: item.control.mean,
    }));
}

function ablationSupport(analysis) {
  const rows = ABLATION_NAMES.map((name) => namedContrast(analysis, name)).filter(Boolean);
  return {
    available: rows.length,
    total: ABLATION_NAMES.length,
    all_positive: rows.length === ABLATION_NAMES.length && rows.every((item) => item.delta > 0 && ciLow(item) >= 0),
    min_delta: rows.length === 0 ? 0 : Math.min(...rows.map((item) => item.delta)),
  };
}

function status(pass, caveat = false) {
  if (pass) {
    return caveat ? "SUPPORTED_WITH_CAVEAT" : "SUPPORTED";
  }
  return "NEEDS_WORK";
}

function buildClaims({ headline, ablation, headlinePath, ablationPath }) {
  const successPass = allControlsPass(headline, "success", (item) => item.delta > 0 && ciLow(item) > 0);
  const scorePass = allControlsPass(headline, "score", (item) => item.delta > 0 && ciLow(item) > 0);
  const leakPass = allControlsPass(headline, "secret_leak_events", (item) =>
    item.treatment.mean === 0 && item.treatment.mean <= item.control.mean);
  const wireLosers = wireCaveats(headline);
  const ablations = ablationSupport(ablation);

  return {
    headline_analysis: headlinePath,
    ablation_analysis: ablationPath,
    model: headline.model,
    live: headline.live,
    health: headline.health,
    modes: [
      {
        mode: "native_protocol_comparison",
        status: status(successPass && scorePass && leakPass),
        claim: "ACM-CP/1.0 Core is SOTA on communication-memory reliability against native-style A2A, AutoGen, MPAC, Mesh Memory, Q-KVComm, and typed-envelope baselines in the Tier 2 benchmark.",
        evidence: {
          min_success_delta: minDelta(headline, "success"),
          worst_success_ci_low: worstCiLow(headline, "success"),
          min_score_delta: minDelta(headline, "score"),
          worst_score_ci_low: worstCiLow(headline, "score"),
          zero_leak: leakPass,
        },
      },
      {
        mode: "matched_task_model_evaluator",
        status: status(successPass && scorePass && leakPass),
        claim: "Under matched task cases, model, transcript runner, and oracle-hidden evaluator, ACM-CP has the strongest reliability envelope.",
        evidence: {
          paired_n_per_control: (headline.contrasts ?? []).find((item) => item.metric === "success")?.paired_n ?? 0,
          model: headline.model,
          live: headline.live,
          api_errors: headline.health?.api_errors ?? 0,
          parse_or_validation_errors: headline.health?.invalid_or_parse_errors ?? 0,
        },
        caveat: "This is not strict information-identical comparison because protocol-native visibility and enforcement differ by design.",
      },
      {
        mode: "budget_pareto_comparison",
        status: status(successPass && scorePass && leakPass, wireLosers.length > 0),
        claim: "ACM-CP is reliability-SOTA on the Pareto surface, but not pure wire-byte SOTA.",
        evidence: {
          lower_wire_controls: wireLosers,
          interpretation: "Q-KVComm-style compression remains the efficiency winner where wire bytes are the only target.",
        },
      },
      {
        mode: "ablation_causal_support",
        status: status(ablations.all_positive, true),
        claim: "ACM-CP's individual semantics have causal support from ablations; this supports mechanism novelty rather than external SOTA by itself.",
        evidence: ablations,
        caveat: "Current ablation evidence is strongest in deterministic/Tier 1 matrices; full Tier 2 ablations are still needed for submission.",
      },
    ],
    allowed_headline: "ACM-CP/1.0 Core achieves protocol-layer SOTA on communication-memory reliability under split native, matched-runner, and Pareto-aware comparisons; Q-KVComm remains stronger for pure wire-byte compression.",
    forbidden_headline: "ACM-CP is universally SOTA for all multi-agent communication metrics or beats prior systems under their original implementations and datasets.",
  };
}

function markdown(report) {
  const lines = [
    "# Split SOTA Claim Report",
    "",
    `Headline analysis: \`${report.headline_analysis}\``,
    `Ablation analysis: \`${report.ablation_analysis}\``,
    `Model: \`${report.model}\``,
    `Live: \`${report.live}\``,
    "",
    "## Allowed Headline",
    "",
    report.allowed_headline,
    "",
    "## Forbidden Headline",
    "",
    report.forbidden_headline,
    "",
    "## Mode Claims",
    "",
    "| Mode | Status | Claim | Key evidence | Caveat |",
    "| --- | --- | --- | --- | --- |",
  ];
  for (const item of report.modes) {
    lines.push(`| ${item.mode} | ${item.status} | ${item.claim} | ${JSON.stringify(item.evidence)} | ${item.caveat ?? "None."} |`);
  }
  lines.push("");
  return `${lines.join("\n")}\n`;
}

const parsed = parseArgs({
  options: {
    headline: { type: "string", default: "results/headline-stage1-live-acmcp-core-analysis-seed2031-tls0.json" },
    ablation: { type: "string", default: "results/pilot-hypothesis-analysis.json" },
    md: { type: "string" },
    json: { type: "string" },
  },
});

const report = buildClaims({
  headline: load(parsed.values.headline),
  ablation: load(parsed.values.ablation),
  headlinePath: parsed.values.headline,
  ablationPath: parsed.values.ablation,
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
