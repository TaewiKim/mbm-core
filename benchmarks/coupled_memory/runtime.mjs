import { randomUUID, createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";

import {
  CONDITION_FEATURES,
  INTENT_MEMORY_TYPES,
  REQUIRED_ENVELOPE_FIELDS,
} from "./constants.mjs";
import { COUPLED_MEMORY_SCHEMA, KERNEL_SCHEMA, KERNEL_TABLES } from "./schema.mjs";
import { causalAncestryFromMessages, verifyCausalEdge, verifiedCausalClosure } from "./causal.mjs";
import { canonicalMemoryForHash, memoryContentHash, memoryWriteReceipt, verifyWriteReceipt } from "./hash.mjs";
import { ControlPlane, integrityLevel } from "./control_plane.mjs";

function nowIso() {
  return new Date().toISOString();
}

// Canonical action serializer (security-kernel exact-action binding). Two actions that differ in ANY
// security-relevant field -- tool, effect class, target/recipient, parameters, data classification -- get
// DIFFERENT digests, so the kernel authorizes and dispatches exactly one canonical action and a parameter
// swap (same effect class, different recipient) cannot be laundered through one authorization. Stable key
// order is enforced recursively so JSON key ordering cannot change the digest. The serializer is part of the
// TCB; URL/path/Unicode normalization of individual fields is a deployment-policy responsibility (stated).
// Prototype-safe canonicalization (review v18 P0-3): a plain `{}` with `out["__proto__"]=v` triggers the
// inherited prototype SETTER, making a value INHERITED (visible to a dispatcher reading the object) yet ABSENT
// from JSON.stringify/the digest -- so H(logged) != H(dispatched). FIX: emit a NULL-prototype object (no
// inherited setter) AND drop the prototype-poisoning keys entirely, so a key can never become inherited.
const POISON_KEYS = new Set(["__proto__", "prototype", "constructor"]);
function canonicalize(value) {
  // (v19 #5) DEEP-FREEZE the output so the canonical action handed to the destination policy and the trusted
  // dispatcher is immutable: a policy callback (or a TCB-internal bug) cannot mutate parameters AFTER the digest
  // is computed, so the hashed/audited action is byte-identical to the dispatched one (exact-effective-action).
  if (Array.isArray(value)) return Object.freeze(value.map(canonicalize));
  if (value && typeof value === "object") {
    const out = Object.create(null);
    for (const k of Object.keys(value).sort()) {
      if (POISON_KEYS.has(k)) continue;            // never hash or carry a prototype-poisoning key
      out[k] = canonicalize(value[k]);
    }
    return Object.freeze(out);
  }
  return value;
}
function canonicalAction(action) {
  const a = action ?? {};
  const norm = {
    tool: typeof a.tool === "string" ? a.tool : null,   // never dispatch a non-string (array/object) tool
    effect: typeof a.effect === "string" ? a.effect : "external",
    target: a.target ?? a.recipient ?? null,
    parameters: a.parameters ?? a.params ?? {},
    classification: a.classification ?? null,
  };
  // Canonicalize ONCE; the SAME object is both hashed and handed to the dispatcher, so the dispatcher cannot
  // read a value (e.g. an inherited body) that is absent from the digest/audit log.
  const canonical = canonicalize(norm);
  const json = JSON.stringify(canonical);
  return { canonical, json, digest: createHash("sha256").update(json).digest("hex") };
}
// Default trusted dispatcher: holds the tool-execution capability that the data-plane facade never exposes.
// In this in-process prototype it records the dispatched action; a deployment binds real tool/network
// credentials here, in a separate process/service the agent cannot call directly (deployment requirement).
function defaultTrustedDispatcher() {
  const log = [];
  return {
    dispatch(canonical, meta) { log.push({ canonical, meta }); return { ok: true, tool: canonical.tool, effect: canonical.effect }; },
    log,
  };
}

// Trusted tool registry (security kernel): the TCB, NOT the caller, decides a tool's effect class, whether it
// is an external (consequential) effect, and which parameter names a destination -- so a caller cannot relabel
// a wire_transfer as effect="read" to dodge empty-view bottom (the externality is registry-derived). An
// UNKNOWN tool is treated, fail-closed, as a consequential external effect. A deployment supplies the full
// registry + parameter schema/ACL; this models the boundary.
// NULL-PROTOTYPE registry: a plain object literal would let a tool named "constructor"/"toString"/"__proto__"
// resolve to an inherited Object.prototype member, defeating the lookup (red-team finding). Object.create(null)
// + an own-property guard in resolveTool makes any such name fall through to the fail-closed unknown branch.
const TOOL_REGISTRY = Object.assign(Object.create(null), {
  notify:        { effect: "send",      external: true,  target: "to",     minimum_integrity: "task" },
  send_email:    { effect: "send",      external: true,  target: "to",     minimum_integrity: "task" },
  send:          { effect: "send",      external: true,  target: "to",     minimum_integrity: "task" },
  wire_transfer: { effect: "transfer",  external: true,  target: "to",     minimum_integrity: "system" },
  delete_file:   { effect: "delete",    external: true,  target: "path",   minimum_integrity: "system" },
  deploy:        { effect: "deploy",    external: true,  target: "target", minimum_integrity: "system" },
  answer:        { effect: "answer",    external: false, minimum_integrity: "untrusted" },
  summarize:     { effect: "summarize", external: false, minimum_integrity: "untrusted" },
});
// EVERY external (consequential) effect is fail-closed for dispatch -- known sends (send/notify/send_email),
// known high-consequence effects (transfer/delete/deploy), AND unknown tools (the TCB has no entry, so the
// kernel cannot reason about them) all dispatch ONLY if the deployment destinationPolicy authorizes the exact
// (tool, target). There is NO weaker "low-consequence" tier: the kernel does not auto-bind+audit sends, and it
// does not branch on an effect-risk classification (an earlier HIGH_RISK_EFFECTS set was dead code -- removed).
// DEPLOYER WARNING: effect CLASS is too coarse to authorize on by itself. send_email (arbitrary external
// recipient + body, data-exfiltration-capable) and notify (internal status ping) share effect="send", so a
// destinationPolicy of the form `tool.effect === "send"` authorizes exfiltration. Discriminate on the resolved
// tool NAME and target (both are on the object handed to the policy), not on the effect class. Full
// per-parameter policy is a deployment responsibility.
const NON_EXTERNAL_LABELS = new Set(["read", "answer", "summarize", "request_clarification", "request_resolution", "abort"]);
function resolveTool(frozenAction) {
  const raw = frozenAction.tool;
  // A tool field PRESENT but not a string (array/object/number) is malformed/adversarial -- it would dodge the
  // string-keyed registry yet be dispatched verbatim, so FAIL CLOSED (external, denied as malformed).
  if (raw != null && typeof raw !== "string") return { tool: null, effect: "external", external: true, target: null, known: false, malformed: true };
  const tool = typeof raw === "string" ? raw : null;
  const reg = tool != null && Object.hasOwn(TOOL_REGISTRY, tool) ? TOOL_REGISTRY[tool] : null;
  if (reg) {
    // Read the destination from the SAME merged source canonicalAction dispatches/audits
    // (`parameters ?? params`). A caller that supplies the recipient under the `params` alias would
    // otherwise leave tool.target=null while a REAL recipient is canonicalized and dispatched -- and the
    // DEPLOYER WARNING above tells policies to key on the resolved tool.target, so a null convenience field
    // sitting beside a live dispatched recipient is a footgun. Same precedence as canonicalAction so the
    // target the policy sees always equals the target the kernel dispatches/audits.
    const params = frozenAction.parameters ?? frozenAction.params;
    // (round-4) Resolve the target with the EXACT precedence canonicalAction uses for dispatch/audit, so the
    // target the policy sees (tool.target) is always the target the kernel dispatches and records. Beyond the
    // registry sub-key (parameters.to) this also honors a TOP-LEVEL target/recipient: a caller that put the
    // recipient top-level (no parameters.to) otherwise left tool.target=null while canonicalAction's
    // `a.target ?? a.recipient` still dispatched/audited it -- so the policy authorized a null target while an
    // attacker recipient was dispatched. Now they cannot diverge.
    const tgt = reg.target ? (params?.[reg.target] ?? null) : null;
    return { tool, effect: reg.effect, external: reg.external,
      target: tgt ?? frozenAction.target ?? frozenAction.recipient ?? null,
      minimum_integrity: reg.minimum_integrity ?? "untrusted", known: true, malformed: false };
  }
  // A NAMED unknown tool is external with a SENTINEL effect: the caller's effect label is NOT trusted to set
  // the effect CLASS for a tool the TCB never registered (else a relabel transfer->send fools a policy). A
  // tool-less action is external unless its effect label is an explicitly non-external class (read/answer/...).
  if (tool != null) return { tool, effect: "external", external: true, target: null, minimum_integrity: "system", known: false, malformed: false };
  const eff = typeof frozenAction.effect === "string" ? frozenAction.effect : "external";
  return { tool: null, effect: eff, external: !NON_EXTERNAL_LABELS.has(eff), target: null,
    minimum_integrity: NON_EXTERNAL_LABELS.has(eff) ? "untrusted" : "system", known: false, malformed: false };
}
// Deep-copy the caller action to plain JSON and FREEZE it ONCE, so a getter/proxy cannot return one value at
// the authorization check and another at canonicalization/dispatch (a TOCTOU on the action object). Every
// subsequent read uses the frozen plain object.
function freezeAction(action) {
  let plain; try { plain = JSON.parse(JSON.stringify(action ?? {})); } catch { plain = {}; }
  return Object.freeze(plain);
}

function asJson(value) {
  return JSON.stringify(value ?? {});
}

function parseJson(value, fallback) {
  if (value == null || value === "") {
    return fallback;
  }
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

// Content-integrity hashing lives in a SQLite-free module so the external gate can share it (M7);
// re-exported here to keep the existing public API stable.
export { canonicalMemoryForHash, memoryContentHash, memoryWriteReceipt, verifyWriteReceipt };
export { ControlPlane };

function requireEnvelope(envelope) {
  for (const field of REQUIRED_ENVELOPE_FIELDS) {
    if (envelope?.[field] == null || envelope[field] === "") {
      throw new Error(`missing envelope field: ${field}`);
    }
  }
  // (v20 red-team) The sequence is a NUMERIC causal clock: it bounds record-scoped adoption (\_adoptedRecords)
  // and orders causal edges (causal.mjs clockOf). A non-numeric sequence (e.g. "zzz") was previously accepted
  // and signed, then coerced with Number(...)=NaN -- making an adopt node's bound Infinity (adopt everything)
  // and letting a far-future created_at win edge ordering. Require a finite non-negative integer so the clock
  // cannot be poisoned at the source.
  if (envelope?.sequence != null) {
    const s = Number(envelope.sequence);
    if (!Number.isInteger(s) || s < 0) throw new Error(`envelope sequence must be a non-negative integer: ${envelope.sequence}`);
  }
}

// Security-relevant fields that define the authorization context of an active message. A caller may
// not assert a value for any of these that conflicts with the persisted envelope (review M1):
// otherwise, knowing one message_id would let an attacker forge run/task/receiver/policy/causal-parent
// and read protected memory under a different principal. We compare CANONICAL (persisted) vs supplied.
const SECURITY_ENVELOPE_FIELDS = [
  "run_id", "task_id", "trace_id", "receiver", "intent",
  "policy_context", "parent_message_id", "delegated_from", "sequence",
];

// Fields where the SUPPLIED object asserts a non-null value that differs from the canonical envelope.
// A null/absent supplied field is not a conflict (the canonical value is authoritative regardless), so
// honest callers passing partial envelopes are unaffected while any forged value is caught.
function envelopeConflicts(supplied, canonical) {
  const conflicts = [];
  for (const f of SECURITY_ENVELOPE_FIELDS) {
    const s = supplied?.[f] ?? null;
    const c = canonical?.[f] ?? null;
    if (s !== null && s !== c) conflicts.push(f);
  }
  return conflicts;
}

function memoryFromRow(row) {
  if (!row) {
    return null;
  }
  const m = {
    memory_id: row.memory_id,
    run_id: row.run_id,
    task_id: row.task_id,
    trace_id: row.trace_id,
    source_message_id: row.source_message_id,
    writer: row.writer,
    memory_type: row.memory_type,
    scope: row.scope,
    status: row.status,
    content: row.content,
    content_ref: row.content_ref,
    allowed_readers: parseJson(row.allowed_readers_json, []),
    supersedes: parseJson(row.supersedes_json, []),
    valid_from_event: row.valid_from_event,
    valid_until_event: row.valid_until_event,
    policy_context: row.policy_context,
    audit_hash: row.audit_hash,
    write_receipt: row.write_receipt,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
  // Frozen write-time integrity is present ONLY on secure-path records; include it only when non-null so
  // records written without it hash identically (content hash is generic over own fields).
  if (row.integrity != null) m.integrity = row.integrity;
  // Logical decision key (Gate 2.0) -- same conditional treatment so records without it hash identically.
  if (row.logical_key != null) m.logical_key = row.logical_key;
  // Effect ceiling (Gate 2.0 #4): allowed effect classes; conditional + JSON so records without it hash identically.
  if (row.effect_ceiling != null) m.effect_ceiling = parseJson(row.effect_ceiling, null);
  // (v20 CE20-00/01) Write-event causal position + input frontier; conditional so legacy records hash identically.
  if (row.write_seq != null) m.write_seq = row.write_seq;
  if (row.input_frontier_json != null) m.input_frontier = parseJson(row.input_frontier_json, []);
  return m;
}

// Base runtime: the BENCHMARK substrate that hosts the conventional-defense baselines and the C0--C5
// ablations. It deliberately exposes ablation hooks (condition, controlNoGate, gateOptions) and trusts
// a writer-declared `status` string -- these are the weaker comparators C5 is measured against, NOT
// the production reference monitor. The enforced reference monitor is SecureMemoryRuntime below: it
// requires authenticated leases, mints/verifies receipts via the trusted control plane, computes
// retirement from the authoritative lifecycle log, and exposes NO bypass option (review M3). Keeping
// the two classes separate is what lets the artifact run baselines and the strict monitor in one
// process without the monitor inheriting the baselines' bypass surface.
export class CoupledMemoryRuntime {
  constructor({ dbPath = ":memory:", kernelDbPath = null } = {}) {
    this.db = new DatabaseSync(dbPath);
    // (v19 P1) TRUSTED/UNTRUSTED store split: the kernel-state tables (consumption, decision versions, MAC-chain
    // anchor heads, action outbox) live in a SEPARATE attached `kernel` DB -- a distinct protected file in a
    // deployment, a private in-memory DB by default -- so a store-write adversary holding only the untrusted
    // memory DB file cannot read, delete, or roll back them. EVERY kernel-state access is FULLY QUALIFIED as
    // kernel.<table> (round-9 red-team: relying on unqualified-name resolution + a one-time main DROP was
    // bypassable -- a memory-file adversary could re-create a main shadow mid-run, which SQLite resolves BEFORE
    // attached DBs, relocating the one-shot/idempotency state into adversary storage; qualifying the names makes
    // any such shadow inert). We also DROP the boot-time main copies (defense in depth). One BEGIN IMMEDIATE still
    // spans both DBs atomically (the row+membership+anchor write stays one txn). A file
    // memory DB defaults its kernel store to a SIBLING file (so both persist across restart); :memory: stays
    // in-memory. In a real deployment kernelDbPath points at integrity-protected, rollback-resistant storage
    // the memory-store adversary cannot reach.
    const kpath = kernelDbPath ?? (dbPath === ":memory:" ? ":memory:" : `${dbPath}.kernel`);
    this.db.exec(`ATTACH DATABASE '${String(kpath).replace(/'/g, "''")}' AS kernel`);
    this.db.exec(COUPLED_MEMORY_SCHEMA);
    this.db.exec(KERNEL_SCHEMA);
    for (const t of KERNEL_TABLES) this.db.exec(`DROP TABLE IF EXISTS main.${t}`); // only the kernel copies remain
    this.kernelDbPath = kpath;
    this.secure = false;
  }

  close() {
    this.db.close();
  }

  ensureRun(runId, metadata = {}) {
    const timestamp = nowIso();
    this.db.prepare(`
      INSERT OR IGNORE INTO runs (run_id, status, created_at, updated_at, metadata_json)
      VALUES (?, 'running', ?, ?, ?)
    `).run(runId, timestamp, timestamp, asJson(metadata));
  }

  sendMessage(envelope) {
    requireEnvelope(envelope);
    this.ensureRun(envelope.run_id);
    const timestamp = nowIso();
    this.db.prepare(`
      INSERT INTO messages (
        message_id, run_id, task_id, trace_id, parent_message_id, correlation_id, delegated_from,
        sender, receiver, intent, state, sequence, policy_context, envelope_json, created_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      envelope.message_id,
      envelope.run_id,
      envelope.task_id,
      envelope.trace_id,
      envelope.parent_message_id ?? null,
      envelope.correlation_id ?? null,
      envelope.delegated_from ?? null,
      envelope.sender,
      envelope.receiver,
      envelope.intent,
      envelope.state,
      envelope.sequence,
      envelope.policy_context ?? null,
      asJson(envelope),
      timestamp,
    );
    this.db.prepare(`
      INSERT INTO message_queue (message_id, run_id, receiver, status, available_at, created_at)
      VALUES (?, ?, ?, 'pending', ?, ?)
    `).run(envelope.message_id, envelope.run_id, envelope.receiver, timestamp, timestamp);
    this.recordEvent({
      event_type: "message_sent",
      run_id: envelope.run_id,
      task_id: envelope.task_id,
      trace_id: envelope.trace_id,
      message_id: envelope.message_id,
      agent: envelope.sender,
      result: "queued",
      payload: { receiver: envelope.receiver, intent: envelope.intent },
    });
    return envelope;
  }

  claimNextMessage(receiver, { workerId = receiver } = {}) {
    const row = this.db.prepare(`
      SELECT queue_id, message_id FROM message_queue
      WHERE receiver = ? AND status = 'pending'
      ORDER BY available_at ASC, queue_id ASC
      LIMIT 1
    `).get(receiver);
    if (!row) {
      return null;
    }
    const timestamp = nowIso();
    this.db.prepare(`
      UPDATE message_queue
      SET status = 'locked', locked_by = ?, locked_at = ?, attempts = attempts + 1, lock_generation = lock_generation + 1
      WHERE queue_id = ?
    `).run(workerId, timestamp, row.queue_id);
    return this.getMessage(row.message_id);
  }

  getMessage(messageId) {
    const row = this.db.prepare(`SELECT message_id, run_id, task_id, trace_id, parent_message_id,
      delegated_from, sender, receiver, sequence, envelope_json, envelope_sig FROM messages
      WHERE message_id = ?`).get(messageId);
    if (!row) return null;
    const env = parseJson(row.envelope_json, null);
    if (!env) return null;
    // IDENTITY BINDING (review M1): a signature proves the envelope's CONTENT, not which DB key/lease it
    // belongs to. We therefore require the signed envelope to be bound to THIS row's identity: the row key
    // and every identity column must equal the signed envelope's fields. Otherwise a valid envelope signed
    // for another message has been copied into this row (signed-object substitution), and we fail closed
    // by returning it WITHOUT its signature so any secure caller denies it (envelope_not_attested).
    const idBound = env.message_id === row.message_id
      && (env.run_id ?? null) === (row.run_id ?? null)
      && (env.task_id ?? null) === (row.task_id ?? null)
      && (env.trace_id ?? null) === (row.trace_id ?? null)
      && (env.parent_message_id ?? null) === (row.parent_message_id ?? null)
      && (env.delegated_from ?? null) === (row.delegated_from ?? null)
      && (env.sender ?? null) === (row.sender ?? null)
      && (env.receiver ?? null) === (row.receiver ?? null)
      && (env.sequence ?? null) === (row.sequence ?? null);
    if (!idBound) return null; // substituted/tampered envelope -> not a valid message for this key
    if (row.envelope_sig != null) env.envelope_sig = row.envelope_sig; // digital fingerprint
    return env;
  }

  // The worker currently holding the queue lock for a message (review M1.1: caller authentication).
  // Returns null if the message is unqueued or unlocked.
  lockOwnerOf(messageId) {
    const row = this.db.prepare("SELECT locked_by FROM message_queue WHERE message_id = ?").get(messageId);
    return row ? (row.locked_by ?? null) : null;
  }

  // Monotonic lock generation for a message: bumped on every (re)claim, so a lease issued under an
  // earlier generation can be recognised as stale after a takeover/retry (review M4).
  lockGenerationOf(messageId) {
    const row = this.db.prepare("SELECT lock_generation FROM message_queue WHERE message_id = ?").get(messageId);
    return row ? (row.lock_generation ?? 0) : 0;
  }

  // Current queue status of a message ('pending' | 'locked' | 'completed' | ...). A lease is only valid
  // while its message is 'locked' (review: a completed/released message must not keep acting).
  claimStatusOf(messageId) {
    const row = this.db.prepare("SELECT status FROM message_queue WHERE message_id = ?").get(messageId);
    return row ? (row.status ?? null) : null;
  }

  // Resolve the active message to its CANONICAL persisted envelope, the authorization context the
  // gate, causal ancestry, and audit log must trust (review M1). A caller-supplied object may not
  // assert a security-relevant field that conflicts with the persisted envelope; if it does, we fail
  // closed. The returned envelope is the persisted one, so even non-conflicting caller fields cannot
  // change the authorization decision.
  resolveActiveMessage(currentMessage) {
    requireEnvelope(currentMessage);
    const canonical = this.getMessage(currentMessage.message_id);
    if (!canonical) {
      throw new Error(`active message not found: ${currentMessage.message_id}`);
    }
    const conflicts = envelopeConflicts(currentMessage, canonical);
    if (conflicts.length) {
      throw new Error(`active_message_envelope_mismatch: ${conflicts.join(",")}`);
    }
    return canonical;
  }

  writeMemory(content, currentMessage, options = {}) {
    if (!currentMessage) {
      throw new Error("writeMemory requires currentMessage");
    }
    // Bind provenance to the CANONICAL persisted envelope (review M1): a forged currentMessage cannot
    // stamp a written record with a run/task/policy it was not actually sent under.
    currentMessage = this.resolveActiveMessage(currentMessage);
    const timestamp = nowIso();
    const memory = {
      memory_id: options.memory_id ?? `mem-${randomUUID()}`,
      run_id: options.run_id ?? currentMessage.run_id,
      task_id: options.task_id ?? currentMessage.task_id,
      trace_id: options.trace_id ?? currentMessage.trace_id,
      source_message_id: currentMessage.message_id,
      writer: options.writer ?? currentMessage.sender,
      memory_type: options.memory_type ?? "summary",
      scope: options.scope ?? "task",
      status: options.status ?? "active",
      content,
      content_ref: options.content_ref ?? null,
      allowed_readers: options.allowed_readers ?? [currentMessage.receiver],
      supersedes: options.supersedes ?? [],
      valid_from_event: options.valid_from_event ?? null,
      valid_until_event: options.valid_until_event ?? null,
      policy_context: options.policy_context ?? currentMessage.policy_context ?? null,
    };
    const hash = memoryContentHash(memory);
    // Base (benchmark) write carries no attestation receipt -- attestation is enforced only by
    // SecureMemoryRuntime, which mints the receipt through the trusted control plane after verifying
    // the writer's lease (review M1). A receipt minted here would be exactly the "signing oracle" the
    // reviewer flagged, so the base class deliberately does not mint one.
    const receipt = null;
    this.db.prepare(`
      INSERT INTO shared_memory (
        memory_id, run_id, task_id, trace_id, source_message_id, writer, memory_type,
        scope, status, content, content_ref, allowed_readers_json, supersedes_json,
        valid_from_event, valid_until_event, policy_context, audit_hash, write_receipt, created_at, updated_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      memory.memory_id,
      memory.run_id,
      memory.task_id,
      memory.trace_id,
      memory.source_message_id,
      memory.writer,
      memory.memory_type,
      memory.scope,
      memory.status,
      memory.content,
      memory.content_ref,
      asJson(memory.allowed_readers),
      asJson(memory.supersedes),
      memory.valid_from_event,
      memory.valid_until_event,
      memory.policy_context,
      hash,
      receipt,
      timestamp,
      timestamp,
    );
    this.recordEvent({
      event_type: "memory_written",
      run_id: memory.run_id,
      task_id: memory.task_id,
      trace_id: memory.trace_id,
      message_id: currentMessage.message_id,
      memory_id: memory.memory_id,
      agent: memory.writer,
      result: "active",
      payload: { memory_type: memory.memory_type, scope: memory.scope },
    });
    return { ...memory, audit_hash: hash, write_receipt: receipt, created_at: timestamp, updated_at: timestamp };
  }

  readMemory(query = {}, currentMessage = null, runState = {}) {
    const condition = runState.condition ?? "C5";
    // Own-property guard (parity with resolveTool): a prototype-member condition name must not resolve to an
    // inherited Object.prototype member and skip the fail-closed `unknown condition` throw below.
    const features = Object.hasOwn(CONDITION_FEATURES, condition) ? CONDITION_FEATURES[condition] : undefined;
    if (!features) {
      throw new Error(`unknown condition: ${condition}`);
    }
    if (!features.sharedMemory) {
      return [];
    }
    if (features.messageBoundMemory && !currentMessage) {
      throw new Error("C5 readMemory requires currentMessage");
    }
    // Bind to the CANONICAL persisted envelope (review M1): forged run/task/receiver/policy/parent
    // fields are rejected fail-closed, and the gate runs against the persisted authorization context,
    // not the caller-supplied object.
    if (features.messageBoundMemory) {
      currentMessage = this.resolveActiveMessage(currentMessage);
    } else if (currentMessage) {
      requireEnvelope(currentMessage);
    }
    const candidates = this.findCandidateMemories(query);
    if (!features.messageBoundMemory) {
      return candidates;
    }
    // Negative-control hook (additive; default path unchanged): a labelled-but-ungated read.
    if (runState.controlNoGate) {
      return candidates;
    }
    const gateOptions = { ...(runState.gateOptions ?? {}) };
    // Precompute the active message's causal closure once per read when the (default) causal
    // provenance check is active, so each candidate is tested against the same event graph.
    const provenanceDisabled = (gateOptions.disabledChecks ?? []).includes("provenance");
    const provenanceMode = gateOptions.provenanceMode ?? "causal";
    if (!provenanceDisabled && provenanceMode !== "exists") {
      gateOptions.causalClosure = this.causalAncestry(currentMessage);
    }
    const readId = `read-${randomUUID()}`;
    const allowed = [];
    for (const memory of candidates) {
      const decision = this.evaluateMemoryGate(memory, currentMessage, gateOptions);
      this.recordMemoryDecision({ memory, currentMessage, readId, ...decision });
      if (decision.decision === "allow") {
        allowed.push(memory);
      }
    }
    // Persist the read manifest (review M2): everything an independent replay needs to re-run the
    // gate from scratch and detect tampered/missing/deleted decisions. We do NOT store the gate's
    // verdict as ground truth -- replay recomputes it and compares.
    this.recordMemoryRead({
      readId, currentMessage, candidates, admitted: allowed,
      closure: gateOptions.causalClosure, gateOptions, condition: runState.condition,
    });
    return allowed;
  }

  // Bump the per-run monotonic read counter (review M1.4) so replay can detect a wiped read manifest.
  bumpAuditAnchor(runId) {
    this.db.prepare(`
      INSERT INTO kernel.audit_anchor (run_id, reads, updated_at) VALUES (?, 1, ?)
      ON CONFLICT(run_id) DO UPDATE SET reads = reads + 1, updated_at = excluded.updated_at
    `).run(runId, nowIso());
  }

  auditAnchor(runId) {
    const row = this.db.prepare("SELECT reads FROM kernel.audit_anchor WHERE run_id = ?").get(runId);
    return row ? row.reads : null;
  }

  recordMemoryRead({ readId, currentMessage, candidates, admitted, closure, gateOptions = {}, condition = null }) {
    this.bumpAuditAnchor(currentMessage.run_id);
    const activeSnapshot = {
      message_id: currentMessage.message_id, run_id: currentMessage.run_id, task_id: currentMessage.task_id,
      trace_id: currentMessage.trace_id, receiver: currentMessage.receiver, intent: currentMessage.intent,
      policy_context: currentMessage.policy_context, parent_message_id: currentMessage.parent_message_id ?? null,
      delegated_from: currentMessage.delegated_from ?? null, sequence: currentMessage.sequence ?? null,
    };
    const gateConfig = {
      disabledChecks: gateOptions.disabledChecks ?? [],
      provenanceMode: gateOptions.provenanceMode ?? "causal",
    };
    this.db.prepare(`
      INSERT INTO memory_reads (
        read_id, run_id, task_id, message_id, reader, condition, active_message_json,
        candidate_ids_json, admitted_ids_json, ancestor_closure_json, gate_options_json, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      readId, currentMessage.run_id, currentMessage.task_id, currentMessage.message_id,
      currentMessage.receiver, condition ?? null, asJson(activeSnapshot),
      asJson(candidates.map((m) => m.memory_id)), asJson(admitted.map((m) => m.memory_id)),
      closure ? asJson([...closure]) : null, asJson(gateConfig), nowIso(),
    );
  }

  findCandidateMemories(query = {}) {
    const rows = this.db.prepare(`
      SELECT * FROM shared_memory
      ORDER BY created_at ASC, memory_id ASC
    `).all();
    const terms = String(query.text ?? "")
      .toLowerCase()
      .split(/\s+/)
      .filter((term) => term.length > 2);
    const filtered = rows
      .map(memoryFromRow)
      .filter((memory) => !query.memory_type || memory.memory_type === query.memory_type)
      .filter((memory) => !query.run_id || memory.run_id === query.run_id)
      .filter((memory) => !query.task_id || memory.task_id === query.task_id)
      .filter((memory) => terms.length === 0 || terms.some((term) => memory.content?.toLowerCase().includes(term)));
    // Optional relevance top-k (Gate 2.0 #5): a bounded retriever keeps only the highest-scoring records,
    // which an attacker can flood to suppress a critical one. Default (no topK) returns all (unchanged).
    if (Number.isFinite(query.topK)) {
      const score = (m) => terms.reduce((n, t) => n + (m.content?.toLowerCase().includes(t) ? 1 : 0), 0);
      return [...filtered].sort((a, b) => score(b) - score(a)).slice(0, query.topK);
    }
    return filtered;
  }

  // Causal (happens-before) closure of an active message: the set of message_ids reachable by
  // walking *directed* ancestry edges only. We follow parent_message_id (reply/continuation) and
  // delegated_from (delegation grant: the delegator strictly precedes the delegate). We do NOT
  // treat a shared correlation_id as a causal edge: a correlation id labels a whole workflow group
  // and is undirected, so expanding it would pull in siblings and even future branches -- exactly
  // the graph-only sibling-branch trap the gate must reject. A memory is valid iff its source
  // message lies in this ancestor set, a distinction a source-exists (referential-integrity) check
  // cannot make.
  causalAncestry(activeMessage) {
    const rows = this.db.prepare(
      "SELECT message_id, parent_message_id, delegated_from, sequence, created_at FROM messages WHERE run_id = ?",
    ).all(activeMessage.run_id);
    // Single shared implementation (causal.mjs) so runtime and the external/framework gate compute
    // provenance identically (review M7); directional, temporally validated happens-before (M4).
    return causalAncestryFromMessages(rows, {
      message_id: activeMessage.message_id,
      parent_message_id: activeMessage.parent_message_id ?? null,
      delegated_from: activeMessage.delegated_from ?? null,
      sequence: activeMessage.sequence ?? null,
      created_at: activeMessage.created_at ?? null,
    });
  }

  evaluateMemoryGate(memory, currentMessage, options = {}) {
    // `options.disabledChecks` (array of check names) and `options.random` (rng fn returning
    // [0,1)) support negative/no-op control conditions. Default options => strict gate.
    // `options.provenanceMode` selects how the provenance check binds memory to the active
    // message: "causal" (default; source must lie in the active message's causal closure) or
    // "exists" (referential-integrity baseline; source message merely has to exist).
    const disabled = new Set(options.disabledChecks ?? []);
    if (typeof options.random === "function") {
      return options.random() < 0.5
        ? { decision: "allow", reason: "random_gate_allow" }
        : { decision: "deny", reason: "random_gate_deny" };
    }
    // Content integrity (review M5): a stored memory whose content/metadata no longer matches its
    // write-time hash has been tampered with; the gate denies it (tamper evidence on read). This is
    // a property of the message-bound gate, so it is not part of the disable-able static checks.
    if (!disabled.has("integrity") && memory.audit_hash && memoryContentHash(memory) !== memory.audit_hash) {
      return { decision: "deny", reason: "integrity_mismatch" };
    }
    if (!disabled.has("run") && memory.run_id !== currentMessage.run_id) {
      return { decision: "deny", reason: "run_id_mismatch" };
    }
    const taskMatches = memory.task_id === currentMessage.task_id || ["run", "global"].includes(memory.scope);
    if (!disabled.has("task") && !taskMatches) {
      return { decision: "deny", reason: "task_scope_mismatch" };
    }
    if (!disabled.has("status") && memory.status !== "active") {
      return { decision: "deny", reason: "inactive_memory" };
    }
    if (!disabled.has("provenance")) {
      // A record with no declared source is denied (fail-closed), matching the external gate and
      // avoiding an undefined SQLite bind (review M3 parity).
      if (!memory.source_message_id || !this.getMessage(memory.source_message_id)) {
        return { decision: "deny", reason: "missing_provenance_message" };
      }
      // Default (causal) mode additionally requires the source message to be reachable in the
      // active message's event graph. The "exists" mode stops at referential integrity and is
      // used by the source-exists / static-filter baselines.
      const mode = options.provenanceMode ?? "causal";
      if (mode !== "exists") {
        const closure = options.causalClosure ?? this.causalAncestry(currentMessage);
        if (!closure.has(memory.source_message_id)) {
          return { decision: "deny", reason: "provenance_not_in_causal_graph" };
        }
      }
    }
    const allowedReaders = new Set(memory.allowed_readers ?? []);
    if (!disabled.has("reader") && !allowedReaders.has("*") && !allowedReaders.has(currentMessage.receiver)) {
      return { decision: "deny", reason: "reader_not_authorized" };
    }
    // Own-property guard (parity with resolveTool): a prototype-member intent ("constructor", "toString", ...)
    // must resolve to undefined here, not a truthy inherited member that would throw on `.has()`.
    const allowedTypes = Object.hasOwn(INTENT_MEMORY_TYPES, currentMessage.intent)
      ? INTENT_MEMORY_TYPES[currentMessage.intent] : undefined;
    if (!disabled.has("intent") && allowedTypes && !allowedTypes.has(memory.memory_type)) {
      return { decision: "deny", reason: "intent_memory_type_mismatch" };
    }
    if (!disabled.has("policy") && memory.policy_context && memory.policy_context !== currentMessage.policy_context) {
      return { decision: "deny", reason: "policy_context_mismatch" };
    }
    return { decision: "allow", reason: "message_bound_access_granted" };
  }

  recordMemoryDecision({ memory, currentMessage, readId = null, decision, reason }) {
    this.db.prepare(`
      INSERT INTO memory_access_decisions (
        decision_id, read_id, run_id, task_id, message_id, memory_id, reader, decision, reason,
        memory_content_hash, created_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      `dec-${randomUUID()}`,
      readId,
      currentMessage.run_id,
      currentMessage.task_id,
      currentMessage.message_id,
      memory.memory_id,
      currentMessage.receiver,
      decision,
      reason,
      memoryContentHash(memory),
      nowIso(),
    );
  }

  recordEvent({ event_type, run_id, task_id = null, trace_id = null, message_id = null, memory_id = null, artifact_id = null, agent = null, decision = null, result = null, payload = {} }) {
    this.db.prepare(`
      INSERT INTO events (
        event_id, event_type, run_id, task_id, trace_id, message_id, memory_id,
        artifact_id, agent, decision, result, payload_json, created_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      `evt-${randomUUID()}`,
      event_type,
      run_id,
      task_id,
      trace_id,
      message_id,
      memory_id,
      artifact_id,
      agent,
      decision,
      result,
      asJson(payload),
      nowIso(),
    );
  }

  auditRun(runId) {
    const events = this.db.prepare("SELECT * FROM events WHERE run_id = ? ORDER BY created_at ASC").all(runId);
    const decisions = this.db.prepare(`
      SELECT * FROM memory_access_decisions
      WHERE run_id = ?
      ORDER BY created_at ASC
    `).all(runId);
    const reads = this.db.prepare("SELECT * FROM memory_reads WHERE run_id = ? ORDER BY created_at ASC").all(runId);
    return { run_id: runId, events, memory_access_decisions: decisions, memory_reads: reads };
  }

  // Independent audit replay (review M2). For every logged read it RECONSTRUCTS the active message,
  // candidate set, and causal closure from PERSISTED state and RE-RUNS the gate, then compares the
  // recomputed verdicts to the logged ones. It never consults the original in-memory result, so a
  // tampered verdict, a missing/duplicate/deleted decision, an altered candidate, or a content edit
  // is detected as a mismatch. (Detecting deletion of the read manifest itself, or a forged hash
  // written by a DB-write-capable adversary, requires an authenticated/append-only log -- out of
  // scope here and stated as a limitation.)
  replayMemoryReads(runId) {
    const reads = this.db.prepare("SELECT * FROM memory_reads WHERE run_id = ? ORDER BY created_at ASC").all(runId);
    const decisions = this.db.prepare("SELECT * FROM memory_access_decisions WHERE run_id = ? ORDER BY created_at ASC").all(runId);
    // Candidates can span runs (a wrong-run record is a legitimate candidate that the gate denies),
    // so resolve memory rows globally rather than scoping to runId.
    const memories = this.db.prepare("SELECT * FROM shared_memory").all().map(memoryFromRow);
    const memById = new Map(memories.map((m) => [m.memory_id, m]));
    const issues = [];

    // (0) deletion check (review M1.4): the monotonic anchor records how many reads occurred; if fewer
    // survive in the manifest, the log was (partly or wholly) deleted -- distinct from "no activity".
    const anchor = this.auditAnchor(runId);
    if (anchor != null && reads.length < anchor) {
      issues.push({ kind: "read_manifest_deleted", expected_reads: anchor, found_reads: reads.length });
    }

    // (1) content integrity for every memory that was a candidate in this run's reads.
    const candidateIdSet = new Set();
    for (const read of reads) for (const id of JSON.parse(read.candidate_ids_json)) candidateIdSet.add(id);
    for (const id of candidateIdSet) {
      const m = memById.get(id);
      if (m && m.audit_hash && memoryContentHash(m) !== m.audit_hash) {
        issues.push({ kind: "content_tampered", memory_id: id });
      }
    }

    // (2) group decisions by read; flag any decision with no parent read, or whose read_id matches no
    // surviving read manifest (an injected/orphaned decision row).
    const knownReadIds = new Set(reads.map((r) => r.read_id));
    const decByRead = new Map();
    for (const d of decisions) {
      if (!d.read_id) { issues.push({ kind: "orphan_decision_no_read", decision_id: d.decision_id }); continue; }
      if (!knownReadIds.has(d.read_id)) { issues.push({ kind: "orphan_decision_unknown_read", decision_id: d.decision_id, read_id: d.read_id }); continue; }
      if (!decByRead.has(d.read_id)) decByRead.set(d.read_id, []);
      decByRead.get(d.read_id).push(d);
    }

    let readsOk = 0;
    for (const read of reads) {
      const before = issues.length;
      const snapshot = JSON.parse(read.active_message_json);
      // Re-run against the CANONICAL persisted envelope, not the logged snapshot (review M1/M5.1):
      // a forged or tampered snapshot cannot launder a forged authorization context past replay.
      const canonical = this.getMessage(snapshot.message_id);
      if (!canonical) {
        issues.push({ kind: "active_message_missing", read_id: read.read_id, message_id: snapshot.message_id });
      } else {
        const conflicts = envelopeConflicts(snapshot, canonical);
        if (conflicts.length) {
          issues.push({ kind: "active_message_envelope_mismatch", read_id: read.read_id,
            message_id: snapshot.message_id, fields: conflicts });
        }
      }
      const active = canonical ?? snapshot;
      const candidateIds = JSON.parse(read.candidate_ids_json);
      const loggedAdmitted = new Set(JSON.parse(read.admitted_ids_json));
      const cfg = JSON.parse(read.gate_options_json ?? "{}");
      const gateOptions = { disabledChecks: cfg.disabledChecks ?? [], provenanceMode: cfg.provenanceMode ?? "causal" };
      if (gateOptions.provenanceMode !== "exists" && !gateOptions.disabledChecks.includes("provenance")) {
        gateOptions.causalClosure = this.causalAncestry(active);
      }

      const readDecs = decByRead.get(read.read_id) ?? [];
      const decByMem = new Map();
      for (const d of readDecs) {
        if (decByMem.has(d.memory_id)) issues.push({ kind: "duplicate_decision", read_id: read.read_id, memory_id: d.memory_id });
        else decByMem.set(d.memory_id, d);
      }

      const recomputedAllow = new Set();
      for (const cid of candidateIds) {
        const mem = memById.get(cid);
        if (!mem) { issues.push({ kind: "candidate_memory_missing", read_id: read.read_id, memory_id: cid }); continue; }
        const verdict = this.evaluateMemoryGate(mem, active, gateOptions);
        if (verdict.decision === "allow") recomputedAllow.add(cid);
        const logged = decByMem.get(cid);
        if (!logged) { issues.push({ kind: "missing_decision", read_id: read.read_id, memory_id: cid }); continue; }
        if (logged.decision !== verdict.decision || logged.reason !== verdict.reason) {
          issues.push({ kind: "decision_mismatch", read_id: read.read_id, memory_id: cid,
            logged: `${logged.decision}:${logged.reason}`, recomputed: `${verdict.decision}:${verdict.reason}` });
        }
        if (logged.memory_content_hash && logged.memory_content_hash !== memoryContentHash(mem)) {
          issues.push({ kind: "content_changed_since_decision", read_id: read.read_id, memory_id: cid });
        }
      }
      for (const d of readDecs) {
        if (!candidateIds.includes(d.memory_id)) {
          issues.push({ kind: "extraneous_decision", read_id: read.read_id, memory_id: d.memory_id });
        }
      }
      const sameAdmitted = recomputedAllow.size === loggedAdmitted.size
        && [...recomputedAllow].every((id) => loggedAdmitted.has(id));
      if (!sameAdmitted) {
        issues.push({ kind: "admitted_set_mismatch", read_id: read.read_id,
          recomputed: [...recomputedAllow].sort(), logged: [...loggedAdmitted].sort() });
      }
      if (issues.length === before) readsOk++;
    }
    return { runId, reads: reads.length, reads_ok: readsOk, decisions: decisions.length, issues, ok: issues.length === 0 };
  }
}

// The ENFORCED reference monitor (review M1--M6, M8). Unlike the base class it has no bypass surface:
// every write requires an authenticated lease, every read derives its active message FROM the lease
// (so a canonical envelope is never a bearer credential), receipts are minted/verified through the
// trusted control plane (ephemeral key, never in the store), retirement comes from the authoritative
// lifecycle log (not a writer-declared status), and there is no `condition`/`controlNoGate`/
// `disabledChecks` parameter -- the strict gate is the only path. Identity is possession of an
// unforgeable control-plane token, not a caller-supplied string.
export class SecureMemoryRuntime extends CoupledMemoryRuntime {
  constructor({ dbPath = ":memory:", kernelDbPath = null, controlPlane = null, dispatcher = null, destinationPolicy = null } = {}) {
    super({ dbPath, kernelDbPath });
    this.controlPlane = controlPlane ?? new ControlPlane();
    this.secure = true;
    // Deployment-supplied destination/parameter policy: (resolvedTool, context) -> bool. EVERY external effect
    // (every send, transfer/delete/deploy, and unknown tools alike) is DENIED unless this authorizes the exact
    // (tool, target) -- fail-closed, with no weaker tier. default null => no policy => every external effect is
    // denied. resolvedTool exposes the tool name, effect class, externality, and target; a correct policy keys
    // on tool/target -- NOT effect class alone, which lumps exfil-capable send_email with internal notify.
    this._destinationPolicy = destinationPolicy;
    // The trusted dispatcher alone executes authorized actions (it holds the tool credentials). It is a
    // private field, NEVER exposed on the data-plane facade, so an agent cannot invoke a tool except by
    // going through executeAuthorizedAction (the kernel). OS-level enforcement of this confinement is a
    // deployment requirement; in-process it rests on capability privacy.
    this._dispatcher = dispatcher ?? defaultTrustedDispatcher();
    // Give the control plane verified access to the canonical signed store so it derives/verifies edges,
    // leases, parent integrity, and write metadata itself rather than trusting caller arguments.
    this.controlPlane.bindStore({
      getSignedMessage: (id) => this.getMessage(id),
      lockOwnerOf: (id) => this.lockOwnerOf(id),
      lockGenerationOf: (id) => this.lockGenerationOf(id),
      claimStatusOf: (id) => this.claimStatusOf(id),
      // Atomic per-run sequence allocation (review S19): a context-driven send gets its sequence here, never
      // from the caller. Single-threaded so SELECT+UPDATE is atomic; returns the value BEFORE the bump.
      allocateSequence: (runId) => this._allocateSequence(runId),
    });
    // Restore the lifecycle chain head into TCB memory from durable storage at startup (review: the head
    // is authoritative in the control plane, not the writable anchor row; a mid-run rollback of the DB row
    // cannot move it). For the ephemeral profile the table is empty and the head starts fresh.
    const a = this.db.prepare("SELECT count, last_mac, last_seq FROM kernel.lifecycle_anchor WHERE id='global'").get();
    if (a) this.controlPlane.seedLifecycle({ count: a.count, lastSeq: a.last_seq, lastMac: a.last_mac });
    // Restore the resolution chain head the same way (durable profile); empty for the ephemeral profile.
    const ra = this.db.prepare("SELECT count, last_mac, last_seq FROM kernel.resolution_anchor WHERE id='global'").get();
    if (ra) this.controlPlane.seedResolution({ count: ra.count, lastSeq: ra.last_seq, lastMac: ra.last_mac });
    // Restore execution contexts from the durable mirror (durable profile). The control plane re-verifies
    // each row's MAC under its key and loads a forged/unverifiable context as 'aborted', so a restart
    // cannot resurrect a usable execution that derived from consumed untrusted inputs. For the ephemeral
    // profile the table is empty and nothing is restored.
    if (typeof this.controlPlane.seedContextHeads === "function") {
      this.controlPlane.seedContextHeads(this.db.prepare("SELECT context_id, version, integrity, input_count, mac FROM kernel.context_anchor").all());
    }
    const ctxRows = this.db.prepare("SELECT * FROM execution_contexts").all();
    if (ctxRows.length) {
      // (v20 CE20-03) Seed the TRUSTED context version heads from the kernel anchor FIRST, so seedContexts can
      // cross-check each (untrusted) execution_contexts row against its monotonic head and reject a row rolled
      // back to a pre-taint version (authentic but stale). Empty for the ephemeral profile.
      const inputsByContext = new Map();
      for (const ir of this.db.prepare("SELECT * FROM execution_inputs").all()) {
        if (!inputsByContext.has(ir.context_id)) inputsByContext.set(ir.context_id, []);
        inputsByContext.get(ir.context_id).push(ir);
      }
      this.controlPlane.seedContexts(ctxRows, inputsByContext);
    }
    // (v18 round-3 / v19) Restore the authority-membership ledger from its durable mirror AND its MAC-chain
    // head from the anchor, so the deletion-omission alarm (P0-1) survives a key-stable restart with TRUE
    // parity to the lifecycle/resolution heads. Without the head a restart silently loses the only check that
    // catches an outright DELETE of a restrictive record; with it, a mirror shrunk after restart no longer
    // matches the restored count + chain and _verifiedMembership fails closed. Empty for the ephemeral profile.
    if (typeof this.controlPlane.seedMembership === "function") {
      const memRows = this.db.prepare("SELECT run_id, memory_id, digest FROM authority_membership").all();
      if (memRows.length) this.controlPlane.seedMembership(memRows);
      if (typeof this.controlPlane.seedMembershipHead === "function") {
        const ma = this.db.prepare("SELECT count, last_mac, last_seq FROM kernel.membership_anchor WHERE id='global'").get();
        if (ma) this.controlPlane.seedMembershipHead({ count: ma.count, lastSeq: ma.last_seq, lastMac: ma.last_mac });
      }
    }
  }

  _withImmediateTransaction(fn) {
    if (this._txnDepth > 0) return fn();
    this._txnDepth = 1;
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const out = fn();
      this.db.exec("COMMIT");
      return out;
    } catch (e) {
      try { this.db.exec("ROLLBACK"); } catch {}
      throw e;
    } finally {
      this._txnDepth = 0;
    }
  }

  // Mirror a context (and its input manifest) into the durable kernel tables. The control-plane copy in
  // TCB memory is authoritative; this row exists so the durable profile can restore/invalidate it at
  // startup. Upserts so attach/complete updates land on the same row.
  _persistContext({ context, inputs }) {
    return this._withImmediateTransaction(() => {
      const ts = nowIso();
      this.db.prepare(`
        INSERT INTO execution_contexts (context_id, principal_id, run_id, task_id, trace_id, current_event_id,
          integrity, state, version, context_mac, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(context_id) DO UPDATE SET current_event_id=excluded.current_event_id,
          integrity=excluded.integrity, state=excluded.state, version=excluded.version,
          context_mac=excluded.context_mac, updated_at=excluded.updated_at
      `).run(context.context_id, context.principal_id, context.run_id, context.task_id, context.trace_id,
        context.current_event_id, context.integrity, context.state, context.version, context.context_mac, ts, ts);
      for (const inp of inputs) {
        this.db.prepare(`
          INSERT INTO execution_inputs (context_id, message_id, lease_id, claim_generation, envelope_digest, input_integrity, observed_at)
          VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT(context_id, message_id) DO NOTHING
        `).run(inp.context_id, inp.message_id, inp.lease_id, inp.claim_generation, inp.envelope_digest, inp.input_integrity, ts);
      }
      // (v20 CE20-03) Advance the TRUSTED anti-rollback head for this context in the kernel DB. The control plane
      // computes a monotone (context_id, version, integrity, input_count) anchor under its key; the row lives in
      // the kernel DB the memory-file adversary cannot reach. A restart cross-checks the (untrusted) main row
      // against this head, so a row rolled back to a pre-taint version (lower) is loaded as aborted. Best-effort
      // by capability: only when the control plane exposes the head API (parity with the membership anchor).
      if (typeof this.controlPlane.recordContextVersion === "function") {
        const anchor = this.controlPlane.recordContextVersion(context.context_id, context.version, context.integrity, inputs.length);
        this.db.prepare(`
          INSERT INTO kernel.context_anchor (context_id, version, integrity, input_count, mac, updated_at)
          VALUES (?, ?, ?, ?, ?, ?)
          ON CONFLICT(context_id) DO UPDATE SET version=excluded.version, integrity=excluded.integrity,
            input_count=excluded.input_count, mac=excluded.mac, updated_at=excluded.updated_at
          WHERE excluded.version > kernel.context_anchor.version
        `).run(anchor.context_id, anchor.version, anchor.integrity ?? null, anchor.input_count, anchor.mac, ts);
      }
    });
  }

  // (v20 round-12) The run's next sequence, read as MAX(advisory main mirror, TRUSTED kernel clock). The kernel
  // clock lives in the protected kernel DB, so a store-write rollback of the untrusted runs.next_sequence cannot
  // lower the write-event clock the creation-cut depends on. Fully-qualified kernel.run_clock (round-9 lesson:
  // an unqualified name would resolve to a main-DB shadow first).
  _nextSeqOf(runId) {
    const m = this.db.prepare("SELECT next_sequence FROM runs WHERE run_id = ?").get(runId);
    const k = this.db.prepare("SELECT next_seq FROM kernel.run_clock WHERE run_id = ?").get(runId);
    return Math.max(m ? m.next_sequence : 1, k ? k.next_seq : 1);
  }

  // Atomic per-run sequence allocation (review S19). Single-threaded, so SELECT-then-UPDATE is atomic. The value
  // is the MAX of the advisory main counter and the trusted kernel clock; BOTH are advanced, so the clock is
  // monotonic and rollback-resistant (a rolled-back main counter is dominated by the kernel clock).
  _allocateSequence(runId) {
    this.ensureRun(runId);
    const ts = nowIso();
    const seq = this._nextSeqOf(runId);
    this.db.prepare("UPDATE runs SET next_sequence = ?, updated_at = ? WHERE run_id = ?").run(seq + 1, ts, runId);
    this.db.prepare(`INSERT INTO kernel.run_clock (run_id, next_seq, updated_at) VALUES (?, ?, ?)
      ON CONFLICT(run_id) DO UPDATE SET next_seq = MAX(next_seq, excluded.next_seq), updated_at = excluded.updated_at`).run(runId, seq + 1, ts);
    return seq;
  }

  // The run's LAST-allocated sequence (MAX(main, kernel) - 1), read WITHOUT consuming. Used by scenario harnesses
  // to sequence a reader/active message strictly after the memory writes it should see (v20 creation-cut), so a
  // legitimately pre-written record's write_seq is <= the reader's creation sequence.
  _currentSequence(runId) {
    return this._nextSeqOf(runId) - 1;
  }

  // Record a context output into the durable audit table (review S3.1): one row per message/record an
  // execution produced, attributable to (context, version). No-op if there is no context.
  _recordOutput(out) {
    if (!out) return;
    this.db.prepare(`
      INSERT INTO execution_outputs (context_id, context_version, output_id, output_kind, output_digest, output_integrity, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT(context_id, output_id) DO NOTHING
    `).run(out.context_id, out.context_version, out.output_id, out.output_kind, out.output_digest, out.output_integrity, nowIso());
  }

  // Context-driven send (review S9/S12): an ORDINARY agent's send. The caller supplies only
  // {receiver, intent, payload, state, requested_integrity}; the control plane composes and signs the whole
  // envelope from the execution context (run/task/trace, parent=current event, sender, allocated sequence,
  // integrity), advances the context's current event, and records the output. The caller cannot choose
  // run/parent/sequence/integrity/sender, so there is no envelope-field forgery surface here.
  send(sessionToken, contextToken, output) {
    return this._withImmediateTransaction(() => {
      const composed = this.controlPlane.composeSend(sessionToken, contextToken, output);
      const { env, sig } = composed;
      requireEnvelope(env);
      this.ensureRun(env.run_id);
      const ts = nowIso();
      this._insertSignedMessage(env, sig, ts);
      this._persistContext({ context: composed.context, inputs: composed.inputs });
      this._recordOutput(composed.output);
      this.recordEvent({ event_type: "message_sent", run_id: env.run_id, task_id: env.task_id,
        trace_id: env.trace_id, message_id: env.message_id, agent: env.sender, result: "queued",
        payload: { receiver: env.receiver, intent: env.intent } });
      return env;
    });
  }

  // Shared signed-message persistence for both ingress (sendMessage) and context-driven send.
  _insertSignedMessage(env, sig, ts = nowIso()) {
    this.db.prepare(`
      INSERT INTO messages (message_id, run_id, task_id, trace_id, parent_message_id, correlation_id,
        delegated_from, sender, receiver, intent, state, sequence, policy_context, envelope_json, envelope_sig, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(env.message_id, env.run_id, env.task_id, env.trace_id, env.parent_message_id ?? null,
      env.correlation_id ?? null, env.delegated_from ?? null, env.sender, env.receiver, env.intent,
      env.state, env.sequence, env.policy_context ?? null, asJson(env), sig, ts);
    this.db.prepare(`
      INSERT INTO message_queue (message_id, run_id, receiver, status, available_at, created_at)
      VALUES (?, ?, ?, 'pending', ?, ?)
    `).run(env.message_id, env.run_id, env.receiver, ts, ts);
  }

  // TRUSTED INGRESS / root creation (review S8): the admin/harness entry point that creates a message from
  // a full envelope (used to seed run graphs and to inject root work). The sender authenticates, the sender
  // field is bound to the authenticated principal, integrity is DERIVED (parent-meet + clearance; an
  // optional context token may additionally bind+lower it), and the control plane SIGNS the envelope. This
  // is NOT exposed on the data-plane facade, so an ordinary agent cannot create a context-less root -- it
  // can only emit derived messages through send(session, context, output).
  sendMessage(envelope, sessionToken, contextToken = null) {
    if (!sessionToken) throw new Error("secure sendMessage requires a sender session");
    const { env, sig } = this.controlPlane.attestSend(sessionToken, envelope, contextToken); // authenticates, derives, signs
    requireEnvelope(env);
    this._withImmediateTransaction(() => {
      this.ensureRun(env.run_id);
      const ts = nowIso();
      this._insertSignedMessage(env, sig, ts);
      // Keep the run's sequence counter ahead of any explicitly-seeded sequence so a later context-driven
      // send (which allocates from the counter) is strictly after these messages (review S19). Advance BOTH the
      // advisory main mirror and the TRUSTED kernel clock (v20 round-12), so the write-event clock is monotonic and
      // a store-write rollback of the main counter cannot lower it. The signed message, queue row, event, main
      // clock mirror, and kernel clock commit as one SQLite transaction.
      const _bumpTo = (Number(env.sequence) || 0) + 1;
      this.db.prepare("UPDATE runs SET next_sequence = MAX(next_sequence, ?) WHERE run_id = ?").run(_bumpTo, env.run_id);
      this.db.prepare(`INSERT INTO kernel.run_clock (run_id, next_seq, updated_at) VALUES (?, ?, ?)
        ON CONFLICT(run_id) DO UPDATE SET next_seq = MAX(next_seq, excluded.next_seq), updated_at = excluded.updated_at`).run(env.run_id, _bumpTo, ts);
      this.recordEvent({ event_type: "message_sent", run_id: env.run_id, task_id: env.task_id,
        trace_id: env.trace_id, message_id: env.message_id, agent: env.sender, result: "queued",
        payload: { receiver: env.receiver, intent: env.intent } });
    });
    return { ...env, envelope_sig: sig };
  }

  // Trusted-ingress alias (review S8): an explicit name for root/graph creation by the harness/operator.
  createIngressMessage(sessionToken, envelope) { return this.sendMessage(envelope, sessionToken); }

  // Fail closed if a message's envelope carries no valid signature: a tampered or forged authorization
  // context (run/task/policy/parent/sender) is rejected rather than trusted as a label.
  _attestEnvelope(env, where) {
    if (!this.controlPlane.verifyEnvelope(env)) throw new Error(`envelope_not_attested: ${where}`);
  }

  // Authenticated claim: the caller presents its session token (its credential). The control plane
  // verifies the principal may serve this receiver queue, records the queue lock AS that principal,
  // and returns a lease token bound to (principal, message). The caller never chooses the workerId
  // (review M2: claimNextMessage let the caller pick receiver AND workerId).
  claim(sessionToken, receiver) {
    const principal = this.controlPlane.authenticate(sessionToken);
    if (!this.controlPlane.principalMayServe(principal, receiver)) {
      throw new Error(`not_authorized_for_queue: ${receiver}`);
    }
    const row = this.db.prepare(`
      SELECT queue_id, message_id FROM message_queue
      WHERE receiver = ? AND status = 'pending'
      ORDER BY available_at ASC, queue_id ASC LIMIT 1
    `).get(receiver);
    if (!row) return null;
    const ts = nowIso();
    // Conditional update guarded on the row still being pending (defends against a concurrent
    // double-claim: only one updater flips 'pending'->'locked'); verify we won the lock before leasing.
    this.db.prepare(`
      UPDATE message_queue SET status='locked', locked_by=?, locked_at=?, attempts=attempts+1, lock_generation=lock_generation+1
      WHERE queue_id=? AND status='pending'
    `).run(principal, ts, row.queue_id);
    if (this.lockOwnerOf(row.message_id) !== principal) throw new Error(`claim_lost: ${row.message_id}`);
    const { token, leaseId } = this.controlPlane.issueLease(sessionToken, row.message_id); // CP re-verifies lock owner
    // A claim OPENS an execution context: the unit every output (message/record) this worker produces from
    // this message is bound to. Its integrity starts at meet(clearance, claimed-message integrity) and only
    // drops as further inputs are attached. The context is mirrored into the durable kernel tables.
    const ctx = this._openContext(token);
    return { lease: token, leaseId, principal, message: this.getMessage(row.message_id), context: ctx };
  }

  // Open + persist the execution context for a freshly issued lease; returns the capability token.
  _openContext(leaseToken) {
    const created = this.controlPlane.createExecutionContext(leaseToken);
    this._persistContext(created);
    return created.token;
  }

  // Acquire a lease for an already-locked message the principal owns (e.g. to write then read). Still
  // requires authentication, queue authority, AND that the principal actually holds the queue lock --
  // a principal cannot lease a message another worker is processing.
  leaseFor(sessionToken, messageId) {
    const principal = this.controlPlane.authenticate(sessionToken);
    const msg = this.getMessage(messageId);
    if (!msg) throw new Error(`unknown_message: ${messageId}`);
    if (!this.controlPlane.principalMayServe(principal, msg.receiver)) {
      throw new Error(`not_authorized_for_queue: ${msg.receiver}`);
    }
    if (this.lockOwnerOf(messageId) !== principal) throw new Error(`not_lock_owner: ${messageId}`);
    const token = this.controlPlane.issueLease(sessionToken, messageId).token; // CP re-verifies lock owner
    this._openContext(token); // open the execution context (retrieve its handle via contextFor if needed)
    return token;
  }

  // Lock and lease a SPECIFIC pending message (authenticated + authorized for its receiver queue).
  // Which pending message a worker takes is a scheduling detail, not a security property -- the
  // security property is that the caller authenticated and is authorized for that queue -- so this is
  // a legitimate authenticated entry point (used by multi-writer seeding where each record is written
  // under its own source message). Returns a lease token.
  claimSpecific(sessionToken, messageId) {
    const principal = this.controlPlane.authenticate(sessionToken);
    const msg = this.getMessage(messageId);
    if (!msg) throw new Error(`unknown_message: ${messageId}`);
    if (!this.controlPlane.principalMayServe(principal, msg.receiver)) {
      throw new Error(`not_authorized_for_queue: ${msg.receiver}`);
    }
    // Conditional lock: only succeeds if the message is still pending. We then VERIFY (not assume)
    // that this principal actually holds the lock before issuing a lease -- otherwise a second caller
    // could lease a message another principal already locked (the UPDATE silently affects 0 rows).
    this.db.prepare(`
      UPDATE message_queue SET status='locked', locked_by=?, locked_at=?, lock_generation=lock_generation+1 WHERE message_id=? AND status='pending'
    `).run(principal, nowIso(), messageId);
    if (this.lockOwnerOf(messageId) !== principal) throw new Error(`not_lock_owner: ${messageId}`);
    const token = this.controlPlane.issueLease(sessionToken, messageId).token; // CP re-verifies lock owner
    this._openContext(token); // open the execution context (handle via contextFor(leaseToken) when needed)
    return token;
  }

  // The execution-context capability token for a held lease (claimSpecific/leaseFor return a bare lease
  // token; this yields the context handle for attachInput/complete/context-bound send).
  contextFor(leaseToken) {
    return this.controlPlane.contextTokenForLease(leaseToken);
  }

  // Attach an additional consumed input to a live execution context (explicit multi-input merge). The
  // additional input is a lease the same principal already holds; the context integrity drops to the meet
  // with that input's signed integrity, snapshotted now. Persists the updated context + input manifest.
  attachInput(sessionToken, contextToken, additionalLeaseToken) {
    const updated = this.controlPlane.attachContextInput(sessionToken, contextToken, additionalLeaseToken);
    this._persistContext(updated);
    return this.controlPlane.contextSnapshot(contextToken);
  }

  // Data-plane attach (review S7): the additional input is identified by ANOTHER CONTEXT the same principal
  // holds (an agent never handles raw leases). We resolve that context's primary lease and merge it.
  attachInputByContext(sessionToken, contextToken, additionalContextToken) {
    const additionalLease = this.controlPlane.primaryLeaseFor(sessionToken, additionalContextToken);
    return this.attachInput(sessionToken, contextToken, additionalLease);
  }

  // Close a live execution context. A completed/aborted context can produce no further output and its
  // leases are revoked, so any subsequent read/write/send/attach under it fails closed.
  complete(sessionToken, contextToken) {
    this._persistContext(this.controlPlane.completeContext(sessionToken, contextToken, "completed"));
  }

  abort(sessionToken, contextToken) {
    this._persistContext(this.controlPlane.completeContext(sessionToken, contextToken, "aborted"));
  }

  // Context-driven write (review S11/S12): an ordinary agent writes through its execution CONTEXT, not a
  // hand-picked lease. The integrity is the context's; the record's source/run/task/policy are the
  // context's claimed message. The lease-centric write path (lock/freshness re-verification) is reused
  // under the primary lease, so the caller never selects which lease backs the record.
  write(sessionToken, contextToken, content, options = {}) {
    const leaseToken = this.controlPlane.primaryLeaseFor(sessionToken, contextToken);
    return this.writeMemory(content, leaseToken, options);
  }

  // Write through the trusted path. The record's run/task/policy/source/writer are AUTHORITATIVE from
  // the lease's canonical message and authenticated principal; the writer cannot self-declare them
  // (review M2). The receipt is minted by the control plane over the full content hash; a record not
  // produced here cannot carry a valid receipt (review M1).
  writeMemory(content, leaseToken, options = {}) {
    const lease = this.controlPlane.resolveLease(leaseToken);
    const currentMessage = this.getMessage(lease.messageId);
    if (!currentMessage) throw new Error(`active message not found: ${lease.messageId}`);
    this._attestEnvelope(currentMessage, lease.messageId); // authorization context must be a signed envelope
    const timestamp = nowIso();
    // (v20 CE20-01) The record's FULL causal dependency set = the writing context's input frontier (every
    // attachContextInput), beyond the primary source message. Bound into the record (below) so the read gate can
    // require each consumed input to be in the reader's closure -- a record that depended on a cross-branch input
    // the reader cannot reach is denied, not silently admitted with only its integrity lowered. Null for a bare
    // lease (no context): a direct writeMemory has only its source, already gate-checked.
    const _frontier = this.controlPlane.contextInputFrontierForLease(leaseToken);
    const extraInputs = Array.isArray(_frontier)
      ? [...new Set(_frontier.filter((mid) => mid && mid !== currentMessage.message_id))] : [];
    // Effect ceiling (Gate 2.0 #4) is a RESTRICTION the writer asks the monitor to enforce: an array of the
    // effect classes this record may justify (an empty array = "justify NO effect"). It MUST be an array.
    // Previously a non-array ceiling (e.g. the string "read") failed `Array.isArray` below and was silently
    // dropped, persisting effect_ceiling=null. That turned a writer's intended restriction into a non-capping
    // record, and older external dispatch code treated a null capability as TOP. Fail CLOSED on a writer type
    // error instead: a malformed ceiling is rejected, never reinterpreted as "not supplied". (null/undefined =
    // intentionally not supplied, preserved below, and never a positive external-effect grant.)
    if (options.effect_ceiling != null && !Array.isArray(options.effect_ceiling)) {
      throw new Error("effect_ceiling must be an array of effect classes");
    }
    // AUTHORIZATION metadata is authoritative from the lease's canonical message and the authenticated
    // principal -- the writer cannot override it (review M1.2). Otherwise a writer leased for task A
    // could stamp task_id=B (or widen scope to run/global) and have the control plane sign a receipt
    // for a cross-task confused-deputy record. The writer controls only the record's CONTENT and its
    // descriptive typing; allowed_readers is a grant scoped to the record's authoritative run/task
    // (it cannot name a principal outside that scope, because run/task/scope are fixed here).
    const memory = {
      memory_id: options.memory_id ?? `mem-${randomUUID()}`,
      run_id: currentMessage.run_id,            // authoritative
      task_id: currentMessage.task_id,          // authoritative (review M1.2)
      trace_id: currentMessage.trace_id,        // authoritative
      source_message_id: currentMessage.message_id, // authoritative
      // (v20 CE20-00) Write-EVENT causal position: a monotonic sequence from the SAME per-run counter as messages,
      // allocated NOW (at write time). The read gate requires write_seq <= the active message's sequence, so a
      // record whose write happened-AFTER the active message -- even one re-using an old ancestor's id as its
      // source -- is excluded from that message's causal past. Frozen into the receipt (generic content hash).
      write_seq: this._allocateSequence(currentMessage.run_id),
      writer: lease.principalId,                // authenticated principal, not caller-supplied
      memory_type: options.memory_type ?? "summary",
      scope: "task",                            // authoritative; widening requires a control-plane policy, not options
      // `status` is descriptive only; admission uses the authoritative lifecycle log, not this string.
      status: "active",
      content,
      content_ref: options.content_ref ?? null,
      allowed_readers: options.allowed_readers ?? [currentMessage.receiver],
      // (v19 #3) Supersession authority is bound at WRITE time, not read time. A `supersedes` claim is kept
      // (and frozen into the receipt) ONLY if the writer holds lifecycle authority NOW; an unprivileged writer's
      // claim is dropped to advisory (empty), so a later authority grant cannot retroactively activate it, and
      // the coherent view trusts the stored claim without a live (mutable) role lookup. (A record cannot be
      // forged: a valid receipt requires attestWrite, and the membership ledger catches off-ledger rows.)
      supersedes: (Array.isArray(options.supersedes) && options.supersedes.length
        && typeof this.controlPlane.principalHasLifecycle === "function"
        && this.controlPlane.principalHasLifecycle(lease.principalId)) ? options.supersedes : [],
      valid_from_event: options.valid_from_event ?? null,
      valid_until_event: options.valid_until_event ?? null,
      policy_context: currentMessage.policy_context ?? null, // authoritative
      // Write-time integrity, computed by the control plane from the writer's clearance and the verified
      // source-message integrity, and FROZEN into the record (covered by the content hash + receipt). Read
      // admission uses this attested value, NOT a live clearance lookup, so a later clearance change cannot
      // retroactively reclassify this record.
      integrity: this.controlPlane.writeTimeIntegrity(leaseToken),
      // Logical decision key (Gate 2.0): descriptive like memory_type, but it drives the set-level
      // coherent-view gate (same-key concurrent versions need a resolution certificate). Included only when
      // supplied so records without it hash identically; covered by the content hash + receipt either way.
      ...(options.logical_key ? { logical_key: options.logical_key } : {}),
      // Effect ceiling (Gate 2.0 #4): the effect classes this record may justify; covered by the hash. A
      // non-array ceiling was already rejected above, so here it is either a (possibly empty) array -- a real
      // positive grant -- or null/undefined (not supplied = no external-effect grant), which is dropped so such
      // records hash identically. Internal/non-external reads still treat absence as not capping the meet.
      ...(Array.isArray(options.effect_ceiling) ? { effect_ceiling: options.effect_ceiling } : {}),
      // (v20 CE20-01) Attached input frontier (additional consumed inputs beyond the source). Included only when
      // non-empty so records written without attached inputs hash identically; covered by the content hash + receipt.
      ...(extraInputs.length ? { input_frontier: extraInputs } : {}),
    };
    const hash = memoryContentHash(memory);
    // The control plane mints ONLY after re-verifying, internally, that the lease is valid and the record's
    // FULL authoritative metadata (source, writer, run/task/trace/policy/scope, frozen integrity) matches
    // the lease's verified canonical message -- there is no public mint oracle and no metadata trusted from
    // the caller, so a held control-plane reference cannot forge a receipt for an unauthorized record.
    const { receipt } = this.controlPlane.attestWrite(leaseToken, memory);
    const insertRow = () => this.db.prepare(`
      INSERT INTO shared_memory (
        memory_id, run_id, task_id, trace_id, source_message_id, writer, memory_type,
        scope, status, content, content_ref, allowed_readers_json, supersedes_json,
        valid_from_event, valid_until_event, policy_context, integrity, logical_key, effect_ceiling,
        write_seq, input_frontier_json, audit_hash, write_receipt, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      memory.memory_id, memory.run_id, memory.task_id, memory.trace_id, memory.source_message_id,
      memory.writer, memory.memory_type, memory.scope, memory.status, memory.content, memory.content_ref,
      asJson(memory.allowed_readers), asJson(memory.supersedes), memory.valid_from_event,
      memory.valid_until_event, memory.policy_context, memory.integrity, memory.logical_key ?? null,
      memory.effect_ceiling ? asJson(memory.effect_ceiling) : null,
      memory.write_seq ?? null, memory.input_frontier ? asJson(memory.input_frontier) : null,
      hash, receipt, timestamp, timestamp,
    );
    // (v19 #1) ATOMIC write: an authority-bearing record (effect_ceiling/logical_key) and its membership-ledger
    // entry + anchor commit in ONE transaction, so a crash can never leave the row in the store WITHOUT the
    // ledger entry (which a later deletion would then widen undetected). The MAC chain head is advanced ONLY
    // after COMMIT (peek/commit), so a rollback leaves head and store both unadvanced -- no DoS, no off-ledger
    // row; a crash after COMMIT is healed by seedMembershipHead from the committed anchor at restart. A plain
    // record carries no restriction, so its omission only empties the view (fail-safe) -- no ledger coupling.
    const authorityBearing = (Array.isArray(memory.effect_ceiling) || memory.logical_key != null)
      && typeof this.controlPlane.nextAuthorityMember === "function";
    if (authorityBearing) {
      this._assertNotInExec("authority-bearing write"); // no nesting inside executeAuthorizedAction's txn
      const next = this.controlPlane.nextAuthorityMember(memory.run_id, memory.memory_id, hash); // pure, no head advance
      this.db.exec("BEGIN IMMEDIATE");
      try {
        insertRow();
        if (next) {
          const mts = nowIso();
          this.db.prepare("INSERT OR REPLACE INTO authority_membership (run_id, memory_id, digest, seq, prev_mac, mac) VALUES (?,?,?,?,?,?)")
            .run(memory.run_id, memory.memory_id, hash, next.seq, next.prev_mac, next.mac);
          this.db.prepare(`
            INSERT INTO kernel.membership_anchor (id, count, last_mac, last_seq, updated_at) VALUES ('global', ?, ?, ?, ?)
            ON CONFLICT(id) DO UPDATE SET count = excluded.count, last_mac = excluded.last_mac, last_seq = excluded.last_seq, updated_at = excluded.updated_at
          `).run(next.count, next.mac, next.seq, mts);
        }
        this.db.exec("COMMIT");
      } catch (e) { try { this.db.exec("ROLLBACK"); } catch {} throw e; }
      if (next) this.controlPlane.commitAuthorityMember(memory.run_id, memory.memory_id, hash, next); // advance head AFTER commit
    } else {
      insertRow();
    }
    // Advance the TCB monotonic key version (security-kernel pivot): a new same-key record strictly bumps the
    // decision epoch, so a view prepared before this write is detected as stale at commit even if a later raw
    // row-delete restores the record COUNT.
    this._bumpKeyVersion(memory.run_id, memory.logical_key);
    this.recordEvent({
      event_type: "memory_written", run_id: memory.run_id, task_id: memory.task_id,
      trace_id: memory.trace_id, message_id: currentMessage.message_id, memory_id: memory.memory_id,
      agent: memory.writer, result: "active", payload: { memory_type: memory.memory_type, scope: memory.scope },
    });
    // Record the write as a context output (review S3.1) -- attributable to (context, version) for audit.
    this._recordOutput(this.controlPlane.noteContextOutput(leaseToken, null,
      { kind: "memory", outputId: memory.memory_id, digest: hash, integrity: memory.integrity }));
    return { ...memory, audit_hash: hash, write_receipt: receipt, created_at: timestamp, updated_at: timestamp };
  }

  // ---- authoritative lifecycle (review M5) -----------------------------------------------------

  // A lifecycle/resolution append advances the control plane's TCB-held head (in ControlPlane memory) AND
  // inserts the event row in the DB. Those two steps are atomic ONLY when there is no enclosing explicit
  // transaction: outside one the insert autocommits with the head advance. Inside executeAuthorizedAction's
  // BEGIN IMMEDIATE txn, however, a later ROLLBACK undoes the DB row but CANNOT undo the in-memory head ->
  // head.count outruns the persisted event count and every subsequent _verified*Events() throws
  // "*_log_tampered: count mismatch", a self-inflicted denial of service. The ONLY deployer code that runs
  // inside that txn is the destinationPolicy callback, so we forbid head-advancing authority mutations while
  // _inExec is set -- the same reentrancy invariant that already blocks a re-entrant executeAuthorizedAction
  // (a policy/dispatcher callback must not mutate authority state). Fail-closed: the throw aborts the action.
  _assertNotInExec(op) {
    if (this._inExec) throw new Error(`lifecycle_mutation_during_authorization: ${op} is forbidden inside executeAuthorizedAction`);
  }

  _appendLifecycle(sessionToken, { memory_id, kind, superseded_by = null }) {
    this._assertNotInExec(`lifecycle ${kind}`); // before any head advance -> no rollback desync
    const principal = this.controlPlane.authenticate(sessionToken);
    if (!this.controlPlane.principalHasLifecycle(principal)) {
      throw new Error("not_authorized_for_lifecycle");
    }
    // MAC-chain the event onto the anchor (review M3): seq = last+1, prev_mac = anchor head, mac covers
    // both, so a later deletion/reorder is detectable.
    const policy_version = this.controlPlane.policyVersion;
    // The control plane derives seq/prev_mac from its TCB-held head (not the writable anchor) and returns
    // the chained mac; we persist the event + mirror the head to the DB for durable restore.
    const { seq, prev_mac, mac } = this.controlPlane.lifecycleAppend(sessionToken,
      { memory_id, kind, superseded_by, by_principal: principal, policy_version });
    const ts = nowIso();
    // Persist the event then mirror the head (review M5: crash consistency). The TCB head was already
    // advanced in lifecycleAppend, so if either write is lost the head is AHEAD of the store and the next
    // read fails closed (count mismatch) rather than silently diverging -- no unsafe state results.
    this.db.prepare(`
      INSERT INTO memory_lifecycle_events (event_id, memory_id, kind, superseded_by, by_principal, policy_version, seq, prev_mac, mac, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(`lc-${randomUUID()}`, memory_id, kind, superseded_by, principal, policy_version, seq, prev_mac, mac, ts);
    this.db.prepare(`
      INSERT INTO kernel.lifecycle_anchor (id, count, last_mac, last_seq, updated_at) VALUES ('global', 1, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET count = count + 1, last_mac = excluded.last_mac, last_seq = excluded.last_seq, updated_at = excluded.updated_at
    `).run(mac, seq, ts);
    // Retiring/superseding a same-key record changes the decision set, so bump the TCB monotonic key version
    // (security-kernel pivot) -- a view prepared before this retirement is detected as stale at commit.
    const lm = this.getMemoryRow(memory_id);
    if (lm) this._bumpKeyVersion(lm.run_id, lm.logical_key);
  }

  // Verify the lifecycle MAC chain against the anchor and return the ordered, verified events. Fails
  // closed (review M3) if any event's MAC is invalid, the chain is broken (deletion/reorder), or the
  // event count / chain head disagree with the anchor -- so deleting a revocation cannot silently
  // un-retire a record.
  _verifiedLifecycleEvents() {
    const events = this.db.prepare(
      "SELECT memory_id, kind, superseded_by, by_principal, policy_version, seq, prev_mac, mac FROM memory_lifecycle_events ORDER BY seq ASC").all();
    // The head is the TCB-held one (control plane memory), NOT the writable anchor row, so a suffix
    // rollback (delete events + replay an old valid anchor) is detected: the store no longer matches the
    // authoritative head and we fail closed.
    const head = this.controlPlane.lifecycleHead();
    if (events.length !== head.count) throw new Error("lifecycle_log_tampered: count mismatch");
    let prev = "";
    for (const e of events) {
      if ((e.prev_mac ?? "") !== prev) throw new Error("lifecycle_log_tampered: chain broken");
      if (!this.controlPlane.verifyLifecycle(e)) throw new Error("lifecycle_log_tampered: bad mac");
      prev = e.mac;
    }
    if ((head.lastMac ?? "") !== prev) throw new Error("lifecycle_log_tampered: head mismatch");
    if (events.length && head.lastSeq !== events[events.length - 1].seq) throw new Error("lifecycle_log_tampered: seq mismatch");
    return events;
  }

  supersede(sessionToken, oldId, newId) { this._appendLifecycle(sessionToken, { memory_id: oldId, kind: "supersede", superseded_by: newId }); }
  expire(sessionToken, id) { this._appendLifecycle(sessionToken, { memory_id: id, kind: "expire" }); }
  revoke(sessionToken, id) { this._appendLifecycle(sessionToken, { memory_id: id, kind: "revoke" }); }

  // The set of memory ids retired by the authoritative lifecycle log: a record is retired if it has an
  // expire/revoke event, or a supersede event names it as the OLD record.
  retiredMemoryIds() {
    const retired = new Set();
    for (const r of this._verifiedLifecycleEvents()) { // M3: verified chain, fails closed on tamper
      retired.add(r.memory_id);
    }
    return retired;
  }

  // Causal closure from VERIFIED SIGNED EDGES only (re-review critical-1 fix). The base class walks the
  // unsigned relational `messages.parent_message_id` column, which a store-write adversary can rewrite
  // without breaking the signature. Here we read each message's signed envelope, verify its signature,
  // and use the SIGNED parent/delegation/sequence edges from the envelope -- so tampering the relational
  // column has no effect on authorization (a message whose signature does not verify is excluded).
  causalAncestry(activeMessage) {
    // Delegates to the SINGLE fail-closed closure verifier shared with the audit replay (review S21): one
    // strict traversal over signed parent/delegation edges. Every referenced ancestor must exist, be
    // identity-bound to its row (getMessage returns null otherwise), and carry a valid signature, else the
    // whole closure throws -- a claimed-but-unattestable lineage aborts the read rather than dropping a node.
    // The base class's lenient `causalAncestryFromMessages` is the OFFLINE/ranking helper and is never used
    // on this security path.
    return verifiedCausalClosure({
      activeId: activeMessage.message_id,
      lookupMessage: (id) => this.getMessage(id),
      verifyEnvelope: (env) => this.controlPlane.verifyEnvelope(env),
    });
  }

  // ---- strict gate (no disable surface) --------------------------------------------------------

  evaluateSecureGate(memory, currentMessage, { causalClosure, retiredIds, delegatedIds }) {
    if (memory.audit_hash && memoryContentHash(memory) !== memory.audit_hash) {
      return { decision: "deny", reason: "integrity_mismatch" };
    }
    if (!this.controlPlane.verifyReceipt(memory)) {
      return { decision: "deny", reason: "provenance_not_attested" };
    }
    if (memory.run_id !== currentMessage.run_id) return { decision: "deny", reason: "run_id_mismatch" };
    // Cross-task delegation (Gate 2.0 #delegate): a record from another task is admitted ONLY if a verified
    // delegation certificate authorizes it to this task+receiver; un-delegated cross-task records stay denied.
    // Delegation grants read; integrity is unchanged, so the integrity-flow predicate below still applies.
    const taskMatches = memory.task_id === currentMessage.task_id || ["run", "global"].includes(memory.scope)
      || (delegatedIds && delegatedIds.has(memory.memory_id));
    if (!taskMatches) return { decision: "deny", reason: "task_scope_mismatch" };
    if (retiredIds.has(memory.memory_id)) return { decision: "deny", reason: "inactive_memory" };
    const sourceEnvelope = memory.source_message_id ? this.getMessage(memory.source_message_id) : null;
    if (!sourceEnvelope) {
      return { decision: "deny", reason: "missing_provenance_message" };
    }
    if (!causalClosure.has(memory.source_message_id)) {
      return { decision: "deny", reason: "provenance_not_in_causal_graph" };
    }
    // (v20 CE20-00) WRITE-EVENT causal precedence -- not just source-message ancestry. The source label is a
    // message id a writer can re-claim long after that message was created, so source-in-closure alone admits a
    // record whose WRITE happened-AFTER the reader's active message was created (a post-hoc insertion laundered
    // into causal history). Every secure write is stamped with write_seq from the per-run counter that also
    // numbers messages, giving the write event a position in the SAME causal order. The cut is the active
    // message's own SIGNED CREATION sequence (currentMessage.sequence): a record is admitted only if its write
    // happened-before (<=) the active message was created. Binding the cut to the signed, attacker-immutable
    // message (not a claim-time value an in-flight reader could advance) means a record written after a victim
    // message was created is excluded even if that victim claims it later. The sequence is a verified numeric
    // clock (requireEnvelope rejects non-numeric, so adoption/edge ordering cannot be poisoned either). Fail
    // closed on a record with no write event; the isFinite guard only skips a (signed) message somehow lacking
    // a sequence -- which requireEnvelope now prevents.
    const activeSeq = Number(currentMessage.sequence);
    if (Number.isFinite(activeSeq) && (memory.write_seq == null || Number(memory.write_seq) > activeSeq)) {
      return { decision: "deny", reason: "write_after_active" };
    }
    // (v20 CE20-01) FULL input-frontier reachability. The record bound every input its writing context consumed
    // (attachContextInput), not just the primary source. A reader must be able to reach EACH consumed input in
    // its own causal closure (or via a delegation that authorizes it) -- otherwise a record that depended on a
    // cross-branch input outside the reader's closure would be admitted with only its integrity lowered, hiding
    // the dependency. Fail closed on any unreachable, un-delegated input.
    if (Array.isArray(memory.input_frontier)) {
      for (const inMid of memory.input_frontier) {
        // (v20 red-team) The input MUST be reachable in the reader's own closure. A record-level delegation cert
        // grants cross-task READ of THIS record; it does NOT vouch for the record's hidden inputs, so it must
        // NOT waive the frontier check (the old `delegatedIds.has(memory_id)` escape waived the whole invariant
        // for any delegated record, re-admitting an unreachable cross-branch dependency). A delegated record
        // whose every input is reachable still passes; one with an unreachable input fails closed.
        if (!causalClosure.has(inMid)) {
          return { decision: "deny", reason: "input_not_in_causal_graph" };
        }
      }
    }
    // Integrity flow (Biba "no read-down"): a high-integrity active context must not ingest a record whose
    // provenance is less trusted. The record's integrity was FROZEN at write time by the control plane
    // (meet of writer clearance and verified source-message integrity) and is covered by the receipt
    // verified above -- so we use the attested value, not a live clearance lookup, and a later clearance
    // change cannot retroactively reclassify the record. The active context's integrity comes from its
    // signed envelope (verified when the closure was built).
    const recordIntegrity = integrityLevel(memory.integrity);
    const contextIntegrity = integrityLevel(currentMessage.integrity);
    if (recordIntegrity < contextIntegrity) {
      return { decision: "deny", reason: "integrity_below_context" };
    }
    const allowedReaders = new Set(memory.allowed_readers ?? []);
    if (!allowedReaders.has("*") && !allowedReaders.has(currentMessage.receiver)) {
      return { decision: "deny", reason: "reader_not_authorized" };
    }
    // Own-property guard (parity with resolveTool): a prototype-member intent must resolve to undefined and hit
    // the fail-closed `intent_unknown` deny below, not a truthy inherited member that would throw on `.has()`.
    const allowedTypes = Object.hasOwn(INTENT_MEMORY_TYPES, currentMessage.intent)
      ? INTENT_MEMORY_TYPES[currentMessage.intent] : undefined;
    if (!allowedTypes) return { decision: "deny", reason: "intent_unknown" }; // fail closed
    if (!allowedTypes.has(memory.memory_type)) return { decision: "deny", reason: "intent_memory_type_mismatch" };
    if (!memory.policy_context) return { decision: "deny", reason: "policy_context_missing" }; // fail closed
    if (memory.policy_context !== currentMessage.policy_context) return { decision: "deny", reason: "policy_context_mismatch" };
    return { decision: "allow", reason: "message_bound_access_granted" };
  }

  // ---- Gate 2.0: set-level coherent view + read-to-use transactions ---------------------------------

  // The set-level pass on top of the per-record gate (review: ancestry != authority). Among records that
  // passed the per-record gate, group by logical_key; within a group, a record whose source is a STRICT
  // causal ancestor of another's is SUPERSEDED (latest-in-lineage wins). If two or more remain that are
  // causally CONCURRENT (incomparable -- the true-merge case), they are competing versions of one decision:
  // admit only those a verified resolution certificate names ADOPTED, else deny the whole conflict
  // (REQUIRE_RESOLUTION, fail-closed). Returns Map(memory_id -> deny_reason) for records it removes.
  _coherentView(prelimAllowed, resolutionLookup, adoptedRecords = new Map()) {
    const denials = new Map();
    const byKey = new Map();
    for (const m of prelimAllowed) {
      if (m.logical_key == null) continue;
      if (!byKey.has(m.logical_key)) byKey.set(m.logical_key, []);
      byKey.get(m.logical_key).push(m);
    }
    const closureCache = new Map();
    const ancestorsOf = (mid) => {
      if (!closureCache.has(mid)) closureCache.set(mid, this.causalAncestry({ message_id: mid }));
      return closureCache.get(mid);
    };
    for (const [key, recs] of byKey) {
      const cert = resolutionLookup(key); // verified, current-epoch, RUN-SCOPED certificate or null
      // (round-2 red-team) A verified current-epoch certificate is AUTHORITATIVE over this key's conflict ACROSS
      // EVERY branch, not only where >=2 versions are co-visible. Per-record provenance can hide the accepted
      // sibling, leaving a REJECTED record or a NEW (uncovered) record as the lone same-key version; the old
      // single-version short-circuit then served it without consulting the cert (a B-only / D-only reader thereby
      // reinstated a forbidden effect_ceiling and dispatched, audit-invisibly). So apply the cert UNIFORMLY here,
      // before any short-circuit:
      if (cert) {
        const covered = new Set([...(cert.accepted || []), ...(cert.rejected || [])]);
        const accepted = new Set(cert.accepted || []);
        if (recs.some((r) => !covered.has(r.memory_id))) {
          // (v19 #2) A same-key record OUTSIDE the conflict the cert resolved (a new/uncovered version) means the
          // conflict set changed: the stale cert no longer authoritatively resolves it. Deny the WHOLE key on
          // every branch (require a fresh resolution), so a lone uncovered record is never served single-version.
          for (const r of recs) denials.set(r.memory_id, "conflict_set_changed");
        } else {
          // All visible same-key records are covered: serve ONLY the accepted, deny the rejected, on every branch.
          for (const r of recs) if (!accepted.has(r.memory_id)) denials.set(r.memory_id, "resolution_rejected");
        }
        continue;
      }
      // ---- no certificate for this key in this run: ancestry/supersession + adopt-edge, else unresolved ----
      if (recs.length < 2) continue; // a single version is authoritative
      const live = recs;
      const dominated = new Set();
      for (const r of live) for (const r2 of live) {
        if (r === r2 || r.source_message_id === r2.source_message_id) continue;
        // (v18 P8 + round-3) Supersession is EXPLICIT \emph{and} AUTHORIZED, not inferred from ancestry nor from
        // a writer's self-declared field. r is dominated by r2 only if (a) r2 carries an attested supersedes
        // claim naming r, (b) r2's source is a causal descendant of r's (temporally well-formed), AND (c) r2's
        // WRITER holds lifecycle (supersession) authority. Absent authorized supersession, a self-declared
        // supersedes is advisory: the two stay competing concurrent versions (require an adopt edge or a signed
        // resolution), so an unprivileged agent cannot evict a restrictive record from the capability meet.
        // (v19 #3) The `supersedes` claim is already WRITE-TIME-authorized (writeMemory drops it unless the
        // writer held lifecycle authority at write), and it is frozen into the record's receipt -- so the
        // coherent view trusts the stored claim and does NOT re-read the writer's (mutable) current role, which
        // would let a later authority grant retroactively activate a claim made while unauthorized.
        const claims = Array.isArray(r2.supersedes) ? r2.supersedes : [];
        // (v18 round-5) Biba integrity floor: r2 may supersede r only if I(r2) >= I(r), so a low-integrity
        // writer cannot drop a high-integrity restriction from the capability meet (no-write-down).
        const integrityOk = (Number(r2.integrity) || 0) >= (Number(r.integrity) || 0);
        if (integrityOk && claims.includes(r.memory_id) && ancestorsOf(r2.source_message_id).has(r.source_message_id)) dominated.add(r.memory_id);
      }
      for (const r of live) if (dominated.has(r.memory_id)) denials.set(r.memory_id, "superseded_in_lineage");
      const maximal = live.filter((r) => !dominated.has(r.memory_id));
      if (maximal.length <= 1) continue; // unique latest -> authoritative
      // Adopt-edge authority (Gate 2.0 #1): if exactly one concurrent version is explicitly ADOPTED via an
      // adopt/resolve edge in the active closure, it is authoritative WITHOUT a resolution certificate; the
      // others are advisory (not_adopted). Adoption is bound to a record id + digest + write event, never to
      // the whole source message. A source-message-only adopt edge adopts nothing (fail closed).
      const adoptedMaximal = maximal.filter((r) => {
        const cert = adoptedRecords.get(r.memory_id);
        if (!cert) return false;
        const ws = Number(r.write_seq);
        if (!Number.isFinite(ws) || ws !== cert.write_seq || ws > cert.adopt_seq) return false;
        if (cert.logical_key != null && cert.logical_key !== r.logical_key) return false;
        return cert.record_digest === memoryContentHash(r);
      });
      if (adoptedMaximal.length === 1) {
        const winner = adoptedMaximal[0];
        const wInt = Number(winner.integrity) || 0;
        const losers = maximal.filter((r) => r.memory_id !== winner.memory_id);
        // (round-7) Biba floor on the adopt edge -- mirrors the supersession floor above and the cert-winner floor
        // in _computeView. An adopted winner may evict a same-key loser ONLY if it dominates the loser's
        // integrity; a low-integrity adopter must not evict a high-integrity restriction (no-write-down). If any
        // loser outranks the winner, the adopt is insufficient -> unresolved_conflict (fail closed), so the
        // restriction is not dropped from the capability meet.
        if (losers.every((r) => wInt >= (Number(r.integrity) || 0))) {
          for (const r of losers) denials.set(r.memory_id, "not_adopted");
          continue;
        }
      }
      // No certificate and no INTEGRITY-VALID unique adopt edge: competing concurrent versions are an unresolved
      // conflict; deny the whole set fail-closed (a fresh resolution or an adequate adopt edge is required).
      for (const r of maximal) denials.set(r.memory_id, "unresolved_conflict");
    }
    return denials;
  }

  // The set of RECORDS adopted by explicit adopt/resolve typed edges in the active closure. The edge must bind
  // record_id + record_digest + write_seq (and optionally logical_key). A bare Adopt(sourceMessage) edge adopts
  // nothing, closing the source-message-scoped authority rebinding found by the independent audit.
  _adoptedRecords(closure) {
    const adopted = new Map();
    for (const mid of closure) {
      const node = this.getMessage(mid);
      if (!node || !Array.isArray(node.parents)) continue;
      const at = Number(node.sequence);
      // (v20 red-team) FAIL CLOSED: an adopt node whose sequence is not a finite number cannot bound which
      // records it adopts, so it adopts NOTHING (-Infinity), never EVERYTHING (Infinity). A non-numeric sequence
      // is also rejected at the source (requireEnvelope), but this keeps the bound safe even if one slips in.
      const seq = Number.isFinite(at) ? at : -Infinity;
      for (const p of node.parents) {
        if (p && p.id && (p.type === "adopt" || p.type === "resolve")) {
          const rid = p.record_id ?? p.memory_id ?? null;
          const rd = p.record_digest ?? p.digest ?? null;
          const ws = Number(p.write_seq);
          if (!rid || !rd || !Number.isFinite(ws)) continue;
          const prev = adopted.get(rid);
          if (!prev || seq > prev.adopt_seq) {
            adopted.set(rid, { source_message_id: p.id, record_digest: rd, logical_key: p.logical_key ?? null,
              write_seq: ws, adopt_seq: seq });
          }
        }
      }
    }
    return adopted;
  }

  // Per-record gate + coherent-view pass, shared by the live read AND the audit replay so both compute the
  // SAME final verdicts (no online/replay divergence). `resolutionLookup(key) -> cert|null` lets replay use
  // the resolution state SNAPSHOTTED at read time (re-verified), not the live table, so a later resolution
  // does not retroactively change a logged decision. Returns Map(memory_id -> {decision, reason}).
  _gateCandidates(records, activeMessage, causalClosure, retiredIds, resolutionLookup = (k) => this._resolutionFor(k), delegatedIds = new Set(), opts = {}) {
    const prelim = new Map();
    for (const m of records) prelim.set(m.memory_id, this.evaluateSecureGate(m, activeMessage, { causalClosure, retiredIds, delegatedIds }));
    const prelimAllowed = records.filter((m) => prelim.get(m.memory_id).decision === "allow");
    const adoptedRecords = this._adoptedRecords(causalClosure);
    // Ablation hook (evaluation only, NOT exposed to the data-plane facade): skip the set-level coherent-view
    // pass to measure the per-record-only condition in the Gate 2.0 schedule evaluation. Default: full gate.
    const denials = opts.skipCoherentView ? new Map() : this._coherentView(prelimAllowed, resolutionLookup, adoptedRecords);
    const out = new Map();
    for (const m of records) {
      let v = prelim.get(m.memory_id);
      if (v.decision === "allow" && denials.has(m.memory_id)) v = { decision: "deny", reason: denials.get(m.memory_id) };
      out.set(m.memory_id, v);
    }
    return out;
  }

  // The verified, current-policy-epoch resolution certificate for a logical_key, or null. A forged/tampered
  // or stale-epoch certificate is ignored, so the conflict stays REQUIRE_RESOLUTION (fail-closed).
  // (v19 round-2 #3) A resolution governs the conflict OF A SPECIFIC RUN. Certificates are chained globally by
  // logical_key, but logical_key is attacker-chosen free text, so a cert issued for the same key string in a
  // DIFFERENT run must NOT shadow this run's resolution. A cert applies to runId iff a record it NAMES belongs to
  // runId (record ids are unique and run-stamped); otherwise it is a foreign-run cert and is ignored here.
  _resolutionInRun(e, runId) {
    if (runId == null) return true;
    for (const id of [...parseJson(e.accepted_json, []), ...parseJson(e.rejected_json, [])]) {
      const r = this.db.prepare("SELECT run_id FROM shared_memory WHERE memory_id=?").get(id);
      if (r && r.run_id === runId) return true;
    }
    return false;
  }

  _resolutionFor(logicalKey, runId = null) {
    // Pick the authoritative resolution by monotonic SEQ from the VERIFIED chain, not by the writable
    // created_at: a delete+reinsert breaks the chain (_verifiedResolutionEvents throws -> read fails closed),
    // and a millisecond created_at tie can no longer select the wrong (older) resolution (review: tie-break).
    // Run-scoped (round-2 #3): only certs governing runId are considered.
    let row = null;
    for (const e of this._verifiedResolutionEvents()) if (e.logical_key === logicalKey && this._resolutionInRun(e, runId) && (!row || e.seq > row.seq)) row = e;
    if (!row) return null;
    const cert = { resolution_id: row.resolution_id, logical_key: row.logical_key,
      accepted: parseJson(row.accepted_json, []), rejected: parseJson(row.rejected_json, []),
      conflict_set: parseJson(row.conflict_set_json, []), conflict_set_digest: row.conflict_set_digest ?? "",
      resolver: row.resolver, authority: row.authority, policy_epoch: row.policy_epoch, resolution_sig: row.resolution_sig };
    if (!this.controlPlane.verifyResolution(cert)) return null;
    if (cert.policy_epoch !== this.controlPlane.policyEpoch()) return null;
    return cert;
  }

  // Verify the resolution MAC chain against the TCB head and return the ordered, verified rows (mirror of
  // _verifiedLifecycleEvents). Fails closed if any chain mac is invalid, the chain is broken (deletion /
  // reorder / count-preserving delete+reinsert), or the count/head/seq disagree with the head -- so a
  // store-write adversary cannot resurrect a superseded resolution.
  _verifiedResolutionEvents() {
    const events = this.db.prepare(
      "SELECT resolution_id, logical_key, accepted_json, rejected_json, conflict_set_json, conflict_set_digest, resolver, authority, policy_epoch, resolution_sig, seq, prev_mac, mac FROM merge_resolutions ORDER BY seq ASC").all();
    const head = this.controlPlane.resolutionHead();
    if (events.length !== head.count) throw new Error("resolution_log_tampered: count mismatch");
    let prev = "";
    for (const e of events) {
      if ((e.prev_mac ?? "") !== prev) throw new Error("resolution_log_tampered: chain broken");
      const ev = { resolution_id: e.resolution_id, logical_key: e.logical_key,
        accepted: parseJson(e.accepted_json, []), rejected: parseJson(e.rejected_json, []),
        conflict_set_digest: e.conflict_set_digest ?? "",
        resolver: e.resolver, authority: e.authority, policy_epoch: e.policy_epoch, seq: e.seq, prev_mac: e.prev_mac, mac: e.mac };
      if (!this.controlPlane.verifyResolutionChain(ev)) throw new Error("resolution_log_tampered: bad mac");
      prev = e.mac;
    }
    if ((head.lastMac ?? "") !== prev) throw new Error("resolution_log_tampered: head mismatch");
    if (events.length && head.lastSeq !== events[events.length - 1].seq) throw new Error("resolution_log_tampered: seq mismatch");
    return events;
  }

  _resolutionEpoch() {
    // Verify the chain (fail closed) and return the TCB head's monotonic seq. A new resolution advances the
    // seq, so a token prepared earlier is stale at commit; a tampered chain throws.
    this._verifiedResolutionEvents();
    return this.controlPlane.resolutionHead().lastSeq;
  }

  // Verify the authority-membership MAC chain against the TCB head and return the ordered, verified mirror
  // rows (mirror of _verifiedLifecycleEvents / _verifiedResolutionEvents, v19). Fails closed if any chain mac
  // is invalid, the chain is broken (deletion / reorder), or the count/head/seq disagree with the TCB head --
  // so a post-restart DELETE of a mirror row (which would shrink the authority ledger and widen the capability
  // meet) is detected rather than silently accepted. Returns [] when the control plane predates the chain
  // (membershipHead absent), so an older control plane degrades to the prior in-memory-only behavior.
  _verifiedMembership() {
    if (typeof this.controlPlane.membershipHead !== "function") return [];
    const rows = this.db.prepare(
      "SELECT run_id, memory_id, digest, seq, prev_mac, mac FROM authority_membership ORDER BY seq ASC").all();
    const head = this.controlPlane.membershipHead();
    if (rows.length !== head.count) throw new Error("membership_log_tampered: count mismatch");
    let prev = "";
    for (const e of rows) {
      if ((e.prev_mac ?? "") !== prev) throw new Error("membership_log_tampered: chain broken");
      if (!this.controlPlane.verifyMembership(e)) throw new Error("membership_log_tampered: bad mac");
      prev = e.mac;
    }
    if ((head.lastMac ?? "") !== prev) throw new Error("membership_log_tampered: head mismatch");
    if (rows.length && head.lastSeq !== rows[rows.length - 1].seq) throw new Error("membership_log_tampered: seq mismatch");
    return rows;
  }

  // Issue + persist a signed cross-task delegation certificate (Gate 2.0 #delegate; an authority operation).
  delegate(sessionToken, { memory_ids = [], target_task, target_receiver }) {
    const cert = this.controlPlane.issueDelegation(sessionToken, { memory_ids, target_task, target_receiver });
    this.db.prepare(`INSERT INTO delegations
      (delegation_id, memory_ids_json, target_task, target_receiver, delegator, authority, policy_epoch, delegation_sig, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(cert.delegation_id, asJson(cert.memory_ids), cert.target_task,
      cert.target_receiver, cert.delegator, cert.authority, cert.policy_epoch, cert.delegation_sig, nowIso());
    return cert;
  }

  // Verified delegation certificates that grant records a cross-task read into the active message's
  // task+receiver, plus the set of authorized memory ids. A forged/stale-epoch certificate is ignored.
  _delegationsFor(activeMessage) {
    const rows = this.db.prepare("SELECT * FROM delegations WHERE target_task=? AND (target_receiver=? OR target_receiver='*')")
      .all(activeMessage.task_id, activeMessage.receiver);
    const certs = []; const ids = new Set();
    for (const row of rows) {
      const cert = { delegation_id: row.delegation_id, memory_ids: parseJson(row.memory_ids_json, []),
        target_task: row.target_task, target_receiver: row.target_receiver, delegator: row.delegator,
        authority: row.authority, policy_epoch: row.policy_epoch, delegation_sig: row.delegation_sig };
      if (!this.controlPlane.verifyDelegation(cert)) continue;
      if (cert.policy_epoch !== this.controlPlane.policyEpoch()) continue;
      certs.push(cert); for (const id of cert.memory_ids) ids.add(id);
    }
    return { certs, ids };
  }

  _conflictSetFor(runId, logicalKey) {
    return this.db.prepare("SELECT * FROM shared_memory WHERE run_id=? AND logical_key=? ORDER BY memory_id ASC")
      .all(runId, logicalKey).map(memoryFromRow);
  }

  _conflictSetDigest(rows) {
    const bound = rows.map((m) => ({
      id: m.memory_id,
      digest: memoryContentHash(m),
      logical_key: m.logical_key,
      write_seq: m.write_seq ?? null,
    })).sort((a, b) => String(a.id).localeCompare(String(b.id)));
    return createHash("sha256").update(JSON.stringify(bound)).digest("hex");
  }

  // Issue + persist a signed resolution certificate (an authority operation). Bumps the resolution epoch so
  // a read token prepared before this resolution becomes stale at commit (read-to-use serializability).
  resolveConflict(sessionToken, { logical_key, accepted = [], rejected = [] }) {
    this._assertNotInExec("resolveConflict"); // advances the resolution head -> same rollback-desync hazard
    const resolver = this.controlPlane.authenticate(sessionToken);
    if (!this.controlPlane.principalHasResolution(resolver)) throw new Error("not_authorized_to_resolve");
    // (v19 #2) BIND THE CERT TO THE CONFLICT THAT EXISTS NOW. A certificate may only name records that
    // currently exist AND carry this logical_key: a resolver cannot pre-name a future id (open-ended
    // future authorization) nor a foreign-key record. Combined with the use-time maximal-coverage check in
    // _coherentView (any NEW same-key record left uncovered -> conflict_set_changed -> require_resolution),
    // this confines a cert to the exact conflict set live at issue time. Fail CLOSED on any unknown/foreign id.
    // (v19 round-2 #3) A certificate resolves the conflict OF ONE RUN: every named record must exist, carry this
    // logical_key, AND belong to the SAME run. logical_key is attacker-chosen free text, so without this a single
    // cert spanning runs (or a same-key cert from another run) could govern a foreign run's conflict.
    let certRun = null;
    for (const id of [...accepted, ...rejected]) {
      const row = this.getMemoryRow(id);
      if (!row) throw new Error(`resolution_names_unknown_record:${id}`);
      if (row.logical_key !== logical_key) throw new Error(`resolution_names_foreign_key:${id}`);
      if (certRun == null) certRun = row.run_id;
      else if (row.run_id !== certRun) throw new Error(`resolution_spans_multiple_runs:${id}`);
    }
    const conflictRows = certRun == null ? [] : this._conflictSetFor(certRun, logical_key);
    const conflictIds = conflictRows.map((m) => m.memory_id).sort();
    const namedIds = [...new Set([...accepted, ...rejected])].sort();
    if (JSON.stringify(conflictIds) !== JSON.stringify(namedIds)) {
      throw new Error(`resolution_conflict_set_mismatch:${logical_key}`);
    }
    const conflictDigest = this._conflictSetDigest(conflictRows);
    const cert = this.controlPlane.issueResolution(sessionToken, {
      logical_key, accepted, rejected, conflict_set: conflictIds, conflict_set_digest: conflictDigest,
    });
    // MAC-chain the resolution (parity with _appendLifecycle): the control plane derives seq/prev_mac from
    // its TCB-held head and returns the chained mac; we persist the cert + mirror the head to resolution_anchor
    // for durable restore, so a later delete/reorder/delete+reinsert is detected and fails closed.
    const { seq, prev_mac, mac } = this.controlPlane.resolutionAppend(sessionToken,
      { resolution_id: cert.resolution_id, logical_key: cert.logical_key, accepted: cert.accepted,
        rejected: cert.rejected, conflict_set_digest: cert.conflict_set_digest,
        resolver: cert.resolver, authority: cert.authority, policy_epoch: cert.policy_epoch });
    const ts = nowIso();
    this.db.prepare(`INSERT INTO merge_resolutions
      (resolution_id, logical_key, accepted_json, rejected_json, conflict_set_json, conflict_set_digest,
       resolver, authority, policy_epoch, resolution_sig, seq, prev_mac, mac, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(cert.resolution_id, cert.logical_key, asJson(cert.accepted),
      asJson(cert.rejected), asJson(cert.conflict_set), cert.conflict_set_digest, cert.resolver, cert.authority,
      cert.policy_epoch, cert.resolution_sig, seq, prev_mac, mac, ts);
    this.db.prepare(`INSERT INTO kernel.resolution_anchor (id, count, last_mac, last_seq, updated_at) VALUES ('global', 1, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET count = count + 1, last_mac = excluded.last_mac, last_seq = excluded.last_seq, updated_at = excluded.updated_at
    `).run(mac, seq, ts);
    // A resolution decides which same-key version is authoritative, so bump the TCB monotonic key version
    // (security-kernel pivot) in addition to the resolution epoch -- the run is derived from a named record.
    const anyId = accepted[0] ?? rejected[0];
    const rm = anyId ? this.getMemoryRow(anyId) : null;
    this._bumpKeyVersion(rm ? rm.run_id : null, logical_key);
    return cert;
  }

  getMemoryRow(memoryId) {
    return memoryFromRow(this.db.prepare("SELECT * FROM shared_memory WHERE memory_id=?").get(memoryId));
  }

  // Records that MUST enter the candidate set regardless of the relevance retriever (Gate 2.0 #5): every
  // competing version of a decision (logical_key) in the active run, fetched by exact index. Unioning these
  // into candidates means an attacker who floods a bounded retriever with invalid-but-relevant records
  // cannot suppress a conflicting or authoritative decision from the coherent-view gate.
  _mandatoryRecords(activeMessage) {
    return this.db.prepare("SELECT * FROM shared_memory WHERE run_id=? AND logical_key IS NOT NULL")
      .all(activeMessage.run_id).map(memoryFromRow);
  }

  // PHASE 1 of the read-to-use transaction: run the full Gate 2.0 read and return the admitted view PLUS a
  // signed token binding the exact exposed records (id + content hash) and the policy/resolution epochs at
  // read time, with an intended-effect capability. A later action must present this token to commit.
  // A monotonic-ish version of the decision state for one (run, logical_key): the count of same-key records
  // plus the resolution-chain length for the key. A new same-key record, retirement, or resolution changes
  // it, so a token prepared before the change is detected as stale at commit (review: a new conflict inserted
  // after prepare must invalidate the prepared view, which the global epochs alone did not catch).
  // TCB monotonic version for a security domain/scope (security-kernel pivot). _bumpVersion is the ONLY
  // writer and only ever increments, so -- unlike a COUNT -- it cannot be returned to a prior value by an
  // add-one-delete-one. Each same-key mutation (write/retire/resolution) bumps the 'key' domain.
  _bumpVersion(domain, scopeKey) {
    this.db.prepare(`INSERT INTO kernel.security_versions (domain, scope_key, version, updated_at) VALUES (?, ?, 1, ?)
      ON CONFLICT(domain, scope_key) DO UPDATE SET version = version + 1, updated_at = excluded.updated_at`)
      .run(domain, scopeKey, nowIso());
  }
  _versionOf(domain, scopeKey) {
    const r = this.db.prepare("SELECT version FROM kernel.security_versions WHERE domain=? AND scope_key=?").get(domain, scopeKey);
    return r ? r.version : 0;
  }
  _keyScope(runId, logicalKey) { return `${runId ?? ""}|${logicalKey}`; }
  _bumpKeyVersion(runId, logicalKey) { if (logicalKey != null) this._bumpVersion("key", this._keyScope(runId, logicalKey)); }

  // Per-(run, logical_key) decision epoch. LEADS with the TCB monotonic version (the authoritative signal;
  // strictly monotone so a delete+reinsert that preserves COUNT is still detected), followed by the record
  // count and resolution-chain length as redundant secondary signals -- so the epoch can only become MORE
  // sensitive, never less, than the prior count-based one.
  _keyEpoch(runId, logicalKey) {
    const v = this._versionOf("key", this._keyScope(runId, logicalKey));
    const rec = this.db.prepare("SELECT COUNT(*) AS n FROM shared_memory WHERE run_id=? AND logical_key=?").get(runId, logicalKey);
    let res = -1;
    try { res = this._verifiedResolutionEvents().filter((e) => e.logical_key === logicalKey).length; } catch { res = -1; }
    return `${v}:${rec ? rec.n : 0}:${res}`;
  }

  _capabilityForView(view, { executorScoped = false } = {}) {
    let capability = executorScoped && view.length === 0 ? [] : null;
    for (const m of view) {
      if (!Array.isArray(m.effect_ceiling)) continue;
      capability = capability === null ? [...m.effect_ceiling] : capability.filter((e) => m.effect_ceiling.includes(e));
    }
    return capability;
  }

  _mintReadTokenForView({ view, capability, principalId, activeMessageId, intendedEffect }) {
    const activeMessage = activeMessageId ? this.getMessage(activeMessageId) : null;
    const runId = activeMessage ? activeMessage.run_id : null;
    const key_epochs = {};
    for (const k of [...new Set(view.map((m) => m.logical_key).filter((x) => x != null))]) key_epochs[k] = this._keyEpoch(runId, k);
    const tokenId = `rtok-${randomUUID()}`;
    const expiresAt = new Date(Date.now() + 5 * 60 * 1000).toISOString(); // 5-min TTL: tokens are short-lived
    const payload = {
      token_id: tokenId,
      principal: principalId,
      active_message_id: activeMessageId,
      exposed: view.map((m) => ({ id: m.memory_id, hash: m.audit_hash })).sort((a, b) => String(a.id).localeCompare(String(b.id))),
      policy_epoch: this.controlPlane.policyEpoch(),
      resolution_epoch: this._resolutionEpoch(),
      key_epochs,
      capability,
      intended: intendedEffect,
      expires_at: expiresAt,
    };
    this.db.prepare("INSERT INTO kernel.read_tokens (token_id, principal, active_message_id, consumed, expires_at, created_at) VALUES (?, ?, ?, 0, ?, ?)")
      .run(tokenId, principalId ?? "", activeMessageId ?? null, expiresAt, nowIso());
    return this.controlPlane.mintReadToken(payload);
  }

  _queryCandidateIdsFromSnapshot(candidates, query = {}, activeMessage = null) {
    const terms = String(query?.text ?? "")
      .toLowerCase()
      .split(/\s+/)
      .filter((term) => term.length > 2);
    const score = (m) => terms.reduce((n, t) => n + (m.content?.toLowerCase().includes(t) ? 1 : 0), 0);
    let filtered = candidates
      .filter((memory) => !query.memory_type || memory.memory_type === query.memory_type)
      .filter((memory) => !query.run_id || memory.run_id === query.run_id)
      .filter((memory) => !query.task_id || memory.task_id === query.task_id)
      .filter((memory) => terms.length === 0 || terms.some((term) => memory.content?.toLowerCase().includes(term)));
    if (Number.isFinite(query.topK)) {
      filtered = [...filtered].sort((a, b) => score(b) - score(a)).slice(0, query.topK);
    }
    const ids = new Set(filtered.map((m) => m.memory_id));
    if (activeMessage) {
      for (const m of candidates) if (m.run_id === activeMessage.run_id && m.logical_key != null) ids.add(m.memory_id);
    }
    return ids;
  }

  prepareMemoryRead(query, handle, sessionToken = null, intendedEffect = "read", opts = {}) {
    // Resolve the handle to the principal + active message so the token binds WHO prepared it and the
    // message it was prepared against (review: the token must bind principal + context, not be a bearer cap).
    let principalId = null, activeMessageId = null;
    if (typeof handle === "string" && handle.startsWith("ctx-")) {
      const rc = this.controlPlane.resolveReadContext(sessionToken, handle);
      principalId = rc.principalId; activeMessageId = rc.activeMessageId;
    } else {
      const l = this.controlPlane.resolveLeaseLive(handle);
      principalId = l.principalId; activeMessageId = l.messageId;
    }
    const full = this.readMemory(query, handle, sessionToken, { skipCoherentView: opts.skipCoherentView });
    // Two-context split (Gate 2.0): the EXECUTOR view (opts.executorScope) drops records whose effect
    // ceiling cannot justify the intended effect, so low-trust evidence does not cap a high-trust action;
    // the default REASONING view keeps everything (capability-capped) for utility. Both are sound -- a
    // record only influences the action if it is in the view, and the executor view's capability permits it.
    const executorScoped = !!(opts.executorScope && intendedEffect && intendedEffect !== "read");
    const view = executorScoped
      ? full.filter((m) => !Array.isArray(m.effect_ceiling) || m.effect_ceiling.includes(intendedEffect))
      : full;
    // Effect capability (Gate 2.0 #4): the MEET (intersection) of every exposed record's effect_ceiling.
    // A record with no ceiling does not narrow the meet, but it is not a positive grant for external tools:
    // executeAuthorizedAction requires an explicit exposed effect class before dispatch. Since every exposed
    // record is an influence source, the action a read justifies is bounded by the least-privileged record in
    // the prompt -- low-trust evidence can be observed but not justify a send.
    // In the EXECUTOR view the meet over an EMPTY (all-dropped) set is the EMPTY capability (deny EVERY
    // effect), NOT the universe: if no surviving record can justify the intended effect, the action must be
    // denied -- otherwise dropping the only restrictive record would silently *widen* authority to top.
    const capability = this._capabilityForView(view, { executorScoped });
    const token = this._mintReadTokenForView({ view, capability, principalId, activeMessageId, intendedEffect });
    return { view, capability, token };
  }

  // PHASE 2: a subsequent action presents its token. We re-verify the token and re-validate freshness -- a
  // policy change, a new resolution, a revoked or mutated exposed record since the read makes the prepared
  // view stale (ABORT_AND_RETRY); an effect beyond the bound capability is DENY. Otherwise the action
  // commits against a still-valid, coherent, authorized view (read-to-use serializability).
  commitMemoryUse(action, tokenStr, sessionToken = null) {
    let payload;
    try { payload = this.controlPlane.verifyReadToken(tokenStr); }
    catch (e) { return { decision: "DENY", reason: String(e.message || e) }; }
    // Expiry (review): tokens are short-lived capabilities, not durable bearer tokens.
    if (payload.expires_at && nowIso() > payload.expires_at) return { decision: "DENY", reason: "token_expired" };
    // Principal binding (review): when the committer authenticates (facade path), it must be the principal
    // that prepared the read -- a token is not transferable.
    if (sessionToken != null) {
      let who = null; try { who = this.controlPlane.authenticate(sessionToken); } catch { who = null; }
      if (who !== payload.principal) return { decision: "DENY", reason: "token_principal_mismatch" };
    }
    // Action/intent binding (review CE1): a read-only token authorizes NO side-effecting action; a token
    // prepared for a specific effect may commit ONLY that effect. This is effect-CLASS binding; parameter-level
    // authorization (e.g. the exact recipient) is a stated deployment requirement, not claimed here.
    const eff = action && action.effect ? action.effect : "read";
    if (payload.intended === "read") {
      if (eff !== "read") return { decision: "DENY", reason: "read_token_authorizes_no_action" };
    } else if (eff !== payload.intended) {
      return { decision: "DENY", reason: "action_intent_mismatch" };
    }
    if (payload.policy_epoch !== this.controlPlane.policyEpoch()) return { decision: "ABORT_AND_RETRY", reason: "policy_epoch_changed" };
    let resEpoch;
    try { resEpoch = this._resolutionEpoch(); } catch { return { decision: "DENY", reason: "resolution_log_tampered" }; }
    if (payload.resolution_epoch !== resEpoch) return { decision: "ABORT_AND_RETRY", reason: "resolution_changed" };
    // Per-key conflict freshness (review CE3): a new same-key record / resolution / retirement since prepare
    // changes the key's decision epoch, so the prepared view is no longer the coherent view -> abort. This
    // catches a conflict inserted after prepare, which the global policy/resolution epochs alone missed.
    const active = payload.active_message_id ? this.getMessage(payload.active_message_id) : null;
    const runId = active ? active.run_id : null;
    for (const [k, ep] of Object.entries(payload.key_epochs ?? {})) {
      if (this._keyEpoch(runId, k) !== ep) return { decision: "ABORT_AND_RETRY", reason: "key_state_changed" };
    }
    let retired;
    try { retired = this.retiredMemoryIds(); } catch { return { decision: "DENY", reason: "lifecycle_log_tampered" }; }
    for (const e of payload.exposed) {
      if (retired.has(e.id)) return { decision: "ABORT_AND_RETRY", reason: "exposed_record_revoked" };
      const m = this.getMemoryRow(e.id);
      if (!m || memoryContentHash(m) !== e.hash) return { decision: "ABORT_AND_RETRY", reason: "exposed_record_changed" };
    }
    // Effect ceiling (Gate 2.0 #4): the action's effect must be permitted by the view's capability (the meet
    // of the exposed records' ceilings). A universe (null) capability permits any effect.
    if (Array.isArray(payload.capability) && action && action.effect && !payload.capability.includes(action.effect)) {
      return { decision: "DENY", reason: "effect_exceeds_ceiling" };
    }
    // One-shot consumption (review CE2): atomically flip consumed 0->1; a second commit with the same token
    // affects 0 rows and is denied. Done LAST, so a DENY/ABORT leaves the token usable for a legitimate retry.
    if (payload.token_id) {
      const res = this.db.prepare("UPDATE kernel.read_tokens SET consumed=1 WHERE token_id=? AND consumed=0").run(payload.token_id);
      if (!res || res.changes !== 1) return { decision: "DENY", reason: "token_already_consumed" };
    }
    return { decision: "ALLOW" };
  }

  // ---- Security kernel: query + atomic authorized dispatch (headline) -------------------------------------
  // queryMemory returns an OPAQUE view handle; the agent NEVER receives a freshness token or an ALLOW it can
  // act on. All authority lives server-side in prepared_views, bound to (principal, full context snapshot,
  // coherent view_root). executeAuthorizedAction re-validates the whole binding atomically, CAS-consumes the
  // view, and the TRUSTED DISPATCHER executes the exact canonical action -- so there is no verify->execute gap
  // and no post-ALLOW execution handle into which a parameter could be substituted.
  _safeResolutionEpoch() { try { return this._resolutionEpoch(); } catch { return "tampered"; } }

  // BIDIRECTIONAL store<->ledger integrity check for a run; returns a reason string if tampered, else null. Used
  // BOTH at read/exposure time (readMemory, so the model never sees an attacker-shaped partial view -- v19 #4)
  // AND at action time (_computeView). Silently dropping an authority-bearing record can WIDEN authority, so any
  // inconsistency fails CLOSED. Checks: (a) every store row's receipt verifies (a stripped/invalid receipt on an
  // authority-bearing row is tamper); (b) REVERSE invariant (v19 #1): an authority-bearing STORE row absent from
  // the verified ledger is tamper (an off-ledger row -- crash-window or raw-inserted -- must not silently cap);
  // (c) the membership MAC chain verifies (cross-restart deletion); (d) LEDGER->store: every ledger member's row
  // is present, receipt-valid, and digest-matched (deletion/strip/content-swap of a tracked member).
  _storeTamperReason(runId) {
    if (!runId) return null;
    let members = [];
    try { members = (typeof this.controlPlane.authorityMembers === "function") ? this.controlPlane.authorityMembers(runId) : []; }
    catch { return "membership_unavailable"; }
    const ledgerIds = new Set(members.map((m) => m.memory_id));
    for (const r of this.db.prepare("SELECT * FROM shared_memory WHERE run_id=?").all(runId)) {
      const m = memoryFromRow(r);
      const authorityBearing = Array.isArray(m.effect_ceiling) || m.logical_key != null;
      // Scope the GLOBAL fail-closed to AUTHORITY-BEARING records only. The store is untrusted: an adversary can
      // always inject standalone non-authority rows with bogus receipts, so treating those as a store-wide tamper
      // would be an attacker-triggerable DoS, not detection of tampered tracked state. Non-authority invalid
      // records are instead FILTERED by per-record mediation downstream (complete mediation: admit none of them),
      // which neither widens the capability meet (no effect_ceiling) nor perturbs the coherent view (no
      // logical_key). Authority-bearing records cannot be silently dropped -- doing so could remove a restrictive
      // ceiling from the meet or empty a contested set -- so any receipt anomaly on them fails CLOSED.
      if (!authorityBearing) continue;
      if (m.write_receipt == null) return "receipt_stripped";
      if (!this.controlPlane.verifyReceipt(m)) return "receipt_invalid";
      // (round-4) The redundant stored audit_hash must equal the recomputed content hash. The receipt covers the
      // CONTENT (canonicalMemoryForHash excludes the audit_hash column), so corrupting ONLY audit_hash leaves the
      // receipt and membership digest valid -- yet the per-record gate then denies the row (integrity_mismatch)
      // and silently drops its restrictive ceiling from the capability meet (widening). Treat an audit_hash that
      // disagrees with the content as tamper on an authority-bearing row, fail CLOSED rather than dropping it.
      if (m.audit_hash !== memoryContentHash(m)) return "audit_hash_mismatch";
      if (typeof this.controlPlane.membershipHead === "function" && !ledgerIds.has(m.memory_id)) return "off_ledger_authority_record"; // (v19 #1) reverse invariant
    }
    if (typeof this.controlPlane.membershipHead === "function") {
      try { this._verifiedMembership(); } catch { return "membership_log_tampered"; }
    }
    for (const mem of members) {
      const r = this.db.prepare("SELECT * FROM shared_memory WHERE memory_id=? AND run_id=?").get(mem.memory_id, runId);
      if (!r) return "member_deleted";
      const m = memoryFromRow(r);
      if (m.write_receipt == null || !this.controlPlane.verifyReceipt(m)) return "member_receipt_invalid";
      if (memoryContentHash(m) !== mem.digest) return "member_digest_mismatch";
    }
    return null;
  }

  // Recompute the AUTHORIZATION view -- the FULL coherent admissible set for the context, INDEPENDENT of the
  // caller's retrieval query/topK. A caller must not be able to shrink the authorized set, or hide a capping
  // record, by passing topK (red-team finding): authorization is over everything admissible, not a ranked
  // sample. executeAuthorizedAction recomputes this and compares the root, so any change to the coherent view
  // since the query (a new capping record, a revocation) aborts.
  _computeView(handle, sessionToken, gate = null) {
    // Tamper FAIL-SAFE: a store-write tamper of a candidate record invalidates its keyed receipt. Silently
    // dropping such a record could WIDEN authority (remove a restrictive effect_ceiling from the meet, or empty
    // a view), so if ANY candidate for the context's run carries a receipt that no longer verifies, the whole
    // authorization fails CLOSED rather than proceeding on a partial, attacker-shaped view (red-team finding).
    let runId = gate?.currentMessage?.run_id ?? null;
    if (!gate) {
      try {
        let amId = null;
        if (typeof handle === "string" && handle.startsWith("ctx-")) amId = this.controlPlane.resolveReadContext(sessionToken, handle).activeMessageId;
        else amId = this.controlPlane.resolveLeaseLive(handle).messageId;
        const am = amId ? this.getMessage(amId) : null; runId = am ? am.run_id : null;
      } catch { runId = null; }
      if (runId && this._storeTamperReason(runId)) {
        return { tampered: true, view: [], capability: null, exposed: [], viewRoot: "TAMPERED" };
      }
      gate = this.readMemory({}, handle, sessionToken, { full: true });
      runId = gate?.currentMessage?.run_id ?? runId;
    }
    const view = gate.allowed;
    // The effect-ceiling CAP is the meet over every record that VALIDLY caps the action. Two regimes:
    //
    // (round-3 red-team) For a key with a verified RUN-SCOPED resolution certificate, the capability contribution
    // is the cert's ACCEPTED-winner ceiling, looked up AUTHORITATIVELY from the cert + store -- NOT the meet of
    // whichever same-key records happen to be visible on THIS branch. Otherwise the capability meet is asymmetric:
    // a same-key record denied PER-RECORD by provenance (the restrictive winner, off this branch) is dropped from
    // the meet, while an attacker's uncovered/rejected permissive sibling denied at the SET level (CONTESTED)
    // still injects its ceiling -- so a branch that cannot see the winner widens to the attacker's permission. The
    // resolution authoritatively fixed the key's outcome (and the winner is an authority-bearing record whose
    // ceiling is receipt-protected; a tampered/deleted winner already fails closed in _storeTamperReason above).
    // If the conflict set CHANGED on this branch (a visible uncovered record), the cert is stale -> contribute []
    // (deny-all for the key) until re-resolved, rather than the stale winner ceiling.
    const certCeil = new Map(); // logical_key -> ceiling array (deny-all []), or null (winner does not cap)
    for (const m of gate.candidates) {
      if (m.logical_key == null || certCeil.has(m.logical_key)) continue;
      let cert = null; try { cert = this._resolutionFor(m.logical_key, runId); } catch { cert = null; }
      if (!cert) continue;
      // (round-7) The cert is STALE if ANY same-run keyed candidate for this key is OUTSIDE the conflict it
      // resolved (accepted+rejected). _mandatoryRecords force-includes every same-run keyed record as a candidate,
      // so this catches a NEW restriction even when it is OFF the reader's branch (denied per-record
      // provenance_not_in_causal_graph, hence never reaching _coherentView's on-branch conflict_set_changed test).
      // A stale cert -> deny-all [] for the key until re-resolved, so an off-branch new restriction is honored.
      const covered = new Set([...(cert.accepted || []), ...(cert.rejected || [])]);
      const stale = gate.candidates.some((x) => x.logical_key === m.logical_key && !covered.has(x.memory_id));
      if (stale) { certCeil.set(m.logical_key, []); continue; }
      const accId = (cert.accepted && cert.accepted[0]) || null;
      const accRow = accId ? this.getMemoryRow(accId) : null;
      // (v20 round-13) The cert winner's effect_ceiling may WIDEN the meet ONLY if the winner is itself ADMISSIBLE
      // to THIS reader -- i.e. it passed the FULL per-record gate (reachable, write happened-BEFORE the reader,
      // integrity floor, input frontier, attested, not retired) and survived the coherent view. This UNIFIES the
      // earlier retired (round-4) / Biba floor (round-6) / off-branch (round-12) / write-event (round-13) checks
      // into one: a winner the reader cannot legitimately read contributes [] (deny-all), which still CAPS for a
      // restrictive winner and never WIDENS for a permissive one. Keyed winners are force-included as candidates
      // (_mandatoryRecords), so a final verdict exists; a missing/denied winner fails closed to []. (The reverse --
      // enumerating reasons the winner STILL caps -- leaked by omission each round; gating on actual admissibility
      // is the fail-safe inverse, mirroring the keyed-restriction meet below.)
      const wv = accId ? gate.verdicts.get(accId) : null;
      const winnerAdmitted = !!accRow && !!wv && wv.decision === "allow";
      certCeil.set(m.logical_key, winnerAdmitted ? (Array.isArray(accRow.effect_ceiling) ? accRow.effect_ceiling : null) : []);
    }
    // (round-7) Capability fail-SAFE inverse. A KEYED record is RUN-GLOBAL by design (_mandatoryRecords
    // force-includes every same-run keyed record as a candidate, so topology/flooding/branch cannot suppress a
    // restriction), so its restrictive effect_ceiling caps the meet UNLESS it was AUTHORITATIVELY removed:
    // superseded by an integrity-dominating authorized supersede (superseded_in_lineage), lifecycle-retired
    // (inactive_memory), not-adopted in favor of a SERVED integrity-valid adopt winner, or it belongs to a
    // DIFFERENT run (run_id_mismatch). EVERY other drop reason (off-branch provenance, low integrity, intent /
    // reader / policy filter, contested) leaves the restriction capping. This is the fail-SAFE inverse of
    // enumerating "still caps" reasons: a MISSED reason now over-restricts (availability) rather than WIDENS
    // (soundness) -- closing the recurring class where a new drop reason silently dropped a restriction. An
    // UNKEYED record is branch-local (not force-included): only an admitted or contested record caps. Cert-
    // governed keys are handled authoritatively by certCeil above (with its own Biba floor + staleness check).
    const STOPS_CAPPING_KEYED = new Set(["superseded_in_lineage", "inactive_memory", "run_id_mismatch", "resolution_rejected"]);
    const UNKEYED_CAPS = new Set(["unresolved_conflict", "conflict_set_changed", "integrity_below_context"]);
    const servedKeys = new Set();
    for (const m of gate.candidates) {
      const v = gate.verdicts.get(m.memory_id);
      if (v && v.decision === "allow" && m.logical_key != null) servedKeys.add(m.logical_key);
    }
    let capability = null;
    const narrow = (ceil) => { capability = capability === null ? [...ceil] : capability.filter((e) => ceil.includes(e)); };
    for (const ceil of certCeil.values()) if (Array.isArray(ceil)) narrow(ceil); // authoritative cert-winner ceilings (once per key)
    for (const m of gate.candidates) {
      if (!Array.isArray(m.effect_ceiling)) continue;
      if (m.logical_key != null && certCeil.has(m.logical_key)) continue; // governed by the cert winner above
      const v = gate.verdicts.get(m.memory_id);
      if (!v) continue;
      let caps;
      if (m.logical_key != null) {
        // run-global keyed restriction: caps unless authoritatively removed by a served integrity-valid winner.
        const authRemoved = STOPS_CAPPING_KEYED.has(v.reason) || (v.reason === "not_adopted" && servedKeys.has(m.logical_key));
        caps = v.decision === "allow" || !authRemoved;
      } else {
        caps = v.decision === "allow" || UNKEYED_CAPS.has(v.reason); // unkeyed: branch-local
      }
      if (!caps) continue;
      narrow(m.effect_ceiling);
    }
    const exposed = view.map((m) => ({ id: m.memory_id, hash: m.audit_hash })).sort((a, b) => String(a.id).localeCompare(String(b.id)));
    const viewRoot = createHash("sha256").update(JSON.stringify({ exposed, cap: capability ?? null, pol: this.controlPlane.policyEpoch(), res: this._safeResolutionEpoch() })).digest("hex");
    return { view, capability, exposed, viewRoot, gate };
  }

  // A digest over the active message's SIGNED envelope payload (not just the signature string), so a payload
  // tamper that leaves the signature in place still changes the digest and aborts a view bound to it.
  _envelopeDigest(messageId) {
    const row = messageId ? this.db.prepare("SELECT envelope_json, envelope_sig FROM messages WHERE message_id=?").get(messageId) : null;
    if (!row) return null;
    return createHash("sha256").update(String(row.envelope_json ?? "") + "|" + String(row.envelope_sig ?? "")).digest("hex");
  }

  queryMemory(query, handle, sessionToken = null, intendedEffect = "read") {
    // Production query path: the FULL coherent view is always used (no ablation/bypass opts accepted). Bind the
    // opaque view to the context snapshot, the recomputed coherent view-root, and the active-envelope digest.
    return this._withImmediateTransaction(() => {
      let ctx = null;
      try { ctx = this.controlPlane.resolveReadContext(sessionToken, handle); } catch { ctx = null; }
      const fullGate = this.readMemory({}, handle, sessionToken, { full: true });
      const vr = this._computeView(handle, sessionToken, fullGate);  // authorization view is query-INDEPENDENT (full set)
      if (vr.tampered) throw new Error("candidate_tampered");
      const queryIds = this._queryCandidateIdsFromSnapshot(fullGate.candidates, query ?? {}, fullGate.currentMessage);
      const records = fullGate.allowed.filter((m) => queryIds.has(m.memory_id));
      const token = this._mintReadTokenForView({
        view: records,
        capability: vr.capability,
        principalId: ctx ? ctx.principalId : "",
        activeMessageId: ctx ? ctx.activeMessageId : null,
        intendedEffect,
      });
      const viewId = "view-" + createHash("sha256").update(randomUUID() + ":" + randomUUID()).digest("hex"); // opaque 256-bit handle
      const expiresAt = new Date(Date.now() + 5 * 60 * 1000).toISOString();
      let lockGen = null; try { lockGen = ctx ? this.lockGenerationOf(ctx.activeMessageId) : null; } catch { lockGen = null; }
      this.db.prepare(`INSERT INTO kernel.prepared_views
        (view_id, principal_id, context_id, context_version, context_integrity, active_message_id,
         active_envelope_digest, lock_generation, query_digest, view_root, exposed_count, intended_effect, capability_json, token,
         state, expires_at, created_at)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?, 'pending', ?, ?)`).run(
        viewId, ctx ? ctx.principalId : "", ctx ? ctx.contextId : null, ctx ? ctx.contextVersion : null,
        ctx ? ctx.integrity : null, ctx ? ctx.activeMessageId : null,
        ctx ? this._envelopeDigest(ctx.activeMessageId) : null, lockGen,
        JSON.stringify(query ?? {}), vr.viewRoot, vr.exposed.length, intendedEffect, asJson(vr.capability), token, expiresAt, nowIso());
      // records are the query-filtered set the agent may put in its prompt; the AUTHORIZATION (capability,
      // view-root, empty-view) is over the full admissible set above, so a topK cannot widen authority.
      return { viewId, records, allowedEffectClasses: vr.capability };
    });
  }

  // Verify -> consume -> dispatch. The action is FROZEN once at entry; the TCB tool registry (not the caller)
  // decides effect class / externality / destination. The view-root and active-envelope digest are RECOMPUTED
  // and compared (not just stored). The view CAS + outbox insert are ONE DB transaction; the external dispatch
  // happens after commit and a dispatch failure is PENDING_RECONCILIATION (not a false DENY, since the effect
  // may already have happened). Returns { actionId, status } or { decision, reason }.
  executeAuthorizedAction(action, viewId, sessionToken = null, handle = null) {
    const A = freezeAction(action);          // (CE7) one deep-copy+freeze; a getter cannot vary across reads
    const tool = resolveTool(A);             // (CE2) externality/effect from the registry, not the caller label
    if (tool.malformed) return { decision: "DENY", reason: "malformed_tool" }; // non-string tool field, fail-closed
    // (v19 red-team #2) The registry-derived decision fields drive the kernel's OWN fail-closed guards (external,
    // known, effect, target). Capture them into immutable locals BEFORE any semi-trusted callback runs, and freeze
    // the object handed to the destination policy. The policy receives `tool` to INSPECT; it must NOT be able to
    // MUTATE the kernel's decision inputs -- a policy that set tool.external=false previously flipped off the
    // external/known/policy guards and dispatched a policy-DENIED external effect (the deep-freeze in v19 #5 froze
    // only the canonical action, a sibling object). Every guard below reads these locals, never the live `tool`.
    const toolExternal = tool.external === true;
    const toolKnown = tool.known === true;
    const toolEffect = tool.effect;
    const toolTarget = tool.target;
    const toolMinIntegrity = integrityLevel(tool.minimum_integrity ?? "untrusted");
    Object.freeze(tool);
    // Re-entrancy guard: a deployer destination-policy or dispatcher callback must not re-enter (it would nest
    // BEGIN IMMEDIATE and could roll back the outer txn). One authorization at a time per kernel.
    if (this._inExec) return { decision: "DENY", reason: "reentrant_execution" };
    if (!this.db.prepare("SELECT 1 FROM kernel.prepared_views WHERE view_id=?").get(viewId)) return { decision: "DENY", reason: "view_not_found" };
    // (v18 P0-2) ALL freshness validation, the destination-policy callback, the coherent-view RECOMPUTE, the
    // capability check, the read-to-use commit, the view CAS, and the outbox insert occur INSIDE ONE
    // BEGIN IMMEDIATE transaction. BEGIN IMMEDIATE takes the write lock, so no other connection can mutate
    // memory between validation and consume; the view is recomputed AFTER the destination policy, so a
    // policy-side insert changes the view-root and aborts. Nothing authority-relevant can change between the
    // check and the consume (no TOCTOU window outside the transaction).
    this._inExec = true;
    const priorTxnDepth = this._txnDepth ?? 0;
    this._txnDepth = priorTxnDepth + 1;
    let committed = null;
    try {
      this.db.exec("BEGIN IMMEDIATE");
      try {
        const row = this.db.prepare("SELECT * FROM kernel.prepared_views WHERE view_id=?").get(viewId);
        if (!row || row.state !== "pending") { this.db.exec("ROLLBACK"); return { decision: "DENY", reason: "view_already_consumed" }; }
        if (row.expires_at && nowIso() > row.expires_at) {
          this.db.prepare("UPDATE kernel.prepared_views SET state='expired' WHERE view_id=? AND state='pending'").run(viewId);
          this.db.exec("COMMIT"); return { decision: "DENY", reason: "view_expired" };
        }
        let who = null; try { who = this.controlPlane.authenticate(sessionToken); } catch { who = null; }
        if (who == null || who !== row.principal_id) { this.db.exec("ROLLBACK"); return { decision: "DENY", reason: "view_principal_mismatch" }; }
        let ctx = null; try { ctx = this.controlPlane.resolveReadContext(sessionToken, handle); } catch { ctx = null; }
        if (!ctx) { this.db.exec("ROLLBACK"); return { decision: "ABORT_AND_RETRY", reason: "context_unavailable" }; }
        if (ctx.contextId !== row.context_id) { this.db.exec("ROLLBACK"); return { decision: "DENY", reason: "view_context_mismatch" }; }
        if (ctx.contextVersion !== row.context_version) { this.db.exec("ROLLBACK"); return { decision: "ABORT_AND_RETRY", reason: "context_version_changed" }; }
        if (ctx.integrity !== row.context_integrity) { this.db.exec("ROLLBACK"); return { decision: "ABORT_AND_RETRY", reason: "context_integrity_changed" }; }
        if (toolExternal && integrityLevel(ctx.integrity) < toolMinIntegrity) {
          this.db.exec("ROLLBACK");
          return { decision: "DENY", reason: "context_integrity_below_tool_minimum" };
        }
        if (ctx.activeMessageId !== row.active_message_id) { this.db.exec("ROLLBACK"); return { decision: "ABORT_AND_RETRY", reason: "active_message_changed" }; }
        // (CE4) re-verify the active envelope by RECOMPUTING its payload digest, not comparing a stored sig.
        if (this._envelopeDigest(ctx.activeMessageId) !== row.active_envelope_digest) { this.db.exec("ROLLBACK"); return { decision: "ABORT_AND_RETRY", reason: "active_envelope_changed" }; }
        // Lease freshness (M4): a superseded lock (lock_generation advanced) makes the view's authority stale.
        let curLockGen = null; try { curLockGen = this.lockGenerationOf(ctx.activeMessageId); } catch { curLockGen = null; }
        if (curLockGen !== row.lock_generation) { this.db.exec("ROLLBACK"); return { decision: "ABORT_AND_RETRY", reason: "lease_superseded" }; }
        // (v18 P5) Canonicalize the action ONCE here; the SAME bytes are shown to the destination policy, hashed
        // into the digest, recorded in the outbox, and handed to the dispatcher -- so a deployer policy can
        // authorize on the FULL canonical parameters (amount/recipient/body/path), not just the effect class.
        const act = canonicalAction({ ...A, effect: toolEffect, target: toolTarget });
        // (idempotency hardening) The view is one-shot -- the state CAS + read-token consume below normally make a
        // replay stop at view_already_consumed above. But if that replay state is ever RESET (a store-write
        // adversary, or a buggy retry/crash-recovery path), the SAME canonical action would re-consume and dispatch
        // a SECOND time -- a duplicate EFFECT (two identical wire_transfers). idempotency_key = sha256(view:digest)
        // carries a UNIQUE index (schema.mjs); we ALSO check it HERE, inside this write-locked BEGIN IMMEDIATE txn
        // and BEFORE the destination policy / consume / insert, so the check+insert is atomic (no other connection
        // can insert between the SELECT and our INSERT). A prior row short-circuits to its recorded {actionId,status}
        // with NO second dispatch -- a clean idempotent replay for a legitimate retry, not a false DENY. (Defense in
        // depth: the viewRoot recompute below already blocks any AUTHORITY change; this stops a same-world dup effect.)
        const idem = createHash("sha256").update(viewId + ":" + act.digest).digest("hex");
        const prior = this.db.prepare("SELECT action_id, status, action_digest FROM kernel.action_outbox WHERE idempotency_key=?").get(idem);
        if (prior) { this.db.exec("ROLLBACK"); return { actionId: prior.action_id, status: prior.status, action_digest: prior.action_digest, deduplicated: true, reason: "duplicate_action" }; }
        // Destination policy FIRST (a deployer callback). Any store write it performs is part of THIS txn and is
        // therefore caught by the recompute below; an external connection's write is blocked by the write lock.
        // (v18 P5) The policy receives the FULL canonical action as a third argument, so a deployment can decide
        // on parameters (amount/recipient/body/path), not just the effect class. Backward-compatible: existing
        // (tool, ctx) policies ignore it.
        let policyOk = true;
        // A throwing/buggy policy fails CLOSED (policyOk stays false), and `tool` is frozen so the callback cannot
        // mutate the kernel's decision inputs. The guards below use the captured locals regardless.
        if (toolExternal) {
          try { policyOk = typeof this._destinationPolicy === "function" && this._destinationPolicy(tool, ctx, act.canonical) === true; }
          catch { policyOk = false; }
        }
        // (CE3 + P0-2) RECOMPUTE the coherent view AFTER the policy and compare its root: any change since the
        // query (a new capping record, a revocation, a policy-side insert) aborts the stale view.
        let fresh; try { fresh = this._computeView(handle, sessionToken); } catch { this.db.exec("ROLLBACK"); return { decision: "ABORT_AND_RETRY", reason: "view_recompute_failed" }; }
        if (fresh.tampered) { this.db.exec("ROLLBACK"); return { decision: "DENY", reason: "candidate_tampered" }; } // fail-closed: omission/tamper must not widen authority
        if (fresh.viewRoot !== row.view_root) { this.db.exec("ROLLBACK"); return { decision: "ABORT_AND_RETRY", reason: "coherent_view_changed" }; }
        if (fresh.exposed.length === 0 && toolExternal) { this.db.exec("ROLLBACK"); return { decision: "DENY", reason: "empty_view_no_authority" }; }
        if (toolExternal && (!Array.isArray(fresh.capability) || !fresh.capability.includes(toolEffect))) {
          this.db.exec("ROLLBACK");
          return { decision: "DENY", reason: "effect_exceeds_ceiling" };
        }
        if (!toolExternal && Array.isArray(fresh.capability) && !fresh.capability.includes(toolEffect)) { this.db.exec("ROLLBACK"); return { decision: "DENY", reason: "effect_exceeds_ceiling" }; }
        // (v18 P9) Fail-safe default: a tool the trusted registry does not know has no parameter schema, effect
        // class, target extractor, or confidentiality semantics, so the kernel CANNOT reason about it -- DENY
        // regardless of what the deployment policy returns (a policy may not authorize an unregistered tool).
        if (toolExternal && !toolKnown) { this.db.exec("ROLLBACK"); return { decision: "DENY", reason: "unknown_tool_not_authorized" }; }
        if (toolExternal && !policyOk) { this.db.exec("ROLLBACK"); return { decision: "DENY", reason: "destination_not_authorized" }; }
        const commit = this.commitMemoryUse({ ...A, effect: toolEffect }, row.token, sessionToken);
        if (commit.decision !== "ALLOW") { this.db.exec("ROLLBACK"); return commit; } // rollback leaves the read-token retryable
        const consumed = this.db.prepare("UPDATE kernel.prepared_views SET state='consumed' WHERE view_id=? AND state='pending'").run(viewId);
        if (!consumed || consumed.changes !== 1) { this.db.exec("ROLLBACK"); return { decision: "DENY", reason: "view_already_consumed" }; }
        const { canonical, json, digest } = act;
        const actionId = "act-" + randomUUID();
        // idem (= sha256(view:digest)) was computed and checked-for-duplicates above; reuse it so the UNIQUE
        // index key we INSERT is byte-identical to the key the dedup SELECT looked up.
        this.db.prepare(`INSERT INTO kernel.action_outbox (action_id, view_id, principal_id, canonical_action_json, action_digest, idempotency_key, status, created_at)
          VALUES (?,?,?,?,?,?, 'authorized', ?)`).run(actionId, viewId, row.principal_id, json, digest, idem, nowIso());
        this.db.exec("COMMIT");
        committed = { canonical, json, digest, actionId, principal: row.principal_id };
      } catch (e) { try { this.db.exec("ROLLBACK"); } catch {} return { decision: "DENY", reason: "authorization_txn_failed" }; }
    } finally {
      this._txnDepth = priorTxnDepth;
      this._inExec = false;
    }
    // External dispatch happens AFTER the authorization commit. (v18 P0-6) A dispatcher that returns a Promise
    // is NOT yet a success: mark the outbox pending_dispatch and settle it when the promise resolves/rejects --
    // never record an unsettled async dispatch as 'dispatched'. A synchronous throw or a rejection is
    // PENDING_RECONCILIATION (the effect may already have happened); a timeout must NOT be read as a DENY.
    const { canonical, json, digest, actionId, principal } = committed;
    let result;
    try { result = this._dispatcher.dispatch(canonical, { actionId, viewId, principal }); }
    catch (e) {
      this.db.prepare("UPDATE kernel.action_outbox SET status='pending_reconciliation', dispatch_result_json=? WHERE action_id=?").run(asJson({ error: String(e.message || e) }), actionId);
      return { actionId, status: "pending_reconciliation", reason: "dispatch_unknown", action_digest: digest };
    }
    if (result && typeof result.then === "function") {
      this.db.prepare("UPDATE kernel.action_outbox SET status='pending_dispatch' WHERE action_id=?").run(actionId);
      Promise.resolve(result).then(
        (r) => { try { this.db.prepare("UPDATE kernel.action_outbox SET status='dispatched', dispatch_result_json=? WHERE action_id=?").run(asJson(r ?? {}), actionId); } catch {} },
        (e) => { try { this.db.prepare("UPDATE kernel.action_outbox SET status='pending_reconciliation', dispatch_result_json=? WHERE action_id=?").run(asJson({ error: String((e && e.message) || e) }), actionId); } catch {} });
      return { actionId, status: "pending_dispatch", action_digest: digest };
    }
    this.db.prepare("UPDATE kernel.action_outbox SET status='dispatched', dispatch_result_json=? WHERE action_id=?").run(asJson(result ?? {}), actionId);
    return { actionId, status: "dispatched", action_digest: digest, dispatched: result };
  }

  // Read through the trusted path. The active message is derived from the HANDLE (never caller-supplied):
  // a context token (review S12: the read binds to the execution context's current event, re-authenticated
  // with the session) or a bare lease token (the lease's message). Possession of the handle IS the caller
  // authentication; there is no condition/bypass. The facade exposes only the context form.
  readMemory(query, handle, sessionToken = null, opts = {}) {
    let lease;
    if (typeof handle === "string" && handle.startsWith("ctx-")) {
      const rc = this.controlPlane.resolveReadContext(sessionToken, handle); // active = context current event
      lease = { principalId: rc.principalId, leaseId: rc.contextId, messageId: rc.activeMessageId };
    } else {
      lease = this.controlPlane.resolveLeaseLive(handle); // M4: lease must still own the lock
    }
    const currentMessage = this.getMessage(lease.messageId);
    if (!currentMessage) throw new Error(`active message not found: ${lease.messageId}`);
    // The authorization context and the event-graph edges it depends on must be signed envelopes, so
    // run/task/policy/parent are verified provenance rather than trusted labels (digital fingerprint). The
    // write-event cut (CE20-00) reads currentMessage.sequence directly from this verified envelope.
    this._attestEnvelope(currentMessage, lease.messageId);
    // (v19 #4) MEMORY EXPOSURE is itself security-sensitive: verify store<->ledger integrity BEFORE releasing any
    // record to the caller (model), so a tampered/omitted view is never exposed -- not merely blocked at the
    // action commit. queryMemory() and the production read() both route here, so they share one verified
    // snapshot pipeline (no weaker read path). Fail CLOSED on any inconsistency.
    { const tr = this._storeTamperReason(currentMessage.run_id); if (tr) throw new Error(`candidate_tampered:${tr}`); }
    // Candidates = the (possibly bounded) relevance set UNION the mandatory records (Gate 2.0 #5): every
    // competing version of a decision in the run is force-included via an exact index, so flooding the
    // retriever with invalid-but-relevant records cannot suppress a conflicting/authoritative decision.
    const relevance = this.findCandidateMemories(query ?? {});
    const seen = new Set(relevance.map((m) => m.memory_id));
    const candidates = [...relevance, ...this._mandatoryRecords(currentMessage).filter((m) => !seen.has(m.memory_id))];
    const causalClosure = this.causalAncestry(currentMessage);
    for (const mid of causalClosure) { const a = this.getMessage(mid); if (a) this._attestEnvelope(a, mid); }
    const retiredIds = this.retiredMemoryIds();
    const readId = `read-${randomUUID()}`;
    // Per-record gate THEN the set-level coherent-view pass (Gate 2.0): the logged decision per record is
    // the FINAL one (an allow the coherent view removes is recorded as deny), so replay reproduces it. We
    // snapshot the resolution certificates actually consulted so replay reproduces the read-time view.
    const usedResolutions = new Map();
    const resolutionLookup = (k) => { const c = this._resolutionFor(k, currentMessage.run_id); if (c) usedResolutions.set(k, c); return c; };
    const { certs: delegationCerts, ids: delegatedIds } = this._delegationsFor(currentMessage);
    const verdicts = this._gateCandidates(candidates, currentMessage, causalClosure, retiredIds, resolutionLookup, delegatedIds, { skipCoherentView: opts.skipCoherentView });
    const allowed = [];
    for (const memory of candidates) {
      const decision = verdicts.get(memory.memory_id);
      this.recordMemoryDecision({ memory, currentMessage, readId, ...decision });
      if (decision.decision === "allow") allowed.push(memory);
    }
    this._recordSecureRead({ readId, currentMessage, candidates, admitted: allowed, closure: causalClosure,
      retiredIds, lease, resolutions: [...usedResolutions.values()], delegations: delegationCerts });
    // (v18 capability-widening fix) the kernel's capability computation needs the per-candidate verdicts, not
    // just the admitted set, so a restriction left CONTESTED by the coherent view still caps (see _computeView).
    if (opts.full) return { allowed, candidates, verdicts, currentMessage };
    return allowed;
  }

  _recordSecureRead({ readId, currentMessage, candidates, admitted, closure, retiredIds, lease, resolutions = [], delegations = [] }) {
    this.bumpAuditAnchor(currentMessage.run_id);
    const activeSnapshot = {
      message_id: currentMessage.message_id, run_id: currentMessage.run_id, task_id: currentMessage.task_id,
      trace_id: currentMessage.trace_id, receiver: currentMessage.receiver, intent: currentMessage.intent,
      policy_context: currentMessage.policy_context, parent_message_id: currentMessage.parent_message_id ?? null,
      delegated_from: currentMessage.delegated_from ?? null, sequence: currentMessage.sequence ?? null,
    };
    // Everything an independent replay needs to reproduce attestation-mode decisions EXACTLY: the
    // profile, key id, policy/monitor versions, authenticated principal + lease, the retired set, and a
    // per-admitted receipt DIGEST (so a later receipt mutation is detected without the manifest ever
    // holding key material). Review M6.
    const security = {
      profile: "secure",
      monitor_version: this.controlPlane.monitorVersion,
      key_id: this.controlPlane.keyId,
      policy_version: this.controlPlane.policyVersion,
      principal: lease.principalId,
      lease_id: lease.leaseId,
      attestation: true,
      caller_auth: true,
      retired_ids: [...retiredIds],
      // The signed resolution + delegation certificates consulted (Gate 2.0). Replay re-verifies each, so a
      // later resolution/delegation does not change a logged decision and a tampered snapshot is detected as
      // a verdict mismatch.
      resolutions,
      delegations,
      admitted_receipt_digests: Object.fromEntries(
        admitted.map((m) => [m.memory_id, this.controlPlane.receiptDigest(m.write_receipt)])),
    };
    this.db.prepare(`
      INSERT INTO memory_reads (
        read_id, run_id, task_id, message_id, reader, condition, active_message_json,
        candidate_ids_json, admitted_ids_json, ancestor_closure_json, gate_options_json, security_json, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      readId, currentMessage.run_id, currentMessage.task_id, currentMessage.message_id,
      currentMessage.receiver, "C5-secure", asJson(activeSnapshot),
      asJson(candidates.map((m) => m.memory_id)), asJson(admitted.map((m) => m.memory_id)),
      asJson([...closure]), asJson({}), asJson(security), nowIso(),
    );
  }

  // Independent attestation-aware replay (review M6). Re-runs the STRICT gate with the SAME control
  // plane (the auditor holds the key from the secret manager, not the audit DB) and the SAME retired
  // set, reconstructs the active message/candidates/closure from persisted state, and additionally
  // verifies each admitted record's receipt digest against the manifest -- so a receipt mutated after
  // the fact is caught and a clean attestation denial is reproduced as a clean denial.
  replaySecureMemoryReads(runId) {
    const reads = this.db.prepare("SELECT * FROM memory_reads WHERE run_id = ? ORDER BY created_at ASC").all(runId);
    const decisions = this.db.prepare("SELECT * FROM memory_access_decisions WHERE run_id = ? ORDER BY created_at ASC").all(runId);
    const memById = new Map(this.db.prepare("SELECT * FROM shared_memory").all().map(memoryFromRow).map((m) => [m.memory_id, m]));
    const issues = [];
    // Deletion check (review M1.4): a wiped read manifest is distinguishable from genuine inactivity.
    const anchor = this.auditAnchor(runId);
    if (anchor != null && reads.length < anchor) {
      issues.push({ kind: "read_manifest_deleted", expected_reads: anchor, found_reads: reads.length });
    }
    // Lifecycle parity (review M6): replay re-runs the SAME lifecycle-chain verification the live read uses,
    // so a lifecycle tampering that fails the online monitor also fails replay (no semantic divergence).
    try { this._verifiedLifecycleEvents(); }
    catch (err) { issues.push({ kind: "lifecycle_log_tampered", detail: String(err.message || err) }); }
    // Resolution-chain parity (same rationale): a tampered resolution log that fails the online monitor also
    // fails replay, so a delete+reinsert resurrecting a superseded resolution cannot pass audit silently.
    try { this._verifiedResolutionEvents(); }
    catch (err) { issues.push({ kind: "resolution_log_tampered", detail: String(err.message || err) }); }
    // Membership-chain parity (v19, same rationale): replay re-runs the SAME membership-chain verification,
    // so a delete of a mirror row (shrinking the authority ledger) that fails the online monitor also fails
    // replay -- a restart-time deletion of a restrictive record's mirror cannot pass audit silently.
    try { this._verifiedMembership(); }
    catch (err) { issues.push({ kind: "membership_log_tampered", detail: String(err.message || err) }); }
    // Bijection on read_id too (review): a decision pointing at a read manifest that does not exist is a
    // fabricated row (its parent read was deleted, or it was injected with a bogus read_id) -- flag it,
    // don't silently drop it. Together with the per-read candidate<->decision bijection below this closes
    // the "orphan decision" gap in both directions.
    const knownReadIds = new Set(reads.map((r) => r.read_id));
    const decByRead = new Map();
    for (const d of decisions) {
      if (!d.read_id) { issues.push({ kind: "orphan_decision_no_read", decision_id: d.decision_id }); continue; }
      if (!knownReadIds.has(d.read_id)) { issues.push({ kind: "orphan_decision_unknown_read", decision_id: d.decision_id, read_id: d.read_id }); continue; }
      if (!decByRead.has(d.read_id)) decByRead.set(d.read_id, []);
      decByRead.get(d.read_id).push(d);
    }
    let readsOk = 0;
    for (const read of reads) {
      const before = issues.length;
      const snapshot = JSON.parse(read.active_message_json);
      const canonical = this.getMessage(snapshot.message_id);
      if (!canonical) issues.push({ kind: "active_message_missing", read_id: read.read_id, message_id: snapshot.message_id });
      // Replay parity (re-review #6): re-verify the active message's envelope signature exactly as the
      // live read path does, so a tampered/forged active envelope is flagged rather than silently
      // re-evaluated. (Ancestor envelope signatures are verified inside causalAncestry below.)
      else if (!this.controlPlane.verifyEnvelope(canonical)) {
        issues.push({ kind: "active_envelope_not_attested", read_id: read.read_id, message_id: snapshot.message_id });
      }
      const active = canonical ?? snapshot;
      const security = JSON.parse(read.security_json ?? "{}");
      // The verifier must hold the SAME control-plane key that signed the decision (review M1.3): a
      // replay under a different/rotated key is flagged rather than silently mis-verifying receipts.
      if (security.key_id && security.key_id !== this.controlPlane.keyId) {
        issues.push({ kind: "key_id_mismatch", read_id: read.read_id, logged: security.key_id, verifier: this.controlPlane.keyId });
      }
      const retiredIds = new Set(security.retired_ids ?? []);
      const candidateIds = JSON.parse(read.candidate_ids_json);
      const loggedAdmitted = new Set(JSON.parse(read.admitted_ids_json));
      // The causal closure is recomputed with the SAME fail-closed verification as the live path (review
      // M5): if a referenced ancestor is now missing/unbound/unsigned, causalAncestry throws and we record
      // it as a verification failure for this read rather than letting the exception abort the replay.
      let closure;
      try {
        closure = this.causalAncestry(active);
      } catch (err) {
        issues.push({ kind: "causal_verification_failed", read_id: read.read_id, message_id: snapshot.message_id, detail: String(err.message || err) });
        continue;
      }
      const readDecs = decByRead.get(read.read_id) ?? [];
      const candidateSet = new Set(candidateIds);
      const decByMem = new Map();
      for (const d of readDecs) {
        if (decByMem.has(d.memory_id)) issues.push({ kind: "duplicate_decision", read_id: read.read_id, memory_id: d.memory_id });
        else decByMem.set(d.memory_id, d);
        // Injected-decision detection (review): a logged decision whose memory is NOT in the candidate
        // manifest is a fabricated row -- the candidate set and the decision set must be a bijection.
        if (!candidateSet.has(d.memory_id)) issues.push({ kind: "extra_decision", read_id: read.read_id, memory_id: d.memory_id });
      }
      if (decByMem.size !== candidateSet.size) {
        issues.push({ kind: "decision_cardinality_mismatch", read_id: read.read_id, candidates: candidateSet.size, decisions: decByMem.size });
      }
      // Re-run the per-record gate AND the set-level coherent-view pass (Gate 2.0) exactly as the live read,
      // so a coherent-view denial (superseded/unresolved/not-adopted) is reproduced, not flagged as a mismatch.
      // Resolutions come from the read-time SNAPSHOT, each RE-VERIFIED, so a later resolution does not change
      // this logged decision and a tampered resolution snapshot surfaces as a verdict mismatch.
      // Replay must apply the SAME admissibility predicate the live path applied (review: snapshot
      // laundering). A snapshot cert is honored only if it re-verifies AND is current-epoch (parity with
      // _resolutionFor / _delegationsFor); a delegation cert must additionally still target THIS active
      // message's task+receiver. Otherwise a store-write adversary could inject a validly-signed but
      // stale-epoch or wrong-target cert into the manifest to launder an admit past replay.
      const epoch = this.controlPlane.policyEpoch();
      const snapRes = new Map();
      for (const c of (security.resolutions ?? [])) {
        if (!this.controlPlane.verifyResolution(c)) continue;
        if (c.policy_epoch !== epoch) continue;
        snapRes.set(c.logical_key, c);
      }
      const snapDelegated = new Set();
      for (const c of (security.delegations ?? [])) {
        if (!this.controlPlane.verifyDelegation(c)) continue;
        if (c.policy_epoch !== epoch) continue;
        if (c.target_task !== active.task_id) continue;
        if (c.target_receiver !== active.receiver && c.target_receiver !== "*") continue;
        for (const id of (c.memory_ids ?? [])) snapDelegated.add(id);
      }
      const recRecords = candidateIds.map((cid) => memById.get(cid)).filter(Boolean);
      const recVerdicts = this._gateCandidates(recRecords, active, closure, retiredIds, (k) => snapRes.get(k) ?? null, snapDelegated);
      const recomputedAllow = new Set();
      for (const cid of candidateIds) {
        const mem = memById.get(cid);
        if (!mem) { issues.push({ kind: "candidate_memory_missing", read_id: read.read_id, memory_id: cid }); continue; }
        const verdict = recVerdicts.get(cid);
        if (verdict.decision === "allow") recomputedAllow.add(cid);
        const logged = decByMem.get(cid);
        if (!logged) { issues.push({ kind: "missing_decision", read_id: read.read_id, memory_id: cid }); continue; }
        if (logged.decision !== verdict.decision || logged.reason !== verdict.reason) {
          issues.push({ kind: "decision_mismatch", read_id: read.read_id, memory_id: cid,
            logged: `${logged.decision}:${logged.reason}`, recomputed: `${verdict.decision}:${verdict.reason}` });
        }
      }
      // Receipt-digest check: a receipt mutated after the decision no longer matches the manifest digest.
      const loggedDigests = security.admitted_receipt_digests ?? {};
      for (const [mid, dig] of Object.entries(loggedDigests)) {
        const mem = memById.get(mid);
        const now = mem ? this.controlPlane.receiptDigest(mem.write_receipt) : null;
        if (now !== dig) issues.push({ kind: "receipt_tampered", read_id: read.read_id, memory_id: mid });
      }
      const sameAdmitted = recomputedAllow.size === loggedAdmitted.size && [...recomputedAllow].every((id) => loggedAdmitted.has(id));
      if (!sameAdmitted) {
        issues.push({ kind: "admitted_set_mismatch", read_id: read.read_id,
          recomputed: [...recomputedAllow].sort(), logged: [...loggedAdmitted].sort() });
      }
      if (issues.length === before) readsOk++;
    }
    return { runId, reads: reads.length, reads_ok: readsOk, decisions: decisions.length, issues, ok: issues.length === 0 };
  }
}

// ---- capability separation (review: strong logic core + explicit trust boundary) ---------------------
// The agent/framework must NOT hold the security kernel. createSecureMemorySystem returns two capabilities:
//   - `runtime`: the DATA-PLANE facade an agent receives. It exposes only claim/send/read/write/retire and
//     deliberately has NO controlPlane, db, bindStore, registerPrincipal, or any attestation operation, so
//     a held data-plane reference cannot mint receipts/leases or replace the kernel's oracles.
//   - `admin`: the privileged kernel (the SecureMemoryRuntime itself) held only by the test harness/operator
//     for principal/key/lifecycle administration.
// In a production deployment the kernel lives behind a process/RPC boundary with a KMS-held key; here it is
// in-process and the separation is language-level (capability + #private), which is the claim we make.
export function createSecureMemorySystem(options = {}) {
  const admin = new SecureMemoryRuntime(options);
  // The data-plane facade is ENTIRELY context-driven (review S2/S8/S9/S11/S12). An agent claims (opening a
  // context and receiving the claimed message), then read/write/send/attachInput/complete all take the
  // (session, context) pair. The agent never holds a raw lease, never selects which lease backs an output,
  // never supplies run/parent/sequence/integrity/sender on a send, and cannot create a context-less root
  // (trusted ingress / root creation is a kernel/admin operation). Every output is bound to the execution's
  // accumulated integrity. There is no controlPlane/db/mint/lifecycle-admin/getMessage surface.
  const runtime = Object.freeze({
    // Returns { context, message }: the capability token for the opened execution context, and the claimed
    // message's content. NO raw lease is exposed to the data plane.
    claim: (sessionToken, receiver) => {
      const c = admin.claim(sessionToken, receiver);
      return c ? { context: c.context, message: c.message } : null;
    },
    // Ordinary-agent send: caller supplies only {receiver, intent, payload, state, requested_integrity};
    // the control plane composes/signs the whole envelope from the context and bounds integrity to it.
    send: (sessionToken, contextToken, output) => {
      if (!contextToken) throw new Error("context_required");
      return admin.send(sessionToken, contextToken, output);
    },
    read: (sessionToken, contextToken, query) => {
      if (!contextToken) throw new Error("context_required");
      return admin.readMemory(query, contextToken, sessionToken);
    },
    // The read-to-use token API (prepareRead/commit) and every skip*/ablation option are NOT exposed on the
    // production facade -- they are internal/eval-only (the `admin` object). A data-plane agent reaches memory
    // for an action ONLY via the kernel below, which always uses the full coherent view (no bypass opt).
    // queryMemory returns an OPAQUE view handle (no token); executeAuthorizedAction re-validates the full
    // binding and the trusted dispatcher (private to the runtime, absent from this facade) performs the action.
    queryMemory: (sessionToken, contextToken, query, intendedEffect) => {
      if (!contextToken) throw new Error("context_required");
      return admin.queryMemory(query, contextToken, sessionToken, intendedEffect);
    },
    executeAuthorizedAction: (sessionToken, contextToken, viewId, action) => {
      if (!contextToken) throw new Error("context_required");
      return admin.executeAuthorizedAction(action, viewId, sessionToken, contextToken);
    },
    write: (sessionToken, contextToken, content, options) => {
      if (!contextToken) throw new Error("context_required");
      return admin.write(sessionToken, contextToken, content, options);
    },
    // Attach another context the same principal holds as an input (lowers integrity), and close the context
    // (revokes its leases; no further output).
    attachInput: (sessionToken, contextToken, additionalContextToken) =>
      admin.attachInputByContext(sessionToken, contextToken, additionalContextToken),
    complete: (sessionToken, contextToken) => admin.complete(sessionToken, contextToken),
  });
  return { runtime, admin };
}
