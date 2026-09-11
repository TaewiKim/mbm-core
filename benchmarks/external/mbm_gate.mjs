// Standalone message-bound memory gate for wrapping EXTERNAL agent benchmarks (E16/E17/E18).
// Mirrors benchmarks/coupled_memory/runtime.mjs::evaluateMemoryGate, with no SQLite dependency so it
// can wrap any external store. Provenance is checked against the active message's DIRECTED causal
// ancestor closure (review M4/M7) -- NOT a flat Set of all known message ids. Callers must build the
// closure with the shared implementation via `ancestorClosureFor(messages, activeMessage)` below, so
// the wrapper enforces the same happens-before semantics as the central runtime.
//
// Conjunctive: a record is admitted iff every check passes. To keep the external wrapper's claim
// "same checks, same reason codes" TRUE (review M7), this mirrors runtime.evaluateMemoryGate exactly:
// the SAME check order, the SAME deny defaults (a record missing `status` or `allowed_readers` is
// DENIED, not silently allowed), a two-stage provenance check (source must exist AND lie in the
// causal closure), and the SAME content-integrity check on read. The only difference is the absence
// of a SQLite handle: the caller supplies the candidate set, the known message ids, and the closure.
import { causalAncestryFromMessages } from "../coupled_memory/causal.mjs";
import { memoryContentHash, verifyWriteReceipt } from "../coupled_memory/hash.mjs";

// Build the active message's causal ancestor closure (the only valid `eventGraph` to pass below).
export function ancestorClosureFor(messages, activeMessage) {
  return causalAncestryFromMessages(messages, activeMessage);
}

// opts.knownMessageIds (Set) lets the wrapper reproduce the central runtime's referential-integrity
// stage (source message must exist). When omitted, the closure membership subsumes existence.
export function evaluateMemoryGateStandalone(memory, currentMessage, { eventGraph, intentMemoryTypes, knownMessageIds, attestationKey, verifyReceipt, secure = false } = {}) {
  // Content integrity (mirror central): a record whose content no longer matches its write-time hash.
  if (memory.audit_hash && memoryContentHash(memory) !== memory.audit_hash) {
    return { decision: "deny", reason: "integrity_mismatch" };
  }
  // Secure mode requires an integrity hash to be present at all (review M3: no hash -> deny).
  if (secure && !memory.audit_hash) {
    return { decision: "deny", reason: "integrity_missing" };
  }
  // Write-time attestation (review M1/M7.1): when the wrapper is given the trusted control plane's
  // receipt verifier (`verifyReceipt`), a record must carry a valid receipt minted by that plane --
  // so a store-injected record that declares even a GENUINE, reachable ancestor is denied. The legacy
  // `attestationKey` string path is kept only for older fixtures.
  if (verifyReceipt) {
    if (!verifyReceipt(memory)) return { decision: "deny", reason: "provenance_not_attested" };
  } else if (attestationKey != null && !verifyWriteReceipt(memory, attestationKey)) {
    return { decision: "deny", reason: "provenance_not_attested" };
  }
  if (memory.run_id !== currentMessage.run_id) {
    return { decision: "deny", reason: "run_id_mismatch" };
  }
  const taskMatches = memory.task_id === currentMessage.task_id || ["run", "global"].includes(memory.scope);
  if (!taskMatches) {
    return { decision: "deny", reason: "task_scope_mismatch" };
  }
  // Deny when status is absent or not active (central denies a missing status -> inactive_memory).
  if (memory.status !== "active") {
    return { decision: "deny", reason: "inactive_memory" };
  }
  // Provenance: source message must EXIST and lie in the causal closure. Parity with the central
  // runtime (review M3): a record with NO source_message_id is denied (central's getMessage(undefined)
  // returns null -> missing_provenance_message), not silently allowed.
  if (!memory.source_message_id) {
    return { decision: "deny", reason: "missing_provenance_message" };
  }
  if (knownMessageIds && !knownMessageIds.has(memory.source_message_id)) {
    return { decision: "deny", reason: "missing_provenance_message" };
  }
  if (eventGraph && memory.source_message_id && !eventGraph.has(memory.source_message_id)) {
    return { decision: "deny", reason: "provenance_not_in_causal_graph" };
  }
  // Deny when allowed_readers is absent or does not include the receiver (no wildcard default).
  const allowedReaders = new Set(memory.allowed_readers ?? []);
  if (!allowedReaders.has("*") && !allowedReaders.has(currentMessage.receiver)) {
    return { decision: "deny", reason: "reader_not_authorized" };
  }
  // Own-property guard (parity with the central runtime): a prototype-member intent must resolve to undefined,
  // not a truthy inherited member that would skip the fail-closed deny and then throw on `.has()`. Robust even
  // if a caller passes a plain (non-null-prototype) intentMemoryTypes map.
  const allowedTypes = intentMemoryTypes && Object.hasOwn(intentMemoryTypes, currentMessage.intent)
    ? intentMemoryTypes[currentMessage.intent] : undefined;
  // Secure mode fails closed on lifecycle ambiguity, matching the central runtime (review M2/M3).
  if (secure && !allowedTypes) {
    return { decision: "deny", reason: "intent_unknown" };
  }
  if (allowedTypes && !allowedTypes.has(memory.memory_type)) {
    return { decision: "deny", reason: "intent_memory_type_mismatch" };
  }
  if (secure && !memory.policy_context) {
    return { decision: "deny", reason: "policy_context_missing" };
  }
  if (memory.policy_context && memory.policy_context !== currentMessage.policy_context) {
    return { decision: "deny", reason: "policy_context_mismatch" };
  }
  return { decision: "allow", reason: "message_bound_access_granted" };
}

// Generic wrapper: given an external benchmark's raw memory/context read (returning candidate records
// stamped with run/task/status/provenance/reader/policy metadata) and the active message, return only
// admitted records. Drop-in around a framework's checkpoint/store or conversation-memory read.
export function wrapMemoryRead(rawRead, opts = {}) {
  return (currentMessage, ...args) => {
    const candidates = rawRead(currentMessage, ...args) || [];
    const admitted = [];
    const audit = [];
    for (const memory of candidates) {
      const { decision, reason } = evaluateMemoryGateStandalone(memory, currentMessage, opts);
      audit.push({ memory_id: memory.memory_id, decision, reason });
      if (decision === "allow") admitted.push(memory);
    }
    return { admitted, audit };
  };
}
