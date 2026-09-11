#!/usr/bin/env node

import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

import {
  DEFAULT_OPENAI_MODEL,
  DEFAULT_DATASET_PATH,
  loadProtocolMemoryDataset,
  runProtocolMemoryCase,
  visibleCaseForProtocol,
} from "./protocol_memory_benchmark.mjs";

const MODULE_DIR = dirname(fileURLToPath(import.meta.url));

export const FINAL_PROTOCOL = "acmcp-core";
export const TIER2_PROTOCOLS = [
  "typed-envelope",
  "a2a-task-artifact",
  "autogen-conversation",
  "mpac-coordination",
  "mesh-memory",
  "q-kvcomm-compressed",
  FINAL_PROTOCOL,
];
export const TIER2_SCENARIOS = [
  "capability_deception",
  "evidence_conflict",
  "delegation_drift",
  "scoped_memory_privacy",
  "context_manifest_stress",
];

function stableStringify(value) {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableStringify(item)).join(",")}]`;
  }
  return `{${Object.keys(value)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`)
    .join(",")}}`;
}

function parseList(value, allowed, flagName) {
  if (value === "all") {
    return allowed;
  }
  const selected = value.split(",").map((item) => item.trim()).filter(Boolean);
  const unknown = selected.filter((item) => !allowed.includes(item));
  if (selected.length === 0 || unknown.length > 0) {
    throw new Error(`--${flagName} must be all or comma-separated values from: ${allowed.join(", ")}`);
  }
  return selected;
}

function selectCases(dataset, scenarios, maxCasesPerScenario) {
  const scenarioSet = new Set(scenarios);
  const counts = new Map();
  return dataset.cases.filter((item) => {
    if (!scenarioSet.has(item.scenario)) {
      return false;
    }
    const count = counts.get(item.scenario) ?? 0;
    if (maxCasesPerScenario > 0 && count >= maxCasesPerScenario) {
      return false;
    }
    counts.set(item.scenario, count + 1);
    return true;
  });
}

function decisionSchema() {
  return {
    type: "object",
    additionalProperties: false,
    properties: {
      selected_agent: { type: "string" },
      answer: { type: "string" },
      claims: { type: "array", items: { type: "string" } },
      evidence_refs: { type: "array", items: { type: "string" } },
      memory_reads: { type: "array", items: { type: "string" } },
      memory_writes: { type: "array", items: { type: "string" } },
      shared_fields: { type: "array", items: { type: "string" } },
      conflict_action: {
        type: "string",
        enum: ["none", "accept_first", "last_write_wins", "reject", "merge", "merge_with_review_required"],
      },
      policy_decision: {
        type: "string",
        enum: ["allow", "deny", "redact", "escalate", "none"],
      },
      final_status: {
        type: "string",
        enum: ["completed", "failed", "needs_review", "cancelled"],
      },
      rationale: { type: "string" },
      outbound_message: { type: "string" },
    },
    required: [
      "selected_agent",
      "answer",
      "claims",
      "evidence_refs",
      "memory_reads",
      "memory_writes",
      "shared_fields",
      "conflict_action",
      "policy_decision",
      "final_status",
      "rationale",
      "outbound_message",
    ],
  };
}

function extractOutputText(response) {
  if (typeof response.output_text === "string") {
    return response.output_text;
  }
  const chunks = [];
  for (const item of response.output ?? []) {
    for (const content of item.content ?? []) {
      if (typeof content.text === "string") {
        chunks.push(content.text);
      } else if (typeof content.output_text === "string") {
        chunks.push(content.output_text);
      }
    }
  }
  if (chunks.length === 0) {
    throw new Error("OpenAI response did not contain output text");
  }
  return chunks.join("");
}

function protocolInstructions(protocol) {
  if (protocol === FINAL_PROTOCOL) {
    return [
      "Use ACM-CP/1.0 Core.",
      "Preserve typed envelope intent, traceability, and state.",
      "Use evidence_refs for every important factual claim.",
      "Choose agents by verified capability, active revocation status, and policy scope.",
      "Record delegation deliverables as machine-checkable memory_writes.",
      "Read only in-scope valid memory and redact private or secret memory.",
      "Use context manifest/artifact references instead of copying large context.",
      "Prefer needs_review over premature completed when commitments are unsatisfied.",
    ].join("\n");
  }
  if (protocol === "a2a-task-artifact") {
    return [
      "Use an A2A-style task/artifact protocol.",
      "Represent work as task lifecycle updates and final artifacts.",
      "Use agent-card style declared capabilities when selecting a remote agent.",
      "Messages and artifacts may contain structured Parts.",
      "No proof-carrying capability attestation, scoped memory enforcement, or evidence capsule semantics are available unless present in the task artifact itself.",
      "Do not invent hidden policy metadata.",
    ].join("\n");
  }
  if (protocol === "autogen-conversation") {
    return [
      "Use an AutoGen-style multi-agent conversation baseline.",
      "Agents coordinate by sending conversational messages and can revise based on peer feedback.",
      "Use role-specific reasoning to solve the task.",
      "No protocol-native evidence capsules, proof-carrying capability cards, scoped memory enforcement, or context manifests are available.",
      "Keep the final answer concise and machine-readable.",
    ].join("\n");
  }
  if (protocol === "mpac-coordination") {
    return [
      "Use an MPAC-style multi-principal coordination protocol.",
      "Represent work through explicit session, intent, operation, conflict, and governance records.",
      "Use causal ordering and conflict objects for shared-state coordination.",
      "Intent declaration and governance review are available for coordination commitments.",
      "No proof-carrying capability attestation, evidence capsule semantics, or context-manifest compression are available unless application messages carry them explicitly.",
      "Security profiles govern sessions, but there is no ACM-CP field-level memory redaction control plane.",
    ].join("\n");
  }
  if (protocol === "mesh-memory") {
    return [
      "Use a Mesh Memory-style semantic memory protocol.",
      "Accept peer content field by field and preserve source lineage for accepted memory blocks.",
      "Store receiver-evaluated memory rather than raw peer messages.",
      "Use lineage to avoid unsupported echoed claims and use scoped memory acceptance for private data.",
      "No proof-carrying capability attestation, task commitment receipts, or context-manifest compression are available.",
    ].join("\n");
  }
  if (protocol === "q-kvcomm-compressed") {
    return [
      "Use a Q-KVComm-style compressed context exchange baseline.",
      "Prioritize compact transmission of large context while preserving critical facts.",
      "Treat compressed representation exchange as the main communication primitive.",
      "No proof-carrying capability attestation, scoped memory redaction, evidence capsule semantics, or commitment receipts are available.",
    ].join("\n");
  }
  return [
    "Use a basic typed task/result envelope.",
    "You may exchange compact structured task information.",
    "No proof-carrying capability cards, scoped memory policy, commitment receipts, or context manifests are available.",
    "Return the best decision you can from the visible case input and transcript.",
  ].join("\n");
}

function isPrivateMemory(memory) {
  return ["private", "secret"].includes(memory.scope) || ["private", "secret"].includes(memory.sensitivity);
}

function visibleCaseForTier2(caseRecord, protocol) {
  const visible = visibleCaseForProtocol(caseRecord, protocol);
  if (protocol !== FINAL_PROTOCOL || !Array.isArray(visible.memories)) {
    return visible;
  }
  visible.memories = visible.memories.map((memory) => {
    if (!isPrivateMemory(memory)) {
      return memory;
    }
    return {
      ...memory,
      value: "[REDACTED_BY_ACMCP_SCOPE]",
      redaction_reason: "private_or_secret_scope",
    };
  });
  return visible;
}

function forbiddenMemoryIds(caseRecord) {
  const ids = new Set(caseRecord.task?.forbidden_memory_ids ?? []);
  for (const memory of caseRecord.memories ?? []) {
    if (isPrivateMemory(memory)) {
      ids.add(memory.id);
    }
  }
  return ids;
}

function forbiddenSharedFields(caseRecord) {
  const fields = new Set(caseRecord.task?.forbidden_shared_fields ?? []);
  for (const memory of caseRecord.memories ?? []) {
    if (isPrivateMemory(memory) && memory.field) {
      fields.add(memory.field);
    }
  }
  return fields;
}

function scrubSecretText(value, caseRecord) {
  if (typeof value !== "string") {
    return value;
  }
  let scrubbed = value;
  const markers = new Set(caseRecord.task?.secret_markers ?? []);
  for (const memory of caseRecord.memories ?? []) {
    if (isPrivateMemory(memory) && typeof memory.value === "string") {
      for (const token of memory.value.split(/\s+/)) {
        if (token) {
          markers.add(token);
        }
      }
    }
  }
  for (const marker of markers) {
    scrubbed = scrubbed.split(marker).join("[REDACTED]");
  }
  return scrubbed;
}

function applyCorePolicy({ protocol, caseRecord, role, decision }) {
  if (protocol !== FINAL_PROTOCOL) {
    return { decision, policyEvents: [] };
  }
  const deniedMemory = forbiddenMemoryIds(caseRecord);
  const deniedFields = forbiddenSharedFields(caseRecord);
  const deniedReads = (decision.memory_reads ?? []).filter((id) => deniedMemory.has(id));
  const deniedEvidence = (decision.evidence_refs ?? []).filter((id) => deniedMemory.has(id));
  const deniedSharedFields = (decision.shared_fields ?? []).filter((field) => deniedFields.has(field));
  const sanitized = {
    ...decision,
    answer: scrubSecretText(decision.answer, caseRecord),
    claims: (decision.claims ?? []).map((claim) => scrubSecretText(claim, caseRecord)),
    evidence_refs: (decision.evidence_refs ?? []).filter((id) => !deniedMemory.has(id)),
    memory_reads: (decision.memory_reads ?? []).filter((id) => !deniedMemory.has(id)),
    memory_writes: (decision.memory_writes ?? []).map((write) => scrubSecretText(write, caseRecord)),
    shared_fields: (decision.shared_fields ?? []).filter((field) => !deniedFields.has(field)),
    rationale: scrubSecretText(decision.rationale, caseRecord),
    outbound_message: scrubSecretText(decision.outbound_message, caseRecord),
    policy_decision: deniedReads.length > 0 || deniedSharedFields.length > 0 ? "redact" : decision.policy_decision,
  };
  const policyEvents = [
    ...deniedReads.map((memoryId) => ({
      event_type: "memory.read.denied",
      protocol,
      role,
      case_id: caseRecord.id,
      memory_id: memoryId,
      decision: "denied_by_scope",
    })),
    ...deniedEvidence.map((evidenceRef) => ({
      event_type: "evidence.redacted",
      protocol,
      role,
      case_id: caseRecord.id,
      evidence_ref: evidenceRef,
      decision: "redacted_by_scope",
    })),
    ...deniedSharedFields.map((field) => ({
      event_type: "policy.redacted",
      protocol,
      role,
      case_id: caseRecord.id,
      field,
      decision: "redacted_by_scope",
    })),
  ];
  return { decision: sanitized, policyEvents };
}

function roleInstructions({ role, protocol, scenario }) {
  return [
    `Role: ${role}`,
    `Protocol: ${protocol}`,
    `Scenario: ${scenario}`,
    protocolInstructions(protocol),
    "Return exactly one JSON object matching the schema.",
    "Do not mention hidden oracle fields.",
    "Do not reveal secret markers or private token values.",
  ].join("\n");
}

export class OpenAITranscriptClient {
  constructor({ apiKey = process.env.OPENAI_API_KEY, model = DEFAULT_OPENAI_MODEL, timeoutMs = 120000 } = {}) {
    this.apiKey = apiKey;
    this.model = model;
    this.timeoutMs = timeoutMs;
    if (!this.apiKey) {
      throw new Error("OPENAI_API_KEY is required for live Tier 2 transcript runs");
    }
  }

  async decide({ role, protocol, scenario, visibleCase, transcript }) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
    const body = {
      model: this.model,
      instructions: roleInstructions({ role, protocol, scenario }),
      input: [
        {
          role: "user",
          content: [
            `Visible case JSON:\n${stableStringify(visibleCase)}`,
            `Transcript so far:\n${stableStringify(transcript)}`,
          ].join("\n\n"),
        },
      ],
      text: {
        format: {
          type: "json_schema",
          name: "tier2_agent_decision",
          strict: true,
          schema: decisionSchema(),
        },
      },
    };
    try {
      const response = await fetch("https://api.openai.com/v1/responses", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) {
        throw new Error(`OpenAI Responses API failed: ${response.status} ${stableStringify(data)}`);
      }
      return JSON.parse(extractOutputText(data));
    } finally {
      clearTimeout(timeout);
    }
  }
}

