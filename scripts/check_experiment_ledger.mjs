import { readFileSync, writeFileSync } from "node:fs";
import { parseArgs } from "node:util";

const EXPECTED = [
  {
    id: "phase6-dev24-gpt5nano",
    check: "results/coupled-memory-phase6-live-dev24-gpt5nano-check.json",
    analysis: "results/coupled-memory-phase6-live-dev24-gpt5nano-analysis.json",
    expected: {
      model: "gpt-5-nano",
      paired_cases: 24,
      c5_successes: 24,
      c4_successes: 5,
      c4_forbidden_memory: 19,
      c5_forbidden_memory: 0,
      delta: 0.7916666666666666,
    },
  },
  {
    id: "phase6-dev24-gpt5mini",
    check: "results/coupled-memory-phase6-live-dev24-gpt5mini-check.json",
    analysis: "results/coupled-memory-phase6-live-dev24-gpt5mini-analysis.json",
    expected: {
      model: "gpt-5-mini",
      paired_cases: 24,
      c5_successes: 24,
      c4_successes: 9,
      c4_forbidden_memory: 15,
      c5_forbidden_memory: 0,
      delta: 0.625,
    },
  },
  {
    id: "phase6-dev24-combined-2models",
    analysis: "results/coupled-memory-phase6-live-dev24-combined-2models-analysis.json",
    expected: {
      model: "gpt-5-mini, gpt-5-nano",
      paired_cases: 48,
      c5_successes: 48,
      c4_successes: 14,
      c4_forbidden_memory: 34,
      c5_forbidden_memory: 0,
      delta: 0.7083333333333334,
    },
  },
  {
    id: "phase6-dev24-r3-gpt5nano",
    check: "results/coupled-memory-phase6-live-dev24-r3-gpt5nano-check.json",
    analysis: "results/coupled-memory-phase6-live-dev24-r3-gpt5nano-analysis.json",
    expected: {
      model: "gpt-5-nano",
      paired_cases: 72,
      c5_successes: 70,
      c4_successes: 19,
      c4_forbidden_memory: 53,
      c5_forbidden_memory: 0,
      delta: 0.7083333333333334,
    },
  },
  {
    id: "phase6-dev24-r3-gpt5mini",
    check: "results/coupled-memory-phase6-live-dev24-r3-gpt5mini-check.json",
    analysis: "results/coupled-memory-phase6-live-dev24-r3-gpt5mini-analysis.json",
    expected: {
      model: "gpt-5-mini",
      paired_cases: 72,
      c5_successes: 69,
      c4_successes: 26,
      c4_forbidden_memory: 46,
      c5_forbidden_memory: 0,
      delta: 0.5972222222222222,
    },
  },
  {
    id: "phase6-dev24-r3-combined-2models",
    analysis: "results/coupled-memory-phase6-live-dev24-r3-combined-2models-analysis.json",
    expected: {
      model: "gpt-5-mini, gpt-5-nano",
      paired_cases: 144,
      c5_successes: 139,
      c4_successes: 45,
      c4_forbidden_memory: 99,
      c5_forbidden_memory: 0,
      delta: 0.6527777777777778,
    },
  },
  {
    id: "phase6-main40-gpt5nano",
    check: "results/coupled-memory-phase6-live-main40-gpt5nano-check.json",
    analysis: "results/coupled-memory-phase6-live-main40-gpt5nano-analysis.json",
    expected: {
      model: "gpt-5-nano",
      paired_cases: 40,
      c5_successes: 39,
      c4_successes: 11,
      c4_forbidden_memory: 30,
      c5_forbidden_memory: 0,
      delta: 0.7,
    },
  },
  {
    id: "phase6-main40-gpt5mini",
    check: "results/coupled-memory-phase6-live-main40-gpt5mini-check.json",
    analysis: "results/coupled-memory-phase6-live-main40-gpt5mini-analysis.json",
    expected: {
      model: "gpt-5-mini",
      paired_cases: 40,
      c5_successes: 37,
      c4_successes: 14,
      c4_forbidden_memory: 26,
      c5_forbidden_memory: 0,
      delta: 0.575,
    },
  },
  {
    id: "phase6-main40-combined-2models",
    analysis: "results/coupled-memory-phase6-live-main40-combined-2models-analysis.json",
    expected: {
      model: "gpt-5-mini, gpt-5-nano",
      paired_cases: 80,
      c5_successes: 76,
      c4_successes: 25,
      c4_forbidden_memory: 56,
      c5_forbidden_memory: 0,
      delta: 0.6375,
    },
  },
  {
    id: "phase6-main40-r3-gpt5nano",
    check: "results/coupled-memory-phase6-live-main40-r3-gpt5nano-check.json",
    analysis: "results/coupled-memory-phase6-live-main40-r3-gpt5nano-analysis.json",
    expected: {
      model: "gpt-5-nano",
      paired_cases: 120,
      c5_successes: 118,
      c4_successes: 26,
      c4_forbidden_memory: 93,
      c5_forbidden_memory: 0,
      delta: 0.7666666666666667,
    },
  },
  {
    id: "phase6-main40-r3-gpt5mini",
    check: "results/coupled-memory-phase6-live-main40-r3-gpt5mini-check.json",
    analysis: "results/coupled-memory-phase6-live-main40-r3-gpt5mini-analysis.json",
    expected: {
      model: "gpt-5-mini",
      paired_cases: 120,
      c5_successes: 115,
      c4_successes: 38,
      c4_forbidden_memory: 82,
      c5_forbidden_memory: 0,
      delta: 0.6416666666666667,
    },
  },
  {
    id: "phase6-main40-r3-combined-2models",
    analysis: "results/coupled-memory-phase6-live-main40-r3-combined-2models-analysis.json",
    expected: {
      model: "gpt-5-mini, gpt-5-nano",
      paired_cases: 240,
      c5_successes: 233,
      c4_successes: 64,
      c4_forbidden_memory: 175,
      c5_forbidden_memory: 0,
      delta: 0.7041666666666667,
    },
  },
];

