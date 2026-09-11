#!/usr/bin/env node

import { readFileSync, writeFileSync } from "node:fs";
import { parseArgs } from "node:util";

function load(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

function status(pass, caveat = false) {
  if (pass) {
    return caveat ? "SUPPORTED_WITH_CAVEAT" : "SUPPORTED";
  }
  return "NEEDS_WORK";
}

function findMode(split, mode) {
  return (split.modes ?? []).find((item) => item.mode === mode);
}

function failedChecks(report) {
  return (report.checks ?? []).filter((item) => !item.pass);
}

function evidenceCheckPass(report) {
  return (report.checks ?? []).length > 0 && (report.checks ?? []).every((item) => item.pass);
}

function makeModeRows(split) {
  const specs = {
    native_protocol_comparison: {
      held_fixed: "task families, transcript runner, evaluator, model, seed plan",
      intentionally_varied: "protocol-native state, visibility, enforcement, and message semantics",
      valid_claim: "native protocol-layer reliability SOTA in the benchmark",
    },
    matched_task_model_evaluator: {
      held_fixed: "case ids, oracle-hidden evaluator, live model, transcript runner",
      intentionally_varied: "protocol-specific admissible evidence, memory, and policy controls",
      valid_claim: "matched-runner reliability dominance, not strict information-identical dominance",
    },
    budget_pareto_comparison: {
      held_fixed: "same cases and scoring, observed wire-byte accounting",
      intentionally_varied: "compression-vs-reliability objective",
      valid_claim: "reliability Pareto SOTA; pure wire-byte SOTA is excluded",
    },
    ablation_causal_support: {
      held_fixed: "ACM-CP family and scenario failure modes",
      intentionally_varied: "one semantic component removed at a time",
      valid_claim: "mechanism support for novelty, not external SOTA by itself",
    },
  };
  return (split.modes ?? []).map((item) => ({
    ...item,
    held_fixed: specs[item.mode]?.held_fixed ?? "not specified",
    intentionally_varied: specs[item.mode]?.intentionally_varied ?? "not specified",
    valid_claim: specs[item.mode]?.valid_claim ?? item.claim,
  }));
}

function buildMatrix({ split, headlineCheck, evidenceCheck, paths }) {
  const native = findMode(split, "native_protocol_comparison");
  const matched = findMode(split, "matched_task_model_evaluator");
  const budget = findMode(split, "budget_pareto_comparison");
  const stage1Pass = evidenceCheckPass(evidenceCheck)
    && native?.status === "SUPPORTED"
    && matched?.status === "SUPPORTED";
  const submissionGaps = failedChecks(headlineCheck);
  const submissionPass = headlineCheck.pass === true && stage1Pass;
  const pureWireBlocked = (budget?.evidence?.lower_wire_controls ?? []).length > 0;

  return {
    generated_from: paths,
    allowed_headline: split.allowed_headline,
    forbidden_headline: split.forbidden_headline,
    claim_tiers: [
      {
        tier: "stage1_live_protocol_reliability",
        status: status(stage1Pass),
        claim: split.allowed_headline,
        evidence: "Stage1 live transcript matrix passes protocol/scenario/error gates and split native/matched reliability modes.",
      },
      {
        tier: "headline_submission",
        status: status(submissionPass),
        claim: "Submission-ready SOTA headline after raw-derived cases, repeat count, and model-setting gates pass.",
        evidence: submissionPass
          ? "All submission gates pass."
          : `${submissionGaps.length} submission gate(s) still open.`,
      },
      {
        tier: "pure_wire_byte_efficiency",
        status: pureWireBlocked ? "FORBIDDEN" : "SUPPORTED_WITH_CAVEAT",
        claim: "ACM-CP is pure communication-efficiency SOTA.",
        evidence: pureWireBlocked
          ? "Blocked by lower-wire Q-KVComm-style comparator."
          : "No lower-wire comparator detected in the supplied split report.",
      },
    ],
    comparison_modes: makeModeRows(split),
    submission_gaps: submissionGaps.map((item) => ({
      name: item.name,
      evidence: item.evidence,
      next: item.next,
    })),
    next_experiments: submissionPass ? [
      "Freeze exact raw JSON, JSONL, analysis, and check artifacts for supplementary reproducibility.",
      "Record checksums and dataset conversion provenance for every public-source row.",
      "Run Tier 2 live ablations for each ACM-CP semantic removal.",
      "Prepare reviewer-facing tables that separate reliability SOTA from pure wire-byte efficiency.",
    ] : [
      "Run target live table with 10 raw-derived cases per hard scenario and 5 repeats.",
      "Repeat the headline table with a second model setting.",
      "Run Tier 2 live ablations for each ACM-CP semantic removal.",
      "Package exact commands, raw JSON files, and dataset conversion hashes for supplementary reproducibility.",
    ],
  };
}

function markdown(report) {
  const lines = [
    "# Submission Evidence Matrix",
    "",
    "## Claim Tiers",
    "",
    "| Tier | Status | Claim | Evidence |",
    "| --- | --- | --- | --- |",
  ];
  for (const item of report.claim_tiers) {
    lines.push(`| ${item.tier} | ${item.status} | ${item.claim} | ${item.evidence} |`);
  }
  lines.push("");
  lines.push("## Comparison Modes");
  lines.push("");
  lines.push("| Mode | Status | Held fixed | Intentionally varied | Valid claim |");
  lines.push("| --- | --- | --- | --- | --- |");
  for (const item of report.comparison_modes) {
    lines.push(`| ${item.mode} | ${item.status} | ${item.held_fixed} | ${item.intentionally_varied} | ${item.valid_claim} |`);
  }
  lines.push("");
  lines.push("## Open Submission Gaps");
  lines.push("");
  lines.push("| Gap | Evidence | Next action |");
  lines.push("| --- | --- | --- |");
  for (const gap of report.submission_gaps) {
    lines.push(`| ${gap.name} | ${gap.evidence} | ${gap.next} |`);
  }
  if (report.submission_gaps.length === 0) {
    lines.push("| None | All supplied gates pass. | Freeze artifacts and run final audit. |");
  }
  lines.push("");
  lines.push("## Allowed Headline");
  lines.push("");
  lines.push(report.allowed_headline);
  lines.push("");
  lines.push("## Forbidden Headline");
  lines.push("");
  lines.push(report.forbidden_headline);
  lines.push("");
  lines.push("## Next Experiments");
  lines.push("");
  for (const item of report.next_experiments) {
    lines.push(`- ${item}`);
  }
  lines.push("");
  return `${lines.join("\n")}\n`;
}

const parsed = parseArgs({
  options: {
    split: { type: "string", default: "results/split-sota-claims-stage1.json" },
    "headline-check": { type: "string", default: "results/headline-sota-current-vs-target-check.json" },
    "evidence-check": { type: "string", default: "results/headline-stage1-live-acmcp-core-evidence-check-seed2031-tls0.json" },
    md: { type: "string" },
    json: { type: "string" },
  },
});

const report = buildMatrix({
  split: load(parsed.values.split),
  headlineCheck: load(parsed.values["headline-check"]),
  evidenceCheck: load(parsed.values["evidence-check"]),
  paths: {
    split: parsed.values.split,
    headline_check: parsed.values["headline-check"],
    evidence_check: parsed.values["evidence-check"],
  },
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
