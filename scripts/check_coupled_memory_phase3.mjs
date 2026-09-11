import { readFileSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";

function fail(message) {
  throw new Error(message);
}

function requireCase(result, condition) {
  const item = result.cases?.find((entry) => entry.condition === condition);
  if (!item) {
    fail(`missing case for ${condition}`);
  }
  return item;
}

function hasDecision(item, memoryId, decision, reason) {
  return item.audit?.memory_access_decisions?.some((entry) => (
    entry.memory_id === memoryId
    && entry.decision === decision
    && (!reason || entry.reason === reason)
  ));
}

export function checkCoupledMemoryPhase3(result) {
  const failures = [];
  const expect = (condition, message) => {
    if (!condition) {
      failures.push(message);
    }
  };

  expect(result.benchmark === "coupled-memory-twin-run-proof", "unexpected benchmark id");
  expect(result.live === false, "phase3 proof must be deterministic and API-free");
  expect(Array.isArray(result.condition_matrix) && result.condition_matrix.length === 6, "missing full C0-C5 condition matrix");
  expect(result.c4_c5_parity?.differing_feature === "messageBoundMemory", "C4/C5 parity metadata missing or invalid");

  const c4 = requireCase(result, "C4");
  const c5 = requireCase(result, "C5");

  expect(c4.success === false, "C4 should fail Twin-Run contamination proof");
  expect(c4.wrong_scope_memory_use > 0, "C4 should expose wrong-scope memory use");
  expect(c4.injected_memory_ids?.includes("mem-A-constraint"), "C4 should inject Run A memory");
  expect(c4.injected_memory_ids?.includes("mem-B-constraint"), "C4 should inject Run B memory");
  expect(c4.failure_modes?.includes("wrong-scope memory"), "C4 should attribute wrong-scope memory failure");

  expect(c5.success === true, "C5 should pass Twin-Run contamination proof");
  expect(c5.wrong_scope_memory_use === 0, "C5 should have zero wrong-scope memory use");
  expect(c5.missing_critical_memory === 0, "C5 should include critical Run B memory");
  expect(c5.causal_memory_binding === 1, "C5 should report causal memory binding");
  expect(c5.event_graph_reconstructability === 1, "C5 should be reconstructable from the event graph");
  expect(JSON.stringify(c5.injected_memory_ids) === JSON.stringify(["mem-B-constraint"]), "C5 should inject only Run B memory");
  expect(hasDecision(c5, "mem-A-constraint", "deny", "run_id_mismatch"), "C5 should deny Run A memory with run_id_mismatch");
  expect(hasDecision(c5, "mem-B-constraint", "allow", "message_bound_access_granted"), "C5 should allow Run B memory");

  return {
    status: failures.length === 0 ? "PASS" : "FAIL",
    failures,
    checked: {
      benchmark: result.benchmark,
      condition_matrix_count: result.condition_matrix?.length ?? 0,
      c4_success: c4.success,
      c4_wrong_scope_memory_use: c4.wrong_scope_memory_use,
      c5_success: c5.success,
      c5_wrong_scope_memory_use: c5.wrong_scope_memory_use,
      c5_memory_access_decisions: c5.audit?.memory_access_decisions?.length ?? 0,
    },
  };
}

function markdownReport(check, input) {
  const lines = [];
  lines.push("# Coupled-Memory Phase 3 Check");
  lines.push("");
  lines.push(`Input: \`${input}\``);
  lines.push("");
  lines.push(`Status: **${check.status}**`);
  lines.push("");
  lines.push("## Checked Evidence");
  lines.push("");
  lines.push(`- Benchmark: \`${check.checked.benchmark}\``);
  lines.push(`- Condition matrix entries: ${check.checked.condition_matrix_count}`);
  lines.push(`- C4 success: ${check.checked.c4_success}`);
  lines.push(`- C4 wrong-scope memory use: ${check.checked.c4_wrong_scope_memory_use}`);
  lines.push(`- C5 success: ${check.checked.c5_success}`);
  lines.push(`- C5 wrong-scope memory use: ${check.checked.c5_wrong_scope_memory_use}`);
  lines.push(`- C5 memory access decisions: ${check.checked.c5_memory_access_decisions}`);
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
      result: { type: "string", default: "results/coupled-memory-twin-run-proof.json" },
      json: { type: "string", default: "results/coupled-memory-phase3-check.json" },
      md: { type: "string", default: "results/coupled-memory-phase3-check.md" },
    },
  });
  const result = JSON.parse(readFileSync(parsed.values.result, "utf8"));
  const check = checkCoupledMemoryPhase3(result);
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
