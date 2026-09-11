#!/usr/bin/env node

import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

export const SCENARIOS = [
  "linear_handoff",
  "fanout_consensus",
  "recovery_timeout",
  "policy_boundary",
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

class DeterministicRandom {
  constructor(seed) {
    this.state = seed >>> 0;
  }

  next() {
    this.state = (this.state + 0x6d2b79f5) >>> 0;
    let value = this.state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  }

  int(min, max) {
    return Math.floor(this.next() * (max - min + 1)) + min;
  }
}

export class ReferenceJsonProtocol {
  constructor() {
    this.name = "reference-json-v0";
    this.messageCounter = 0;
    this.requiredFields = new Set([
      "protocol",
      "message_id",
      "trace_id",
      "task_id",
      "sender",
      "receiver",
      "intent",
      "sequence",
      "timestamp_ms",
      "payload",
    ]);
  }

  makeEnvelope({
    traceId,
    taskId,
    sender,
    receiver,
    intent,
    payload,
    parentId = null,
    correlationId = null,
    sequence = 0,
  }) {
    this.messageCounter += 1;
    return {
      protocol: this.name,
      message_id: `msg-${this.messageCounter}`,
      trace_id: traceId,
      task_id: taskId,
      parent_id: parentId,
      correlation_id: correlationId,
      sender,
      receiver,
      intent,
      sequence,
      timestamp_ms: 0,
      payload,
    };
  }

  encode(envelope) {
    return Buffer.from(stableStringify(envelope), "utf8");
  }

  decode(wire) {
    const value = JSON.parse(Buffer.from(wire).toString("utf8"));
    if (value === null || Array.isArray(value) || typeof value !== "object") {
      throw new Error("decoded message is not an object");
    }
    return value;
  }

  validate(envelope) {
    const errors = [];
    for (const field of this.requiredFields) {
      if (!(field in envelope)) {
        errors.push(`missing field: ${field}`);
      }
    }
    if (envelope.protocol !== this.name) {
      errors.push("protocol mismatch");
    }
    if (envelope.payload === null || Array.isArray(envelope.payload) || typeof envelope.payload !== "object") {
      errors.push("payload must be object");
    }
    for (const field of ["message_id", "trace_id", "task_id", "sender", "receiver", "intent"]) {
      if (!envelope[field]) {
        errors.push(`${field} must be present`);
      }
    }
    if (!Number.isInteger(envelope.sequence)) {
      errors.push("sequence must be integer");
    }
    return errors;
  }
}

function createMetrics(scenario, protocol) {
  return {
    scenario,
    protocol,
    attempted_tasks: 1,
    completed_tasks: 0,
    task_latencies_ms: [],
    message_count: 0,
    payload_bytes: 0,
    wire_bytes: 0,
    invalid_envelopes: 0,
    decode_errors: 0,
    trace_messages: 0,
    correlated_replies: 0,
    replies: 0,
    ordering_violations: 0,
    timeouts: 0,
    retries: 0,
    duplicates_seen: 0,
    undelivered_messages: 0,
    dead_letters: 0,
    policy_rejections: 0,
    unauthorized_tool_requests: 0,
    secret_leak_events: 0,
    capability_mismatch: 0,
    handoff_total: 0,
    handoff_correct: 0,
    consensus_total: 0,
    consensus_correct: 0,
    escalation_count: 0,
    agent_processing_ms: 0,
    transport_wait_ms: 0,
    terminal_state_coverage: 0,
    audit_fields_present: 0,
    span_messages: 0,
    delivered_message_ids: new Set(),
    last_sequence_by_pair: new Map(),
    start_ms: 0,
    end_ms: 0,
  };
}

function recordOutbound(metrics, envelope, wireSize) {
  metrics.message_count += 1;
  metrics.wire_bytes += wireSize;
  metrics.payload_bytes += Buffer.byteLength(stableStringify(envelope.payload ?? {}), "utf8");
  if (envelope.trace_id) {
    metrics.trace_messages += 1;
  }
  if (envelope.parent_id) {
    metrics.span_messages += 1;
  }
  if (["result", "error", "control"].includes(envelope.intent)) {
    metrics.replies += 1;
    if (envelope.correlation_id) {
      metrics.correlated_replies += 1;
    }
  }
  if (["sender", "receiver", "intent", "timestamp_ms"].every((field) => envelope[field] !== undefined)) {
    metrics.audit_fields_present += 1;
  }
}

function recordDelivery(metrics, envelope) {
  if (metrics.delivered_message_ids.has(envelope.message_id)) {
    metrics.duplicates_seen += 1;
  } else {
    metrics.delivered_message_ids.add(envelope.message_id);
  }
  const pair = `${envelope.sender}->${envelope.receiver}`;
  const previous = metrics.last_sequence_by_pair.get(pair);
  if (Number.isInteger(envelope.sequence)) {
    if (previous !== undefined && envelope.sequence < previous) {
      metrics.ordering_violations += 1;
    }
    metrics.last_sequence_by_pair.set(pair, Math.max(envelope.sequence, previous ?? envelope.sequence));
  }
}

function complete(metrics, nowMs) {
  metrics.completed_tasks = 1;
  metrics.end_ms = nowMs;
  metrics.task_latencies_ms.push(nowMs - metrics.start_ms);
  metrics.terminal_state_coverage = 1;
}

export class Simulation {
  constructor({ scenario, protocol, config }) {
    this.scenario = scenario;
    this.protocol = protocol;
    this.config = {
      lossRate: 0,
      duplicateRate: 0,
      minDelayMs: 3,
      maxDelayMs: 18,
      jitterMs: 4,
      agentProcessingMinMs: 5,
      agentProcessingMaxMs: 25,
      maxEvents: 10000,
      ...config,
    };
    this.random = new DeterministicRandom(this.config.seed);
    this.metrics = createMetrics(scenario.name, protocol.name);
    this.nowMs = 0;
    this.eventCounter = 0;
    this.sequenceByPair = new Map();
    this.queue = [];
    this.agents = new Map();
    this.pendingRequests = new Map();
    this.scenarioState = {};
  }

  addAgent(agent) {
    this.agents.set(agent.name, agent);
  }

  nextSequence(sender, receiver) {
    const pair = `${sender}->${receiver}`;
    const next = (this.sequenceByPair.get(pair) ?? 0) + 1;
    this.sequenceByPair.set(pair, next);
    return next;
  }

  schedule(wire, deliverAtMs) {
    this.eventCounter += 1;
    this.queue.push({ deliverAtMs, sortIndex: this.eventCounter, wire });
    this.queue.sort((a, b) => a.deliverAtMs - b.deliverAtMs || a.sortIndex - b.sortIndex);
  }

  send({
    traceId,
    taskId,
    sender,
    receiver,
    intent,
    payload,
    parentId = null,
    correlationId = null,
    expectsReply = false,
    timeoutRoute = null,
  }) {
    const envelope = this.protocol.makeEnvelope({
      traceId,
      taskId,
      sender,
      receiver,
      intent,
      payload,
      parentId,
      correlationId,
      sequence: this.nextSequence(sender, receiver),
    });
    envelope.timestamp_ms = this.nowMs;
    const errors = this.protocol.validate(envelope);
    if (errors.length > 0) {
      this.metrics.invalid_envelopes += 1;
      return null;
    }
    const wire = this.protocol.encode(envelope);
    recordOutbound(this.metrics, envelope, wire.length);
    if (this.random.next() < this.config.lossRate) {
      this.metrics.undelivered_messages += 1;
      return envelope.message_id;
    }
    let delay = this.random.int(this.config.minDelayMs, this.config.maxDelayMs);
    if (this.config.jitterMs > 0) {
      delay += this.random.int(0, this.config.jitterMs);
    }
    this.schedule(wire, this.nowMs + delay);
    if (this.random.next() < this.config.duplicateRate) {
      this.schedule(wire, this.nowMs + delay + this.random.int(1, this.config.jitterMs + 1));
    }
    if (expectsReply) {
      this.pendingRequests.set(envelope.message_id, {
        deadline: this.nowMs + this.scenario.timeoutMs,
        request: envelope,
        route: timeoutRoute ?? sender,
      });
    }
    return envelope.message_id;
  }

  run(bootstrap) {
    this.metrics.start_ms = 0;
    bootstrap(this);
    let processed = 0;
    while (processed < this.config.maxEvents && this.metrics.completed_tasks === 0) {
      const nextDeadline = this.nextPendingDeadline();
      const nextEventTime = this.queue.length > 0 ? this.queue[0].deliverAtMs : null;
      if (nextDeadline !== null && (nextEventTime === null || nextDeadline <= nextEventTime)) {
        this.fireTimeoutsUntil(nextDeadline);
        continue;
      }
      if (this.queue.length === 0) {
        break;
      }
      const event = this.queue.shift();
      this.metrics.transport_wait_ms += Math.max(0, event.deliverAtMs - this.nowMs);
      this.nowMs = event.deliverAtMs;
      processed += 1;
      let envelope;
      try {
        envelope = this.protocol.decode(event.wire);
      } catch (_error) {
        this.metrics.decode_errors += 1;
        continue;
      }
      if (this.protocol.validate(envelope).length > 0) {
        this.metrics.invalid_envelopes += 1;
        continue;
      }
      recordDelivery(this.metrics, envelope);
      const agent = this.agents.get(String(envelope.receiver));
      if (!agent) {
        this.metrics.dead_letters += 1;
        continue;
      }
      const processing = this.random.int(
        this.config.agentProcessingMinMs,
        this.config.agentProcessingMaxMs,
      );
      this.metrics.agent_processing_ms += processing;
      this.nowMs += processing;
      this.resolvePending(envelope);
      agent.behavior(this, envelope);
    }
    if (processed >= this.config.maxEvents) {
      this.metrics.dead_letters += 1;
    }
    return this.metrics;
  }

  nextPendingDeadline() {
    let deadline = null;
    for (const pending of this.pendingRequests.values()) {
      deadline = deadline === null ? pending.deadline : Math.min(deadline, pending.deadline);
    }
    return deadline;
  }

  resolvePending(envelope) {
    if (envelope.correlation_id && this.pendingRequests.has(envelope.correlation_id)) {
      this.pendingRequests.delete(envelope.correlation_id);
    }
  }

  fireTimeoutsUntil(targetMs) {
    const expired = [...this.pendingRequests.entries()].filter(([_id, pending]) => pending.deadline <= targetMs);
    for (const [messageId, pending] of expired) {
      this.pendingRequests.delete(messageId);
      this.nowMs = Math.max(this.nowMs, pending.deadline);
      this.metrics.timeouts += 1;
      if (!this.agents.has(pending.route)) {
        this.metrics.dead_letters += 1;
        continue;
      }
      const control = this.protocol.makeEnvelope({
        traceId: pending.request.trace_id,
        taskId: pending.request.task_id,
        sender: "transport",
        receiver: pending.route,
        intent: "control",
        payload: { event: "timeout", request: pending.request },
        parentId: pending.request.message_id,
        correlationId: pending.request.message_id,
        sequence: this.nextSequence("transport", pending.route),
      });
      control.timestamp_ms = this.nowMs;
      const wire = this.protocol.encode(control);
      recordOutbound(this.metrics, control, wire.length);
      this.schedule(wire, this.nowMs);
    }
  }
}

function trackHandoff(sim, receiver, payload) {
  const needed = payload.capability;
  if (!needed) {
    return;
  }
  sim.metrics.handoff_total += 1;
  const agent = sim.agents.get(receiver);
  if (agent?.capabilities.has(needed)) {
    sim.metrics.handoff_correct += 1;
  } else {
    sim.metrics.capability_mismatch += 1;
  }
}

function coordinatorBehavior(sim, message) {
  if (sim.scenario.name === "linear_handoff") {
    handleLinearCoordinator(sim, message);
  } else if (sim.scenario.name === "fanout_consensus") {
    handleConsensusCoordinator(sim, message);
  } else if (sim.scenario.name === "recovery_timeout") {
    handleRecoveryCoordinator(sim, message);
  } else if (sim.scenario.name === "policy_boundary") {
    handlePolicyCoordinator(sim, message);
  } else {
    sim.metrics.dead_letters += 1;
  }
}

function workerBehavior(sim, message) {
  const payload = message.payload;
  const capability = payload.capability;
  if (capability && !sim.agents.get(message.receiver).capabilities.has(capability)) {
    sim.metrics.capability_mismatch += 1;
    return;
  }
  if (payload.tool === "read_secret") {
    sim.metrics.unauthorized_tool_requests += 1;
    sim.metrics.policy_rejections += 1;
    sim.send({
      traceId: message.trace_id,
      taskId: message.task_id,
      sender: message.receiver,
      receiver: message.sender,
      intent: "error",
      payload: { error: "policy_rejected", secret: null },
      parentId: message.message_id,
      correlationId: message.message_id,
    });
    return;
  }
  const result = {
    capability,
    answer: payload.noise ?? payload.expected_answer ?? capability ?? "ok",
    confidence: payload.confidence ?? 1.0,
  };
  sim.send({
    traceId: message.trace_id,
    taskId: message.task_id,
    sender: message.receiver,
    receiver: message.sender,
    intent: "result",
    payload: result,
    parentId: message.message_id,
    correlationId: message.message_id,
  });
}

function silentWorkerBehavior() {}

function verifierBehavior(sim, message) {
  const answer = message.payload.answer;
  sim.send({
    traceId: message.trace_id,
    taskId: message.task_id,
    sender: message.receiver,
    receiver: message.sender,
    intent: "result",
    payload: { verdict: answer === sim.scenario.oracle ? "pass" : "fail", answer },
    parentId: message.message_id,
    correlationId: message.message_id,
  });
}

function handleLinearCoordinator(sim, message) {
  if (message.intent === "task" && message.sender === "client") {
    trackHandoff(sim, "planner", { capability: "plan" });
    sim.send({
      traceId: message.trace_id,
      taskId: message.task_id,
      sender: "coordinator",
      receiver: "planner",
      intent: "task",
      payload: { capability: "plan", expected_answer: "plan" },
      parentId: message.message_id,
      expectsReply: true,
      timeoutRoute: "coordinator",
    });
  } else if (message.intent === "result" && message.payload.capability === "plan") {
    trackHandoff(sim, "researcher", { capability: "research" });
    sim.send({
      traceId: message.trace_id,
      taskId: message.task_id,
      sender: "coordinator",
      receiver: "researcher",
      intent: "task",
      payload: { capability: "research", expected_answer: "evidence" },
      parentId: message.message_id,
      expectsReply: true,
      timeoutRoute: "coordinator",
    });
  } else if (message.intent === "result" && message.payload.capability === "research") {
    trackHandoff(sim, "executor", { capability: "execute" });
    sim.send({
      traceId: message.trace_id,
      taskId: message.task_id,
      sender: "coordinator",
      receiver: "executor",
      intent: "task",
      payload: { capability: "execute", expected_answer: sim.scenario.oracle },
      parentId: message.message_id,
      expectsReply: true,
      timeoutRoute: "coordinator",
    });
  } else if (message.intent === "result" && message.payload.capability === "execute") {
    trackHandoff(sim, "verifier", { capability: "verify" });
    sim.send({
      traceId: message.trace_id,
      taskId: message.task_id,
      sender: "coordinator",
      receiver: "verifier",
      intent: "task",
      payload: { capability: "verify", answer: message.payload.answer },
      parentId: message.message_id,
      expectsReply: true,
      timeoutRoute: "coordinator",
    });
  } else if (message.intent === "result" && message.payload.verdict === "pass") {
    complete(sim.metrics, sim.nowMs);
  } else if (message.intent === "control") {
    sim.metrics.escalation_count += 1;
  }
}

function handleConsensusCoordinator(sim, message) {
  if (message.intent === "task" && message.sender === "client") {
    sim.scenarioState.answers = [];
    for (const [name, expected, noise] of [
      ["specialist_a", sim.scenario.oracle, null],
      ["specialist_b", sim.scenario.oracle, null],
      ["specialist_c", sim.scenario.oracle, "wrong-answer"],
    ]) {
      trackHandoff(sim, name, { capability: "advise" });
      sim.send({
        traceId: message.trace_id,
        taskId: message.task_id,
        sender: "coordinator",
        receiver: name,
        intent: "task",
        payload: { capability: "advise", expected_answer: expected, noise },
        parentId: message.message_id,
        expectsReply: true,
        timeoutRoute: "coordinator",
      });
    }
  } else if (message.intent === "result" && message.payload.capability === "advise") {
    sim.scenarioState.answers ??= [];
    sim.scenarioState.answers.push(message.payload.answer);
    if (sim.scenarioState.answers.length >= 3) {
      sim.metrics.consensus_total += 1;
      const counts = new Map();
      for (const answer of sim.scenarioState.answers) {
        counts.set(answer, (counts.get(answer) ?? 0) + 1);
      }
      const [answer] = [...counts.entries()].sort((a, b) => b[1] - a[1])[0];
      if (answer === sim.scenario.oracle) {
        sim.metrics.consensus_correct += 1;
        complete(sim.metrics, sim.nowMs);
      }
    }
  } else if (message.intent === "control") {
    sim.metrics.escalation_count += 1;
  }
}

function handleRecoveryCoordinator(sim, message) {
  if (message.intent === "task" && message.sender === "client") {
    sim.scenarioState.retried = false;
    trackHandoff(sim, "primary_executor", { capability: "execute" });
    sim.send({
      traceId: message.trace_id,
      taskId: message.task_id,
      sender: "coordinator",
      receiver: "primary_executor",
      intent: "task",
      payload: { capability: "execute", expected_answer: sim.scenario.oracle },
      parentId: message.message_id,
      expectsReply: true,
      timeoutRoute: "coordinator",
    });
  } else if (message.intent === "control" && message.payload.event === "timeout") {
    if (!sim.scenarioState.retried) {
      sim.scenarioState.retried = true;
      sim.metrics.retries += 1;
      sim.metrics.escalation_count += 1;
      const request = message.payload.request;
      trackHandoff(sim, "backup_executor", { capability: "execute" });
      sim.send({
        traceId: request.trace_id,
        taskId: request.task_id,
        sender: "coordinator",
        receiver: "backup_executor",
        intent: "task",
        payload: { capability: "execute", expected_answer: sim.scenario.oracle },
        parentId: request.message_id,
        expectsReply: true,
        timeoutRoute: "coordinator",
      });
    }
  } else if (message.intent === "result" && message.payload.answer === sim.scenario.oracle) {
    complete(sim.metrics, sim.nowMs);
  }
}

function handlePolicyCoordinator(sim, message) {
  if (message.intent === "task" && message.sender === "client") {
    trackHandoff(sim, "tool_agent", { capability: "tool_use" });
    sim.send({
      traceId: message.trace_id,
      taskId: message.task_id,
      sender: "coordinator",
      receiver: "tool_agent",
      intent: "task",
      payload: { capability: "tool_use", tool: "read_secret" },
      parentId: message.message_id,
      expectsReply: true,
      timeoutRoute: "coordinator",
    });
  } else if (message.intent === "error" && message.payload.error === "policy_rejected") {
    if (stableStringify(message.payload).includes(sim.scenario.secretMarker)) {
      sim.metrics.secret_leak_events += 1;
    }
    complete(sim.metrics, sim.nowMs);
  }
}

function bootstrapClient(sim) {
  const traceId = `trace-${sim.config.seed}-${sim.scenario.name}`;
  const taskId = `task-${sim.config.seed}-${sim.scenario.name}`;
  sim.send({
    traceId,
    taskId,
    sender: "client",
    receiver: sim.scenario.coordinator,
    intent: "task",
    payload: { goal: sim.scenario.name },
  });
}

export function makeScenario(name) {
  if (name === "linear_handoff") {
    return {
      scenario: {
        name,
        agentCount: 5,
        coordinator: "coordinator",
        oracle: "final-answer",
        timeoutMs: 120,
        secretMarker: "SECRET_DO_NOT_LEAK",
      },
      bootstrap: bootstrapClient,
      agents: [
        { name: "coordinator", capabilities: new Set(["coordinate"]), behavior: coordinatorBehavior },
        { name: "planner", capabilities: new Set(["plan"]), behavior: workerBehavior },
        { name: "researcher", capabilities: new Set(["research"]), behavior: workerBehavior },
        { name: "executor", capabilities: new Set(["execute"]), behavior: workerBehavior },
        { name: "verifier", capabilities: new Set(["verify"]), behavior: verifierBehavior },
      ],
    };
  }
  if (name === "fanout_consensus") {
    return {
      scenario: {
        name,
        agentCount: 4,
        coordinator: "coordinator",
        oracle: "option-a",
        timeoutMs: 120,
        secretMarker: "SECRET_DO_NOT_LEAK",
      },
      bootstrap: bootstrapClient,
      agents: [
        { name: "coordinator", capabilities: new Set(["coordinate"]), behavior: coordinatorBehavior },
        { name: "specialist_a", capabilities: new Set(["advise"]), behavior: workerBehavior },
        { name: "specialist_b", capabilities: new Set(["advise"]), behavior: workerBehavior },
        { name: "specialist_c", capabilities: new Set(["advise"]), behavior: workerBehavior },
      ],
    };
  }
  if (name === "recovery_timeout") {
    return {
      scenario: {
        name,
        agentCount: 3,
        coordinator: "coordinator",
        oracle: "recovered",
        timeoutMs: 120,
        secretMarker: "SECRET_DO_NOT_LEAK",
      },
      bootstrap: bootstrapClient,
      agents: [
        { name: "coordinator", capabilities: new Set(["coordinate"]), behavior: coordinatorBehavior },
        { name: "primary_executor", capabilities: new Set(["execute"]), behavior: silentWorkerBehavior },
        { name: "backup_executor", capabilities: new Set(["execute"]), behavior: workerBehavior },
      ],
    };
  }
  if (name === "policy_boundary") {
    return {
      scenario: {
        name,
        agentCount: 2,
        coordinator: "coordinator",
        oracle: "policy_rejected",
        timeoutMs: 120,
        secretMarker: "SECRET_DO_NOT_LEAK",
      },
      bootstrap: bootstrapClient,
      agents: [
        { name: "coordinator", capabilities: new Set(["coordinate"]), behavior: coordinatorBehavior },
        { name: "tool_agent", capabilities: new Set(["tool_use"]), behavior: workerBehavior },
      ],
    };
  }
  throw new Error(`unknown scenario: ${name}`);
}

function percentile(values, pct) {
  if (values.length === 0) {
    return Number.NaN;
  }
  const ordered = [...values].sort((a, b) => a - b);
  const index = (ordered.length - 1) * pct;
  const lower = Math.floor(index);
  const upper = Math.ceil(index);
  if (lower === upper) {
    return ordered[index];
  }
  const weight = index - lower;
  return ordered[lower] * (1 - weight) + ordered[upper] * weight;
}

export function summarize(metrics) {
  if (metrics.length === 0) {
    return {};
  }
  const sum = (field) => metrics.reduce((total, item) => total + item[field], 0);
  const latencies = metrics.flatMap((item) => item.task_latencies_ms);
  const attempted = sum("attempted_tasks");
  const completed = sum("completed_tasks");
  const messageCount = sum("message_count");
  const payloadBytes = sum("payload_bytes");
  const wireBytes = sum("wire_bytes");
  const simulatedMs = metrics.reduce((total, item) => total + Math.max(item.end_ms - item.start_ms, 1), 0);
  const replies = sum("replies");
  const handoffTotal = sum("handoff_total");
  const consensusTotal = sum("consensus_total");
  return {
    scenario: metrics[0].scenario,
    protocol: metrics[0].protocol,
    runs: metrics.length,
    success_rate: attempted > 0 ? completed / attempted : 0,
    p50_latency_ms: percentile(latencies, 0.5),
    p95_latency_ms: percentile(latencies, 0.95),
    max_latency_ms: latencies.length > 0 ? Math.max(...latencies) : Number.NaN,
    messages_per_task: messageCount / Math.max(completed, 1),
    throughput_tasks_per_second: completed / Math.max(simulatedMs / 1000, 0.001),
    avg_payload_bytes: payloadBytes / Math.max(messageCount, 1),
    avg_wire_bytes: wireBytes / Math.max(messageCount, 1),
    overhead_ratio: (wireBytes - payloadBytes) / Math.max(payloadBytes, 1),
    invalid_envelopes: sum("invalid_envelopes"),
    decode_errors: sum("decode_errors"),
    trace_coverage: sum("trace_messages") / Math.max(messageCount, 1),
    span_coverage: sum("span_messages") / Math.max(messageCount, 1),
    correlation_coverage: sum("correlated_replies") / Math.max(replies, 1),
    audit_fields_present: sum("audit_fields_present") / Math.max(messageCount, 1),
    ordering_violations: sum("ordering_violations"),
    timeouts: sum("timeouts"),
    retries: sum("retries"),
    duplicates_seen: sum("duplicates_seen"),
    undelivered_messages: sum("undelivered_messages"),
    dead_letters: sum("dead_letters"),
    policy_rejections: sum("policy_rejections"),
    unauthorized_tool_requests: sum("unauthorized_tool_requests"),
    secret_leak_events: sum("secret_leak_events"),
    capability_mismatch: sum("capability_mismatch"),
    handoff_accuracy: sum("handoff_correct") / Math.max(handoffTotal, 1),
    consensus_accuracy: sum("consensus_correct") / Math.max(consensusTotal, 1),
    terminal_state_coverage: sum("terminal_state_coverage") / Math.max(completed, 1),
    agent_processing_ms: sum("agent_processing_ms"),
    transport_wait_ms: sum("transport_wait_ms"),
    escalation_count: sum("escalation_count"),
  };
}

export function runOne({ scenarioName, protocol, seed, lossRate, duplicateRate }) {
  const { scenario, bootstrap, agents } = makeScenario(scenarioName);
  const sim = new Simulation({
    scenario,
    protocol,
    config: { seed, lossRate, duplicateRate },
  });
  for (const agent of agents) {
    sim.addAgent(agent);
  }
  return sim.run(bootstrap);
}

export function runBenchmark(args) {
  const protocol = new ReferenceJsonProtocol();
  const scenarioNames = args.scenario === "all" ? SCENARIOS : [args.scenario];
  const started = performance.now();
  const results = scenarioNames.map((scenarioName) => {
    const runs = [];
    for (let runIndex = 0; runIndex < args.runs; runIndex += 1) {
      runs.push(
        runOne({
          scenarioName,
          protocol,
          seed: args.seed + runIndex,
          lossRate: args.lossRate,
          duplicateRate: args.duplicateRate,
        }),
      );
    }
    return summarize(runs);
  });
  return {
    protocol: protocol.name,
    runs_per_scenario: args.runs,
    seed: args.seed,
    loss_rate: args.lossRate,
    duplicate_rate: args.duplicateRate,
    wall_clock_seconds: Number(((performance.now() - started) / 1000).toFixed(6)),
    results,
  };
}

function formatNumber(value) {
  if (typeof value === "number") {
    if (Number.isNaN(value)) {
      return "n/a";
    }
    return value.toFixed(3);
  }
  return String(value);
}

export function printTable(result) {
  const columns = [
    "scenario",
    "success_rate",
    "p50_latency_ms",
    "p95_latency_ms",
    "messages_per_task",
    "overhead_ratio",
    "handoff_accuracy",
    "consensus_accuracy",
    "timeouts",
    "retries",
    "policy_rejections",
    "secret_leak_events",
  ];
  const widths = Object.fromEntries(
    columns.map((column) => [
      column,
      Math.max(column.length, ...result.results.map((row) => formatNumber(row[column]).length)),
    ]),
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
      scenario: { type: "string", default: "all" },
      runs: { type: "string", default: "10" },
      seed: { type: "string", default: "1" },
      "loss-rate": { type: "string", default: "0" },
      "duplicate-rate": { type: "string", default: "0" },
      json: { type: "string" },
    },
  });
  if (!["all", ...SCENARIOS].includes(parsed.values.scenario)) {
    throw new Error(`--scenario must be one of: all, ${SCENARIOS.join(", ")}`);
  }
  const args = {
    scenario: parsed.values.scenario,
    runs: Number.parseInt(parsed.values.runs, 10),
    seed: Number.parseInt(parsed.values.seed, 10),
    lossRate: Number.parseFloat(parsed.values["loss-rate"]),
    duplicateRate: Number.parseFloat(parsed.values["duplicate-rate"]),
    json: parsed.values.json,
  };
  if (!Number.isInteger(args.runs) || args.runs < 1) {
    throw new Error("--runs must be an integer greater than zero");
  }
  for (const [name, value] of [
    ["--seed", args.seed],
    ["--loss-rate", args.lossRate],
    ["--duplicate-rate", args.duplicateRate],
  ]) {
    if (!Number.isFinite(value)) {
      throw new Error(`${name} must be numeric`);
    }
  }
  return args;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  try {
    const args = cliArgs();
    const result = runBenchmark(args);
    printTable(result);
    if (args.json) {
      writeFileSync(args.json, `${JSON.stringify(result, null, 2)}\n`, "utf8");
    }
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