class DryRunTranscriptClient {
  constructor({ model = "dry-run-transcript" } = {}) {
    this.model = model;
  }

  async decide({ role, protocol, visibleCase }) {
    const task = visibleCase.task ?? {};
    const isCore = protocol === FINAL_PROTOCOL;
    return {
      selected_agent: isCore ? "verified_incident_triager" : "charismatic_router",
      answer: task.oracle_answer ?? "",
      claims: task.required_claims ?? [],
      evidence_refs: isCore ? task.critical_fact_ids ?? [] : [],
      memory_reads: isCore ? ["mem-ticket-count", "mem-sla"] : ["mem-ticket-count", "mem-sla", "mem-private-token"],
      memory_writes: isCore
        ? task.required_deliverables ?? ["evidence_capsules_written", "privacy_review_done", "final_report_written"]
        : ["final_report_written"],
      shared_fields: isCore ? task.required_shared_fields ?? [] : [...(task.required_shared_fields ?? []), ...(task.forbidden_shared_fields ?? [])],
      conflict_action: "none",
      policy_decision: isCore ? "allow" : "none",
      final_status: "completed",
      rationale: `${role} dry-run decision`,
      outbound_message: `${role} message`,
    };
  }
}

function makeEvent({ eventType, protocol, caseRecord, role, receiver, decision, index }) {
  return {
    event_type: eventType,
    protocol,
    trace_id: `tier2-${caseRecord.id}`,
    span_id: `${role}-${index}`,
    role,
    receiver,
    scenario: caseRecord.scenario,
    case_id: caseRecord.id,
    payload: {
      selected_agent: decision.selected_agent,
      answer: decision.answer,
      claims: decision.claims,
      evidence_refs: decision.evidence_refs,
      memory_reads: decision.memory_reads,
      memory_writes: decision.memory_writes,
      shared_fields: decision.shared_fields,
      conflict_action: decision.conflict_action,
      policy_decision: decision.policy_decision,
      final_status: decision.final_status,
      outbound_message: decision.outbound_message,
    },
  };
}

