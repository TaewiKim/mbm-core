#!/usr/bin/env node

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

export const MOCK_HARNESSES = ["langgraph", "autogen", "crewai", "openhands"];

export const PROTOCOL_CONDITIONS = ["C0", "C1", "C2", "C3", "C4", "C5"];

export const LONG_RUNNING_SCENARIOS = [
  "pause_resume_deferred_constraint",
  "crash_retry_superseded_policy",
  "branch_merge_conflicting_memories",
  "artifact_dependent_handoff",
  "private_memory_summary",
  "long_horizon_drift",
  "audit_reconstruction",
];

const HARNESS_PROFILES = {
  langgraph: {
    name: "LangGraph",
    role: "stateful graph execution substrate",
    statePersistence: 0.96,
    messageNative: 0.78,
    memoryNative: 0.82,
    artifactNative: 0.72,
    recoveryNative: 0.92,
    auditNative: 0.9,
  },
  autogen: {
    name: "AutoGen",
    role: "agent message and team orchestration substrate",
    statePersistence: 0.76,
    messageNative: 0.96,
    memoryNative: 0.74,
    artifactNative: 0.62,
    recoveryNative: 0.7,
    auditNative: 0.78,
  },
  crewai: {
    name: "CrewAI",
    role: "role/task and memory-heavy orchestration substrate",
    statePersistence: 0.74,
    messageNative: 0.68,
    memoryNative: 0.92,
    artifactNative: 0.68,
    recoveryNative: 0.66,
    auditNative: 0.66,
  },
  openhands: {
    name: "OpenHands",
    role: "software-agent execution and workspace substrate",
    statePersistence: 0.82,
    messageNative: 0.72,
    memoryNative: 0.66,
    artifactNative: 0.96,
    recoveryNative: 0.86,
    auditNative: 0.82,
  },
};

const CONDITIONS = {
  C0: {
    label: "transcript + no memory",
    communicationProtocol: "transcript",
    memoryProtocol: "none",
    coupling: "uncoupled",
    comm: 0.15,
    state: 0.1,
    retry: 0.05,
    memory: 0,
    scope: 0,
    freshness: 0,
    artifact: 0.05,
    privacy: 0.1,
    audit: 0.05,
  },
  C1: {
    label: "typed-envelope + no memory",
    communicationProtocol: "typed-envelope",
    memoryProtocol: "none",
    coupling: "uncoupled",
    comm: 0.62,
    state: 0.42,
    retry: 0.25,
    memory: 0,
    scope: 0,
    freshness: 0,
    artifact: 0.15,
    privacy: 0.22,
    audit: 0.25,
  },
  C2: {
    label: "transcript + vector retrieval",
    communicationProtocol: "transcript",
    memoryProtocol: "vector-retrieval",
    coupling: "uncoupled",
    comm: 0.18,
    state: 0.12,
    retry: 0.08,
    memory: 0.58,
    scope: 0.2,
    freshness: 0.18,
    artifact: 0.22,
    privacy: 0.18,
    audit: 0.18,
  },
  C3: {
    label: "stateful-envelope + vector retrieval",
    communicationProtocol: "stateful-envelope",
    memoryProtocol: "vector-retrieval",
    coupling: "uncoupled",
    comm: 0.72,
    state: 0.68,
    retry: 0.42,
    memory: 0.6,
    scope: 0.35,
    freshness: 0.3,
    artifact: 0.35,
    privacy: 0.3,
    audit: 0.42,
  },
  C4: {
    label: "causal-reliable + scoped-event-memory, uncoupled",
    communicationProtocol: "causal-reliable",
    memoryProtocol: "scoped-event-memory",
    coupling: "uncoupled",
    comm: 0.86,
    state: 0.82,
    retry: 0.78,
    memory: 0.76,
    scope: 0.68,
    freshness: 0.62,
    artifact: 0.68,
    privacy: 0.62,
    audit: 0.7,
  },
  C5: {
    label: "causal-reliable + governed-memory, coupled",
    communicationProtocol: "causal-reliable",
    memoryProtocol: "governed-memory",
    coupling: "coupled",
    comm: 0.92,
    state: 0.92,
    retry: 0.9,
    memory: 0.9,
    scope: 0.9,
    freshness: 0.88,
    artifact: 0.86,
    privacy: 0.88,
    audit: 0.9,
  },
};

