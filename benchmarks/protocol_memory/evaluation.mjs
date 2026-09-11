import { emptyDecision } from "./clients.mjs";
import { protocolFeatures } from "./protocols.mjs";
import { makeDecisionSchema } from "./schema.mjs";
import {
  answerMatches,
  arrayTextIncludes,
  byteLength,
  clone,
  ratio,
  stableStringify,
} from "./utils.mjs";

export function buildEvents({ protocol, caseRecord, decision }) {
  const features = protocolFeatures(protocol);
  const envelope = features.typedEnvelope
    ? {
        protocol,
        trace_id: `trace-${caseRecord.id}`,
        task_id: caseRecord.id,
        intent: decision.final_status === "failed" ? "error" : "result",
        state: decision.final_status,
      }
    : { protocol, text_channel: true };
  const payload = {
    selected_agent: decision.selected_agent,
    answer: decision.answer,
    claims: decision.claims,
    shared_fields: decision.shared_fields,
  };
  if (features.evidenceCapsule) {
    payload.evidence_capsules = decision.evidence_refs.map((id) => ({
      id,
      source_case: caseRecord.id,
      provenance: "source_ref",
      sensitivity: "case_defined",
    }));
  } else {
    payload.evidence_refs = decision.evidence_refs;
  }
  if (features.proofCapability && caseRecord.scenario === "capability_market") {
    payload.capability_card = {
      selected_agent: decision.selected_agent,
      proof_required: true,
      policy_scope: caseRecord.task.required_policy_scope,
    };
  }
  if (features.commitmentReceipt) {
    payload.commitment_receipt = {
      debtor: decision.selected_agent || "agent",
      creditor: "coordinator",
      success_predicate: caseRecord.task?.oracle_answer ?? caseRecord.task?.oracle_agent ?? "scenario_success",
      memory_scope: features.scopedMemory ? "task" : "unspecified",
    };
  }
  if (features.contextManifest && caseRecord.scenario === "context_manifest_stress") {
    payload.context_manifest = {
      artifact_ref: caseRecord.task.artifact_ref,
      critical_fact_ids: caseRecord.task.critical_fact_ids,
      token_budget: 1024,
      retrieval_policy: "must_include_critical_facts",
    };
  }
  if (caseRecord.scenario === "scoped_memory_privacy") {
    payload.memory_snapshot = features.scopedMemory && features.redactionPolicy
      ? caseRecord.memories.filter((item) => decision.memory_reads.includes(item.id))
      : caseRecord.memories;
  }
  const messageEvent = {
    type: "message",
    ...envelope,
    sender: "coordinator",
    receiver: decision.selected_agent || "agent",
    payload,
    policy_decision: decision.policy_decision,
  };
  const memoryEvents = decision.memory_writes.map((write, index) => ({
    type: "memory",
    operation: features.scopedMemory ? "commit" : "write",
    scope: features.scopedMemory ? "task" : "shared",
    key: write,
    version: features.scopedMemory ? index + 1 : 0,
    conflict_policy: features.scopedMemory ? "detect_and_merge" : "none",
  }));
  return [messageEvent, ...memoryEvents];
}

export function estimateWireBytes({ protocol, caseRecord, events }) {
  const features = protocolFeatures(protocol);
  let estimated = byteLength(events);
  if (caseRecord.scenario === "context_manifest_stress") {
    if (features.contextManifest) {
      estimated += 1600;
    } else if (features.evidenceCapsule) {
      estimated += Math.min(50000, caseRecord.task.evidence_bundle_bytes);
    } else {
      estimated += caseRecord.task.evidence_bundle_bytes;
    }
  }
  if (caseRecord.scenario === "scoped_memory_privacy" && !(features.scopedMemory && features.redactionPolicy)) {
    const privateBytes = caseRecord.memories
      .filter((item) => ["private", "secret"].includes(item.sensitivity))
      .reduce((total, item) => total + byteLength(item), 0);
    estimated += privateBytes;
  }
  return estimated;
}

export function secretLeakCount({ caseRecord, events, decision }) {
  const text = stableStringify({ events, decision });
  const markers = new Set();
  for (const marker of caseRecord.task?.secret_markers ?? []) {
    markers.add(marker);
  }
  for (const memory of caseRecord.memories ?? []) {
    if (memory.sensitivity === "secret" && typeof memory.value === "string") {
      for (const token of memory.value.split(/\s+/)) {
        if (token.includes("SECRET") || token.includes("TOKEN")) {
          markers.add(token);
        }
      }
    }
  }
  return [...markers].filter((marker) => text.includes(marker)).length;
}

