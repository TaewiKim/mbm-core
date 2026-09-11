import { readFileSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";

const REQUIRED_SCENARIO_TYPES = [
  "twin_run_shared_memory_contamination",
  "pause_resume_deferred_constraint",
  "crash_retry_with_superseded_policy",
  "branch_merge_with_conflicting_memories",
  "artifact_dependent_handoff",
  "private_memory_summary",
  "long_horizon_drift",
  "audit_reconstruction",
  "graph_only_sibling_branch_provenance",
];

const DEFAULT_REQUIRED_INSTANCES_PER_TYPE = 3;

function casesFor(result, scenarioId) {
  return result.cases?.filter((item) => item.scenario_id === scenarioId) ?? [];
}

function caseFor(result, scenarioId, condition) {
  return casesFor(result, scenarioId).find((item) => item.condition === condition);
}

export function checkCoupledMemoryPhase4(result, {
  benchmark = "coupled-memory-phase4-dev-suite",
  instancesPerType = DEFAULT_REQUIRED_INSTANCES_PER_TYPE,
} = {}) {
  const failures = [];
  const expect = (condition, message) => {
    if (!condition) {
      failures.push(message);
    }
  };

  expect(result.benchmark === benchmark, "unexpected benchmark id");
  expect(result.live === false, "phase4 suite must be deterministic and API-free");
  expect(result.c4_c5_parity?.differing_feature === "messageBoundMemory", "C4/C5 parity metadata missing or invalid");
  expect(Array.isArray(result.condition_matrix) && result.condition_matrix.length === 6, "missing full C0-C5 condition matrix");

  for (const scenarioType of REQUIRED_SCENARIO_TYPES) {
    const ids = new Set((result.scenarios ?? [])
      .filter((item) => item.scenario_type === scenarioType)
      .map((item) => item.scenario_id));
    expect(ids.size === instancesPerType, `${scenarioType} should have ${instancesPerType} scenario instances`);
    for (const scenarioId of ids) {
    const scenarioCases = casesFor(result, scenarioId);
    expect(scenarioCases.length === 6, `${scenarioId} should have all six C0-C5 cases`);
    const c0 = caseFor(result, scenarioId, "C0");
    const c1 = caseFor(result, scenarioId, "C1");
    const c4 = caseFor(result, scenarioId, "C4");
    const c5 = caseFor(result, scenarioId, "C5");
    expect(c0?.success === false && c0?.missing_critical_memory > 0, `${scenarioId} C0 should fail by missing memory`);
    expect(c1?.success === false && c1?.missing_critical_memory > 0, `${scenarioId} C1 should fail by missing memory`);
    expect(c4?.success === false, `${scenarioId} C4 should fail`);
    expect((c4?.wrong_scope_memory_use ?? 0) + (c4?.stale_memory_use ?? 0) + (c4?.forbidden_memory_use ?? 0) > 0, `${scenarioId} C4 should expose protocol-level memory failure`);
    expect(c5?.success === true, `${scenarioId} C5 should succeed`);
    expect(c5?.wrong_scope_memory_use === 0, `${scenarioId} C5 should have zero wrong-scope memory`);
    expect(c5?.stale_memory_use === 0, `${scenarioId} C5 should have zero stale memory`);
    expect(c5?.forbidden_memory_use === 0, `${scenarioId} C5 should have zero forbidden memory`);
    expect(c5?.missing_critical_memory === 0, `${scenarioId} C5 should include critical memory`);
    expect(c5?.event_graph_reconstructability === 1, `${scenarioId} C5 should be reconstructable`);
    }
  }

  const c5Cases = result.cases?.filter((item) => item.condition === "C5") ?? [];
  const c4Cases = result.cases?.filter((item) => item.condition === "C4") ?? [];
  return {
    status: failures.length === 0 ? "PASS" : "FAIL",
    failures,
    checked: {
      benchmark: result.benchmark,
      scenario_family_count: REQUIRED_SCENARIO_TYPES.length,
      scenario_instance_count: result.scenarios?.length ?? 0,
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
  lines.push("# Coupled-Memory Phase 4 Dev-Suite Check");
  lines.push("");
  lines.push(`Input: \`${input}\``);
  lines.push("");
  lines.push(`Status: **${check.status}**`);
  lines.push("");
  lines.push("## Checked Evidence");
  lines.push("");
  lines.push(`- Benchmark: \`${check.checked.benchmark}\``);
  lines.push(`- Scenario family count: ${check.checked.scenario_family_count}`);
  lines.push(`- Scenario instance count: ${check.checked.scenario_instance_count}`);
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
      result: { type: "string", default: "results/coupled-memory-phase4-dev-suite.json" },
      json: { type: "string", default: "results/coupled-memory-phase4-check.json" },
      md: { type: "string", default: "results/coupled-memory-phase4-check.md" },
      benchmark: { type: "string", default: "coupled-memory-phase4-dev-suite" },
      "instances-per-type": { type: "string", default: "3" },
    },
  });
  const result = JSON.parse(readFileSync(parsed.values.result, "utf8"));
  const check = checkCoupledMemoryPhase4(result, {
    benchmark: parsed.values.benchmark,
    instancesPerType: Number.parseInt(parsed.values["instances-per-type"], 10),
  });
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