const SCENARIOS = {
  pause_resume_deferred_constraint: {
    title: "Pause-resume deferred constraint",
    workflowLength: 25,
    weights: { state: 0.22, comm: 0.15, memory: 0.24, scope: 0.12, freshness: 0.08, audit: 0.08, artifact: 0.03, retry: 0.03, privacy: 0.05 },
    failureModes: ["lost_run_state", "lost_pending_task", "lost_deferred_constraint", "phase_inappropriate_memory"],
  },
  crash_retry_superseded_policy: {
    title: "Crash-retry with superseded policy",
    workflowLength: 30,
    weights: { retry: 0.24, comm: 0.16, state: 0.12, memory: 0.14, freshness: 0.18, scope: 0.06, audit: 0.06, privacy: 0.02, artifact: 0.02 },
    failureModes: ["uncorrelated_retry", "duplicate_side_effect", "stale_memory_used", "missing_supersession"],
  },
  branch_merge_conflicting_memories: {
    title: "Branch-merge with conflicting memories",
    workflowLength: 40,
    weights: { state: 0.18, comm: 0.16, memory: 0.18, scope: 0.16, freshness: 0.14, audit: 0.1, retry: 0.02, privacy: 0.02, artifact: 0.04 },
    failureModes: ["wrong_branch_memory", "merge_inconsistency", "conflict_not_detected", "unverified_branch_output"],
  },
  artifact_dependent_handoff: {
    title: "Artifact-dependent handoff",
    workflowLength: 20,
    weights: { artifact: 0.28, comm: 0.16, memory: 0.14, scope: 0.08, state: 0.08, audit: 0.12, freshness: 0.06, retry: 0.02, privacy: 0.06 },
    failureModes: ["artifact_ref_unresolved", "artifact_version_error", "artifact_provenance_missing", "context_bloat"],
  },
  private_memory_summary: {
    title: "Private memory summary",
    workflowLength: 18,
    weights: { privacy: 0.3, comm: 0.14, memory: 0.16, scope: 0.16, audit: 0.1, state: 0.05, freshness: 0.05, artifact: 0.02, retry: 0.02 },
    failureModes: ["private_state_leak", "unauthorized_memory_read", "redaction_failure", "policy_context_missing"],
  },
  long_horizon_drift: {
    title: "Long-horizon drift with distractors",
    workflowLength: 100,
    weights: { memory: 0.22, scope: 0.18, freshness: 0.18, state: 0.12, comm: 0.1, audit: 0.08, privacy: 0.04, artifact: 0.04, retry: 0.04 },
    failureModes: ["state_drift", "wrong_scope_memory", "cross_task_contamination", "obsolete_decision_used"],
  },
  audit_reconstruction: {
    title: "Final audit reconstruction",
    workflowLength: 55,
    weights: { audit: 0.28, comm: 0.16, memory: 0.12, state: 0.12, scope: 0.1, artifact: 0.08, freshness: 0.06, retry: 0.04, privacy: 0.04 },
    failureModes: ["unreconstructable_decision", "source_event_missing", "message_memory_mismatch", "artifact_provenance_missing"],
  },
};

function clamp01(value) {
  return Math.max(0, Math.min(1, value));
}

function average(values) {
  const finite = values.filter((value) => Number.isFinite(value));
  if (finite.length === 0) return Number.NaN;
  return finite.reduce((total, value) => total + value, 0) / finite.length;
}

function deterministicNoise(seed, ...parts) {
  let hash = seed >>> 0;
  for (const part of parts.join("|").split("")) {
    hash = Math.imul(hash ^ part.charCodeAt(0), 2654435761) >>> 0;
  }
  return (hash / 0xffffffff - 0.5) * 0.04;
}

