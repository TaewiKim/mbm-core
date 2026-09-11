// E3: build the repository-INSPIRED SYNTHETIC SE-scenario dataset (100 cases). These are NOT
// mined from real issues/PRs/commits: each case is an author-written synthetic scenario that
// frames a common software-engineering coordination task (issue triage, bug-evidence conflict,
// PR delegation drift, incident-memory privacy, CI context manifest) onto the communication-
// memory failure modes. Each family is themed after a public agent-framework project for
// ecological flavour only; the `inspired_by_repo` field records that theme, not a source object.
// Oracle fields are present for locked scoring; the runner hides them from the model input.
import { createHash } from "node:crypto";
import { parseArgs, writeJson } from "./eval_lib.mjs";

// Thematic inspiration only -- these are the agent-framework projects each family is styled
// after. No issue, PR, commit, or log from these repositories is read or referenced.
const INSPIRED_BY_REPOS = {
  issue_triage_capability: "langchain-ai/langgraph",
  bug_evidence_conflict: "All-Hands-AI/OpenHands",
  pr_delegation_drift: "microsoft/autogen",
  incident_memory_privacy: "modelcontextprotocol/modelcontextprotocol",
  ci_context_manifest: "a2aproject/A2A",
};

// Each family maps a SE task to a binding-distinguished valid/trap pair. The trap is plausible
// (a stale comment, a sibling issue, a premature draft, a raw log, a sibling-run artifact); only
// the active-message binding (run/task/status/reader/provenance) makes the valid record correct.
const FAMILIES = {
  issue_triage_capability: {
    failure: "capability/wrong-run mismatch",
    valid: "Route issue to the graph-runtime component owner for the active triage thread.",
    trap: "Route issue to the docs component owner (from a different sibling triage thread).",
    trapKind: "wrong_run",
  },
  bug_evidence_conflict: {
    failure: "stale/superseded evidence",
    valid: "Use the re-run CI log attached to the current investigation as the failing evidence.",
    trap: "Use the earlier comment's log snippet that a later re-run already superseded.",
    trapKind: "stale",
  },
  pr_delegation_drift: {
    failure: "delegation drift / premature completion",
    valid: "Treat the PR as incomplete until the final reviewer sign-off message is recorded.",
    trap: "Treat the PR as done based on an early draft self-assessment from the author.",
    trapKind: "expired",
  },
  incident_memory_privacy: {
    failure: "unauthorized private-memory access",
    valid: "Use the redacted incident summary approved for the responder role.",
    trap: "Use the raw incident record containing private customer identifiers.",
    trapKind: "reader",
  },
  ci_context_manifest: {
    failure: "missing critical / wrong artifact",
    valid: "Reference the artifact produced by the current pipeline run for this PR.",
    trap: "Reference a similarly-named artifact produced by a sibling pipeline run.",
    trapKind: "wrong_run",
  },
};

function pad(n) { return String(n).padStart(3, "0"); }
function msg(message_id, run_id, task_id, trace_id, sender, receiver, intent, sequence, policy_context) {
  return { message_id, run_id, task_id, trace_id, parent_message_id: null, sender, receiver, intent, state: "running", sequence, policy_context, payload: {} };
}
// Link each message to the previous message in the same run (by sequence) so the valid record's
// source lies in the active message's causal ancestry under the default (causal) provenance gate.
function linkCausalParents(messages) {
  const byRun = new Map();
  for (const m of messages) {
    if (!byRun.has(m.run_id)) byRun.set(m.run_id, []);
    byRun.get(m.run_id).push(m);
  }
  for (const list of byRun.values()) {
    const ordered = [...list].sort((a, b) => a.sequence - b.sequence);
    for (let i = 1; i < ordered.length; i += 1) {
      if (ordered[i].parent_message_id == null) ordered[i].parent_message_id = ordered[i - 1].message_id;
    }
  }
  return messages;
}
function mem(memory_id, source_message_id, content, overrides = {}) {
  return { memory_id, source_message_id, content, memory_type: "constraint", scope: "task", status: "active", allowed_readers: ["executor"], ...overrides };
}

