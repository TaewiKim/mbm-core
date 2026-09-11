import { CoupledMemoryRuntime, memoryContentHash } from "./runtime.mjs";

const FAMILY_BUILDERS = [
  buildTwinRun,
  buildPauseResume,
  buildSupersededPolicy,
  buildBranchMerge,
  buildArtifactHandoff,
  buildPrivateSummary,
  buildLongHorizonDrift,
  buildAuditReconstruction,
  buildGraphProvenanceTrap,
];

export const PHASE4_SCENARIOS = FAMILY_BUILDERS.flatMap((builder) => [1, 2, 3].map((variant) => builder(variant)));
export const PHASE4_MAIN_SCENARIOS = buildPhase4Scenarios({ instancesPerFamily: 20 });

export function buildPhase4Scenarios({ instancesPerFamily = 3 } = {}) {
  return FAMILY_BUILDERS.flatMap((builder) =>
    Array.from({ length: instancesPerFamily }, (_, index) => builder(index + 1)));
}

function message(messageId, runId, taskId, traceId, sender, receiver, intent, sequence, policyContext = "policy-003", parentMessageId = null) {
  return {
    message_id: messageId,
    run_id: runId,
    task_id: taskId,
    trace_id: traceId,
    parent_message_id: parentMessageId,
    sender,
    receiver,
    intent,
    state: "running",
    sequence,
    policy_context: policyContext,
    payload: {},
  };
}

// Build the event-graph edges a scenario relies on: any message without an explicit
// parent_message_id is chained to the previous message in the same run (by sequence), giving
// a linear causal history so legitimate, in-lineage sources are reachable from the active
// message. Branch families set parent_message_id explicitly to create sibling branches that
// the linear linker leaves untouched.
export function linkCausalParents(messages) {
  const byRun = new Map();
  for (const m of messages) {
    if (!byRun.has(m.run_id)) byRun.set(m.run_id, []);
    byRun.get(m.run_id).push(m);
  }
  for (const list of byRun.values()) {
    const ordered = [...list].sort((a, b) => a.sequence - b.sequence);
    for (let i = 1; i < ordered.length; i += 1) {
      if (ordered[i].parent_message_id == null) {
        ordered[i].parent_message_id = ordered[i - 1].message_id;
      }
    }
  }
  return messages;
}

function memory(memoryId, sourceMessageId, content, overrides = {}) {
  return {
    memory_id: memoryId,
    source_message_id: sourceMessageId,
    content,
    memory_type: "constraint",
    scope: "task",
    status: "active",
    allowed_readers: ["executor"],
    ...overrides,
  };
}

function scenario({
  scenario_id,
  scenario_type,
  query,
  expected_memory_ids,
  forbidden_memory_ids,
  messages,
  active_message_id,
  memories,
}) {
  return { scenario_id, scenario_type, query, expected_memory_ids, forbidden_memory_ids, messages, active_message_id, memories };
}

function buildTwinRun(v) {
  return scenario({
    scenario_id: `twin_run_contamination_${pad(v)}`,
    scenario_type: "twin_run_shared_memory_contamination",
    query: { text: `deployment storage constraint variant ${v}`, memory_type: "constraint" },
    expected_memory_ids: [`mem-B-twin-${v}`],
    forbidden_memory_ids: [`mem-A-twin-${v}`],
    messages: [
      message(`msg-A-twin-${v}`, `run-A-${v}`, "deploy", `trace-A-${v}`, "planner", "memory", "produce_final_plan", 1),
      message(`msg-B-twin-${v}`, `run-B-${v}`, "deploy", `trace-B-${v}`, "planner", "memory", "produce_final_plan", 1),
      message(`msg-B-twin-exec-${v}`, `run-B-${v}`, "deploy", `trace-B-${v}`, "coordinator", "executor", "produce_final_plan", 2),
    ],
    active_message_id: `msg-B-twin-exec-${v}`,
    memories: [
      memory(`mem-A-twin-${v}`, `msg-A-twin-${v}`, `Run A deployment storage constraint variant ${v}: use LOCAL_ONLY_STORAGE.`),
      memory(`mem-B-twin-${v}`, `msg-B-twin-${v}`, `Run B deployment storage constraint variant ${v}: use CLOUD_STORAGE_REQUIRED.`),
    ],
  });
}

