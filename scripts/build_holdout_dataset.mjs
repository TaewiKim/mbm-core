// E7: build the blinded adversarial holdout dataset (80 cases) with a frozen manifest hash.
// Design principle: each case COMPOUNDS several failure modes AND neutralizes content, so the
// model cannot tell valid from invalid from the text alone -- only the message binding decides.
// Crucially every case includes a content-identical orphan (missing-provenance) trap, which the
// strongest static-filter baseline (run+task+status+reader+policy) cannot catch; only the full
// message-bound gate (with provenance) does. Oracle fields are kept out of the model-visible
// payload by the runner; here we record them for locked scoring only.
import { createHash } from "node:crypto";
import { parseArgs, writeJson } from "./eval_lib.mjs";

const FAMILIES = [
  "adv_twin_run_neutral",
  "adv_pause_resume_neutral",
  "adv_superseded_policy_neutral",
  "adv_branch_merge_neutral",
  "adv_artifact_handoff_neutral",
  "adv_private_summary_neutral",
  "adv_long_horizon_neutral",
  "adv_audit_provenance_neutral",
];

function pad(n) { return String(n).padStart(3, "0"); }

function msg(message_id, run_id, task_id, trace_id, sender, receiver, intent, sequence, policy_context, parent_message_id = null) {
  return { message_id, run_id, task_id, trace_id, parent_message_id, sender, receiver, intent, state: "running", sequence, policy_context, payload: {} };
}
function mem(memory_id, source_message_id, content, overrides = {}) {
  return { memory_id, source_message_id, content, memory_type: "constraint", scope: "task", status: "active", allowed_readers: ["executor"], ...overrides };
}

// Deterministic permutation of [0..n-1] from a string seed (no Math.random).
function seededPerm(n, seedStr) {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < seedStr.length; i += 1) h = Math.imul(h ^ seedStr.charCodeAt(i), 16777619) >>> 0;
  const rng = () => { h = (Math.imul(h ^ (h >>> 15), 1 | h) + Math.imul(h ^ (h >>> 7), 61 | h)) >>> 0; return h / 4294967296; };
  const arr = Array.from({ length: n }, (_, i) => i);
  for (let i = n - 1; i > 0; i -= 1) { const j = Math.floor(rng() * (i + 1)); [arr[i], arr[j]] = [arr[j], arr[i]]; }
  return arr;
}

// One adversarial case. CRITICAL anti-leak design: all four candidate memories carry
// BYTE-IDENTICAL content and OPAQUE ids (no role hint), and the valid memory's slot is permuted
// per case. Thus neither content nor id nor position reveals validity -- only the message
// binding metadata (run/task/provenance) distinguishes the valid record from the traps.
// Roles: 0=valid, 1=orphan(missing provenance), 2=wrong-run, 3=wrong-task.
function buildCase(family, v) {
  const id = `${family}_${pad(v)}`;
  const run = `runH-${family}-${v}`;
  const task = "deploy";
  const trace = `traceH-${family}-${v}`;
  const policy = "policy-200";
  const messages = [
    msg(`m-s0-${id}`, run, task, trace, "planner", "memory", "produce_final_plan", 1, policy),
    msg(`m-s2-${id}`, `runX-${family}-${v}`, task, `traceX-${family}-${v}`, "planner", "memory", "produce_final_plan", 1, policy),
    msg(`m-s3-${id}`, run, "audit", trace, "planner", "memory", "produce_final_plan", 1, policy),
    // Active message descends from the valid record's message only; the wrong-run/wrong-task
    // decoys are off-lineage, so under causal provenance they are not in the active ancestry.
    msg(`m-exec-${id}`, run, task, trace, "coordinator", "executor", "produce_final_plan", 2, policy, `m-s0-${id}`),
  ];
  // identical content for every candidate -- content gives no signal
  const content = `Deployment configuration for variant ${v}: adopt the approved PRIMARY profile.`;
  // opaque ids m1..m4, assigned to roles via a per-case permutation
  const perm = seededPerm(4, `holdout|${id}`); // perm[slot] = role index
  const idForSlot = (slot) => `${id}-m${slot + 1}`;
  const roleSpec = {
    0: { source: `m-s0-${id}`, overrides: { policy_context: policy } },                 // valid
    1: { source: `m-missing-${id}`, overrides: { policy_context: policy } },             // orphan (no provenance)
    2: { source: `m-s2-${id}`, overrides: {} },                                          // wrong-run
    3: { source: `m-s3-${id}`, overrides: { task_id: "audit" } },                        // wrong-task
  };
  const memories = [];
  let expectedId = null;
  const forbidden = [];
  for (let slot = 0; slot < 4; slot += 1) {
    const role = perm[slot];
    const mid = idForSlot(slot);
    const spec = roleSpec[role];
    memories.push(mem(mid, spec.source, content, spec.overrides));
    if (role === 0) expectedId = mid;
    else forbidden.push(mid);
  }
  return {
    scenario_id: id,
    scenario_type: family,
    query: { text: `deployment configuration variant ${v}`, memory_type: "constraint" },
    expected_memory_ids: [expectedId],
    forbidden_memory_ids: forbidden,
    messages,
    active_message_id: `m-exec-${id}`,
    memories,
    adversarial_modes: ["missing-provenance (identical content)", "wrong-run", "wrong-task"],
  };
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const perFamily = Number.parseInt(args["per-family"] ?? "10", 10);
  const out = args.output ?? "data/holdout/blinded_adversarial_80.json";

  const cases = [];
  for (const fam of FAMILIES) {
    for (let v = 1; v <= perFamily; v += 1) cases.push(buildCase(fam, v));
  }
  const payload = {
    dataset: "blinded_adversarial_holdout",
    version: 1,
    families: FAMILIES,
    per_family: perFamily,
    count: cases.length,
    design: "Each case compounds missing-provenance (content-neutral orphan), wrong-run near-duplicate, and wrong-task decoy traps. Only the full message-bound gate (incl. provenance) excludes all traps; static run+task+status+reader+policy filters cannot exclude the neutral-content orphan.",
    cases,
  };
  const canonical = JSON.stringify(payload);
  const hash = `sha256:${createHash("sha256").update(canonical).digest("hex")}`;
  payload.manifest_hash = hash;
  writeJson(out, payload);

  // separate frozen manifest (hash recorded BEFORE any run)
  writeJson("data/holdout/source_manifest.json", {
    dataset: payload.dataset,
    count: cases.length,
    families: FAMILIES,
    per_family: perFamily,
    manifest_hash: hash,
    output: out,
    note: "Hash frozen at generation; locked scoring verifies this hash before scoring.",
  });
  process.stdout.write(`[holdout] wrote ${cases.length} cases to ${out}\n  manifest_hash=${hash}\n`);
}

main();