function load(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

function closeEnough(a, b) {
  return Math.abs(Number(a) - Number(b)) < 1e-9;
}

function checkOne(item) {
  const failures = [];
  const check = item.check ? load(item.check) : null;
  const analysis = item.analysis ? load(item.analysis) : null;
  const actual = {
    model: analysis?.model ?? check?.checked?.model,
    paired_cases: analysis?.paired_n ?? check?.checked?.paired_cases,
    c5_successes: analysis?.c5_successes ?? check?.checked?.c5_successes,
    c4_successes: analysis?.c4_successes ?? check?.checked?.c4_successes,
    c4_forbidden_memory: analysis?.c4_forbidden_memory,
    c5_forbidden_memory: analysis?.c5_forbidden_memory,
    delta: analysis?.paired_success_delta ?? check?.checked?.paired_delta_success_rate,
  };
  for (const [key, expected] of Object.entries(item.expected)) {
    const observed = actual[key];
    const ok = typeof expected === "number" ? closeEnough(observed, expected) : observed === expected;
    if (!ok) {
      failures.push(`${item.id}.${key}: expected ${expected}, observed ${observed}`);
    }
  }
  return {
    id: item.id,
    status: failures.length === 0 ? "PASS" : "FAIL",
    failures,
    actual,
  };
}

function markdown(report) {
  const lines = [
    "# Experiment Ledger Check",
    "",
    `Status: **${report.status}**`,
    "",
    "| Experiment | Status | Paired cases | C5 successes | C4 successes | Delta | Forbidden C4/C5 |",
    "|---|---|---:|---:|---:|---:|---:|",
  ];
  for (const item of report.checks) {
    lines.push([
      item.id,
      item.status,
      item.actual.paired_cases,
      item.actual.c5_successes,
      item.actual.c4_successes,
      Number(item.actual.delta).toFixed(4),
      `${item.actual.c4_forbidden_memory}/${item.actual.c5_forbidden_memory}`,
    ].join(" | ").replace(/^/, "| ").replace(/$/, " |"));
  }
  lines.push("");
  lines.push("## Failures");
  lines.push("");
  const failures = report.checks.flatMap((item) => item.failures);
  if (failures.length === 0) {
    lines.push("- None.");
  } else {
    for (const failure of failures) {
      lines.push(`- ${failure}`);
    }
  }
  lines.push("");
  return `${lines.join("\n")}\n`;
}

const parsed = parseArgs({
  options: {
    json: { type: "string", default: "results/experiment-ledger-check.json" },
    md: { type: "string", default: "results/experiment-ledger-check.md" },
  },
});

const checks = EXPECTED.map(checkOne);
const report = {
  status: checks.every((item) => item.status === "PASS") ? "PASS" : "FAIL",
  checks,
};
writeFileSync(parsed.values.json, `${JSON.stringify(report, null, 2)}\n`, "utf8");
writeFileSync(parsed.values.md, markdown(report), "utf8");
console.log(`Status: ${report.status}`);
console.log(`Wrote ${parsed.values.json}`);
console.log(`Wrote ${parsed.values.md}`);
if (report.status !== "PASS") {
  process.exitCode = 1;
}