function buildPauseResume(v) {
  return scenario({
    scenario_id: `pause_resume_deferred_constraint_${pad(v)}`,
    scenario_type: "pause_resume_deferred_constraint",
    query: { text: `resume deployment storage constraint variant ${v}`, memory_type: "constraint" },
    expected_memory_ids: [`mem-B-resume-${v}`],
    forbidden_memory_ids: [`mem-A-resume-${v}`],
    messages: [
      message(`msg-A-resume-${v}`, `run-A-${v}`, "deploy", `trace-A-${v}`, "planner", "memory", "produce_final_plan", 1),
      message(`msg-B-resume-${v}`, `run-B-${v}`, "deploy", `trace-B-${v}`, "planner", "memory", "produce_final_plan", 1),
      message(`msg-B-resume-exec-${v}`, `run-B-${v}`, "deploy", `trace-B-${v}`, "coordinator", "executor", "produce_final_plan", 2),
    ],
    active_message_id: `msg-B-resume-exec-${v}`,
    memories: [
      memory(`mem-A-resume-${v}`, `msg-A-resume-${v}`, `Run A resume deployment storage constraint variant ${v}: use LOCAL_ONLY_STORAGE.`),
      memory(`mem-B-resume-${v}`, `msg-B-resume-${v}`, `Run B resume deployment storage constraint variant ${v}: use CLOUD_STORAGE_REQUIRED.`),
    ],
  });
}

function buildSupersededPolicy(v) {
  return scenario({
    scenario_id: `crash_retry_superseded_policy_${pad(v)}`,
    scenario_type: "crash_retry_with_superseded_policy",
    query: { text: `retry deployment storage policy variant ${v}`, memory_type: "policy" },
    expected_memory_ids: [`mem-policy-current-${v}`],
    forbidden_memory_ids: [`mem-policy-old-${v}`],
    messages: [
      message(`msg-policy-old-${v}`, `run-B-${v}`, "deploy", `trace-B-${v}`, "planner", "memory", "produce_final_plan", 1, "policy-001"),
      message(`msg-policy-new-${v}`, `run-B-${v}`, "deploy", `trace-B-${v}`, "planner", "memory", "produce_final_plan", 2, "policy-002"),
      message(`msg-policy-retry-${v}`, `run-B-${v}`, "deploy", `trace-B-${v}`, "coordinator", "executor", "produce_final_plan", 3, "policy-002"),
    ],
    active_message_id: `msg-policy-retry-${v}`,
    memories: [
      memory(`mem-policy-old-${v}`, `msg-policy-old-${v}`, `Retry deployment storage policy variant ${v}: use LEGACY_UNENCRYPTED_BUCKET.`, {
        memory_type: "policy",
        status: "superseded",
        policy_context: "policy-001",
      }),
      memory(`mem-policy-current-${v}`, `msg-policy-new-${v}`, `Retry deployment storage policy variant ${v}: use ENCRYPTED_CLOUD_BUCKET.`, {
        memory_type: "policy",
        policy_context: "policy-002",
      }),
    ],
  });
}

function buildBranchMerge(v) {
  return scenario({
    scenario_id: `branch_merge_conflict_${pad(v)}`,
    scenario_type: "branch_merge_with_conflicting_memories",
    query: { text: `deployment branch decision variant ${v}`, memory_type: "decision" },
    expected_memory_ids: [`mem-branch-b-${v}`],
    forbidden_memory_ids: [`mem-branch-a-${v}`],
    messages: [
      message(`msg-branch-a-${v}`, `run-B-${v}`, "branch-A", `trace-B-${v}`, "planner", "memory", "produce_final_plan", 1),
      message(`msg-branch-b-${v}`, `run-B-${v}`, "branch-B", `trace-B-${v}`, "planner", "memory", "produce_final_plan", 2),
      message(`msg-branch-merge-${v}`, `run-B-${v}`, "branch-B", `trace-B-${v}`, "coordinator", "executor", "produce_final_plan", 3),
    ],
    active_message_id: `msg-branch-merge-${v}`,
    memories: [
      memory(`mem-branch-a-${v}`, `msg-branch-a-${v}`, `Deployment branch decision variant ${v}: choose local rollback branch.`, {
        memory_type: "decision",
        task_id: "branch-A",
      }),
      memory(`mem-branch-b-${v}`, `msg-branch-b-${v}`, `Deployment branch decision variant ${v}: choose cloud migration branch.`, {
        memory_type: "decision",
        task_id: "branch-B",
      }),
    ],
  });
}

function buildArtifactHandoff(v) {
  return scenario({
    scenario_id: `artifact_handoff_${pad(v)}`,
    scenario_type: "artifact_dependent_handoff",
    query: { text: `artifact deployment plan variant ${v}`, memory_type: "artifact_reference" },
    expected_memory_ids: [`mem-B-artifact-${v}`],
    forbidden_memory_ids: [`mem-A-artifact-${v}`],
    messages: [
      message(`msg-A-artifact-${v}`, `run-A-${v}`, "deploy", `trace-A-${v}`, "builder", "memory", "resolve_artifact", 1),
      message(`msg-B-artifact-${v}`, `run-B-${v}`, "deploy", `trace-B-${v}`, "builder", "memory", "resolve_artifact", 1),
      message(`msg-B-artifact-exec-${v}`, `run-B-${v}`, "deploy", `trace-B-${v}`, "coordinator", "executor", "resolve_artifact", 2),
    ],
    active_message_id: `msg-B-artifact-exec-${v}`,
    memories: [
      memory(`mem-A-artifact-${v}`, `msg-A-artifact-${v}`, `Artifact deployment plan variant ${v}: artifact://run-A-${v}/plan-v1.`, {
        memory_type: "artifact_reference",
        content_ref: `artifact://run-A-${v}/plan-v1`,
      }),
      memory(`mem-B-artifact-${v}`, `msg-B-artifact-${v}`, `Artifact deployment plan variant ${v}: artifact://run-B-${v}/plan-v2.`, {
        memory_type: "artifact_reference",
        content_ref: `artifact://run-B-${v}/plan-v2`,
      }),
    ],
  });
}

