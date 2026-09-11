#!/usr/bin/env node
// RG1 / review M1: does an INDEPENDENT conventional contextual-authorization policy reproduce
// MBM-Core's admitted set? For every deterministic scenario we (a) read C5's admitted set from the
// runtime gate and (b) evaluate a generic ABAC+ReBAC policy (benchmarks/policy_comparator,
// no shared code with the gate) over the same candidates/context/ancestry. If the admitted sets are
// identical on all families, MBM-Core is expressible as one ordinary contextual policy -- so the
// contribution is "contextual authorization applied systematically to agent-memory injection", not
// a new authorization primitive. We also confirm that DROPPING the ancestry predicate makes the
// conventional policy admit the graph-only sibling-branch trap (i.e., ancestry is the load-bearing
// relationship predicate, matching the separation matrix).
import { writeFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { parseArgs } from "node:util";

import { CoupledMemoryRuntime } from "../benchmarks/coupled_memory/runtime.mjs";
import { seedScenario, PHASE4_SCENARIOS } from "../benchmarks/coupled_memory/scenarios.mjs";
import { causalAncestryFromMessages } from "../benchmarks/coupled_memory/causal.mjs";
import { INTENT_MEMORY_TYPES } from "../benchmarks/coupled_memory/constants.mjs";
import { admitByPolicy } from "../benchmarks/policy_comparator/conventional_policy_engine.mjs";

const FULL = ["run", "task", "status", "reader", "policy", "intent", "provenance"];
const NO_ANCESTRY = FULL.filter((k) => k !== "provenance");

function idsOf(list) { return [...list.map((m) => m.memory_id)].sort(); }
function sameSet(a, b) { const x = idsOf(a), y = idsOf(b); return x.length === y.length && x.every((v, i) => v === y[i]); }

function runOne(scenario) {
  const rt = new CoupledMemoryRuntime({});
  try {
    const active = seedScenario(rt, scenario);
    const candidates = rt.findCandidateMemories(scenario.query);            // ungated candidate set
    const c5 = rt.readMemory(scenario.query, active, { condition: "C5" });  // gate-admitted set
    const messages = rt.db
      .prepare("SELECT message_id, parent_message_id, delegated_from, sequence, created_at FROM messages WHERE run_id = ?")
      .all(active.run_id);
    const ancestors = causalAncestryFromMessages(messages, active);
    const ctx = {
      run_id: active.run_id, task_id: active.task_id, trace_id: active.trace_id,
      receiver: active.receiver, intent: active.intent, policy_context: active.policy_context,
      message_id: active.message_id,
    };
    const conv = admitByPolicy(candidates, ctx, { ancestors }, { enabled: FULL, intentTypes: INTENT_MEMORY_TYPES });
    const convNoAnc = admitByPolicy(candidates, ctx, { ancestors }, { enabled: NO_ANCESTRY, intentTypes: INTENT_MEMORY_TYPES });
    return {
      scenario_id: scenario.scenario_id,
      family: scenario.scenario_type,
      equivalent: sameSet(conv.admitted, c5),
      ancestry_load_bearing: !sameSet(convNoAnc.admitted, c5), // dropping ancestry changes admitted set
    };
  } finally { rt.close(); }
}

const { values } = parseArgs({ options: { json: { type: "string" } } });
const rows = PHASE4_SCENARIOS.map(runOne);
const equivalent = rows.filter((r) => r.equivalent).length;
const families = [...new Set(rows.map((r) => r.family))];
const ancestryFamilies = families.filter((f) =>
  rows.some((r) => r.family === f && r.ancestry_load_bearing));
const out = {
  generated_for: "RG1 independent conventional-policy comparator (review M1)",
  total: rows.length,
  equivalent_admitted_set: equivalent,
  all_equivalent: equivalent === rows.length,
  families: families.length,
  ancestry_load_bearing_families: ancestryFamilies,
  conclusion: equivalent === rows.length
    ? "MBM-Core's admitted set is reproduced exactly by a generic ABAC+ReBAC contextual policy; the contribution is systematic application, not a new authorization primitive."
    : "Admitted sets diverge on some scenarios; MBM-Core is NOT expressible as the tested conventional policy (see rows).",
  rows,
};
if (values.json) { mkdirSync(dirname(values.json), { recursive: true }); writeFileSync(values.json, JSON.stringify(out, null, 2) + "\n"); }
console.log(`[policy-comparator] ${equivalent}/${rows.length} scenarios: conventional ABAC+ReBAC policy == C5 admitted set`);
console.log(`  ancestry load-bearing on families: ${ancestryFamilies.join(", ") || "(none)"}`);
console.log(`  ${out.conclusion}`);
process.exitCode = 0;
