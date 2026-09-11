#!/usr/bin/env node

import { readFileSync, writeFileSync } from "node:fs";
import { parseArgs } from "node:util";

const EXPECTED_SCENARIOS = ["evidence_conflict", "context_manifest_stress"];
const EXPECTED_PROTOCOLS = [
  "typed-envelope",
  "evidence-capsule",
  "acmcp-full",
  "acmcp-no-evidence",
  "acmcp-no-context-manifest",
  "q-kvcomm-compressed",
];

function load(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

function countBy(items, keyFn) {
  const counts = new Map();
  for (const item of items) {
    const key = keyFn(item);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return counts;
}

function hasSummary(result, protocol, scenario) {
  return result.results.some((item) => item.protocol === protocol && item.scenario === scenario);
}

function check({ datasetPath, resultPath, expectedCasesPerScenario }) {
  const dataset = load(datasetPath);
  const result = load(resultPath);
  const failures = [];
  const scenarioCounts = countBy(dataset.cases, (item) => item.scenario);

  if (dataset.name !== "agent-protocol-hotpotqa-derived") {
    failures.push(`unexpected dataset name: ${dataset.name}`);
  }
  if (!dataset.sources?.some((item) => item.id === "hotpotqa")) {
    failures.push("missing hotpotqa source metadata");
  }
  for (const scenario of EXPECTED_SCENARIOS) {
    if (scenarioCounts.get(scenario) !== expectedCasesPerScenario) {
      failures.push(
        `${scenario} expected ${expectedCasesPerScenario} cases, observed ${scenarioCounts.get(scenario) ?? 0}`,
      );
    }
  }
  const expectedDatasetCases = expectedCasesPerScenario * EXPECTED_SCENARIOS.length;
  if (dataset.cases.length !== expectedDatasetCases) {
    failures.push(`expected ${expectedDatasetCases} dataset cases, observed ${dataset.cases.length}`);
  }
  const observedBenchmarkCases = result.case_count ?? result.cases?.length;
  const expectedBenchmarkCases = dataset.cases.length * EXPECTED_PROTOCOLS.length * result.runs_per_case;
  if (observedBenchmarkCases !== expectedBenchmarkCases) {
    failures.push(`expected ${expectedBenchmarkCases} benchmark cases, observed ${observedBenchmarkCases}`);
  }
  for (const scenario of EXPECTED_SCENARIOS) {
    for (const protocol of EXPECTED_PROTOCOLS) {
      if (!hasSummary(result, protocol, scenario)) {
        failures.push(`missing summary row for ${protocol}/${scenario}`);
      }
    }
  }

  const acmcpEvidence = result.results.find(
    (item) => item.protocol === "acmcp-full" && item.scenario === "evidence_conflict",
  );
  const acmcpContext = result.results.find(
    (item) => item.protocol === "acmcp-full" && item.scenario === "context_manifest_stress",
  );
  const typedEvidence = result.results.find(
    (item) => item.protocol === "typed-envelope" && item.scenario === "evidence_conflict",
  );
  const noContext = result.results.find(
    (item) => item.protocol === "acmcp-no-context-manifest" && item.scenario === "context_manifest_stress",
  );

  if (acmcpEvidence?.success_rate !== 1) {
    failures.push(`acmcp-full evidence success expected 1, observed ${acmcpEvidence?.success_rate}`);
  }
  if (acmcpContext?.success_rate !== 1) {
    failures.push(`acmcp-full context success expected 1, observed ${acmcpContext?.success_rate}`);
  }
  if (acmcpEvidence && (typedEvidence?.success_rate ?? 1) >= acmcpEvidence.success_rate) {
    failures.push("typed-envelope should trail acmcp-full on evidence_conflict");
  }
  if (acmcpContext && (noContext?.success_rate ?? 1) >= acmcpContext.success_rate) {
    failures.push("acmcp-no-context-manifest should trail acmcp-full on context_manifest_stress");
  }

  return {
    status: failures.length === 0 ? "PASS" : "FAIL",
    failures,
    dataset: {
      name: dataset.name,
      version: dataset.version,
      source: "hotpotqa",
      cases: dataset.cases.length,
      scenario_counts: Object.fromEntries(scenarioCounts),
    },
    benchmark: {
      cases: observedBenchmarkCases,
      runs_per_case: result.runs_per_case,
      protocols: EXPECTED_PROTOCOLS,
      scenarios: EXPECTED_SCENARIOS,
    },
    headline: {
      acmcp_full_evidence_success: acmcpEvidence?.success_rate,
      acmcp_full_context_success: acmcpContext?.success_rate,
      typed_envelope_evidence_success: typedEvidence?.success_rate,
      no_context_manifest_success: noContext?.success_rate,
    },
  };
}

function markdown(report) {
  const lines = [
    "# HotpotQA Raw-Derived Benchmark Check",
    "",
    `Status: **${report.status}**`,
    "",
    "| Field | Value |",
    "|---|---:|",
    `| Dataset cases | ${report.dataset.cases} |`,
    `| Benchmark cases | ${report.benchmark.cases} |`,
    `| Runs per protocol-case | ${report.benchmark.runs_per_case} |`,
    `| ACM-CP evidence success | ${report.headline.acmcp_full_evidence_success} |`,
    `| ACM-CP context success | ${report.headline.acmcp_full_context_success} |`,
    `| Typed-envelope evidence success | ${report.headline.typed_envelope_evidence_success} |`,
    `| No-context-manifest success | ${report.headline.no_context_manifest_success} |`,
    "",
    "## Failures",
    "",
  ];
  if (report.failures.length === 0) {
    lines.push("- None.");
  } else {
    for (const failure of report.failures) {
      lines.push(`- ${failure}`);
    }
  }
  lines.push("");
  return `${lines.join("\n")}\n`;
}

const parsed = parseArgs({
  options: {
    dataset: { type: "string", default: "data/raw_derived/protocol_memory_hotpotqa_evidence_context_20.json" },
    result: { type: "string", default: "results/hotpotqa-raw-derived-dryrun-evidence-context-r3-seed2060.json" },
    "expected-cases-per-scenario": { type: "string", default: "20" },
    json: { type: "string", default: "results/hotpotqa-raw-derived-check.json" },
    md: { type: "string", default: "results/hotpotqa-raw-derived-check.md" },
  },
});

const report = check({
  datasetPath: parsed.values.dataset,
  resultPath: parsed.values.result,
  expectedCasesPerScenario: Number.parseInt(parsed.values["expected-cases-per-scenario"], 10),
});
writeFileSync(parsed.values.json, `${JSON.stringify(report, null, 2)}\n`, "utf8");
writeFileSync(parsed.values.md, markdown(report), "utf8");
console.log(`Status: ${report.status}`);
console.log(`Wrote ${parsed.values.json}`);
console.log(`Wrote ${parsed.values.md}`);
if (report.status !== "PASS") {
  process.exitCode = 1;
}
