// E5: strong-baseline rescue suite.
// Compares ACM-CP (C5) against C4 augmented with isolated static scope filters and an oracle
// retriever, to block the "C4 is a weak baseline" criticism. The model receives the
// (deterministically scope-filtered) candidate set for each baseline; only C5 presents the
// full active-message binding.
import { mkdirSync, writeFileSync, appendFileSync, readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { dirname } from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";

import { OpenAICoupledMemoryClient, evaluateLiveDecision } from "./coupled_memory/live_model.mjs";
import {
  STRONG_BASELINES,
  PHASE4_MAIN_SCENARIOS,
  buildPhase4Scenarios,
  runPhase4ScenarioBaseline,
} from "./coupled_memory/scenarios.mjs";

function mulberry32(seed) {
  let a = seed >>> 0;
  return () => { a |= 0; a = (a + 0x6d2b79f5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
function hashSeed(str, salt) {
  let h = salt >>> 0;
  for (let i = 0; i < str.length; i += 1) { h = Math.imul(h ^ str.charCodeAt(i), 16777619) >>> 0; }
  return h;
}
// Seeded Fisher-Yates shuffle to remove candidate-position bias (key per scenario).
function shuffleCandidates(payload, scenarioId, shuffleSeed) {
  const arr = payload.candidate_memories;
  const rng = mulberry32(hashSeed(scenarioId, shuffleSeed));
  for (let i = arr.length - 1; i > 0; i -= 1) {
    const j = Math.floor(rng() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
}

function selectScenarios({ instancesPerFamily, scenarioLimit, data }) {
  if (data) return loadDataset(data);
  if (instancesPerFamily > 0) return buildPhase4Scenarios({ instancesPerFamily });
  return PHASE4_MAIN_SCENARIOS.slice(0, scenarioLimit);
}

// Load an external scenario dataset (e.g., the blinded holdout) and verify its frozen hash.
function loadDataset(path) {
  const raw = JSON.parse(readFileSync(path, "utf8"));
  if (raw.manifest_hash) {
    const { manifest_hash, ...rest } = raw;
    const recomputed = `sha256:${createHash("sha256").update(JSON.stringify(rest)).digest("hex")}`;
    if (recomputed !== manifest_hash) {
      throw new Error(`holdout manifest hash mismatch: expected ${manifest_hash}, got ${recomputed}`);
    }
    process.stderr.write(`[holdout] manifest hash verified: ${manifest_hash}\n`);
  }
  return raw.cases ?? raw;
}

// Prompt-matched paired payload (review M2/M3): EVERY condition -- C5 and every baseline -- sees the
// IDENTICAL active-message context and the IDENTICAL instruction. The ONLY thing that varies across
// conditions is `candidate_memories` (the pre-filtered set the upstream baseline/gate produced). The
// payload carries NO condition/baseline label, treatment vocabulary, or arm spec, so the model cannot
// infer which arm it is in; this is what makes the live comparison isolate the candidate set, as the
// abstract claims. (Earlier versions leaked `condition`/`baseline_id` into the model input; removed.)
export function baselinePayload(scenario, det, baseline) {
  const m = det.message_for_read;
  return {
    scenario_id: scenario.scenario_id,
    scenario_type: scenario.scenario_type,
    query: scenario.query,
    candidate_memories: det.injected_memory_ids.map((id, i) => ({
      memory_id: id,
      content: det.injected_memory_contents[i],
    })),
    active_message: {
      message_id: m.message_id, run_id: m.run_id, task_id: m.task_id,
      trace_id: m.trace_id, receiver: m.receiver, policy_context: m.policy_context,
    },
    protocol_rule: "From the candidate memories below, use only those appropriate for the active "
      + "message; if a candidate is not appropriate, ignore it, and if none are appropriate, proceed "
      + "without memory.",
  };
}

export async function runStrongBaselineSuite({
  baselines = STRONG_BASELINES,
  instancesPerFamily = 5,
  scenarioLimit = 8,
  runs = 1,
  model = "gpt-5.4-nano",
  timeoutMs = 120000,
  data = null,
  benchmark = "coupled-memory-strong-baseline",
  shuffleSeed = null,
  jsonl,
} = {}) {
  const scenarios = selectScenarios({ instancesPerFamily, scenarioLimit, data });
  const client = new OpenAICoupledMemoryClient({ model, timeoutMs });
  const cases = [];
  if (jsonl) { mkdirSync(dirname(jsonl), { recursive: true }); writeFileSync(jsonl, "", "utf8"); }

  for (const scenario of scenarios) {
    for (const baseline of baselines) {
      for (let runIndex = 0; runIndex < runs; runIndex += 1) {
        const det = runPhase4ScenarioBaseline({ scenario, baseline });
        let decision = null;
        let apiError = "";
        try {
          const payload = baselinePayload(scenario, det, baseline);
          if (shuffleSeed !== null) shuffleCandidates(payload, scenario.scenario_id, shuffleSeed);
          decision = await client.decidePayload(payload);
        } catch (error) {
          apiError = error.message;
        }
        const evaluated = decision ? evaluateLiveDecision({ deterministic: det, decision }) : {};
        const row = {
          benchmark,
          live: true,
          model,
          scenario_id: scenario.scenario_id,
          scenario_type: scenario.scenario_type,
          condition: baseline,
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
    benchmark,
    live: true,
    model,
    runs_per_case: runs,
    instances_per_family: instancesPerFamily,
    data: data ?? null,
    baselines,
    cases,
    summary: summarize(cases),
  };
}

function summarize(cases) {
  const by = new Map();
  for (const c of cases) {
    if (!by.has(c.condition)) by.set(c.condition, []);
    by.get(c.condition).push(c);
  }
  return [...by.entries()].map(([condition, items]) => ({
    condition,
    cases: items.length,
    api_errors: items.filter((i) => i.api_error).length,
    model_success_rate: Number((items.filter((i) => i.model_success).length / Math.max(1, items.length)).toFixed(4)),
    selected_forbidden_memory: items.reduce((s, i) => s + Number(i.selected_forbidden_memory ?? 0), 0),
  }));
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const parsed = parseArgs({
    options: {
      baselines: { type: "string" },
      "instances-per-family": { type: "string", default: "5" },
      scenarios: { type: "string", default: "8" },
      runs: { type: "string", default: "1" },
      model: { type: "string", default: "gpt-5.4-nano" },
      "timeout-ms": { type: "string", default: "120000" },
      data: { type: "string" },
      benchmark: { type: "string", default: "coupled-memory-strong-baseline" },
      "shuffle-seed": { type: "string" },
      json: { type: "string" },
      jsonl: { type: "string" },
    },
  });
  const v = parsed.values;
  const result = await runStrongBaselineSuite({
    baselines: v.baselines ? v.baselines.split(",").map((s) => s.trim()) : STRONG_BASELINES,
    instancesPerFamily: Number.parseInt(v["instances-per-family"], 10),
    scenarioLimit: Number.parseInt(v.scenarios, 10),
    runs: Number.parseInt(v.runs, 10),
    model: v.model,
    timeoutMs: Number.parseInt(v["timeout-ms"], 10),
    data: v.data ?? null,
    benchmark: v.benchmark,
    shuffleSeed: v["shuffle-seed"] !== undefined ? Number.parseInt(v["shuffle-seed"], 10) : null,
    jsonl: v.jsonl,
  });
  console.log(["condition", "cases", "api_errors", "model_success_rate", "selected_forbidden_memory"].join("\t"));
  for (const r of result.summary) {
    console.log([r.condition, r.cases, r.api_errors, r.model_success_rate, r.selected_forbidden_memory].join("\t"));
  }
  if (v.json) {
    mkdirSync(dirname(v.json), { recursive: true });
    writeFileSync(v.json, `${JSON.stringify(result, null, 2)}\n`, "utf8");
    console.log(`Wrote ${v.json}`);
  }
}