function buildPrivateSummary(v) {
  return scenario({
    scenario_id: `private_memory_summary_${pad(v)}`,
    scenario_type: "private_memory_summary",
    query: { text: `private customer summary variant ${v}`, memory_type: "summary" },
    expected_memory_ids: [`mem-private-summary-${v}`],
    forbidden_memory_ids: [`mem-private-raw-${v}`],
    messages: [
      message(`msg-private-raw-${v}`, `run-B-${v}`, "privacy", `trace-B-${v}`, "privacy", "memory", "summarize_private_memory", 1),
      message(`msg-private-summary-${v}`, `run-B-${v}`, "privacy", `trace-B-${v}`, "privacy", "memory", "summarize_private_memory", 2),
      message(`msg-private-exec-${v}`, `run-B-${v}`, "privacy", `trace-B-${v}`, "coordinator", "executor", "summarize_private_memory", 3),
    ],
    active_message_id: `msg-private-exec-${v}`,
    memories: [
      memory(`mem-private-raw-${v}`, `msg-private-raw-${v}`, `Private customer summary variant ${v}: SECRET_RAW_TOKEN_${v} must never be shown.`, {
        memory_type: "summary",
        allowed_readers: ["privacy"],
      }),
      memory(`mem-private-summary-${v}`, `msg-private-summary-${v}`, `Private customer summary variant ${v}: redacted customer risk summary is approved for executor.`, {
        memory_type: "summary",
      }),
    ],
  });
}

function buildLongHorizonDrift(v) {
  return scenario({
    scenario_id: `long_horizon_drift_${pad(v)}`,
    scenario_type: "long_horizon_drift",
    query: { text: `long horizon deployment decision variant ${v}`, memory_type: "decision" },
    expected_memory_ids: [`mem-long-current-${v}`],
    forbidden_memory_ids: [`mem-long-old-${v}`],
    messages: [
      message(`msg-long-old-${v}`, `run-B-${v}`, "deploy", `trace-B-${v}`, "planner", "memory", "produce_final_plan", 1),
      message(`msg-long-current-${v}`, `run-B-${v}`, "deploy", `trace-B-${v}`, "planner", "memory", "produce_final_plan", 99),
      message(`msg-long-exec-${v}`, `run-B-${v}`, "deploy", `trace-B-${v}`, "coordinator", "executor", "produce_final_plan", 100),
    ],
    active_message_id: `msg-long-exec-${v}`,
    memories: [
      memory(`mem-long-old-${v}`, `msg-long-old-${v}`, `Long horizon deployment decision variant ${v}: early draft says skip verification.`, {
        memory_type: "decision",
        status: "expired",
      }),
      memory(`mem-long-current-${v}`, `msg-long-current-${v}`, `Long horizon deployment decision variant ${v}: final decision requires verification gate.`, {
        memory_type: "decision",
      }),
    ],
  });
}

function buildAuditReconstruction(v) {
  return scenario({
    scenario_id: `audit_reconstruction_${pad(v)}`,
    scenario_type: "audit_reconstruction",
    query: { text: `audit reconstruction decision variant ${v}`, memory_type: "decision" },
    expected_memory_ids: [`mem-audit-valid-${v}`],
    forbidden_memory_ids: [`mem-audit-orphan-${v}`],
    messages: [
      message(`msg-audit-valid-${v}`, `run-B-${v}`, "audit", `trace-B-${v}`, "verifier", "memory", "audit_run", 1),
      message(`msg-audit-exec-${v}`, `run-B-${v}`, "audit", `trace-B-${v}`, "coordinator", "executor", "audit_run", 2),
    ],
    active_message_id: `msg-audit-exec-${v}`,
    memories: [
      memory(`mem-audit-valid-${v}`, `msg-audit-valid-${v}`, `Audit reconstruction decision variant ${v}: verified decision has source message.` , {
        memory_type: "decision",
      }),
      memory(`mem-audit-orphan-${v}`, `msg-audit-missing-${v}`, `Audit reconstruction decision variant ${v}: orphan decision has no source message.`, {
        memory_type: "decision",
      }),
    ],
  });
}