function weightedProtocolScore(condition, scenario, harness, seed) {
  const cond = CONDITIONS[condition];
  const spec = SCENARIOS[scenario];
  const profile = HARNESS_PROFILES[harness];
  const weights = spec.weights;
  const components = {
    comm: clamp01(cond.comm * 0.8 + profile.messageNative * 0.2),
    state: clamp01(cond.state * 0.75 + profile.statePersistence * 0.25),
    retry: clamp01(cond.retry * 0.75 + profile.recoveryNative * 0.25),
    memory: clamp01(cond.memory * 0.75 + profile.memoryNative * 0.25),
    scope: clamp01(cond.scope * 0.85 + profile.memoryNative * 0.15),
    freshness: cond.freshness,
    artifact: clamp01(cond.artifact * 0.65 + profile.artifactNative * 0.35),
    privacy: cond.privacy,
    audit: clamp01(cond.audit * 0.7 + profile.auditNative * 0.3),
  };
  const score = Object.entries(weights).reduce((total, [key, weight]) => total + components[key] * weight, 0);
  const longRunPenalty = Math.max(0, spec.workflowLength - 20) / 200;
  const couplingBonus = cond.coupling === "coupled" ? 0.08 + longRunPenalty : 0;
  const uncoupledPenalty = cond.coupling === "uncoupled" && cond.memory > 0 && cond.comm > 0.5 ? longRunPenalty * 0.8 : 0;
  const noMemoryPenalty = cond.memory === 0 ? Math.min(0.18, spec.workflowLength / 500) : 0;
  return {
    score: clamp01(score + couplingBonus - uncoupledPenalty - noMemoryPenalty + deterministicNoise(seed, condition, scenario, harness)),
    components,
  };
}

function failureAttribution(condition, scenario, components, score) {
  const cond = CONDITIONS[condition];
  const spec = SCENARIOS[scenario];
  const failures = [];
  const add = (mode, reason) => failures.push({ mode, reason });
  if (score >= 0.82) return failures;
  if (components.comm < 0.55) add("lost_handoff_context", "communication protocol lacks typed trace/task/handoff semantics");
  if (components.retry < 0.55 && scenario.includes("retry")) add("uncorrelated_retry", "retry cannot be tied to the original request and side effects");
  if (components.memory < 0.55) add("critical_state_not_recalled", "prior work is not available as durable state");
  if (components.scope < 0.55) add("wrong_scope_memory", "retrieved memory is not constrained by run/task/branch scope");
  if (components.freshness < 0.55 && ["crash_retry_superseded_policy", "long_horizon_drift", "branch_merge_conflicting_memories"].includes(scenario)) {
    add("stale_memory_used", "superseded or expired memory can be treated as current");
  }
  if (components.artifact < 0.55 && scenario === "artifact_dependent_handoff") {
    add("artifact_ref_unresolved", "artifact reference is not reliably resolved by downstream agent");
  }
  if (components.privacy < 0.55 && scenario === "private_memory_summary") {
    add("private_state_leak", "private memory is not protected across summary/message boundaries");
  }
  if (components.audit < 0.6 && scenario === "audit_reconstruction") {
    add("unreconstructable_decision", "final decision cannot be traced to message-memory-artifact events");
  }
  if (cond.memory > 0 && cond.comm > 0.5 && cond.coupling === "uncoupled") {
    add("message_memory_mismatch", "communication and memory modules exist but are not causally bound");
  }
  if (failures.length === 0) {
    add(spec.failureModes[0], "scenario-specific long-running continuity failure");
  }
  return failures;
}