function memoryEvents({ protocol, caseRecord, role, decision }) {
  const events = [];
  for (const id of decision.memory_reads ?? []) {
    events.push({
      event_type: "memory.read.requested",
      protocol,
      role,
      case_id: caseRecord.id,
      memory_id: id,
      decision: protocol === FINAL_PROTOCOL ? "policy_checked" : "unscoped",
    });
  }
  for (const key of decision.memory_writes ?? []) {
    events.push({
      event_type: "memory.write.committed",
      protocol,
      role,
      case_id: caseRecord.id,
      key,
      scope: protocol === FINAL_PROTOCOL ? "task" : "shared",
    });
  }
  for (const id of decision.evidence_refs ?? []) {
    events.push({
      event_type: "evidence.attached",
      protocol,
      role,
      case_id: caseRecord.id,
      evidence_ref: id,
    });
  }
  if (protocol === FINAL_PROTOCOL && decision.selected_agent) {
    events.push({
      event_type: "capability.verified",
      protocol,
      role,
      case_id: caseRecord.id,
      selected_agent: decision.selected_agent,
    });
  }
  return events;
}

function finalDecisionFrom(decision) {
  const { outbound_message, ...finalDecision } = decision;
  return finalDecision;
}

async function evaluateFinalDecision({ protocol, caseRecord, finalDecision, model, seed, runIndex }) {
  const modelClient = {
    model,
    live: true,
    decide: async () => finalDecision,
  };
  return runProtocolMemoryCase({
    protocol,
    caseRecord,
    modelClient,
    seed,
    runIndex,
  });
}