// Graph-only-separable trap: the forbidden record shares EVERY static attribute with the valid
// record (same run, task, trace, policy, active status, reader, type) and its source message
// exists -- so run/task/status/reader/type/policy filters and a source-message referential-
// integrity (source-exists) check all admit it. It differs only in causal lineage: its source
// is an abandoned sibling branch that is not in the active message's event-graph ancestry.
// This is the case that isolates active-message causal binding from every static/foreign-key
// baseline.
function buildGraphProvenanceTrap(v) {
  const run = `run-G-${v}`;
  return scenario({
    scenario_id: `graph_provenance_sibling_branch_${pad(v)}`,
    scenario_type: "graph_only_sibling_branch_provenance",
    query: { text: `deployment storage constraint variant ${v}`, memory_type: "constraint" },
    expected_memory_ids: [`mem-G-live-${v}`],
    forbidden_memory_ids: [`mem-G-stale-${v}`],
    messages: [
      message(`msg-G-root-${v}`, run, "deploy", `trace-G-${v}`, "planner", "memory", "produce_final_plan", 1, "policy-002"),
      // Abandoned sibling branch off the shared root (parent=root, same sequence as the live branch).
      message(`msg-G-stale-${v}`, run, "deploy", `trace-G-${v}`, "planner", "memory", "produce_final_plan", 2, "policy-002", `msg-G-root-${v}`),
      // Live branch that the active message descends from.
      message(`msg-G-live-${v}`, run, "deploy", `trace-G-${v}`, "planner", "memory", "produce_final_plan", 2, "policy-002", `msg-G-root-${v}`),
      message(`msg-G-exec-${v}`, run, "deploy", `trace-G-${v}`, "coordinator", "executor", "produce_final_plan", 3, "policy-002", `msg-G-live-${v}`),
    ],
    active_message_id: `msg-G-exec-${v}`,
    memories: [
      // Forbidden: identical static attributes to the valid record, existing source, sibling branch.
      memory(`mem-G-stale-${v}`, `msg-G-stale-${v}`, `Deployment storage constraint variant ${v}: use ABANDONED_BRANCH_STORAGE (stale sibling decision).`, {
        memory_type: "constraint",
        status: "active",
        policy_context: "policy-002",
        allowed_readers: ["executor"],
      }),
      memory(`mem-G-live-${v}`, `msg-G-live-${v}`, `Deployment storage constraint variant ${v}: use CLOUD_STORAGE_REQUIRED (in-lineage decision).`, {
        memory_type: "constraint",
        status: "active",
        policy_context: "policy-002",
        allowed_readers: ["executor"],
      }),
    ],
  });
}

// Integrity-flow discriminating family (the second axis), SOUND version. Integrity is derived by the
// control plane, never caller-declared, so taint cannot be laundered by relabelling a message. The
// discriminator here is the WRITER's clearance: a low-clearance background/ingestion principal writes a
// contextually-valid, attested, in-lineage record (passes all seven context predicates, including causal
// reachability -- its source message IS in the active message's closure), but its record integrity is
// meet(writer clearance = untrusted, source integrity) = untrusted, so a system-integrity decision
// context refuses it. The paired BENIGN record has identical shape and a reachable source but a
// system-clearance writer, so it is admitted -- the load-bearing over-block control proving the predicate
// blocks by provenance (writer trust), not by content, and is not redundant with reachability (both
// sources are reachable; only the integrity axis separates them).
function buildInjectedWriterTaint(v) {
  const run = `run-IFC-${v}`;
  const trace = `trace-IFC-${v}`;
  const policy = "policy-002";
  return scenario({
    scenario_id: `authenticated_injected_writer_${pad(v)}`,
    scenario_type: "authenticated_injected_writer",
    query: { text: `deployment retention constraint variant ${v}`, memory_type: "constraint" },
    expected_memory_ids: [`mem-IFC-clean-${v}`],
    forbidden_memory_ids: [`mem-IFC-tainted-${v}`],
    // Linear, all-trusted lineage (no caller integrity labels; the control plane derives them all to
    // system): root -> benign-source -> tainted-source -> exec. Both record sources are reachable from
    // the active message, so the causal predicate admits both; only writer-clearance integrity differs.
    messages: [
      message(`msg-IFC-root-${v}`, run, "deploy", trace, "planner", "memory", "produce_final_plan", 1, policy),
      message(`msg-IFC-rb-${v}`, run, "deploy", trace, "researcher", "memory", "produce_final_plan", 2, policy, `msg-IFC-root-${v}`),
      message(`msg-IFC-rt-${v}`, run, "deploy", trace, "researcher", "memory", "produce_final_plan", 3, policy, `msg-IFC-rb-${v}`),
      message(`msg-IFC-exec-${v}`, run, "deploy", trace, "coordinator", "executor", "produce_final_plan", 4, policy, `msg-IFC-rt-${v}`),
    ],
    active_message_id: `msg-IFC-exec-${v}`,
    memories: [
      // Forbidden: written by a LOW-CLEARANCE (untrusted) background/ingestion principal; reachable,
      // attested, contextually valid, but record integrity = meet(untrusted, system) = untrusted.
      memory(`mem-IFC-tainted-${v}`, `msg-IFC-rt-${v}`, `Deployment retention constraint variant ${v}: retain backups 7 days (untrusted writer).`, {
        memory_type: "constraint", status: "active", policy_context: policy, allowed_readers: ["executor"],
        writer_clearance: "untrusted",
      }),
      // Expected: identical shape, reachable source, but a system-clearance writer.
      memory(`mem-IFC-clean-${v}`, `msg-IFC-rb-${v}`, `Deployment retention constraint variant ${v}: retain backups 30 days (system writer).`, {
        memory_type: "constraint", status: "active", policy_context: policy, allowed_readers: ["executor"],
      }),
    ],
  });
}

