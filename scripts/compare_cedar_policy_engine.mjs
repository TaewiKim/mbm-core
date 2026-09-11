#!/usr/bin/env node
// RG11 / review M1 empirical reinforcement: does a DEPLOYED, industry-standard policy engine
// reproduce MBM-Core's admitted set? We re-express the gate decision as an ordinary Cedar policy
// (benchmarks/policy_comparator/cedar/*.cedar) and evaluate it with the production Cedar engine
// (@cedar-policy/cedar-wasm -- the engine behind AWS Verified Permissions), importing no MBM-Core
// code. For every deterministic scenario we (a) read C5's admitted set from the runtime gate and
// (b) ask Cedar to authorize each candidate memory under the same run/task/policy/intent context
// and the message's causal-ancestor closure. If the admitted sets match on all families, the gate
// is a systematic application of contextual authorization, not a new primitive.
//
// We also evaluate two ablations with the same engine:
//   * no-ancestry: full ABAC attribute policy minus the ReBAC provenance clause -> shows the
//     causal-ancestry predicate is the load-bearing one (it alone excludes the sibling-branch trap).
//   * naive-default: a plausible "same run + active" starter policy -> quantifies how many records
//     the obvious default false-admits, i.e. that the necessary predicate set is non-obvious.
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseArgs } from "node:util";

import * as cedar from "@cedar-policy/cedar-wasm/nodejs";

import { CoupledMemoryRuntime } from "../benchmarks/coupled_memory/runtime.mjs";
import { seedScenario, PHASE4_SCENARIOS } from "../benchmarks/coupled_memory/scenarios.mjs";
import { causalAncestryFromMessages } from "../benchmarks/coupled_memory/causal.mjs";
import { INTENT_MEMORY_TYPES } from "../benchmarks/coupled_memory/constants.mjs";
import { admitByPolicy } from "../benchmarks/policy_comparator/conventional_policy_engine.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const CEDAR_DIR = join(HERE, "..", "benchmarks", "policy_comparator", "cedar");
const FULL_POLICY = readFileSync(join(CEDAR_DIR, "mbm_read_full.cedar"), "utf8");
const NO_ANCESTRY_POLICY = readFileSync(join(CEDAR_DIR, "mbm_read_no_ancestry.cedar"), "utf8");
const NAIVE_POLICY = readFileSync(join(CEDAR_DIR, "mbm_read_naive_default.cedar"), "utf8");
const SCHEMA = readFileSync(join(CEDAR_DIR, "mbm.cedarschema"), "utf8");

const FULL = ["run", "task", "status", "reader", "policy", "intent", "provenance"];

const str = (v) => (v == null ? "" : String(v));
const idsOf = (list) => [...list.map((m) => m.memory_id)].sort();
const sameSet = (a, b) => {
  const x = idsOf(a), y = idsOf(b);
  return x.length === y.length && x.every((v, i) => v === y[i]);
};

// Map one candidate memory to a Cedar resource entity (normalized: absent attrs -> "" / []).
function memoryEntity(m) {
  return {
    uid: { type: "Memory", id: m.memory_id },
    attrs: {
      run_id: str(m.run_id),
      task_id: str(m.task_id),
      scope: str(m.scope),
      status: str(m.status),
      allowed_readers: (m.allowed_readers ?? []).map(str),
      policy_context: str(m.policy_context),
      memory_type: str(m.memory_type),
      source_message_id: str(m.source_message_id),
    },
    parents: [],
  };
}

// Authorize one memory with the production Cedar engine under a given policy.
function cedarAdmits(policy, principal, resourceUid, context, entities, validate) {
  const ans = cedar.isAuthorized({
    principal,
    action: { type: "Action", id: "ReadMemory" },
    resource: resourceUid,
    context,
    policies: { staticPolicies: policy },
    entities,
    ...(validate ? { schema: SCHEMA, validateRequest: true } : {}),
  });
  if (ans.type !== "success") {
    throw new Error("cedar evaluation failure: " + JSON.stringify(ans.errors));
  }
  return ans.response.decision === "allow";
}

function admitSetCedar(policy, candidates, ctxEntities, principal, context, validate) {
  return candidates.filter((m) =>
    cedarAdmits(policy, principal, { type: "Memory", id: m.memory_id }, context, ctxEntities, validate));
}