export async function runTier2TranscriptCase({ protocol, caseRecord, client, seed, runIndex }) {
  const visibleProtocol = protocol === FINAL_PROTOCOL ? FINAL_PROTOCOL : protocol;
  const visibleCase = visibleCaseForTier2(caseRecord, visibleProtocol);
  const transcript = [];
  const roles = [
    ["coordinator", "specialist"],
    ["specialist", "verifier"],
    ["verifier", "coordinator"],
  ];
  let finalDecision;
  let apiError = "";
  for (const [index, [role, receiver]] of roles.entries()) {
    try {
      const rawDecision = await client.decide({
        role,
        protocol,
        scenario: caseRecord.scenario,
        visibleCase,
        transcript,
      });
      const { decision, policyEvents } = applyCorePolicy({
        protocol,
        caseRecord,
        role,
        decision: rawDecision,
      });
      const messageEvent = makeEvent({
        eventType: "message.sent",
        protocol,
        caseRecord,
        role,
        receiver,
        decision,
        index,
      });
      transcript.push(...policyEvents, messageEvent, ...memoryEvents({ protocol, caseRecord, role, decision }));
      finalDecision = finalDecisionFrom(decision);
    } catch (error) {
      apiError = error.message;
      finalDecision = {
        selected_agent: "",
        answer: "",
        claims: [],
        evidence_refs: [],
        memory_reads: [],
        memory_writes: [],
        shared_fields: [],
        conflict_action: "none",
        policy_decision: "none",
        final_status: "failed",
        rationale: "Tier 2 transcript API error",
      };
      break;
    }
  }
  const evaluation = await evaluateFinalDecision({
    protocol,
    caseRecord,
    finalDecision,
    model: client.model,
    seed,
    runIndex,
  });
  return {
    ...evaluation,
    benchmark: "tier2-live-transcript",
    api_error: apiError || evaluation.api_error,
    transcript_events: transcript.length,
    api_calls: apiError ? transcript.filter((item) => item.event_type === "message.sent").length : roles.length,
    transcript,
  };
}