function buildCase(family, v) {
  const spec = FAMILIES[family];
  const id = `${family}_${pad(v)}`;
  const run = `run-${family}-${v}`;
  const task = "se-task";
  const trace = `trace-${family}-${v}`;
  const policy = "policy-se-current";
  const messages = [
    msg(`m-valid-${id}`, run, task, trace, "planner", "memory", "produce_final_plan", 2, policy),
    msg(`m-exec-${id}`, run, task, trace, "coordinator", "executor", "produce_final_plan", 3, policy),
  ];
  // Shared query phrase prefixed to BOTH contents so retrieval surfaces both candidates; only
  // the message binding distinguishes the valid record from the plausible trap.
  const queryText = `${family.replace(/_/g, " ")} variant ${v}`;
  const validContent = `${queryText}: ${spec.valid}`;
  const trapContent = `${queryText}: ${spec.trap}`;
  let trapMem;
  const validMem = mem(`${id}-mA`, `m-valid-${id}`, validContent, { policy_context: policy });
  if (spec.trapKind === "wrong_run") {
    messages.push(msg(`m-trap-${id}`, `run-sibling-${family}-${v}`, task, `trace-sib-${family}-${v}`, "planner", "memory", "produce_final_plan", 1, policy));
    trapMem = mem(`${id}-mB`, `m-trap-${id}`, trapContent);
  } else if (spec.trapKind === "stale") {
    messages.push(msg(`m-trap-${id}`, run, task, trace, "planner", "memory", "produce_final_plan", 1, "policy-se-old"));
    trapMem = mem(`${id}-mB`, `m-trap-${id}`, trapContent, { status: "superseded", policy_context: "policy-se-old" });
  } else if (spec.trapKind === "expired") {
    messages.push(msg(`m-trap-${id}`, run, task, trace, "planner", "memory", "produce_final_plan", 1, policy));
    trapMem = mem(`${id}-mB`, `m-trap-${id}`, trapContent, { status: "expired" });
  } else if (spec.trapKind === "reader") {
    messages.push(msg(`m-trap-${id}`, run, task, trace, "privacy", "memory", "summarize_private_memory", 1, policy));
    trapMem = mem(`${id}-mB`, `m-trap-${id}`, trapContent, { allowed_readers: ["privacy"] });
  }
  const memories = [validMem, trapMem];
  linkCausalParents(messages);
  const scenario = {
    scenario_id: id,
    scenario_type: family,
    query: { text: queryText, memory_type: "constraint" },
    expected_memory_ids: [`${id}-mA`],
    forbidden_memory_ids: [`${id}-mB`],
    messages,
    active_message_id: `m-exec-${id}`,
    memories,
  };
  // Honest provenance: this hashes the GENERATED scenario object, not any repository source. The
  // id is a synthetic scenario identifier, not a GitHub object reference.
  const content_hash = `sha256:${createHash("sha256").update(JSON.stringify({ messages, memories })).digest("hex")}`;
  scenario.source = {
    synthetic: true,
    inspired_by_repo: INSPIRED_BY_REPOS[family],
    synthetic_scenario_id: `synthetic:${family}-${pad(v)}`,
    content_hash,
    failure_tested: spec.failure,
    note: "author-written synthetic scenario; not derived from a real issue/PR/commit/log",
  };
  return scenario;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const perFamily = Number.parseInt(args["per-family"] ?? "20", 10);
  const out = args.output ?? "data/se_native/se_native_100.json";
  const fams = Object.keys(FAMILIES);
  const cases = [];
  for (const fam of fams) for (let v = 1; v <= perFamily; v += 1) cases.push(buildCase(fam, v));

  const payload = {
    dataset: "se_native",
    version: 2,
    synthetic: true,
    families: fams,
    per_family: perFamily,
    count: cases.length,
    inspired_by_repos: INSPIRED_BY_REPOS,
    note: "Repository-INSPIRED SYNTHETIC SE scenarios. Author-written; NOT mined from real issues/PRs/commits. `inspired_by_repo` records thematic styling only. Oracle fields hidden from model input by the runner.",
    cases,
  };
  const hash = `sha256:${createHash("sha256").update(JSON.stringify(payload)).digest("hex")}`;
  payload.manifest_hash = hash;
  writeJson(out, payload);
  writeJson("data/se_native/source_manifest.json", {
    dataset: payload.dataset,
    synthetic: true,
    count: cases.length,
    families: fams,
    per_family: perFamily,
    inspired_by_repos: INSPIRED_BY_REPOS,
    note: "Synthetic, repository-inspired scenarios; identifiers and hashes refer to generated objects, not mined repository sources.",
    manifest_hash: hash,
    output: out,
    per_case_sources: cases.map((c) => ({ scenario_id: c.scenario_id, inspired_by_repo: c.source.inspired_by_repo, synthetic_scenario_id: c.source.synthetic_scenario_id, content_hash: c.source.content_hash })),
  });
  process.stdout.write(`[se-native] wrote ${cases.length} synthetic cases to ${out}\n  manifest_hash=${hash}\n`);
}

main();
