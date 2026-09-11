import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

import { buildConditionMatrix, assertC4C5OnlyDifferByBinding } from "./conditions.mjs";
import { COUPLED_MEMORY_CONDITIONS } from "./constants.mjs";
import { PHASE4_SCENARIOS, runPhase4Scenario } from "./scenarios.mjs";

// Resolve a Python interpreter portably: explicit env override first, then a repo-local venv if
// present, then python3/python on PATH. Returns null when none is usable so callers can SKIP the
// native-SDK run instead of failing on machines without Python/AutoGen (e.g. CI, the artifact box).
function resolvePython() {
  const explicit = [process.env.AUTOGEN_PYTHON, process.env.PYTHON, process.env.PYTHON3,
    resolve(".venv/bin/python"), resolve(".venv/Scripts/python.exe")]
    .filter(Boolean);
  for (const p of explicit) { if (existsSync(p)) return p; }
  for (const name of ["python3", "python"]) {
    try { if (spawnSync(name, ["--version"], { encoding: "utf8" }).status === 0) return name; } catch { /* not on PATH */ }
  }
  return null;
}

const RUNNER = resolve("benchmarks/coupled_memory/autogen_native_runner.py");

function buildDeterministicSuite({ scenarios, conditions }) {
  const cases = [];
  for (const scenario of scenarios) {
    for (const condition of conditions) {
      cases.push({
        ...runPhase4Scenario({ scenario, condition }),
        harness_id: "autogen-native",
        harness_type: "native-sdk",
      });
    }
  }
  return {
    benchmark: "coupled-memory-phase5-autogen-native-suite",
    live: false,
    adapter_status: "native-sdk",
    harnesses: [
      {
        harness_id: "autogen-native",
        harness_type: "native-sdk",
        package: "autogen-agentchat",
        sdk_features: ["BaseChatAgent", "TextMessage", "Response"],
      },
    ],
    scenarios: scenarios.map((item) => ({
      scenario_id: item.scenario_id,
      scenario_type: item.scenario_type,
    })),
    condition_matrix: buildConditionMatrix(conditions),
    c4_c5_parity: assertC4C5OnlyDifferByBinding(),
    cases,
    summary: cases.map((item) => ({
      harness_id: item.harness_id,
      scenario_id: item.scenario_id,
      condition: item.condition,
      success: item.success,
      wrong_scope_memory_use: item.wrong_scope_memory_use,
      stale_memory_use: item.stale_memory_use,
      forbidden_memory_use: item.forbidden_memory_use,
      missing_critical_memory: item.missing_critical_memory,
      causal_memory_binding: item.causal_memory_binding,
      event_graph_reconstructability: item.event_graph_reconstructability,
    })),
  };
}

export function runAutoGenNativeSuite({
  scenarios = PHASE4_SCENARIOS,
  conditions = COUPLED_MEMORY_CONDITIONS,
} = {}) {
  const python = resolvePython();
  if (!python || !existsSync(RUNNER)) {
    return { skipped: true, reason: `native AutoGen runner unavailable (python=${python ?? "not found"}, runner=${existsSync(RUNNER)})` };
  }
  const suite = buildDeterministicSuite({ scenarios, conditions });
  const outDir = resolve("build/autogen-native");
  const tmpInput = resolve(outDir, "input.json");
  const tmpOutput = resolve(outDir, "output.json");
  mkdirSync(outDir, { recursive: true });
  writeFileSync(tmpInput, `${JSON.stringify(suite)}\n`, "utf8");
  const run = spawnSync(python, [RUNNER, "--input", tmpInput, "--output", tmpOutput], {
    cwd: resolve("."),
    encoding: "utf8",
  });
  if (run.error || run.status !== 0 || !existsSync(tmpOutput)) {
    // AutoGen not installed in this interpreter -> skip rather than fail the portable test suite.
    return { skipped: true, reason: `AutoGen native runner did not complete: ${run.stderr || run.error?.message || "no output"}` };
  }
  const result = JSON.parse(readFileSync(tmpOutput, "utf8"));
  result.harnesses[0].versions = result.autogen_metadata;
  return result;
}