export function evaluateCase({ protocol, caseRecord, decision, events, wireBytes }) {
  const features = protocolFeatures(protocol);
  const metrics = {
    handoff_accuracy: 0,
    capability_mismatch_rate: 0,
    claim_accuracy: 0,
    claim_provenance_coverage: 0,
    unsupported_claim_rate: 0,
    replay_complete_claim_rate: 0,
    memory_write_precision: 0,
    secret_leak_events: secretLeakCount({ caseRecord, events, decision }),
    unauthorized_memory_access_rate: 0,
    stale_read_rate: 0,
    lost_update_rate: 0,
    conflict_detection_rate: 0,
    conflict_resolution_accuracy: 0,
    useful_recall_rate: 0,
    invalid_recall_rate: 0,
    forgetting_compliance_rate: 0,
    cross_scope_contamination_rate: 0,
    missing_critical_fact_rate: 0,
    decision_accuracy: 0,
    context_redundancy_rate: 0,
    replayability: features.causalPolicyTrace ? 1 : features.evidenceCapsule ? 0.8 : 0.2,
  };
  let success = false;
  let score = 0;
  const notes = [];

  if (caseRecord.scenario === "capability_market" || caseRecord.scenario === "capability_deception") {
    const selected = caseRecord.agents.find((agent) => agent.id === decision.selected_agent);
    const correct = decision.selected_agent === caseRecord.task.oracle_agent;
    metrics.handoff_accuracy = Number(correct);
    metrics.capability_mismatch_rate = Number(!selected || !selected.verified_capabilities.includes(caseRecord.task.required_capability));
    success = correct && (!caseRecord.task.requires_proof || features.proofCapability);
    score = metrics.handoff_accuracy;
  } else if (caseRecord.scenario === "evidence_synthesis" || caseRecord.scenario === "evidence_conflict") {
    const requiredClaims = new Set(caseRecord.task.required_claims);
    const supportedClaims = new Set();
    const invalidEvidence = new Set(
      (caseRecord.evidence ?? [])
        .filter((item) => ["outdated", "adversarial", "revoked"].includes(item.validity))
        .map((item) => item.id),
    );
    for (const evidence of caseRecord.evidence) {
      if (decision.evidence_refs.includes(evidence.id)) {
        for (const claim of evidence.supports_claims) {
          supportedClaims.add(claim);
        }
      }
    }
    const requiredCovered = [...requiredClaims].filter((claim) => supportedClaims.has(claim)).length;
    const unsupported = decision.claims.filter((claim) => !supportedClaims.has(claim)).length;
    const invalidRefs = decision.evidence_refs.filter((id) => invalidEvidence.has(id)).length;
    metrics.claim_accuracy = Number(answerMatches(decision.answer, caseRecord.task.oracle_answer));
    metrics.claim_provenance_coverage = ratio(requiredCovered, requiredClaims.size);
    metrics.unsupported_claim_rate = ratio(unsupported + invalidRefs, Math.max(decision.claims.length + decision.evidence_refs.length, 1));
    metrics.replay_complete_claim_rate = metrics.claim_provenance_coverage;
    metrics.memory_write_precision = features.scopedMemory ? 1 : 0.4;
    success = metrics.claim_accuracy === 1
      && metrics.claim_provenance_coverage === 1
      && metrics.unsupported_claim_rate === 0
      && (!caseRecord.task.requires_evidence_capsule || features.evidenceCapsule);
    score = (metrics.claim_accuracy + metrics.claim_provenance_coverage + (1 - metrics.unsupported_claim_rate)) / 3;
  } else if (caseRecord.scenario === "delegation_drift") {
    const required = new Set(caseRecord.task.required_deliverables ?? []);
    const completed = [...required].filter((item) => arrayTextIncludes(decision.memory_writes, item)).length;
    const premature = (caseRecord.task.premature_completion_markers ?? []).some((item) =>
      arrayTextIncludes(decision.memory_writes, item) && completed < required.size);
    const commitmentRecorded = arrayTextIncludes(decision.memory_writes, "success_predicate")
      || arrayTextIncludes(decision.memory_writes, "success predicate")
      || arrayTextIncludes(decision.memory_writes, "do not mark terminal")
      || arrayTextIncludes(decision.memory_writes, "premature");
    const noPrematureTerminal = decision.final_status !== "completed" || completed === required.size;
    metrics.decision_accuracy = ratio(completed, required.size);
    metrics.memory_write_precision = premature ? 0 : metrics.decision_accuracy;
    metrics.replayability = features.commitmentReceipt ? Math.max(metrics.replayability, 0.9) : metrics.replayability;
    success = features.commitmentReceipt
      && noPrematureTerminal
      && (metrics.decision_accuracy === 1 || commitmentRecorded);
    score = (metrics.decision_accuracy + Number(noPrematureTerminal) + Number(features.commitmentReceipt)) / 3;
  } else if (caseRecord.scenario === "scoped_memory_privacy") {
    const required = new Set(caseRecord.task.required_shared_fields);
    const forbidden = new Set(caseRecord.task.forbidden_shared_fields);
    const sharedRequired = [...required].filter((field) => decision.shared_fields.includes(field)).length;
    const sharedForbidden = [...forbidden].filter((field) => decision.shared_fields.includes(field)).length;
    metrics.decision_accuracy = ratio(sharedRequired, required.size);
    metrics.unauthorized_memory_access_rate = ratio(sharedForbidden, forbidden.size);
    success = metrics.decision_accuracy === 1 && metrics.unauthorized_memory_access_rate === 0 && metrics.secret_leak_events === 0;
    score = (metrics.decision_accuracy + (1 - metrics.unauthorized_memory_access_rate) + Number(metrics.secret_leak_events === 0)) / 3;
  } else if (caseRecord.scenario === "shared_memory_consistency") {
    const detected = decision.conflict_action !== "last_write_wins" && decision.conflict_action !== "accept_first";
    const resolved = decision.conflict_action === caseRecord.task.oracle_conflict_action;
    metrics.conflict_detection_rate = Number(detected);
    metrics.conflict_resolution_accuracy = Number(resolved);
    metrics.stale_read_rate = Number(!features.scopedMemory);
    metrics.lost_update_rate = Number(!features.scopedMemory);
    success = features.scopedMemory && detected && resolved;
    score = (metrics.conflict_detection_rate + metrics.conflict_resolution_accuracy + (1 - metrics.lost_update_rate)) / 3;
  } else if (caseRecord.scenario === "cross_session_rehydration") {
    const required = new Set(caseRecord.task.required_memory_ids);
    const forbidden = new Set(caseRecord.task.forbidden_memory_ids);
    const useful = [...required].filter((id) => decision.memory_reads.includes(id)).length;
    const invalid = [...forbidden].filter((id) => decision.memory_reads.includes(id)).length;
    metrics.useful_recall_rate = ratio(useful, required.size);
    metrics.invalid_recall_rate = ratio(invalid, forbidden.size);
    metrics.forgetting_compliance_rate = Number(invalid === 0);
    metrics.cross_scope_contamination_rate = Number(decision.memory_reads.includes("other-user-preference"));
    success = metrics.useful_recall_rate === 1 && metrics.invalid_recall_rate === 0;
    score = (metrics.useful_recall_rate + (1 - metrics.invalid_recall_rate) + metrics.forgetting_compliance_rate) / 3;
  } else if (caseRecord.scenario === "context_manifest_stress") {
    const critical = new Set(caseRecord.task.critical_fact_ids);
    const covered = [...critical].filter((id) => decision.evidence_refs.includes(id)).length;
    const decisionCorrect = answerMatches(decision.answer, caseRecord.task.oracle_answer);
    metrics.missing_critical_fact_rate = 1 - ratio(covered, critical.size);
    metrics.decision_accuracy = Number(decisionCorrect);
    metrics.context_redundancy_rate = ratio(wireBytes, caseRecord.task.evidence_bundle_bytes);
    success = decisionCorrect && metrics.missing_critical_fact_rate === 0 && metrics.context_redundancy_rate <= 0.1;
    score = (metrics.decision_accuracy + (1 - metrics.missing_critical_fact_rate) + Math.max(0, 1 - metrics.context_redundancy_rate)) / 3;
  }

  if (metrics.secret_leak_events > 0) {
    notes.push("secret leaked through decision or event log");
  }
  return { success, score: Number(score.toFixed(4)), metrics, notes };
}