function runOne(scenario, validate) {
  const rt = new CoupledMemoryRuntime({});
  try {
    const active = seedScenario(rt, scenario);
    const candidates = rt.findCandidateMemories(scenario.query);
    const gateC5 = rt.readMemory(scenario.query, active, { condition: "C5" });

    const messages = rt.db
      .prepare("SELECT message_id, parent_message_id, delegated_from, sequence, created_at FROM messages WHERE run_id = ?")
      .all(active.run_id);
    const ancestors = causalAncestryFromMessages(messages, active);

    const allowedTypes = INTENT_MEMORY_TYPES[active.intent];
    const principal = { type: "Agent", id: str(active.receiver) };
    const context = {
      run_id: str(active.run_id),
      task_id: str(active.task_id),
      receiver: str(active.receiver),
      policy_context: str(active.policy_context),
      ancestors: [...ancestors].map(str),
      intent_constrained: Boolean(allowedTypes),
      allowed_memory_types: allowedTypes ? [...allowedTypes].map(str) : [],
    };

    const entities = [{ uid: principal, attrs: {}, parents: [] }, ...candidates.map(memoryEntity)];

    const cedarFull = admitSetCedar(FULL_POLICY, candidates, entities, principal, context, validate);
    const cedarNoAnc = admitSetCedar(NO_ANCESTRY_POLICY, candidates, entities, principal, context, validate);
    const cedarNaive = admitSetCedar(NAIVE_POLICY, candidates, entities, principal, context, validate);

    // JS ABAC+ReBAC comparator as an independent triangulation against the Cedar engine.
    const js = admitByPolicy(
      candidates,
      { run_id: active.run_id, task_id: active.task_id, trace_id: active.trace_id, receiver: active.receiver,
        intent: active.intent, policy_context: active.policy_context, message_id: active.message_id },
      { ancestors },
      { enabled: FULL, intentTypes: INTENT_MEMORY_TYPES },
    ).admitted;

    return {
      scenario_id: scenario.scenario_id,
      family: scenario.scenario_type,
      candidates: candidates.length,
      gate_admitted: idsOf(gateC5),
      cedar_full_admitted: idsOf(cedarFull),
      cedar_no_ancestry_admitted: idsOf(cedarNoAnc),
      cedar_naive_admitted: idsOf(cedarNaive),
      equivalent_to_gate: sameSet(cedarFull, gateC5),
      agrees_with_js_comparator: sameSet(cedarFull, js),
      ancestry_load_bearing: !sameSet(cedarNoAnc, gateC5),
      naive_false_admits: idsOf(cedarNaive).filter((id) => !idsOf(gateC5).includes(id)),
    };
  } finally {
    rt.close();
  }
}

function configSurface() {
  const loc = (s) => s.split("\n").filter((l) => l.trim() && !l.trim().startsWith("//")).length;
  return {
    full_policy_effective_loc: loc(FULL_POLICY),
    predicate_count: FULL.length,
    no_ancestry_predicate_count: FULL.length - 1,
    naive_predicate_count: 2,
    entity_types: 2,
    context_attributes: 7,
  };
}

// Run the full deployed-engine cross-check and return the structured result (no I/O). Exported so
// both the CLI below and the test suite drive the identical comparison.
export function runCedarComparison({ validate = true } = {}) {
  const rows = PHASE4_SCENARIOS.map((s) => runOne(s, validate));

  const equivalent = rows.filter((r) => r.equivalent_to_gate).length;
  const triangulated = rows.filter((r) => r.agrees_with_js_comparator).length;
  const families = [...new Set(rows.map((r) => r.family))];
  const ancestryFamilies = families.filter((f) => rows.some((r) => r.family === f && r.ancestry_load_bearing));
  const naiveBroken = families.filter((f) => rows.some((r) => r.family === f && r.naive_false_admits.length > 0));
  const naiveFalseAdmits = rows.reduce((n, r) => n + r.naive_false_admits.length, 0);

  return {
    generated_for: "Cedar deployed-engine cross-check of MBM-Core admitted set (review M1 empirical reinforcement)",
    engine: "Cedar",
    engine_version: cedar.getCedarVersion(),
    package: "@cedar-policy/cedar-wasm",
    schema_validated: validate,
    policy_files: {
      full: "benchmarks/policy_comparator/cedar/mbm_read_full.cedar",
      no_ancestry: "benchmarks/policy_comparator/cedar/mbm_read_no_ancestry.cedar",
      naive_default: "benchmarks/policy_comparator/cedar/mbm_read_naive_default.cedar",
      schema: "benchmarks/policy_comparator/cedar/mbm.cedarschema",
    },
    config_surface: configSurface(),
    total: rows.length,
    equivalent_to_gate: equivalent,
    agree_with_js_comparator: triangulated,
    all_equivalent: equivalent === rows.length,
    families: families.length,
    ancestry_load_bearing_families: ancestryFamilies,
    naive_default_broken_families: naiveBroken,
    naive_default_false_admits: naiveFalseAdmits,
    conclusion:
      equivalent === rows.length
        ? "The production Cedar engine reproduces MBM-Core's admitted set on all evaluated scenarios; the gate is a systematic application of contextual authorization, not a new primitive. Dropping the ReBAC ancestry clause breaks the sibling-branch family, and a naive run+active default false-admits across families -- so the necessary predicate set is non-obvious."
        : "Cedar admitted set diverges from the gate on some scenarios (see rows).",
    rows,
  };
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { values } = parseArgs({ options: { json: { type: "string" }, validate: { type: "boolean", default: true } } });
  const out = runCedarComparison({ validate: values.validate });
  if (values.json) {
    mkdirSync(dirname(values.json), { recursive: true });
    writeFileSync(values.json, JSON.stringify(out, null, 2) + "\n");
  }
  console.log(`[cedar-comparator] engine Cedar ${out.engine_version} (${out.package})`);
  console.log(`  ${out.equivalent_to_gate}/${out.total} scenarios: deployed Cedar policy == C5 gate admitted set`);
  console.log(`  ${out.agree_with_js_comparator}/${out.total} agree with independent JS ABAC+ReBAC comparator`);
  console.log(`  ancestry load-bearing on: ${out.ancestry_load_bearing_families.join(", ") || "(none)"}`);
  console.log(`  naive run+active default false-admits ${out.naive_default_false_admits} record(s) across: ${out.naive_default_broken_families.join(", ") || "(none)"}`);
  console.log(`  schema-validated requests: ${out.schema_validated}`);
  process.exitCode = out.all_equivalent ? 0 : 1;
}