function summarize(cases) {
  const groups = new Map();
  for (const item of cases) {
    const key = `${item.protocol}:${item.scenario}`;
    if (!groups.has(key)) {
      groups.set(key, []);
    }
    groups.get(key).push(item);
  }
  return [...groups.values()].map((items) => {
    const first = items[0];
    const avg = (field) => items.reduce((total, item) => total + Number(item[field] ?? item.metrics?.[field] ?? 0), 0) / items.length;
    return {
      protocol: first.protocol,
      scenario: first.scenario,
      runs: items.length,
      success_rate: Number(avg("success").toFixed(4)),
      avg_score: Number(avg("score").toFixed(4)),
      avg_wire_bytes: Number(avg("wire_bytes").toFixed(1)),
      secret_leak_events: items.reduce((total, item) => total + (item.metrics.secret_leak_events ?? 0), 0),
      avg_transcript_events: Number(avg("transcript_events").toFixed(1)),
      avg_api_calls: Number(avg("api_calls").toFixed(1)),
      api_errors: items.filter((item) => item.api_error).length,
    };
  });
}

export async function runTier2TranscriptBenchmark(args) {
  const dataset = loadProtocolMemoryDataset(args.data);
  const protocols = args.protocols;
  const scenarios = args.scenarios;
  const selectedCases = selectCases(dataset, scenarios, args.maxCasesPerScenario);
  const client = args.live
    ? new OpenAITranscriptClient({ apiKey: args.apiKey, model: args.model, timeoutMs: args.timeoutMs })
    : new DryRunTranscriptClient({ model: args.model });
  const jobs = [];
  for (const protocol of protocols) {
    for (const caseRecord of selectedCases) {
      for (let runIndex = 0; runIndex < args.runs; runIndex += 1) {
        jobs.push(() => runTier2TranscriptCase({
          protocol,
          caseRecord,
          client,
          seed: args.seed,
          runIndex,
        }));
      }
    }
  }
  if (args.jsonl) {
    writeFileSync(args.jsonl, "", "utf8");
  }
  const cases = await runPool(jobs, args.concurrency, (item, completed, total) => {
    if (args.jsonl) {
      appendFileSync(args.jsonl, `${JSON.stringify(item)}\n`, "utf8");
    }
    if (args.progressEvery > 0 && (completed % args.progressEvery === 0 || completed === total)) {
      console.error(`progress ${completed}/${total}`);
    }
  });
  return {
    benchmark: "tier2-live-transcript",
    final_protocol: FINAL_PROTOCOL,
    dataset: {
      name: dataset.name,
      version: dataset.version,
      path: args.data,
      sources: dataset.sources,
    },
    model: args.model,
    live: args.live,
    seed: args.seed,
    runs_per_case: args.runs,
    max_cases_per_scenario: args.maxCasesPerScenario,
    concurrency: args.concurrency,
    results: summarize(cases),
    cases,
  };
}