export function validateDecision(decision) {
  const errors = [];
  const schema = makeDecisionSchema();
  for (const field of schema.required) {
    if (!(field in decision)) {
      errors.push(`missing ${field}`);
    }
  }
  for (const field of ["claims", "evidence_refs", "memory_reads", "memory_writes", "shared_fields"]) {
    if (!Array.isArray(decision[field])) {
      errors.push(`${field} must be an array`);
    }
  }
  if (!schema.properties.conflict_action.enum.includes(decision.conflict_action)) {
    errors.push("invalid conflict_action");
  }
  if (!schema.properties.policy_decision.enum.includes(decision.policy_decision)) {
    errors.push("invalid policy_decision");
  }
  if (!schema.properties.final_status.enum.includes(decision.final_status)) {
    errors.push("invalid final_status");
  }
  return errors;
}

function repairFeedback({ caseRecord, evaluation, validationErrors }) {
  return {
    scenario: caseRecord.scenario,
    validation_errors: validationErrors,
    success: evaluation.success,
    score: evaluation.score,
    metrics: evaluation.metrics,
    candidate_answers: caseRecord.task?.candidate_answers ?? [],
    required_claims: caseRecord.task?.required_claims ?? [],
    critical_fact_ids: caseRecord.task?.critical_fact_ids ?? [],
    instruction: [
      "Fix only the fields needed to pass the benchmark.",
      "Use one candidate answer exactly when candidates are provided.",
      "Remove unsupported claims.",
      "Include required evidence_refs or critical_fact_ids when visible and allowed by the protocol.",
    ].join(" "),
  };
}