// A dedicated set (NOT folded into PHASE4_MAIN_SCENARIOS): the integrity predicate is deliberately
// BEYOND ABAC+ReBAC, so the Cedar/policy comparators -- which assert the seven-predicate admitted set
// equals the gate -- must keep running over the legacy families only. This set is exercised through the
// enforced SecureMemoryRuntime by the secure-coverage harness and the integrity-flow PoC/gate.
export const INTEGRITY_FLOW_SCENARIOS = Array.from({ length: 20 }, (_, i) => buildInjectedWriterTaint(i + 1));

function pad(value) {
  return String(value).padStart(3, "0");
}

export function seedScenario(runtime, scenario) {
  linkCausalParents(scenario.messages);
  const byMessage = new Map(scenario.messages.map((item) => [item.message_id, item]));
  for (const item of scenario.messages) {
    runtime.sendMessage(item);
  }
  for (const item of scenario.memories) {
    const source = byMessage.get(item.source_message_id) ?? {
      message_id: item.source_message_id,
      run_id: item.run_id ?? scenario.messages[0].run_id,
      task_id: item.task_id ?? scenario.messages[0].task_id,
      trace_id: item.trace_id ?? scenario.messages[0].trace_id,
      sender: "orphan",
      receiver: "memory",
      intent: "audit_run",
      state: "running",
      sequence: -1,
      policy_context: item.policy_context ?? "policy-003",
    };
    if (byMessage.has(item.source_message_id)) {
      runtime.writeMemory(item.content, source, memoryOptions(item, source));
    } else {
      insertOrphanMemory(runtime, item, source);
    }
  }
  return byMessage.get(scenario.active_message_id);
}

function memoryOptions(item, source) {
  return {
    memory_id: item.memory_id,
    memory_type: item.memory_type,
    scope: item.scope,
    status: item.status,
    task_id: item.task_id ?? source.task_id,
    content_ref: item.content_ref ?? null,
    allowed_readers: item.allowed_readers,
    policy_context: item.policy_context ?? source.policy_context,
  };
}

