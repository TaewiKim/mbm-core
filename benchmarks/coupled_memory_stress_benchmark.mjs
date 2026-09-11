// E10: long-horizon stress scaling.
// Injects K distractor memories into each scenario's candidate pool and measures how Failure-Free
// Completion Rate degrades as memory pressure grows, for ACM-CP (C5) vs the strongest static-filter
// baseline vs C4. Distractors are same-run/same-task, content-matched, ACTIVE, authorized orphans
// (no provenance message): only the message-bound gate (provenance) excludes them, so ACM-CP stays
// flat while static-filter baselines are flooded.
import { mkdirSync, writeFileSync, appendFileSync } from "node:fs";
import { dirname } from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";

import { OpenAICoupledMemoryClient, evaluateLiveDecision } from "./coupled_memory/live_model.mjs";
import { getConditionSpec } from "./coupled_memory/conditions.mjs";
import { buildPhase4Scenarios, runPhase4ScenarioBaseline } from "./coupled_memory/scenarios.mjs";

function mulberry32(seed) {
  let a = seed >>> 0;
  return () => { a |= 0; a = (a + 0x6d2b79f5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}

// Append K orphan distractor memories (missing provenance) to a clone of the scenario.
function withDistractors(scenario, k) {
  if (k <= 0) return scenario;
  const clone = JSON.parse(JSON.stringify(scenario));
  const qphrase = scenario.query?.text ?? "deployment configuration";
  // distractors share the ACTIVE message's run/task/policy so run/task/status/reader/policy
  // filters all pass; only the missing-provenance check (ACM-CP only) excludes them.
  const active = scenario.messages.find((m) => m.message_id === scenario.active_message_id) ?? scenario.messages[scenario.messages.length - 1];
  // Distractors are near-duplicates of the VALID record's content, so they cannot be told apart
  // by text -- modelling many unbound sources restating the same fact. Only the message binding
  // (provenance) identifies the authoritative record.
  const validId = scenario.expected_memory_ids?.[0];
  const validContent = scenario.memories.find((mm) => mm.memory_id === validId)?.content ?? qphrase;
  clone.forbidden_memory_ids = [...(clone.forbidden_memory_ids ?? [])];
  for (let i = 0; i < k; i += 1) {
    const did = `${scenario.scenario_id}-distractor-${i}`;
    clone.forbidden_memory_ids.push(did); // selecting a distractor counts as a failure
    clone.memories.push({
      memory_id: did,
      source_message_id: `missing-distractor-${scenario.scenario_id}-${i}`, // orphan: no such message
      run_id: active.run_id,
      task_id: active.task_id,
      trace_id: active.trace_id,
      content: validContent,
      memory_type: scenario.query?.memory_type ?? "constraint",
      scope: "task",
      status: "active",
      allowed_readers: ["executor"],
      policy_context: active.policy_context,
    });
  }
  return clone;
}

function payloadFor(scenario, det, baseline) {
  const isTreatment = baseline === "C5";
  const payload = {
    scenario_id: scenario.scenario_id,
    scenario_type: scenario.scenario_type,
    condition: getConditionSpec(isTreatment ? "C5" : "C4"),
    query: scenario.query,
    candidate_memories: det.injected_memory_ids.map((id, i) => ({ memory_id: id, content: det.injected_memory_contents[i] })),
  };
  if (isTreatment) {
    const m = det.message_for_read;
    payload.active_message = { message_id: m.message_id, run_id: m.run_id, task_id: m.task_id, trace_id: m.trace_id, receiver: m.receiver, policy_context: m.policy_context };
    payload.protocol_rule = "Use only memory that is bound to the active message run/task/trace and current receiver.";
  } else {
    payload.protocol_rule = baseline === "C4"
      ? "Use the retrieved shared-memory candidates. No active-message memory binding is available."
      : `Candidates were scope-filtered by a static ${baseline} filter. No active-message binding is available.`;
  }
  return payload;
}

export async function runStressSuite({
  baselines = ["C5", "C4+all-static-filters", "C4"],
  distractorLevels = [0, 10, 50, 200],
  instancesPerFamily = 2,
  model = "gpt-5.4-nano",
  timeoutMs = 120000,
  seed = 3010,
  jsonl,
} = {}) {
  const scenarios = buildPhase4Scenarios({ instancesPerFamily });
  const client = new OpenAICoupledMemoryClient({ model, timeoutMs });
  const rng = mulberry32(seed);
  const cases = [];
  if (jsonl) { mkdirSync(dirname(jsonl), { recursive: true }); writeFileSync(jsonl, "", "utf8"); }

  for (const scenario of scenarios) {
    for (const k of distractorLevels) {
      const aug = withDistractors(scenario, k);
      for (const baseline of baselines) {
        const det = runPhase4ScenarioBaseline({ scenario: aug, baseline });
        let decision = null; let apiError = "";
        try {
          const payload = payloadFor(aug, det, baseline);
          // shuffle candidate order (seeded) so position is not a cue
          for (let i = payload.candidate_memories.length - 1; i > 0; i -= 1) { const j = Math.floor(rng() * (i + 1)); [payload.candidate_memories[i], payload.candidate_memories[j]] = [payload.candidate_memories[j], payload.candidate_memories[i]]; }
          // anonymize candidate ids (c1..cN) so the id string itself carries no validity cue
          const realToAnon = new Map();
          const anonToReal = new Map();
          payload.candidate_memories = payload.candidate_memories.map((c, idx) => {
            const anon = `c${idx + 1}`;
            realToAnon.set(c.memory_id, anon);
            anonToReal.set(anon, c.memory_id);
            return { memory_id: anon, content: c.content };
          });
          decision = await client.decidePayload(payload);
          // map anonymized selections back to real ids before scoring
          if (decision && Array.isArray(decision.selected_memory_ids)) {
            decision.selected_memory_ids = decision.selected_memory_ids.map((a) => anonToReal.get(a) ?? a);
          }
        } catch (error) { apiError = error.message; }
        const evaluated = decision ? evaluateLiveDecision({ deterministic: det, decision }) : {};
        const row = {
          benchmark: "coupled-memory-stress",
          live: true, model,
          scenario_id: scenario.scenario_id, scenario_type: scenario.scenario_type,
          condition: baseline, distractors: k, run_index: 0,
          candidate_count: det.injected_memory_ids.length,
          expected_memory_ids: det.expected_memory_ids, forbidden_memory_ids: det.forbidden_memory_ids,
          api_error: apiError, ...evaluated,
        };
        cases.push(row);
        if (jsonl) appendFileSync(jsonl, `${JSON.stringify(row)}\n`, "utf8");
      }
    }
  }
  return { benchmark: "coupled-memory-stress", live: true, model, distractor_levels: distractorLevels, baselines, instances_per_family: instancesPerFamily, cases };
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const parsed = parseArgs({ options: {
    "instances-per-family": { type: "string", default: "2" },
    distractors: { type: "string", default: "0,10,50,200" },
    model: { type: "string", default: "gpt-5.4-nano" },
    "timeout-ms": { type: "string", default: "120000" },
    seed: { type: "string", default: "3010" },
    json: { type: "string" }, jsonl: { type: "string" },
  } });
  const v = parsed.values;
  const result = await runStressSuite({
    distractorLevels: v.distractors.split(",").map((s) => Number.parseInt(s.trim(), 10)),
    instancesPerFamily: Number.parseInt(v["instances-per-family"], 10),
    model: v.model, timeoutMs: Number.parseInt(v["timeout-ms"], 10), seed: Number.parseInt(v.seed, 10),
    jsonl: v.jsonl,
  });
  // quick summary
  const byKey = {};
  for (const c of result.cases) { const key = `${c.condition}@${c.distractors}`; byKey[key] = byKey[key] || { n: 0, s: 0 }; byKey[key].n++; if (c.model_success) byKey[key].s++; }
  for (const k of Object.keys(byKey)) console.log(k.padEnd(34), (byKey[k].s / byKey[k].n).toFixed(3));
  if (v.json) { mkdirSync(dirname(v.json), { recursive: true }); writeFileSync(v.json, `${JSON.stringify(result, null, 2)}\n`, "utf8"); console.log(`Wrote ${v.json}`); }
}