async function runPool(jobs, concurrency, onResult = () => {}) {
  const limit = Math.max(1, Number(concurrency ?? 1));
  const results = new Array(jobs.length);
  let cursor = 0;
  let completed = 0;
  async function worker() {
    while (cursor < jobs.length) {
      const index = cursor;
      cursor += 1;
      results[index] = await jobs[index]();
      completed += 1;
      onResult(results[index], completed, jobs.length);
    }
  }
  const workers = Array.from({ length: Math.min(limit, jobs.length) }, () => worker());
  await Promise.all(workers);
  return results;
}

function printSummary(result) {
  const columns = ["protocol", "scenario", "success_rate", "avg_score", "avg_wire_bytes", "secret_leak_events", "avg_transcript_events", "avg_api_calls", "api_errors"];
  const widths = Object.fromEntries(columns.map((column) => [
    column,
    Math.max(column.length, ...result.results.map((row) => String(row[column]).length)),
  ]));
  console.log(columns.map((column) => column.padEnd(widths[column])).join("  "));
  console.log(columns.map((column) => "-".repeat(widths[column])).join("  "));
  for (const row of result.results) {
    console.log(columns.map((column) => String(row[column]).padEnd(widths[column])).join("  "));
  }
}

export function cliArgs(argv = process.argv.slice(2)) {
  const parsed = parseArgs({
    args: argv,
    options: {
      protocol: { type: "string", default: TIER2_PROTOCOLS.join(",") },
      scenario: { type: "string", default: TIER2_SCENARIOS.join(",") },
      runs: { type: "string", default: "1" },
      seed: { type: "string", default: "1" },
      data: { type: "string", default: resolve(MODULE_DIR, "../data/open_source_fixtures/protocol_memory_seed.json") },
      model: { type: "string", default: DEFAULT_OPENAI_MODEL },
      "max-cases-per-scenario": { type: "string", default: "1" },
      concurrency: { type: "string", default: "1" },
      "progress-every": { type: "string", default: "0" },
      "timeout-ms": { type: "string", default: "120000" },
      live: { type: "boolean", default: false },
      json: { type: "string" },
      jsonl: { type: "string" },
    },
  });
  const protocols = parseList(parsed.values.protocol, TIER2_PROTOCOLS, "protocol");
  const scenarios = parseList(parsed.values.scenario, TIER2_SCENARIOS, "scenario");
  const runs = Number.parseInt(parsed.values.runs, 10);
  const seed = Number.parseInt(parsed.values.seed, 10);
  const maxCasesPerScenario = Number.parseInt(parsed.values["max-cases-per-scenario"], 10);
  const concurrency = Number.parseInt(parsed.values.concurrency, 10);
  const progressEvery = Number.parseInt(parsed.values["progress-every"], 10);
  const timeoutMs = Number.parseInt(parsed.values["timeout-ms"], 10);
  if (!Number.isInteger(runs) || runs < 1) {
    throw new Error("--runs must be an integer greater than zero");
  }
  if (!Number.isInteger(seed)) {
    throw new Error("--seed must be an integer");
  }
  if (!Number.isInteger(maxCasesPerScenario) || maxCasesPerScenario < 1) {
    throw new Error("--max-cases-per-scenario must be an integer greater than zero");
  }
  if (!Number.isInteger(concurrency) || concurrency < 1) {
    throw new Error("--concurrency must be an integer greater than zero");
  }
  if (!Number.isInteger(progressEvery) || progressEvery < 0) {
    throw new Error("--progress-every must be a non-negative integer");
  }
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1000) {
    throw new Error("--timeout-ms must be an integer of at least 1000");
  }
  return {
    protocols,
    scenarios,
    runs,
    seed,
    maxCasesPerScenario,
    concurrency,
    progressEvery,
    timeoutMs,
    data: resolve(parsed.values.data ?? DEFAULT_DATASET_PATH),
    model: parsed.values.model,
    live: parsed.values.live,
    apiKey: process.env.OPENAI_API_KEY,
    json: parsed.values.json,
    jsonl: parsed.values.jsonl,
  };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  try {
    const args = cliArgs();
    const result = await runTier2TranscriptBenchmark(args);
    printSummary(result);
    if (args.json) {
      writeFileSync(args.json, `${JSON.stringify(result, null, 2)}\n`, "utf8");
    }
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