function insertOrphanMemory(runtime, item, source) {
  const timestamp = new Date().toISOString();
  // The sibling-branch trap is a LEGITIMATELY written record (valid content + a real content hash);
  // only its causal provenance is invalid. It must carry a correct canonical hash so the gate's
  // integrity check does not reject it -- the trap is meant to be caught by the causal-graph check,
  // not by tamper detection (otherwise weak baselines would get provenance for free; review M5).
  const orphanHash = memoryContentHash({
    memory_id: item.memory_id,
    run_id: source.run_id,
    task_id: item.task_id ?? source.task_id,
    trace_id: source.trace_id,
    source_message_id: item.source_message_id,
    writer: source.sender,
    memory_type: item.memory_type,
    scope: item.scope,
    status: item.status,
    content: item.content,
    content_ref: item.content_ref ?? null,
    allowed_readers: item.allowed_readers,
    supersedes: [],
    valid_from_event: null,
    valid_until_event: null,
    policy_context: item.policy_context ?? source.policy_context,
  });
  runtime.db.prepare(`
    INSERT INTO shared_memory (
      memory_id, run_id, task_id, trace_id, source_message_id, writer, memory_type,
      scope, status, content, content_ref, allowed_readers_json, supersedes_json,
      valid_from_event, valid_until_event, policy_context, audit_hash, created_at, updated_at
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    item.memory_id,
    source.run_id,
    item.task_id ?? source.task_id,
    source.trace_id,
    item.source_message_id,
    source.sender,
    item.memory_type,
    item.scope,
    item.status,
    item.content,
    item.content_ref ?? null,
    JSON.stringify(item.allowed_readers),
    "[]",
    null,
    null,
    item.policy_context ?? source.policy_context,
    orphanHash,
    timestamp,
    timestamp,
  );
}

// Real reconstructability (review M2): run an INDEPENDENT replay that reconstructs the active
// message, candidate set, and causal closure from persisted state and RE-RUNS the gate, then
// confirms the recomputed admitted set and every per-candidate verdict match the logged ones. This
// is not a self-comparison of "returned set vs its own allow-log": the gate is re-evaluated from the
// database, so a tampered verdict, a missing/duplicate/deleted decision, or an edited record fails
// it. A condition with no gated read (controlNoGate) writes no read manifest and is, by definition,
// not reconstructable (score 0).
function reconstructAudit({ runtime, currentMessage }) {
  const replay = runtime.replayMemoryReads(currentMessage.run_id);
  if (replay.reads === 0) return 0; // ungated read => no auditable trail
  return replay.ok ? 1 : 0;
}

function evaluateScenario({ runtime, condition, scenario, currentMessage, injectedMemories, audit }) {
  const injectedIds = injectedMemories.map((item) => item.memory_id);
  const missing = scenario.expected_memory_ids.filter((id) => !injectedIds.includes(id));
  const forbidden = scenario.forbidden_memory_ids.filter((id) => injectedIds.includes(id));
  const wrongScope = injectedMemories.filter((item) => item.run_id !== currentMessage.run_id || item.task_id !== currentMessage.task_id);
  const stale = injectedMemories.filter((item) => item.status !== "active");
  const success = missing.length === 0 && forbidden.length === 0;
  // Section 4 failure sub-modes (k=1..6): wrong-run, stale, unauthorized, missing,
  // artifact-misbinding, unreconstructable. Artifact misbinding is an unauthorized admission in
  // the artifact family, so it is captured by the forbidden-admission count for those cases.
  const recon = reconstructAudit({ runtime, currentMessage });
  const artifactMisbinding = scenario.scenario_type === "artifact_dependent_handoff" ? forbidden.length : 0;
  const modes = {
    wrong_run: wrongScope.length > 0,
    stale: stale.length > 0,
    unauthorized: forbidden.length > 0,
    missing: missing.length > 0,
    artifact_misbinding: artifactMisbinding > 0,
    unreconstructable: recon === 0,
  };
  // done = task completed correctly (required memory present, no forbidden memory admitted).
  const done = success;
  const failureFree = done && Object.values(modes).every((m) => !m) ? 1 : 0;
  return {
    scenario_id: scenario.scenario_id,
    scenario_type: scenario.scenario_type,
    condition,
    current_message: currentMessage,
    success,
    final_correct_rate: success ? 1 : 0,
    // Failure-Free Completion per Section 4: done ∧ ⋀_{k=1}^6 ¬mode_k ∧ recon.
    failure_free_completion: failureFree,
    task_done: done ? 1 : 0,
    injected_memory_ids: injectedIds,
    injected_memory_contents: injectedMemories.map((item) => item.content),
    expected_memory_ids: scenario.expected_memory_ids,
    forbidden_memory_ids: scenario.forbidden_memory_ids,
    wrong_scope_memory_use: wrongScope.length,
    stale_memory_use: stale.length,
    missing_critical_memory: missing.length,
    forbidden_memory_use: forbidden.length,
    artifact_misbinding_use: artifactMisbinding,
    causal_memory_binding: condition === "C5" ? 1 : 0,
    message_memory_consistency: success ? 1 : 0,
    event_graph_reconstructability: recon,
    failure_modes: [
      ...(modes.wrong_run ? ["wrong-run memory"] : []),
      ...(modes.stale ? ["stale memory"] : []),
      ...(modes.unauthorized ? ["unauthorized memory"] : []),
      ...(modes.missing ? ["missing critical memory"] : []),
      ...(modes.artifact_misbinding ? ["artifact misbinding"] : []),
      ...(modes.unreconstructable ? ["unreconstructable decision"] : []),
    ],
    audit,
  };
}

export function runPhase4Scenario({ scenario, condition = "C5", dbPath = ":memory:" }) {
  const runtime = new CoupledMemoryRuntime({ dbPath });
  try {
    const currentMessage = seedScenario(runtime, scenario);
    const messageForRead = condition === "C5" ? currentMessage : null;
    const injectedMemories = runtime.readMemory(scenario.query, messageForRead, { condition });
    const audit = runtime.auditRun(currentMessage.run_id);
    return evaluateScenario({ runtime, condition, scenario, currentMessage, injectedMemories, audit });
  } finally {
    runtime.close();
  }
}

// Negative / no-op control conditions (E9). Each control corrupts or removes part of the
// message-bound gate while still presenting itself as ACM-CP, to show the benefit comes from
// correct binding semantics rather than labels, structure, or prompt length.
export const NEGATIVE_CONTROLS = [
  "acmcp-core",        // real C5 (reference)
  "C5-label-only",     // labelled ACM-CP but no gate at all
  "C5-shuffled-binding", // gate run against scrambled binding fields
  "C5-wrong-message",  // active message taken from the wrong run/task
  "C5-no-policy",      // policy/status (current-state) check removed
  "C5-no-provenance",  // event-graph provenance check removed
  "C5-random-gate",    // random allow/deny gate
];

// E5 strong static-filter / oracle baselines. Each applies an isolated, non-message-bound
// scope filter (or strong retrieval), in contrast to ACM-CP's full message-bound gate.
export const STRONG_BASELINES = [
  "C4",                    // scoped memory, no filtering
  "C4+run-filter",
  "C4+task-filter",
  "C4+status-filter",
  "C4+reader-filter",
  "C4+policy-filter",
  "C4+all-static-filters", // run+task+status+reader+policy (no provenance/intent binding)
  // Conventional-authorization counter-baselines requested in review. Each represents a single
  // established paradigm; none mediates the full active-message context, so each is defeated by
  // at least one trap family while C5's integrated message-bound gate handles all of them.
  "C4+all-static-filters+source-exists", // static filters + source-message referential integrity (FK)
  "C4+abac",               // attribute-based: all static attributes + intent + source-exists (no causal graph)
  "C4+rebac-provenance-graph", // relationship/graph reachability + run/task/reader (no current-state status/policy)
  "C4+capability-token",   // capability/token: reader + memory-type only
  "C4+oracle-retriever",   // strong retrieval, no active-message authorization
  "C5",                    // ACM-CP full message-bound gate (treatment)
];

const ALL_CHECKS = ["run", "task", "status", "provenance", "reader", "intent", "policy"];

function gateForBaseline(baseline) {
  // returns { controlNoGate } or { gateOptions:{disabledChecks, provenanceMode} } or {} for full gate
  switch (baseline) {
    case "C4":
    case "C4+oracle-retriever":
      return { controlNoGate: true };
    case "C4+all-static-filters":
      return { gateOptions: { disabledChecks: ["provenance", "intent"] } };
    case "C4+all-static-filters+source-exists":
      // run+task+status+reader+policy + source-message existence; no intent, no causal graph.
      return { gateOptions: { disabledChecks: ["intent"], provenanceMode: "exists" } };
    case "C4+abac":
      // Every static attribute incl. intent, plus referential-integrity provenance; no causal graph.
      return { gateOptions: { disabledChecks: [], provenanceMode: "exists" } };
    case "C4+rebac-provenance-graph":
      // Pure relationship/graph authorization: causal reachability + run/task/reader scoping,
      // but no current-state (status/policy) or intent typing.
      return { gateOptions: { disabledChecks: ["status", "policy", "intent"] } };
    case "C4+capability-token":
      // Capability/token model: reader capability + memory-type only.
      return { gateOptions: { disabledChecks: ["run", "task", "status", "provenance", "policy"] } };
    case "C4+combined-conventional-exists":
      // STRONG COMBINED conventional baseline: the union of every deployable access-control
      // paradigm's strength -- all static attributes + intent (ABAC) + relationship scoping +
      // referential-integrity provenance (source message exists) -- but WITHOUT recomputed
      // write-event causal reachability (the discriminating predicate no conventional system runs).
      return { gateOptions: { disabledChecks: [], provenanceMode: "exists" } };
    case "C4+combined-causal":
      // The same maximal combination but adopting recomputed causal-graph reachability instead of
      // mere referential integrity. This is the only conventional combination that reproduces MBM's
      // per-record admission gate; on the per-record suite it ties C5 (so it is intentionally NOT in
      // check_baseline_separation's panel, which asserts no baseline reaches C5).
      return { gateOptions: { disabledChecks: [] } };
    case "C5":
    case "acmcp-core":
      return {};
    default: {
      const m = baseline.match(/^C4\+(run|task|status|reader|policy)-filter$/);
      if (m) {
        const keep = m[1];
        return { gateOptions: { disabledChecks: ALL_CHECKS.filter((c) => c !== keep) } };
      }
      throw new Error(`unknown strong baseline: ${baseline}`);
    }
  }
}

export function runPhase4ScenarioBaseline({ scenario, baseline = "C4", dbPath = ":memory:" }) {
  const runtime = new CoupledMemoryRuntime({ dbPath });
  try {
    const currentMessage = seedScenario(runtime, scenario);
    const g = gateForBaseline(baseline);
    const runState = { condition: "C5", ...g };
    let injectedMemories = runtime.readMemory(scenario.query, currentMessage, runState);
    if (baseline === "C4+oracle-retriever") {
      // Real oracle RETRIEVER (review M3/req4): perfect relevance retrieval using the ground-truth
      // relevance labels (the expected + forbidden records are the ones relevant to this query),
      // but with NO authorization -- so it still surfaces relevant-but-invalid traps. This is a
      // retrieval oracle (strictly stronger than C4's keyword/recency retrieval, since it drops
      // irrelevant distractors), not an authorization oracle, and is distinct from plain C4.
      const relevant = new Set([
        ...(scenario.expected_memory_ids ?? []),
        ...(scenario.forbidden_memory_ids ?? []),
      ]);
      injectedMemories = injectedMemories.filter((m) => relevant.has(m.memory_id));
    }
    const audit = runtime.auditRun(currentMessage.run_id);
    const evaluated = evaluateScenario({ runtime, condition: baseline, scenario, currentMessage, injectedMemories, audit });
    return { ...evaluated, baseline, message_for_read: currentMessage };
  } finally {
    runtime.close();
  }
}

function memoryById(runtime, memoryId) {
  const row = runtime.db.prepare("SELECT * FROM shared_memory WHERE memory_id = ?").get(memoryId);
  if (!row) return null;
  return {
    memory_id: row.memory_id,
    run_id: row.run_id,
    task_id: row.task_id,
    trace_id: row.trace_id,
    policy_context: row.policy_context,
  };
}

export function runPhase4ScenarioControl({ scenario, control = "acmcp-core", rng = Math.random, dbPath = ":memory:" }) {
  const runtime = new CoupledMemoryRuntime({ dbPath });
  try {
    const currentMessage = seedScenario(runtime, scenario);
    const forbiddenId = scenario.forbidden_memory_ids[0];
    const forbidden = forbiddenId ? memoryById(runtime, forbiddenId) : null;
    let messageForRead = currentMessage;
    let runState = { condition: "C5" };

    switch (control) {
      case "acmcp-core":
        break;
      case "C5-label-only":
        runState = { condition: "C5", controlNoGate: true };
        break;
      case "C5-shuffled-binding":
        // scramble binding fields toward the forbidden record's context
        messageForRead = {
          ...currentMessage,
          run_id: forbidden?.run_id ?? currentMessage.run_id,
          task_id: forbidden?.task_id ?? currentMessage.task_id,
          policy_context: forbidden?.policy_context ?? currentMessage.policy_context,
          trace_id: forbidden?.trace_id ?? currentMessage.trace_id,
        };
        break;
      case "C5-wrong-message":
        // active message identity taken from the wrong run/task
        messageForRead = {
          ...currentMessage,
          run_id: forbidden?.run_id ?? currentMessage.run_id,
          task_id: forbidden?.task_id ?? currentMessage.task_id,
        };
        break;
      case "C5-no-policy":
        runState = { condition: "C5", gateOptions: { disabledChecks: ["policy", "status"] } };
        break;
      case "C5-no-provenance":
        runState = { condition: "C5", gateOptions: { disabledChecks: ["provenance"] } };
        break;
      case "C5-random-gate":
        runState = { condition: "C5", gateOptions: { random: rng } };
        break;
      default:
        throw new Error(`unknown control: ${control}`);
    }

    const injectedMemories = runtime.readMemory(scenario.query, messageForRead, runState);
    const audit = runtime.auditRun(currentMessage.run_id);
    const evaluated = evaluateScenario({ runtime, condition: control, scenario, currentMessage, injectedMemories, audit });
    return { ...evaluated, control, message_for_read: messageForRead };
  } finally {
    runtime.close();
  }
}

export function runPhase4Suite({
  conditions = ["C0", "C1", "C2", "C3", "C4", "C5"],
  scenarios = PHASE4_SCENARIOS,
  benchmark = "coupled-memory-phase4-dev-suite",
} = {}) {
  const cases = [];
  for (const item of scenarios) {
    for (const condition of conditions) {
      cases.push(runPhase4Scenario({ scenario: item, condition }));
    }
  }
  return {
    benchmark,
    live: false,
    scenarios: scenarios.map((item) => ({ scenario_id: item.scenario_id, scenario_type: item.scenario_type })),
    cases,
    summary: cases.map((item) => ({
      scenario_id: item.scenario_id,
      scenario_type: item.scenario_type,
      condition: item.condition,
      success: item.success,
      wrong_scope_memory_use: item.wrong_scope_memory_use,
      stale_memory_use: item.stale_memory_use,
      missing_critical_memory: item.missing_critical_memory,
      forbidden_memory_use: item.forbidden_memory_use,
      causal_memory_binding: item.causal_memory_binding,
      event_graph_reconstructability: item.event_graph_reconstructability,
    })),
  };
}

export function runPhase4DevSuite(options = {}) {
  return runPhase4Suite({
    ...options,
    scenarios: options.scenarios ?? PHASE4_SCENARIOS,
    benchmark: options.benchmark ?? "coupled-memory-phase4-dev-suite",
  });
}

export function runPhase4MainSuite(options = {}) {
  return runPhase4Suite({
    ...options,
    scenarios: options.scenarios ?? PHASE4_MAIN_SCENARIOS,
    benchmark: options.benchmark ?? "coupled-memory-phase4-main-suite",
  });
}
