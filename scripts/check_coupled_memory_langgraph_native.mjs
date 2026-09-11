import { readFileSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";

export function checkLangGraphNative(result) {
  const failures = [];
  const expect = (condition, message) => {
    if (!condition) {
      failures.push(message);
    }
  };

  expect(result.benchmark === "coupled-memory-phase5-langgraph-native-suite", "unexpected benchmark id");
  expect(result.live === false, "native LangGraph adapter suite must be deterministic and API-free");
  expect(result.adapter_status === "native-sdk", "adapter status should be native-sdk");
  expect(result.harnesses?.[0]?.harness_id === "langgraph-native", "missing langgraph-native harness id");
  expect(result.harnesses?.[0]?.package === "@langchain/langgraph", "missing LangGraph package metadata");
  expect(result.c4_c5_parity?.differing_feature === "messageBoundMemory", "C4/C5 parity metadata missing or invalid");
  expect((result.scenarios?.length ?? 0) === 27, "native LangGraph should run the full 9x3 dev split");

  const c5Cases = result.cases?.filter((item) => item.condition === "C5") ?? [];
  const c4Cases = result.cases?.filter((item) => item.condition === "C4") ?? [];
  expect(c5Cases.length === 27, "expected 27 C5 cases");
  expect(c4Cases.length === 27, "expected 27 C4 cases");
  expect(c5Cases.every((item) => item.success), "all C5 cases should succeed");
  expect(c4Cases.every((item) => !item.success), "all C4 cases should fail");
  expect(c5Cases.every((item) => item.event_graph_reconstructability === 1), "all C5 cases should be reconstructable");

  return {
    status: failures.length === 0 ? "PASS" : "FAIL",
    failures,
    checked: {
      benchmark: result.benchmark,
      adapter_status: result.adapter_status,
      harness_id: result.harnesses?.[0]?.harness_id,
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
  lines.push("# Coupled-Memory Native LangGraph Adapter Check");
  lines.push("");
  lines.push(`Input: \`${input}\``);
  lines.push("");
  lines.push(`Status: **${check.status}**`);
  lines.push("");
  lines.push("## Checked Evidence");
  lines.push("");
  lines.push(`- Benchmark: \`${check.checked.benchmark}\``);
  lines.push(`- Adapter status: \`${check.checked.adapter_status}\``);
  lines.push(`- Harness id: \`${check.checked.harness_id}\``);
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
      result: { type: "string", default: "results/coupled-memory-phase5-langgraph-native.json" },
      json: { type: "string", default: "results/coupled-memory-phase5-langgraph-native-check.json" },
      md: { type: "string", default: "results/coupled-memory-phase5-langgraph-native-check.md" },
    },
  });
  const result = JSON.parse(readFileSync(parsed.values.result, "utf8"));
  const check = checkLangGraphNative(result);
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
