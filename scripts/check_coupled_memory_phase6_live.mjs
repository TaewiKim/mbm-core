import { readFileSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";

export function checkCoupledMemoryPhase6Live(result, {
  benchmark = "coupled-memory-phase6-live-model",
} = {}) {
  const failures = [];
  const expect = (condition, message) => {
    if (!condition) {
      failures.push(message);
    }
  };
  const cases = result.cases ?? [];
  const c4Cases = cases.filter((item) => item.condition === "C4");
  const c5Cases = cases.filter((item) => item.condition === "C5");
  const apiErrors = cases.filter((item) => item.api_error);
  const pairedKeys = new Set(cases.map((item) => `${item.scenario_id}:${item.run_index}`));
  const paired = [...pairedKeys].filter((key) =>
    c4Cases.some((item) => `${item.scenario_id}:${item.run_index}` === key)
    && c5Cases.some((item) => `${item.scenario_id}:${item.run_index}` === key));
  const c4Successes = c4Cases.filter((item) => item.model_success).length;
  const c5Successes = c5Cases.filter((item) => item.model_success).length;

  expect(result.benchmark === benchmark, "unexpected benchmark id");
  expect(result.live === true, "Phase 6 check expects live=true");
  expect(c4Cases.length > 0 && c5Cases.length > 0, "expected both C4 and C5 cases");
  expect(paired.length === c5Cases.length && paired.length === c4Cases.length, "C4/C5 cases should be paired");
  expect(apiErrors.length === 0, "live run should have zero API errors");
  expect(result.c4_c5_parity?.differing_feature === "messageBoundMemory", "C4/C5 parity metadata missing");

  return {
    status: failures.length === 0 ? "PASS" : "FAIL",
    failures,
    checked: {
      benchmark: result.benchmark,
      model: result.model,
      cases: cases.length,
      paired_cases: paired.length,
      api_errors: apiErrors.length,
      c4_successes: c4Successes,
      c4_cases: c4Cases.length,
      c5_successes: c5Successes,
      c5_cases: c5Cases.length,
      paired_delta_success_rate: rate(c5Successes, c5Cases.length) - rate(c4Successes, c4Cases.length),
    },
  };
}

function rate(successes, total) {
  return total === 0 ? 0 : successes / total;
}

function markdownReport(check, input) {
  const lines = [];
  lines.push("# Coupled-Memory Phase 6 Live Check");
  lines.push("");
  lines.push(`Input: \`${input}\``);
  lines.push("");
  lines.push(`Status: **${check.status}**`);
  lines.push("");
  lines.push("## Checked Evidence");
  lines.push("");
  lines.push(`- Benchmark: \`${check.checked.benchmark}\``);
  lines.push(`- Model: \`${check.checked.model}\``);
  lines.push(`- Cases: ${check.checked.cases}`);
  lines.push(`- Paired cases: ${check.checked.paired_cases}`);
  lines.push(`- API errors: ${check.checked.api_errors}`);
  lines.push(`- C5 successes: ${check.checked.c5_successes}/${check.checked.c5_cases}`);
  lines.push(`- C4 successes: ${check.checked.c4_successes}/${check.checked.c4_cases}`);
  lines.push(`- Paired delta success rate: ${check.checked.paired_delta_success_rate.toFixed(4)}`);
  lines.push("");
  lines.push("## Failures");
  lines.push("");
  if (check.failures.length === 0) {
    lines.push("- None.");
  } else {
    for (const failure of check.failures) {
      lines.push(`- ${failure}`);
    }
  }
  lines.push("");
  return `${lines.join("\n")}\n`;
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const parsed = parseArgs({
    options: {
      result: { type: "string", default: "results/coupled-memory-phase6-live-pilot-gpt5nano.json" },
      json: { type: "string", default: "results/coupled-memory-phase6-live-pilot-check.json" },
      md: { type: "string", default: "results/coupled-memory-phase6-live-pilot-check.md" },
      benchmark: { type: "string", default: "coupled-memory-phase6-live-model" },
    },
  });
  const result = JSON.parse(readFileSync(parsed.values.result, "utf8"));
  const check = checkCoupledMemoryPhase6Live(result, { benchmark: parsed.values.benchmark });
  mkdirSync(dirname(parsed.values.json), { recursive: true });
  writeFileSync(parsed.values.json, `${JSON.stringify(check, null, 2)}\n`, "utf8");
  writeFileSync(parsed.values.md, markdownReport(check, parsed.values.result), "utf8");
  console.log(`Status: ${check.status}`);
  console.log(`Wrote ${parsed.values.json}`);
  console.log(`Wrote ${parsed.values.md}`);
  if (check.status !== "PASS") {
    process.exitCode = 1;
  }
}
