// E9: negative / no-op control benchmark.
// Every control presents itself to the model as ACM-CP (message-bound), but the underlying
// gate is corrupted or removed (see runPhase4ScenarioControl). Shows that the reliability
// benefit comes from correct binding semantics, not from labels, structure, or prompt length.
import { mkdirSync, writeFileSync, appendFileSync } from "node:fs";
import { dirname } from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";

import { OpenAICoupledMemoryClient, evaluateLiveDecision } from "./coupled_memory/live_model.mjs";
import { getConditionSpec } from "./coupled_memory/conditions.mjs";
import {
  NEGATIVE_CONTROLS,
  PHASE4_MAIN_SCENARIOS,
  PHASE4_SCENARIOS,
  buildPhase4Scenarios,
  runPhase4ScenarioControl,
} from "./coupled_memory/scenarios.mjs";

function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function selectScenarios({ split, instancesPerFamily, scenarioLimit }) {
  if (split === "main") {
    if (instancesPerFamily > 0) return buildPhase4Scenarios({ instancesPerFamily });
    return PHASE4_MAIN_SCENARIOS.slice(0, scenarioLimit);
  }
  return PHASE4_SCENARIOS.slice(0, scenarioLimit);
}

function controlPayload(scenario, det, control) {
  const spec = getConditionSpec("C5");
  const m = det.message_for_read;
  const payload = {
    scenario_id: scenario.scenario_id,
    scenario_type: scenario.scenario_type,
    condition: spec,
    query: scenario.query,
    candidate_memories: det.injected_memory_ids.map((id, i) => ({
      memory_id: id,
      content: det.injected_memory_contents[i],
    })),
  };
  if (control === "C5-label-only") {
    // Pure label: present as ACM-CP, but provide no active-message binding at all.
    payload.protocol_rule = "Condition is labelled ACM-CP message-bound, but no active-message binding is provided.";
    return payload;
  }
  payload.active_message = {
    message_id: m.message_id,
    run_id: m.run_id,
    task_id: m.task_id,
    trace_id: m.trace_id,
    receiver: m.receiver,
    policy_context: m.policy_context,
  };
  payload.protocol_rule = "Use only memory that is bound to the active message run/task/trace and current receiver.";
  return payload;
}

export async function runNegativeControlsSuite({
  controls = NEGATIVE_CONTROLS,
  split = "main",
  instancesPerFamily = 5,
  scenarioLimit = 8,
  runs = 1,
  model = "gpt-5.4-nano",
  timeoutMs = 120000,
  seed = 2911,
  jsonl,
} = {}) {
  const scenarios = selectScenarios({ split, instancesPerFamily, scenarioLimit });
  const client = new OpenAICoupledMemoryClient({ model, timeoutMs });
  const rng = mulberry32(seed);
  const cases = [];
  if (jsonl) { mkdirSync(dirname(jsonl), { recursive: true }); writeFileSync(jsonl, "", "utf8"); }

  for (const scenario of scenarios) {
    for (const control of controls) {
      for (let runIndex = 0; runIndex < runs; runIndex += 1) {
        const det = runPhase4ScenarioControl({ scenario, control, rng });
        let decision = null;
        let apiError = "";
        try {
          decision = await client.decidePayload(controlPayload(scenario, det, control));
        } catch (error) {
          apiError = error.message;
        }
        const evaluated = decision ? evaluateLiveDecision({ deterministic: det, decision }) : {};
        const row = {
          benchmark: "coupled-memory-negative-controls",
          live: true,
          model,
          scenario_id: scenario.scenario_id,
          scenario_type: scenario.scenario_type,
          condition: control,
          run_index: runIndex,
          deterministic_success: det.success,
          injected_memory_ids: det.injected_memory_ids,
          expected_memory_ids: det.expected_memory_ids,
          forbidden_memory_ids: det.forbidden_memory_ids,
          api_error: apiError,
          ...evaluated,
        };
        cases.push(row);
        if (jsonl) appendFileSync(jsonl, `${JSON.stringify(row)}\n`, "utf8");
      }
    }
  }
  return {
    benchmark: "coupled-memory-negative-controls",
    live: true,
    model,
    runs_per_case: runs,
    split,
    instances_per_family: instancesPerFamily,
    seed,
    controls,
    cases,
    summary: summarize(cases),
  };
}

function summarize(cases) {
  const byControl = new Map();
  for (const c of cases) {
    if (!byControl.has(c.condition)) byControl.set(c.condition, []);
    byControl.get(c.condition).push(c);
  }
  return [...byControl.entries()].map(([control, items]) => ({
    control,
    cases: items.length,
    api_errors: items.filter((i) => i.api_error).length,
    model_success_rate: Number((items.filter((i) => i.model_success).length / Math.max(1, items.length)).toFixed(4)),
    selected_forbidden_memory: items.reduce((s, i) => s + Number(i.selected_forbidden_memory ?? 0), 0),
  }));
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const parsed = parseArgs({
    options: {
      controls: { type: "string" },
      split: { type: "string", default: "main" },
      "instances-per-family": { type: "string", default: "5" },
      scenarios: { type: "string", default: "8" },
      runs: { type: "string", default: "1" },
      model: { type: "string", default: "gpt-5.4-nano" },
      "timeout-ms": { type: "string", default: "120000" },
      seed: { type: "string", default: "2911" },
      json: { type: "string" },
      jsonl: { type: "string" },
    },
  });
  const v = parsed.values;
  const result = await runNegativeControlsSuite({
    controls: v.controls ? v.controls.split(",").map((s) => s.trim()) : NEGATIVE_CONTROLS,
    split: v.split,
    instancesPerFamily: Number.parseInt(v["instances-per-family"], 10),
    scenarioLimit: Number.parseInt(v.scenarios, 10),
    runs: Number.parseInt(v.runs, 10),
    model: v.model,
    timeoutMs: Number.parseInt(v["timeout-ms"], 10),
    seed: Number.parseInt(v.seed, 10),
    jsonl: v.jsonl,
  });
  console.log(["control", "cases", "api_errors", "model_success_rate", "selected_forbidden_memory"].join("\t"));
  for (const r of result.summary) {
    console.log([r.control, r.cases, r.api_errors, r.model_success_rate, r.selected_forbidden_memory].join("\t"));
  }
  if (v.json) {
    mkdirSync(dirname(v.json), { recursive: true });
    writeFileSync(v.json, `${JSON.stringify(result, null, 2)}\n`, "utf8");
    console.log(`Wrote ${v.json}`);
  }
}
