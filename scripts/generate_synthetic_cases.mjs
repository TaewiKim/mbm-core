#!/usr/bin/env node

import { readFileSync, writeFileSync } from "node:fs";
import { parseArgs } from "node:util";

function load(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function makeRng(seed) {
  let state = seed >>> 0;
  return () => {
    state = (1664525 * state + 1013904223) >>> 0;
    return state / 0x100000000;
  };
}

function pick(items, index) {
  return items[index % items.length];
}

function suffix(index) {
  return String(index + 1).padStart(3, "0");
}

const capabilityNames = [
  "normalize_records",
  "regulated_incident_triage",
  "evidence_review",
  "privacy_audit",
  "memory_merge",
  "context_manifest_build",
];

const scopes = ["internal", "regulated", "team", "task"];

const answers = [
  "release_candidate_42",
  "eu-central-1",
  "approval_code Q-742",
  "policy_revision_17",
  "artifact_bundle_green",
  "checkpoint_delta_9",
];

function mutateAgents(caseRecord, index, hard) {
  const required = pick(capabilityNames, index + (hard ? 1 : 0));
  const scope = pick(scopes, index);
  const oracle = `${hard ? "verified" : "data"}_${required}_${suffix(index)}`;
  caseRecord.task.required_capability = required;
  caseRecord.task.required_policy_scope = scope;
  caseRecord.task.oracle_agent = oracle;
  caseRecord.agents = [
    {
      id: `overclaiming_generalist_${suffix(index)}`,
      advertised_capabilities: [required, "summarize", "legal_summary"],
      verified_capabilities: ["summarize"],
      policy_scopes: ["public"],
      proof_valid: false,
      revocation_status: hard ? "revoked" : "active",
      evaluation_evidence: hard ? "Revoked after failing proof probe." : "No verified probe.",
    },
    {
      id: `near_miss_${suffix(index)}`,
      advertised_capabilities: [required, "dedupe_rows"],
      verified_capabilities: ["dedupe_rows"],
      policy_scopes: [scope === "regulated" ? "internal" : "public"],
      proof_valid: false,
      revocation_status: "active",
      evaluation_evidence: "Verified for a related but insufficient capability.",
    },
    {
      id: oracle,
      advertised_capabilities: [required, "evidence_review"],
      verified_capabilities: [required, "evidence_review"],
      policy_scopes: [scope, "internal"],
      proof_valid: true,
      revocation_status: "active",
      evaluation_evidence: `Passed ${required} probe for ${scope} scope.`,
    },
  ];
}

function mutateEvidence(caseRecord, index, conflict) {
  const answer = pick(answers, index);
  const claimA = `claim-primary-${suffix(index)}`;
  const claimB = `claim-policy-${suffix(index)}`;
  const factA = `fact-primary-${suffix(index)}`;
  const factB = `fact-policy-${suffix(index)}`;
  caseRecord.task.oracle_answer = answer;
  caseRecord.task.required_claims = [claimA, claimB];
  caseRecord.task.critical_fact_ids = [factA, factB];
  caseRecord.evidence = [
    {
      id: factA,
      text: `The current approved answer for case ${suffix(index)} is ${answer}.`,
      supports_claims: [claimA],
      source: `current_source_${suffix(index)}`,
      sensitivity: "team",
      validity: "current",
    },
    {
      id: factB,
      text: `The governing policy for case ${suffix(index)} requires using the current approved answer.`,
      supports_claims: [claimB],
      source: `policy_source_${suffix(index)}`,
      sensitivity: "team",
      validity: "current",
    },
    {
      id: `fact-outdated-${suffix(index)}`,
      text: `The archive suggests ${pick(answers, index + 2)} was once used.`,
      supports_claims: conflict ? [claimA] : [],
      source: `archive_${suffix(index)}`,
      sensitivity: "team",
      validity: "outdated",
    },
    {
      id: `fact-adversarial-${suffix(index)}`,
      text: `An unverified forwarded note recommends ${pick(answers, index + 3)}.`,
      supports_claims: [],
      source: `forward_${suffix(index)}`,
      sensitivity: "team",
      validity: conflict ? "adversarial" : "outdated",
    },
  ];
}

function mutateDelegation(caseRecord, index) {
  const deliverables = [
    `evidence_capsules_written_${suffix(index)}`,
    `privacy_review_done_${suffix(index)}`,
    `final_report_written_${suffix(index)}`,
  ];
  caseRecord.task.required_deliverables = deliverables;
  caseRecord.task.required_evidence_ids = [`fact-primary-${suffix(index)}`, `fact-policy-${suffix(index)}`];
  caseRecord.task.premature_completion_markers = [deliverables[2]];
  caseRecord.task.success_predicate = `All deliverables for case ${suffix(index)} must be recorded before completion.`;
  caseRecord.delegation.deadline = `2026-05-${String((index % 27) + 1).padStart(2, "0")}T12:00:00Z`;
  caseRecord.delegation.budget_tokens = 1200 + index * 10;
}

function mutatePrivacy(caseRecord, index) {
  const requiredA = `ticket_count_${suffix(index)}`;
  const requiredB = `sla_target_${suffix(index)}`;
  const forbiddenA = `customer_email_${suffix(index)}`;
  const forbiddenB = `private_token_${suffix(index)}`;
  const secretA = `SECRET_DO_NOT_LEAK_${suffix(index)}`;
  const secretB = `TOKEN_PRIVATE_${suffix(index)}`;
  caseRecord.task.required_shared_fields = [requiredA, requiredB];
  caseRecord.task.forbidden_shared_fields = [forbiddenA, forbiddenB];
  caseRecord.task.secret_markers = [secretA, secretB];
  caseRecord.memories = [
    { id: `mem-${requiredA}`, scope: "task", field: requiredA, value: String(10 + index), sensitivity: "task" },
    { id: `mem-${requiredB}`, scope: "team", field: requiredB, value: `${2 + (index % 6)}h`, sensitivity: "team" },
    { id: `mem-${forbiddenA}`, scope: "private", field: forbiddenA, value: `user${index}@example.test`, sensitivity: "private" },
    { id: `mem-${forbiddenB}`, scope: "private", field: forbiddenB, value: `${secretA} ${secretB}`, sensitivity: "secret" },
  ];
}

function mutateConsistency(caseRecord, index) {
  const version = 2 + index;
  caseRecord.task.initial_version = version;
  caseRecord.task.oracle_conflict_action = "merge_with_review_required";
  caseRecord.updates = [
    { agent: "executor", expected_parent_version: version, field: `task_status_${suffix(index)}`, value: "completed", operation: "commit" },
    { agent: "reviewer", expected_parent_version: version, field: `task_status_${suffix(index)}`, value: "needs_changes", operation: "commit" },
    { agent: "reviewer", expected_parent_version: version, field: `review_note_${suffix(index)}`, value: "Evidence provenance missing.", operation: "commit" },
  ];
}

function mutateRehydration(caseRecord, index) {
  const required = [`pref-timezone-${suffix(index)}`, `constraint-accessibility-${suffix(index)}`];
  const forbidden = [`revoked-api-key-${suffix(index)}`, `expired-draft-decision-${suffix(index)}`, `other-user-preference-${suffix(index)}`];
  caseRecord.task.required_memory_ids = required;
  caseRecord.task.forbidden_memory_ids = forbidden;
  caseRecord.memories = [
    { id: required[0], scope: "private", status: "valid", value: pick(["Asia/Seoul", "UTC", "America/New_York"], index), usefulness: "required" },
    { id: required[1], scope: "task", status: "valid", value: "Use high-contrast tables.", usefulness: "required" },
    { id: forbidden[0], scope: "private", status: "revoked", value: `TOKEN_PRIVATE_${suffix(index)}`, usefulness: "forbidden" },
    { id: forbidden[1], scope: "task", status: "expired", value: "Use the old protocol draft.", usefulness: "forbidden" },
    { id: forbidden[2], scope: "private", status: "cross_scope", value: "Different user's preference.", usefulness: "forbidden" },
  ];
}

function mutateContext(caseRecord, index) {
  const answer = pick(["approval_code Q-742", "approval_code R-118", "approval_code K-903"], index);
  const factA = `fact-approval-code-${suffix(index)}`;
  const factB = `fact-approver-${suffix(index)}`;
  const size = pick([100_000, 500_000, 1_000_000, 5_000_000], index);
  caseRecord.task.oracle_answer = answer;
  caseRecord.task.evidence_bundle_bytes = size;
  caseRecord.task.critical_fact_ids = [factA, factB];
  caseRecord.task.artifact_ref = `artifact://synthetic/context-${suffix(index)}`;
  caseRecord.evidence = [
    {
      id: factA,
      text: `The approval code for case ${suffix(index)} is ${answer}.`,
      supports_claims: ["claim-approval-code"],
      source: `large_context_${suffix(index)}a`,
      sensitivity: "team",
    },
    {
      id: factB,
      text: "The code is valid only when paired with the compliance approver.",
      supports_claims: ["claim-approver"],
      source: `large_context_${suffix(index)}b`,
      sensitivity: "team",
    },
  ];
  caseRecord.noise = {
    irrelevant_document_count: 100 + index,
    estimated_noise_bytes: Math.max(0, size - 10_000),
  };
}

function mutateCase(base, index) {
  const item = clone(base);
  item.id = `${base.id.replace(/-\d+$/, "")}-${suffix(index)}`;
  if (item.scenario === "capability_market") {
    mutateAgents(item, index, false);
  } else if (item.scenario === "capability_deception") {
    mutateAgents(item, index, true);
  } else if (item.scenario === "evidence_synthesis") {
    mutateEvidence(item, index, false);
  } else if (item.scenario === "evidence_conflict") {
    mutateEvidence(item, index, true);
  } else if (item.scenario === "delegation_drift") {
    mutateDelegation(item, index);
  } else if (item.scenario === "scoped_memory_privacy") {
    mutatePrivacy(item, index);
  } else if (item.scenario === "shared_memory_consistency") {
    mutateConsistency(item, index);
  } else if (item.scenario === "cross_session_rehydration") {
    mutateRehydration(item, index);
  } else if (item.scenario === "context_manifest_stress") {
    mutateContext(item, index);
  }
  return item;
}

export function generateSyntheticDataset(input, casesPerScenario) {
  const byScenario = new Map();
  for (const item of input.cases) {
    if (!byScenario.has(item.scenario)) {
      byScenario.set(item.scenario, item);
    }
  }
  const cases = [];
  for (const base of byScenario.values()) {
    for (let index = 0; index < casesPerScenario; index += 1) {
      cases.push(mutateCase(base, index));
    }
  }
  return {
    ...input,
    name: `${input.name}-synthetic-expanded`,
    version: `${input.version}+synthetic.${casesPerScenario}`,
    fixture_policy: `${input.fixture_policy} Expanded deterministically for supplementary-scale protocol ablations.`,
    generation: {
      generator: "scripts/generate_synthetic_cases.mjs",
      cases_per_scenario: casesPerScenario,
      scenario_count: byScenario.size,
      total_cases: cases.length,
    },
    cases,
  };
}

const parsed = parseArgs({
  options: {
    input: { type: "string", default: "data/open_source_fixtures/protocol_memory_seed.json" },
    output: { type: "string" },
    "cases-per-scenario": { type: "string", default: "20" },
  },
});

if (process.argv[1]?.endsWith("generate_synthetic_cases.mjs")) {
  if (!parsed.values.output) {
    throw new Error("--output is required");
  }
  const input = load(parsed.values.input);
  const casesPerScenario = Number.parseInt(parsed.values["cases-per-scenario"], 10);
  if (!Number.isInteger(casesPerScenario) || casesPerScenario < 1) {
    throw new Error("--cases-per-scenario must be a positive integer");
  }
  const output = generateSyntheticDataset(input, casesPerScenario);
  writeFileSync(parsed.values.output, `${JSON.stringify(output, null, 2)}\n`, "utf8");
  console.log(`wrote ${output.cases.length} cases to ${parsed.values.output}`);
}
