import { readFileSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";

const REQUIRED_HARNESSES = ["sqlite-reference", "langgraph-checkpoint-shim"];
const REQUIRED_SCENARIO_COUNT = 27;

function casesFor(result, harnessId, scenarioId) {
  return result.cases?.filter((item) => item.harness_id === harnessId && item.scenario_id === scenarioId) ?? [];
}

function caseFor(result, harnessId, scenarioId, condition) {
  return casesFor(result, harnessId, scenarioId).find((item) => item.condition === condition);
}

export function checkCoupledMemoryPhase5(result) {
  const failures = [];
  const expect = (condition, message) => {
    if (!condition) {
      failures.push(message);
    }
  };

  expect(result.benchmark === "coupled-memory-phase5-harness-adapter-suite", "unexpected benchmark id");
  expect(result.live === false, "phase5 adapter suite must be deterministic and API-free");
  expect(result.adapter_status === "parity-shim", "phase5 result should be marked as adapter parity shim");
  expect(result.c4_c5_parity?.differing_feature === "messageBoundMemory", "C4/C5 parity metadata missing or invalid");
  expect((result.scenarios?.length ?? 0) === REQUIRED_SCENARIO_COUNT, "phase5 should reuse the full 9x3 dev scenario split");

  const harnessIds = new Set((result.harnesses ?? []).map((item) => item.harness_id));
  for (const harnessId of REQUIRED_HARNESSES) {
    expect(harnessIds.has(harnessId), `missing harness adapter: ${harnessId}`);
    for (const scenario of result.scenarios ?? []) {
      const scenarioCases = casesFor(result, harnessId, scenario.scenario_id);
      expect(scenarioCases.length === 6, `${harnessId}/${scenario.scenario_id} should have all six C0-C5 cases`);
      const c4 = caseFor(result, harnessId, scenario.scenario_id, "C4");
      const c5 = caseFor(result, harnessId, scenario.scenario_id, "C5");
      expect(c4?.success === false, `${harnessId}/${scenario.scenario_id} C4 should fail`);
      expect(c5?.success === true, `${harnessId}/${scenario.scenario_id} C5 should succeed`);
      expect(c5?.wrong_scope_memory_use === 0, `${harnessId}/${scenario.scenario_id} C5 should have zero wrong-scope memory`);
      expect(c5?.stale_memory_use === 0, `${harnessId}/${scenario.scenario_id} C5 should have zero stale memory`);
      expect(c5?.forbidden_memory_use === 0, `${harnessId}/${scenario.scenario_id} C5 should have zero forbidden memory`);
      expect(c5?.missing_critical_memory === 0, `${harnessId}/${scenario.scenario_id} C5 should have zero missing critical memory`);
    }
  }

  const c5Cases = result.cases?.filter((item) => item.condition === "C5") ?? [];
  const c4Cases = result.cases?.filter((item) => item.condition === "C4") ?? [];
  return {
    status: failures.length === 0 ? "PASS" : "FAIL",
    failures,
    checked: {
      benchmark: result.benchmark,
      adapter_status: result.adapter_status,
      harness_count: result.harnesses?.length ?? 0,
      scenario_count: result.scenarios?.length ?? 0,
      case_count: result.cases?.length ?? 0,
      c5_successes: c5Cases.filter((item) => item.success).length,
      c5_cases: c5Cases.length,
      c4_failures: c4Cases.filter((item) => !item.success).length,
      c4_cases: c4Cases.length,
    },
  };
}

function markdownReport(check, input) {
  const lines = [];
  lines.push("# Coupled-Memory Phase 5 Harness-Adapter Check");
  lines.push("");
  lines.push(`Input: \`${input}\``);
  lines.push("");
  lines.push(`Status: **${check.status}**`);
  lines.push("");
  lines.push("## Checked Evidence");
  lines.push("");
  lines.push(`- Benchmark: \`${check.checked.benchmark}\``);
  lines.push(`- Adapter status: \`${check.checked.adapter_status}\``);
  lines.push(`- Harness count: ${check.checked.harness_count}`);
  lines.push(`- Scenario count: ${check.checked.scenario_count}`);
  lines.push(`- Case count: ${check.checked.case_count}`);
  lines.push(`- C5 successes: ${check.checked.c5_successes}/${check.checked.c5_cases}`);
  lines.push(`- C4 failures: ${check.checked.c4_failures}/${check.checked.c4_cases}`);
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
      result: { type: "string", default: "results/coupled-memory-phase5-harness-suite.json" },
      json: { type: "string", default: "results/coupled-memory-phase5-check.json" },
      md: { type: "string", default: "results/coupled-memory-phase5-check.md" },
    },
  });
  const result = JSON.parse(readFileSync(parsed.values.result, "utf8"));
  const check = checkCoupledMemoryPhase5(result);
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
