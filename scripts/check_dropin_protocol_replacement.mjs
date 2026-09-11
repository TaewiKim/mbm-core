import { readFileSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";

const EXPECTED_WRAPPERS = ["legacy-shared-memory", "acmcp-message-bound"];

function casesFor(result, scenarioId) {
  return result.cases?.filter((item) => item.scenario_id === scenarioId) ?? [];
}

function caseFor(result, scenarioId, wrapper) {
  return casesFor(result, scenarioId).find((item) => item.protocol_wrapper === wrapper);
}

function sameControls(cases) {
  const encoded = new Set(cases.map((item) => JSON.stringify(item.same_agent_controls)));
  return encoded.size === 1;
}

export function checkDropInProtocolReplacement(result, {
  expectedInstancesPerFamily = 3,
  benchmark = "dropin-protocol-replacement-dev",
} = {}) {
  const failures = [];
  const expect = (condition, message) => {
    if (!condition) {
      failures.push(message);
    }
  };
  const expectedScenarios = expectedInstancesPerFamily * 9;
  expect(result.benchmark === benchmark, "unexpected benchmark id");
  expect(result.live === false, "drop-in protocol replacement check must be deterministic");
  expect(result.c4_c5_parity?.differing_feature === "messageBoundMemory", "C4/C5 parity metadata missing");
  expect(sameControls(result.cases ?? []), "agent app/model/tools/memory controls differ across cases");
  expect((result.scenarios ?? []).length === expectedScenarios, `expected ${expectedScenarios} scenarios`);

  for (const wrapper of EXPECTED_WRAPPERS) {
    expect(result.protocol_wrappers?.[wrapper], `missing protocol wrapper ${wrapper}`);
  }

  for (const scenario of result.scenarios ?? []) {
    const scenarioCases = casesFor(result, scenario.scenario_id);
    expect(scenarioCases.length === 2, `${scenario.scenario_id} should have exactly two protocol-wrapper cases`);
    const legacy = caseFor(result, scenario.scenario_id, "legacy-shared-memory");
    const acmcp = caseFor(result, scenario.scenario_id, "acmcp-message-bound");
    expect(legacy?.success === false, `${scenario.scenario_id} legacy wrapper should fail`);
    expect(acmcp?.success === true, `${scenario.scenario_id} ACM-CP wrapper should succeed`);
    expect(acmcp?.wrong_scope_memory_use === 0, `${scenario.scenario_id} ACM-CP should avoid wrong-scope memory`);
    expect(acmcp?.stale_memory_use === 0, `${scenario.scenario_id} ACM-CP should avoid stale memory`);
    expect(acmcp?.forbidden_memory_use === 0, `${scenario.scenario_id} ACM-CP should avoid forbidden memory`);
    expect(acmcp?.missing_critical_memory === 0, `${scenario.scenario_id} ACM-CP should include critical memory`);
  }

  const legacyCases = (result.cases ?? []).filter((item) => item.protocol_wrapper === "legacy-shared-memory");
  const acmcpCases = (result.cases ?? []).filter((item) => item.protocol_wrapper === "acmcp-message-bound");
  return {
    status: failures.length === 0 ? "PASS" : "FAIL",
    failures,
    checked: {
      benchmark: result.benchmark,
      scenario_count: result.scenarios?.length ?? 0,
      case_count: result.cases?.length ?? 0,
      same_agent_controls: sameControls(result.cases ?? []),
      legacy_failures: legacyCases.filter((item) => !item.success).length,
      legacy_cases: legacyCases.length,
      acmcp_successes: acmcpCases.filter((item) => item.success).length,
      acmcp_cases: acmcpCases.length,
    },
  };
}

function markdownReport(check, input) {
  const lines = [];
  lines.push("# Drop-In Protocol Replacement Check");
  lines.push("");
  lines.push(`Input: \`${input}\``);
  lines.push("");
  lines.push(`Status: **${check.status}**`);
  lines.push("");
  lines.push("## Checked Evidence");
  lines.push("");
  lines.push(`- Benchmark: \`${check.checked.benchmark}\``);
  lines.push(`- Scenario count: ${check.checked.scenario_count}`);
  lines.push(`- Case count: ${check.checked.case_count}`);
  lines.push(`- Same agent controls: ${check.checked.same_agent_controls}`);
  lines.push(`- Legacy failures: ${check.checked.legacy_failures}/${check.checked.legacy_cases}`);
  lines.push(`- ACM-CP successes: ${check.checked.acmcp_successes}/${check.checked.acmcp_cases}`);
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
      result: { type: "string", default: "results/dropin-protocol-replacement-dev.json" },
      json: { type: "string", default: "results/dropin-protocol-replacement-dev-check.json" },
      md: { type: "string", default: "results/dropin-protocol-replacement-dev-check.md" },
      benchmark: { type: "string", default: "dropin-protocol-replacement-dev" },
      "instances-per-family": { type: "string", default: "3" },
    },
  });
  const result = JSON.parse(readFileSync(parsed.values.result, "utf8"));
  const check = checkDropInProtocolReplacement(result, {
    benchmark: parsed.values.benchmark,
    expectedInstancesPerFamily: Number.parseInt(parsed.values["instances-per-family"], 10),
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