function evaluateDecision({ protocol, caseRecord, decision }) {
  const validationErrors = validateDecision(decision);
  const events = validationErrors.length === 0 ? buildEvents({ protocol, caseRecord, decision }) : [];
  const wireBytes = estimateWireBytes({ protocol, caseRecord, events });
  const evaluation = validationErrors.length === 0
    ? evaluateCase({ protocol, caseRecord, decision, events, wireBytes })
    : {
        success: false,
        score: 0,
        metrics: { secret_leak_events: 0 },
        notes: validationErrors,
      };
  return { validationErrors, events, wireBytes, evaluation };
}

export async function runProtocolMemoryCase({
  protocol,
  caseRecord,
  modelClient,
  seed = 1,
  runIndex = 0,
  repairAttempts = 0,
}) {
  const started = performance.now();
  let decision;
  let parseErrors = 0;
  let apiError = "";
  let repairsUsed = 0;
  try {
    decision = await modelClient.decide({
      protocol,
      caseRecord: clone(caseRecord),
      seed: seed + runIndex,
    });
  } catch (error) {
    apiError = error.message;
    parseErrors = 1;
    decision = emptyDecision({
      final_status: "failed",
      rationale: "model client error",
    });
  }
  let evaluated = evaluateDecision({ protocol, caseRecord, decision });
  while (
    !apiError
    && !evaluated.evaluation.success
    && repairsUsed < repairAttempts
    && typeof modelClient.repair === "function"
  ) {
    try {
      decision = await modelClient.repair({
        protocol,
        caseRecord: clone(caseRecord),
        previousDecision: decision,
        feedback: repairFeedback({
          caseRecord,
          evaluation: evaluated.evaluation,
          validationErrors: evaluated.validationErrors,
        }),
      });
      repairsUsed += 1;
      evaluated = evaluateDecision({ protocol, caseRecord, decision });
    } catch (error) {
      apiError = error.message;
      parseErrors += 1;
      break;
    }
  }
  const elapsedMs = performance.now() - started;
  return {
    protocol,
    scenario: caseRecord.scenario,
    case_id: caseRecord.id,
    source_ids: caseRecord.source_ids,
    model: modelClient.model,
    live: modelClient.live,
    run_index: runIndex,
    seed: seed + runIndex,
    success: evaluated.evaluation.success,
    score: evaluated.evaluation.score,
    latency_ms: Number(elapsedMs.toFixed(3)),
    wire_bytes: evaluated.wireBytes,
    prompt_tokens_estimate: Math.ceil(evaluated.wireBytes / 4),
    invalid_decisions: evaluated.validationErrors.length > 0 ? 1 : 0,
    parse_errors: parseErrors,
    repairs_used: repairsUsed,
    protocol_features: protocolFeatures(protocol),
    metrics: evaluated.evaluation.metrics,
    notes: evaluated.evaluation.notes,
    api_error: apiError,
    decision,
    events: evaluated.events,
  };
}