export function runMockOne({ harness, condition, scenario, seed = 1 }) {
  if (!MOCK_HARNESSES.includes(harness)) throw new Error(`unknown harness: ${harness}`);
  if (!PROTOCOL_CONDITIONS.includes(condition)) throw new Error(`unknown condition: ${condition}`);
  if (!LONG_RUNNING_SCENARIOS.includes(scenario)) throw new Error(`unknown scenario: ${scenario}`);
  const cond = CONDITIONS[condition];
  const spec = SCENARIOS[scenario];
  const profile = HARNESS_PROFILES[harness];
  const { score, components } = weightedProtocolScore(condition, scenario, harness, seed);
  const threshold = 0.68;
  const finalCorrect = score >= threshold ? 1 : 0;
  const failures = failureAttribution(condition, scenario, components, score);
  const communicationIntegrity = average([
    components.comm,
    components.state,
    components.retry,
  ]);
  const memoryProtocolIntegrity = average([
    components.memory,
    components.scope,
    components.freshness,
  ]);
  const causalMemoryBinding = clamp01((components.comm + components.memory + components.scope + components.freshness) / 4 + (cond.coupling === "coupled" ? 0.12 : -0.15));
  const recoveryReliability = components.retry;
  const artifactContinuity = components.artifact;
  const privacySafety = clamp01(components.privacy - (failures.some((failure) => failure.mode === "private_state_leak") ? 0.25 : 0));
  const eventGraphReconstructability = average([components.audit, causalMemoryBinding, components.comm]);
  const longRunningHarnessProtocolScore = clamp01(average([
    score,
    communicationIntegrity,
    memoryProtocolIntegrity,
    causalMemoryBinding,
    recoveryReliability,
    artifactContinuity,
    privacySafety,
    eventGraphReconstructability,
  ]));
  return {
    benchmark: "mock-long-running-harness-protocol-swap",
    alignment_status: "mock-validation",
    api_key_required: false,
    not_llm_performance: true,
    harness,
    harness_name: profile.name,
    harness_role: profile.role,
    condition,
    condition_label: cond.label,
    communication_protocol: cond.communicationProtocol,
    memory_protocol: cond.memoryProtocol,
    coupling: cond.coupling,
    scenario,
    scenario_title: spec.title,
    workflow_length: spec.workflowLength,
    seed,
    final_correct: finalCorrect,
    final_score: score,
    communication_integrity: communicationIntegrity,
    memory_protocol_integrity: memoryProtocolIntegrity,
    causal_memory_binding: causalMemoryBinding,
    recovery_reliability: recoveryReliability,
    artifact_continuity: artifactContinuity,
    privacy_safety: privacySafety,
    event_graph_reconstructability: eventGraphReconstructability,
    long_running_harness_protocol_score: longRunningHarnessProtocolScore,
    context_savings_ratio: cond.memoryProtocol === "none" ? 0 : clamp01(0.2 + components.artifact * 0.35 + components.memory * 0.25),
    failure_count: failures.length,
    failures,
  };
}

export function summarizeRows(rows) {
  if (rows.length === 0) return {};
  const fields = [
    "final_correct",
    "final_score",
    "communication_integrity",
    "memory_protocol_integrity",
    "causal_memory_binding",
    "recovery_reliability",
    "artifact_continuity",
    "privacy_safety",
    "event_graph_reconstructability",
    "long_running_harness_protocol_score",
    "context_savings_ratio",
    "failure_count",
  ];
  const out = {
    harness: rows[0].harness,
    condition: rows[0].condition,
    scenario: rows[0].scenario,
    runs: rows.length,
  };
  for (const field of fields) {
    out[field] = rows.reduce((total, row) => total + row[field], 0) / rows.length;
  }
  const failureCounts = new Map();
  for (const row of rows) {
    for (const failure of row.failures) {
      failureCounts.set(failure.mode, (failureCounts.get(failure.mode) ?? 0) + 1);
    }
  }
  out.failure_modes = Object.fromEntries([...failureCounts.entries()].sort((a, b) => b[1] - a[1]));
  return out;
}

export function runMockBenchmark(args) {
  const harnesses = args.harness === "all" ? MOCK_HARNESSES : [args.harness];
  const conditions = args.condition === "all" ? PROTOCOL_CONDITIONS : [args.condition];
  const scenarios = args.scenario === "all" ? LONG_RUNNING_SCENARIOS : [args.scenario];
  const raw = [];
  const results = [];
  for (const harness of harnesses) {
    for (const condition of conditions) {
      for (const scenario of scenarios) {
        const rows = [];
        for (let runIndex = 0; runIndex < args.runs; runIndex += 1) {
          const row = runMockOne({ harness, condition, scenario, seed: args.seed + runIndex });
          rows.push(row);
          if (args.includeRaw) raw.push(row);
        }
        results.push(summarizeRows(rows));
      }
    }
  }
  return {
    benchmark: "mock-long-running-harness-protocol-swap",
    purpose: "API-free validation of protocol conditions, scenario mechanics, metric calculations, and failure attribution before LLM-backed SOTA harness runs.",
    api_key_required: false,
    not_llm_performance: true,
    harnesses,
    conditions,
    scenarios,
    runs_per_cell: args.runs,
    seed: args.seed,
    results,
    ...(args.includeRaw ? { raw } : {}),
  };
}

function formatNumber(value) {
  if (typeof value !== "number") return String(value);
  if (Number.isNaN(value)) return "n/a";
  return value.toFixed(3);
}

export function printTable(result) {
  const columns = [
    "harness",
    "condition",
    "scenario",
    "final_correct",
    "communication_integrity",
    "memory_protocol_integrity",
    "causal_memory_binding",
    "long_running_harness_protocol_score",
    "failure_count",
  ];
  const widths = Object.fromEntries(
    columns.map((column) => [column, Math.max(column.length, ...result.results.map((row) => formatNumber(row[column]).length))]),
  );
  console.log(columns.map((column) => column.padEnd(widths[column])).join("  "));
  console.log(columns.map((column) => "-".repeat(widths[column])).join("  "));
  for (const row of result.results) {
    console.log(columns.map((column) => formatNumber(row[column]).padEnd(widths[column])).join("  "));
  }
}

export function cliArgs(argv = process.argv.slice(2)) {
  const parsed = parseArgs({
    args: argv,
    options: {
      harness: { type: "string", default: "all" },
      condition: { type: "string", default: "all" },
      scenario: { type: "string", default: "all" },
      runs: { type: "string", default: "3" },
      seed: { type: "string", default: "1" },
      json: { type: "string" },
      "include-raw": { type: "boolean", default: false },
    },
  });
  if (!["all", ...MOCK_HARNESSES].includes(parsed.values.harness)) {
    throw new Error(`--harness must be one of: all, ${MOCK_HARNESSES.join(", ")}`);
  }
  if (!["all", ...PROTOCOL_CONDITIONS].includes(parsed.values.condition)) {
    throw new Error(`--condition must be one of: all, ${PROTOCOL_CONDITIONS.join(", ")}`);
  }
  if (!["all", ...LONG_RUNNING_SCENARIOS].includes(parsed.values.scenario)) {
    throw new Error(`--scenario must be one of: all, ${LONG_RUNNING_SCENARIOS.join(", ")}`);
  }
  const runs = Number.parseInt(parsed.values.runs, 10);
  const seed = Number.parseInt(parsed.values.seed, 10);
  if (!Number.isInteger(runs) || runs < 1) throw new Error("--runs must be a positive integer");
  if (!Number.isInteger(seed)) throw new Error("--seed must be an integer");
  return {
    harness: parsed.values.harness,
    condition: parsed.values.condition,
    scenario: parsed.values.scenario,
    runs,
    seed,
    json: parsed.values.json,
    includeRaw: parsed.values["include-raw"],
  };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  try {
    const args = cliArgs();
    const result = runMockBenchmark(args);
    printTable(result);
    if (args.json) {
      const path = resolve(args.json);
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, `${JSON.stringify(result, null, 2)}\n`, "utf8");
    }
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
