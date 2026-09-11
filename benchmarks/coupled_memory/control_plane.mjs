// The trusted control plane. Re-architected so it never trusts its caller: it owns the signing key and
// all session/principal/lease state in PRIVATE fields, and every attestation/lease operation derives and
// verifies from the canonical SIGNED store itself (bound via bindStore), not from caller-supplied
// arguments. This closes the independent re-review's counterexamples:
//   - causal closure was computed from an UNSIGNED SQL column -> now the runtime walks signed-envelope
//     edges and verifies signatures (see runtime.causalAncestry); the control plane verifies envelopes.
//   - issueLease() issued a lease for any caller-named principal -> now it authenticates the session and
//     verifies the principal actually holds the queue lock for the message (via the bound store).
//   - attestSend() trusted a caller-supplied parentIntegrities array -> now it looks the parents up in
//     the store, verifies their signatures, and derives integrity itself.
//   - attestWrite() checked only (source, writer) -> now it re-verifies ALL authoritative metadata
//     (run/task/trace/policy/scope) against the lease's verified canonical message and FREEZES the
//     write-time integrity into the signed record (so a later clearance change cannot reclassify it).
//
// HONEST BOUNDARY: in this artifact the control plane is an in-process object and the in-process boundary
// is JavaScript privacy (#fields make session/principal/lease state and the key unreachable from a held
// reference; mint/sign are not public methods). True non-bypassability requires the documented
// deployment: a separate process/service with a KMS-held key and authenticated RPC for every operation.
// The paper states this explicitly; the artifact demonstrates the authorization/integrity LOGIC and the
// in-process enforcement, not OS-level isolation.
import { randomBytes, createHmac, createHash, timingSafeEqual } from "node:crypto";
import { memoryContentHash } from "./hash.mjs";
import { verifyCausalEdge, parentIdsOf } from "./causal.mjs";

function token(prefix) {
  return `${prefix}-${randomBytes(24).toString("hex")}`;
}

export const INTEGRITY_LEVELS = Object.freeze({ untrusted: 0, task: 1, system: 2 });
const MAX_LEVEL = 2;

export function integrityLevel(v) {
  if (typeof v === "number" && Number.isFinite(v)) return Math.max(0, Math.min(MAX_LEVEL, Math.trunc(v)));
  const n = INTEGRITY_LEVELS[v];
  return typeof n === "number" ? n : 0;
}

export function integrityMeet(a, b) {
  return Math.min(integrityLevel(a), integrityLevel(b));
}

export class ControlPlane {
  #key;            // signing key: private, never returned/readable
  #sessions;       // sessionToken -> principalId
  #principals;     // principalId -> { queues:Set, lifecycle, clearance, endorse }
  #leases;         // leaseToken -> { leaseId, principalId, messageId, generation, revoked, contextId }
  #leaseSeq;
  #store;          // canonical signed store: { getSignedMessage(id), lockOwnerOf(id), lockGenerationOf(id) }
  #lifecycleHead;  // {count,lastSeq,lastMac}: the lifecycle MAC-chain head, held in TCB memory (review:
  #resolutionHead; // {count,lastSeq,lastMac}: the merge-resolution MAC-chain head, held in TCB memory
  #contexts;       // contextId -> ExecutionContext (the per-execution integrity unit; TCB memory + durable mirror)
  #contextSeq;
  #membership;     // runId -> Map(memoryId -> {digest}): TCB membership ledger of authority-bearing records,
                   // so a store-write that deletes/strips a restrictive record is detected as an omission (v18 P0-1)
  #membershipHead; // {count,lastSeq,lastMac}: the authority-membership MAC-chain head, held in TCB memory
                   // (v19), so the durable mirror cannot be silently shrunk across a restart -- parity with
                   // #lifecycleHead/#resolutionHead
  #contextVersionHead; // contextId -> latest monotonic version, held in TCB memory + mirrored to the kernel
                   // context_anchor (v20 CE20-03): a restart cross-checks the untrusted execution_contexts row's
                   // version against this trusted head, so a rolled-back (pre-taint) context is rejected

  constructor({ keyBytes = null, policyVersion = 1 } = {}) {
    const envKey = (typeof process !== "undefined" && process.env && process.env.MBM_ATTESTATION_KEY) || null;
    this.#key = keyBytes ? Buffer.from(keyBytes)
      : envKey ? Buffer.from(envKey, "hex")
      : randomBytes(32);
    this.durable = !!(keyBytes || envKey);
    this.keyId = `cpkey-${createHash("sha256").update(this.#key).digest("hex").slice(0, 16)}`;
    this.policyVersion = policyVersion;
    this.monitorVersion = "mbm-secure-3";
    this.#sessions = new Map();
    this.#principals = new Map();
    this.#leases = new Map();
    this.#leaseSeq = 0;
    this.#store = null;
    this.#lifecycleHead = { count: 0, lastSeq: 0, lastMac: "" };
    this.#resolutionHead = { count: 0, lastSeq: 0, lastMac: "" };
    this.#contexts = new Map();
    this.#contextSeq = 0;
    this.#membership = new Map();
    this.#membershipHead = { count: 0, lastSeq: 0, lastMac: "" };
    this.#contextVersionHead = new Map();
  }

  // The runtime binds its canonical, signature-bearing store so the control plane can look up and verify
  // messages itself. IMMUTABLE (review M2): binding is one-shot and rejected once set, so a held control
  // -plane reference cannot swap the lock/identity oracle the monitor's decisions depend on (the oracle is
  // part of the tamper-resistant reference monitor, not caller-replaceable). The store is never exposed.
  bindStore(store) {
    if (this.#store) throw new Error("store_already_bound");
    this.#store = store;
  }

  #lockGenerationOf(messageId) {
    return this.#store && this.#store.lockGenerationOf ? (this.#store.lockGenerationOf(messageId) ?? 0) : 0;
  }

  // ---- authority-membership ledger (TCB) -------------------------------------------------------
  // Records every authority-bearing memory record (effect_ceiling / logical_key) by content digest, in TCB
  // memory the data-plane adversary cannot reach. The monitor cross-checks it on every view computation, so a
  // store-write that DELETES a restrictive record or STRIPS its receipt is detected as an authenticated
  // omission (v18 P0-1) -- excluding such a record can no longer silently widen authority.
  //
  // GUARANTEE (v19, accurate parity statement). The Map above is authoritative IN-INSTANCE; on its own it
  // does not survive a restart, so the durable mirror (authority_membership) restores it. Earlier the mirror
  // carried only (run_id, memory_id, digest) -- NO count, NO MAC -- which was a FALSE parity claim: a
  // key-stable restart that deleted both a restrictive record's shared_memory row AND its mirror row restored
  // a SILENTLY SMALLER ledger, so the omission alarm never fired. The ledger is now MAC-CHAINED like the
  // lifecycle/resolution logs: recordAuthorityMember advances a TCB head MAC, and the read/replay path
  // (_verifiedMembership) fails closed if the surviving mirror rows do not match the head's count + chain. The
  // in-instance head stays AHEAD of the store (suffix-rollback is caught); ACROSS A RESTART the head is
  // restored from the durable anchor, so -- exactly like #lifecycleHead/#resolutionHead -- the cross-restart
  // non-deletion guarantee rests on that anchor sitting in PROTECTED storage (a fully consistent
  // store-rewriting adversary who also forges a matching anchor is out of scope, as stated for those heads).
  #membershipMac(o) {
    const fields = [o.seq, o.prev_mac ?? "", o.run_id, o.memory_id, o.digest];
    return `msmac:${createHmac("sha256", this.#key).update(JSON.stringify(fields)).digest("hex")}`;
  }

  // Register an authority-bearing record AND advance the membership MAC chain whose HEAD lives in TCB memory
  // (parity with lifecycleAppend/resolutionAppend). Returns the chained {seq, prev_mac, mac} for the runtime
  // to persist into the durable mirror + anchor, or null when there is nothing to append. IDEMPOTENT: the
  // mirror is keyed by (run_id, memory_id) and the in-memory Map overwrites, so a re-record of an already
  // -known member must NOT advance the chain (else count != surviving rows and verification would wrongly
  // fail closed). A normal write inserts a fresh memory_id exactly once, so this advances once per member.
  recordAuthorityMember(runId, memoryId, digest) {
    if (!runId || !memoryId) return null;
    let m = this.#membership.get(runId);
    if (!m) { m = new Map(); this.#membership.set(runId, m); }
    if (m.has(memoryId)) return null; // already chained; do not double-advance the head
    m.set(memoryId, { digest });
    const seq = this.#membershipHead.lastSeq + 1;
    const prev_mac = this.#membershipHead.lastMac;
    const mac = this.#membershipMac({ run_id: runId, memory_id: memoryId, digest, seq, prev_mac });
    this.#membershipHead = { count: this.#membershipHead.count + 1, lastSeq: seq, lastMac: mac };
    return { seq, prev_mac, mac };
  }

  // (v19 #1) Crash-safe two-phase append for the atomic write protocol. `nextAuthorityMember` COMPUTES the
  // chained {seq, prev_mac, mac, count} from the current head WITHOUT mutating it (null if already a member);
  // the runtime persists the row + mirror + anchor in ONE transaction, then calls `commitAuthorityMember` to
  // advance the in-memory head ONLY after the COMMIT. So a crash/rollback before COMMIT leaves the head and the
  // store both unadvanced (no DoS, no off-ledger row); a crash after COMMIT but before the head-advance is
  // healed at restart by seedMembershipHead from the committed anchor.
  nextAuthorityMember(runId, memoryId, digest) {
    if (!runId || !memoryId) return null;
    const m = this.#membership.get(runId);
    if (m && m.has(memoryId)) return null;
    const seq = this.#membershipHead.lastSeq + 1;
    const prev_mac = this.#membershipHead.lastMac;
    const mac = this.#membershipMac({ run_id: runId, memory_id: memoryId, digest, seq, prev_mac });
    return { seq, prev_mac, mac, count: this.#membershipHead.count + 1 };
  }

  commitAuthorityMember(runId, memoryId, digest, chained) {
    if (!chained || !runId || !memoryId) return;
    let m = this.#membership.get(runId);
    if (!m) { m = new Map(); this.#membership.set(runId, m); }
    if (m.has(memoryId)) return;
    m.set(memoryId, { digest });
    this.#membershipHead = { count: chained.count, lastSeq: chained.seq, lastMac: chained.mac };
  }

  authorityMembers(runId) {
    const m = this.#membership.get(runId);
    return m ? [...m.entries()].map(([memory_id, v]) => ({ memory_id, digest: v.digest })) : [];
  }

  // Restore the membership ledger Map from its durable mirror at startup (durable profile) WITHOUT advancing
  // the chain -- the head is restored separately from the anchor via seedMembershipHead. Rebuilds the Map
  // directly (not via recordAuthorityMember) so seeding does not re-derive a fresh chain that would disagree
  // with the restored head. Parity with seedLifecycle/seedResolution/seedContexts.
  seedMembership(rows) {
    for (const r of rows || []) {
      if (!r || !r.run_id || !r.memory_id) continue;
      let m = this.#membership.get(r.run_id);
      if (!m) { m = new Map(); this.#membership.set(r.run_id, m); }
      m.set(r.memory_id, { digest: r.digest });
    }
  }

  // Restore the membership chain head from durable protected storage at startup (durable profile). Idempotent:
  // only seeds a fresh (empty) head, so it cannot be used mid-run to roll the live head back (mirror of
  // seedLifecycle/seedResolution).
  seedMembershipHead(head) {
    if (this.#membershipHead.count === 0 && head && Number.isFinite(head.count)) {
      this.#membershipHead = { count: head.count, lastSeq: head.lastSeq ?? 0, lastMac: head.lastMac ?? "" };
    }
  }

  membershipHead() { return { ...this.#membershipHead }; }

  verifyMembership(member) {
    if (typeof member?.mac !== "string") return false;
    const expected = this.#membershipMac(member);
    const a = Buffer.from(member.mac), b = Buffer.from(expected);
    if (a.length !== b.length) return false;
    return timingSafeEqual(a, b);
  }

  // ---- principals & authentication (administrative; behind the service boundary in production) ------

  registerPrincipal(principalId, { queues = [], lifecycle = false, clearance = "system", endorse = false, resolution = false, delegation = false, adoption = false } = {}) {
    this.#principals.set(principalId, { queues: new Set(queues), lifecycle: !!lifecycle, clearance, endorse: !!endorse, resolution: !!resolution, delegation: !!delegation, adoption: !!adoption });
    const sess = token("sess");
    this.#sessions.set(sess, principalId);
    return sess;
  }

  principalHasResolution(principalId) {
    const p = this.#principals.get(principalId);
    return !!p && p.resolution;
  }

  // Adoption authority is implied by resolution authority (a resolver may adopt a branch) or granted
  // explicitly. An adopt/resolve typed edge may be created ONLY by a principal holding it (review).
  principalHasAdoption(principalId) {
    const p = this.#principals.get(principalId);
    return !!p && (p.adoption || p.resolution);
  }

  principalHasDelegation(principalId) {
    const p = this.#principals.get(principalId);
    return !!p && p.delegation;
  }

  policyEpoch() { return this.policyVersion; }

  clearanceOf(principalId) {
    const p = this.#principals.get(principalId);
    return p ? integrityLevel(p.clearance) : 0;
  }

  authenticate(sessionToken) {
    const pid = this.#sessions.get(sessionToken);
    if (!pid) throw new Error("authentication_failed");
    return pid;
  }

  principalMayServe(principalId, receiver) {
    const p = this.#principals.get(principalId);
    return !!p && (p.queues.has(receiver) || p.queues.has("*"));
  }

  principalHasLifecycle(principalId) {
    const p = this.#principals.get(principalId);
    return !!p && p.lifecycle;
  }

  // ---- leases: issued only to an authenticated principal that holds the queue lock --------------

  // Authenticated, lock-verified lease issuance. The caller proves identity with a session token; the
  // control plane verifies (via the bound store) that this principal is the current lock owner of the
  // message and may serve its receiver. A caller cannot mint a lease for a principal it is not, nor for a
  // message it has not locked.
  issueLease(sessionToken, messageId) {
    const principal = this.authenticate(sessionToken);
    const msg = this.#requireSignedMessage(messageId);
    if (!this.principalMayServe(principal, msg.receiver)) throw new Error(`not_authorized_for_queue:${msg.receiver}`);
    if (!this.#store) throw new Error("control_plane_store_unbound");
    if (this.#store.lockOwnerOf(messageId) !== principal) throw new Error(`not_lock_owner:${messageId}`);
    const leaseId = `lease-${++this.#leaseSeq}`;
    const tok = token("leaset");
    // Bind the lease to the CURRENT lock generation (review M4) AND the exact signed-envelope digest of
    // its message (review M1/M4): a later takeover advances the generation, and any change to the message
    // envelope changes the digest -- either invalidates this lease.
    this.#leases.set(tok, { leaseId, principalId: principal, messageId,
      generation: this.#lockGenerationOf(messageId), envelopeDigest: this.#envelopeHash(msg), revoked: false,
      contextId: null });
    return { token: tok, leaseId, principal };
  }

  // Re-verify, against live store state, that a lease still holds the lock it was issued under and that
  // its message envelope is unchanged. Used at every security-sensitive operation so a lease that lost
  // its lock (takeover) or whose message was altered can no longer act (review M1/M4).
  #assertLeaseFresh(lease) {
    if (!this.#store) throw new Error("control_plane_store_unbound");
    if (this.#store.claimStatusOf && this.#store.claimStatusOf(lease.messageId) !== "locked") throw new Error("lease_message_not_active");
    if (this.#store.lockOwnerOf(lease.messageId) !== lease.principalId) throw new Error("lease_lock_lost");
    if (this.#lockGenerationOf(lease.messageId) !== lease.generation) throw new Error("lease_stale_generation");
    const msg = this.#requireSignedMessage(lease.messageId); // verified canonical message (identity + signature)
    if (this.#envelopeHash(msg) !== lease.envelopeDigest) throw new Error("lease_message_changed");
  }

  // Resolve a lease AND re-verify it still owns the lock at the current generation (fail-closed). The
  // read path and any caller acting under a lease should use this, not the bare resolveLease.
  resolveLeaseLive(leaseToken) {
    const lease = this.#leases.get(leaseToken);
    if (!lease || lease.revoked) throw new Error("lease_invalid");
    this.#assertLeaseFresh(lease);
    return { leaseId: lease.leaseId, principalId: lease.principalId, messageId: lease.messageId };
  }

  resolveLease(leaseToken) {
    const lease = this.#leases.get(leaseToken);
    if (!lease || lease.revoked) throw new Error("lease_invalid");
    return { leaseId: lease.leaseId, principalId: lease.principalId, messageId: lease.messageId };
  }

  revokeLease(leaseToken) {
    const lease = this.#leases.get(leaseToken);
    if (lease) lease.revoked = true;
  }

  // ---- integrity derivation (from verified canonical state, not caller input) -------------------

  endorse(sessionToken, targetLevel) {
    const principal = this.authenticate(sessionToken);
    const p = this.#principals.get(principal);
    if (!p || !p.endorse) throw new Error("not_authorized_to_endorse");
    return Math.min(integrityLevel(targetLevel), this.clearanceOf(principal));
  }

  // ---- attestation: the ONLY producers of a valid receipt / signature --------------------------

  #requireSignedMessage(id) {
    if (!this.#store) throw new Error("control_plane_store_unbound");
    const m = id ? this.#store.getSignedMessage(id) : null;
    if (!m) throw new Error(`unknown_message:${id}`);
    if (!this.verifyEnvelope(m)) throw new Error(`envelope_not_attested:${id}`);
    return m;
  }

  #receiptFor(memory) {
    return `hmac:${createHmac("sha256", this.#key).update(memoryContentHash(memory)).digest("hex")}`;
  }

  // Sign the ENTIRE envelope, not a field allowlist (review M1): the previous hash covered only routing/
  // authorization fields, so a store-write adversary could mutate the message PAYLOAD (the content an
  // agent consumes) or `state`/`correlation_id` while keeping a valid signature. We now canonicalize every
  // own field (sorted keys) except the signature itself, so any payload/state change invalidates the sig
  // and the read fails closed -- the integrity label is bound to the content it labels.
  #envelopeHash(env) {
    const o = {};
    for (const k of Object.keys(env || {}).sort()) {
      if (k === "envelope_sig") continue; // the signature is not part of the signed content
      o[k] = env[k];
    }
    return createHash("sha256").update(JSON.stringify(o)).digest("hex");
  }

  #sigFor(env) {
    return `esig:${createHmac("sha256", this.#key).update(this.#envelopeHash(env)).digest("hex")}`;
  }

  // Sign a message envelope for an authenticated sender. Integrity is DERIVED by the control plane: it
  // looks up each causal parent in the store, VERIFIES its signature, reads its (signed) integrity, and
  // meets with the sender's clearance. When the send is an OUTPUT of an execution (a context token is
  // supplied), it additionally meets with that context's accumulated integrity, so a derived message is
  // never more trusted than the inputs the execution consumed. A context-less send is a trusted INGRESS /
  // root creation (clearance + parents only); the data-plane facade requires a context, so an ordinary
  // agent cannot launder taint by emitting a context-less root. The caller may only LOWER.
  attestSend(sessionToken, env, contextToken = null) {
    const principal = this.authenticate(sessionToken);
    // Adopt/resolve edges are AUTHORITY-bearing (Gate 2.0): a signed edge proves who created it, not that
    // the creator may decide adoption. Only a principal holding adoption authority may create one, so an
    // ordinary authenticated sender cannot self-grant branch adoption. A plain depends edge needs no authority.
    if (Array.isArray(env?.parents)
        && env.parents.some((p) => p && (p.type === "adopt" || p.type === "resolve"))
        && !this.principalHasAdoption(principal)) {
      throw new Error("not_authorized_to_adopt");
    }
    let lvl = this.clearanceOf(principal);
    // Declared causal parents: verify the edge (same-run, strictly-precedes, no self-loop) and meet with
    // each parent's signed integrity. An unverified parent contributes untrusted (fail-closed).
    for (const pid of parentIdsOf(env)) {
      if (!pid) continue;
      const pe = this.#store ? this.#store.getSignedMessage(pid) : null;
      if (!pe || !this.verifyEnvelope(pe)) { lvl = 0; continue; }
      verifyCausalEdge(pe, env); // rejects a future/self/cross-run parent at SEND time
      lvl = Math.min(lvl, integrityLevel(pe.integrity));
    }
    if (contextToken != null) {
      const ctx = this.#resolveContextLive(sessionToken, contextToken); // active + same principal + MAC ok
      // The output belongs to THIS execution: a caller cannot retarget a derived message into another run
      // (cross-run laundering). Run is fixed at claim time and verified here.
      if ((env?.run_id ?? null) !== (ctx.runId ?? null)) throw new Error("context_run_mismatch");
      lvl = Math.min(lvl, ctx.integrity); // output bound by the execution's accumulated integrity
    }
    if (env?.integrity != null) lvl = Math.min(lvl, integrityLevel(env.integrity)); // caller may only lower
    const e = { ...env, sender: principal, integrity: lvl };
    return { env: e, sig: this.#sigFor(e), principal };
  }

  // Mint a receipt ONLY for a record that binds to a held lease AND whose authoritative metadata matches
  // the lease's verified canonical message; the write-time integrity is recomputed and frozen here.
  // Returns { receipt, integrity } -- the runtime must store the returned (frozen) integrity in the record.
  attestWrite(leaseToken, memory) {
    const lease = this.#leases.get(leaseToken);
    if (!lease || lease.revoked) throw new Error("lease_invalid");
    this.#assertLeaseFresh(lease); // M4: the lease must still own the lock at its issue generation
    const msg = this.#requireSignedMessage(lease.messageId); // verified canonical source message
    if (memory?.source_message_id !== lease.messageId) throw new Error("attest_mismatch:source");
    if (memory?.writer !== lease.principalId) throw new Error("attest_mismatch:writer");
    for (const f of ["run_id", "task_id", "trace_id", "policy_context"]) {
      if ((memory?.[f] ?? null) !== (msg?.[f] ?? null)) throw new Error(`attest_mismatch:${f}`);
    }
    if (memory?.scope !== "task") throw new Error("attest_mismatch:scope"); // widening requires policy, not a write
    // Frozen write-time integrity = the writer's EXECUTION CONTEXT integrity (review: per-execution model
    // replaces the principal x run consumed-input floor). The context already folds in the writer's
    // clearance, the claimed source message, and every input the writer EXPLICITLY attached, snapshotted at
    // attach time -- so a writer that attached an untrusted input cannot mint a trusted record, while an
    // unrelated execution by the same principal is NOT tainted (context isolation, not principal-global).
    const frozen = this.#frozenWriteIntegrity(lease);
    if (integrityLevel(memory?.integrity) !== frozen) throw new Error("attest_mismatch:integrity");
    return { receipt: this.#receiptFor(memory), integrity: frozen };
  }

  // The write-time integrity the runtime must stamp into a record before attestWrite (so attestWrite's
  // check passes and the value is frozen into the signed content hash).
  writeTimeIntegrity(leaseToken) {
    const lease = this.#leases.get(leaseToken);
    if (!lease || lease.revoked) throw new Error("lease_invalid");
    return this.#frozenWriteIntegrity(lease);
  }

  // The integrity an output written under this lease must carry: its execution context's accumulated
  // integrity if the lease belongs to a context (the normal path), else a single-input execution
  // (clearance meet source integrity) for a bare lease.
  #frozenWriteIntegrity(lease) {
    const msg = this.#requireSignedMessage(lease.messageId);
    const ctx = lease.contextId ? this.#contexts.get(lease.contextId) : null;
    if (ctx) {
      if (ctx.state !== "active") throw new Error("context_not_active");
      return ctx.integrity;
    }
    return Math.min(this.clearanceOf(lease.principalId), integrityLevel(msg.integrity));
  }

  // ---- ExecutionContext: the per-execution integrity unit (review: replace the principal x run floor) ----
  // A context is created when a principal CLAIMS a message and is the unit every output binds to. Its
  // integrity is the meet of the claimed message and every input later ATTACHED, snapshotted at attach
  // time, so it is monotone non-increasing and immune to a later store tamper of an input. The context is
  // authoritative in TCB memory and MAC'd, and mirrored to a durable table so the durable profile can
  // restore it (same key) or invalidate it (different/forged) across restart -- rather than letting a
  // stateless agent keep emitting outputs derived from consumed inputs. The token is an HMAC capability,
  // so it is unforgeable and stable across restart. Each helper that mutates a context returns the
  // persist-ready rows for the runtime to mirror; the in-memory copy is the source of truth.

  #contextMac(ctx) {
    const canonical = {
      context_id: ctx.contextId, principal_id: ctx.principalId, run_id: ctx.runId, task_id: ctx.taskId,
      trace_id: ctx.traceId, current_event_id: ctx.currentEventId, integrity: ctx.integrity,
      state: ctx.state, version: ctx.version,
      inputs: ctx.inputs
        .map((x) => ({ message_id: x.messageId, lease_id: x.leaseId, claim_generation: x.generation,
          envelope_digest: x.envelopeDigest, input_integrity: x.inputIntegrity }))
        .sort((a, b) => a.message_id.localeCompare(b.message_id)),
    };
    return `ctxmac:${createHmac("sha256", this.#key).update(JSON.stringify(canonical)).digest("hex")}`;
  }

  // HMAC capability token: ctx-<contextId>-<hmac(contextId|principalId)>. contextId is a random incarnation
  // nonce, not a reusable counter, so a stale token cannot re-bind to a new execution after mirror deletion.
  // Unforgeable without the key, and recomputable across restart for the same durable context row.
  #mintContextToken(ctx) {
    const mac = createHmac("sha256", this.#key).update(`ctxtok.${ctx.contextId}.${ctx.principalId}`).digest("hex");
    return `ctx-${ctx.contextId}-${mac}`;
  }

  #verifyContextToken(token) {
    if (typeof token !== "string" || !token.startsWith("ctx-")) throw new Error("context_token_malformed");
    const dash = token.indexOf("-", 4);
    if (dash < 0) throw new Error("context_token_malformed");
    const contextId = token.slice(4, dash);
    const presented = token.slice(dash + 1);
    const ctx = this.#contexts.get(contextId);
    if (!ctx) throw new Error("context_unknown");
    const expected = createHmac("sha256", this.#key).update(`ctxtok.${contextId}.${ctx.principalId}`).digest("hex");
    const a = Buffer.from(presented), b = Buffer.from(expected);
    if (a.length !== b.length || !timingSafeEqual(a, b)) throw new Error("context_token_invalid");
    return ctx;
  }

  // Resolve a context for a security-sensitive operation: re-authenticate the session, verify the
  // capability token, require the SAME principal and an active state, and recompute the MAC (so a
  // store-tampered durable row cannot raise integrity or resurrect a completed context). Fail-closed.
  #resolveContextLive(sessionToken, contextToken) {
    const principal = this.authenticate(sessionToken);
    const ctx = this.#verifyContextToken(contextToken);
    if (ctx.principalId !== principal) throw new Error("context_principal_mismatch");
    if (ctx.state !== "active") throw new Error("context_not_active");
    if (this.#contextMac(ctx) !== ctx.mac) throw new Error("context_not_attested");
    return ctx;
  }

  #contextPersist(ctx) {
    return {
      context: { context_id: ctx.contextId, principal_id: ctx.principalId, run_id: ctx.runId,
        task_id: ctx.taskId, trace_id: ctx.traceId, current_event_id: ctx.currentEventId,
        integrity: ctx.integrity, state: ctx.state, version: ctx.version, context_mac: ctx.mac },
      inputs: ctx.inputs.map((x) => ({ context_id: ctx.contextId, message_id: x.messageId, lease_id: x.leaseId,
        claim_generation: x.generation, envelope_digest: x.envelopeDigest, input_integrity: x.inputIntegrity })),
    };
  }

  // Create the execution context for a freshly claimed lease. Initial integrity = meet(writer clearance,
  // claimed message integrity); the claimed message is the first consumed input. Links the lease to the
  // context and returns the capability token plus persist-ready rows.
  createExecutionContext(leaseToken) {
    const lease = this.#leases.get(leaseToken);
    if (!lease || lease.revoked) throw new Error("lease_invalid");
    this.#assertLeaseFresh(lease);
    const msg = this.#requireSignedMessage(lease.messageId);
    const inputIntegrity = integrityLevel(msg.integrity);
    const ctx = {
      contextId: `ec${randomBytes(16).toString("hex")}`,
      principalId: lease.principalId,
      runId: msg.run_id ?? "", taskId: msg.task_id ?? "", traceId: msg.trace_id ?? "",
      currentEventId: msg.message_id,
      integrity: Math.min(this.clearanceOf(lease.principalId), inputIntegrity),
      state: "active", version: 1,
      inputs: [{ messageId: msg.message_id, leaseId: lease.leaseId, generation: lease.generation,
        envelopeDigest: this.#envelopeHash(msg), inputIntegrity }],
    };
    ctx.mac = this.#contextMac(ctx);
    this.#contexts.set(ctx.contextId, ctx);
    lease.contextId = ctx.contextId;
    return { token: this.#mintContextToken(ctx), ...this.#contextPersist(ctx) };
  }

  // Attach an additional verified input to a live context (explicit multi-input execution). The input is
  // snapshotted (digest + integrity at observation time) and meet-ed into the context, lowering it
  // monotonically. Cross-run inputs are refused (a bridge is a separate trusted operation).
  attachContextInput(sessionToken, contextToken, leaseToken) {
    const ctx = this.#resolveContextLive(sessionToken, contextToken);
    // (v20 round-13) FREEZE-ON-ATTACH. The transitive fold below snapshots the additional context's frontier +
    // integrity at attach time. A context that has ALREADY been attached as an input elsewhere must therefore be
    // immutable -- otherwise mutating it afterward (e.g. attaching a low-integrity input to it) would leave the
    // PARENT's snapshot stale, laundering a hidden dependency / raising the parent's integrity. So a context
    // refuses further inputs once it has been consumed as an input. (Legitimate flows attach children in
    // dependency order -- taint a context fully, THEN attach it -- so this never blocks a sound build.)
    if (ctx.attachedElsewhere) throw new Error("context_frozen_after_attach");
    const lease = this.#leases.get(leaseToken);
    if (!lease || lease.revoked) throw new Error("lease_invalid");
    if (lease.principalId !== ctx.principalId) throw new Error("context_input_principal_mismatch");
    this.#assertLeaseFresh(lease);
    const msg = this.#requireSignedMessage(lease.messageId);
    if ((msg.run_id ?? "") !== ctx.runId) throw new Error("cross_run_input_requires_bridge");
    // (v20 round-12) Fold the additional input TRANSITIVELY. If the lease belongs to an execution context, that
    // context may itself have CONSUMED other inputs (a chained merge) and already had its integrity lowered. Fold
    // its FULL input frontier AND its accumulated integrity -- not just the lease's primary message -- else a
    // hidden cross-branch low-integrity dependency is dropped from both this record's frontier and its integrity
    // meet, laundering it. A bare lease (no context) contributes only its primary message.
    const addCtx = lease.contextId ? this.#contexts.get(lease.contextId) : null;
    if (addCtx && addCtx.runId !== ctx.runId) throw new Error("cross_run_input_requires_bridge");
    const addInputs = (addCtx && Array.isArray(addCtx.inputs) && addCtx.inputs.length)
      ? addCtx.inputs.map((x) => ({ messageId: x.messageId, leaseId: x.leaseId, generation: x.generation, envelopeDigest: x.envelopeDigest, inputIntegrity: x.inputIntegrity }))
      : [{ messageId: msg.message_id, leaseId: lease.leaseId, generation: lease.generation, envelopeDigest: this.#envelopeHash(msg), inputIntegrity: integrityLevel(msg.integrity) }];
    let changed = false;
    for (const inp of addInputs) {
      if (!ctx.inputs.some((x) => x.messageId === inp.messageId)) {
        ctx.inputs.push(inp);
        ctx.integrity = Math.min(ctx.integrity, inp.inputIntegrity); // monotone non-increasing
        changed = true;
      }
    }
    // Also meet the additional context's accumulated integrity (covers any lowering beyond its per-input meets).
    if (addCtx && addCtx.integrity < ctx.integrity) { ctx.integrity = addCtx.integrity; changed = true; }
    // (v20 round-13) The additional context is now CONSUMED as an input here; freeze it so a later mutation
    // cannot make this snapshot stale (see freeze check at entry).
    if (addCtx) addCtx.attachedElsewhere = true;
    if (changed) {
      ctx.version += 1;
      ctx.mac = this.#contextMac(ctx);
    }
    return { token: contextToken, ...this.#contextPersist(ctx) };
  }

  // Terminate a context. A completed/aborted context can produce no further output (resolveContextLive
  // requires 'active'); the version bump + MAC keep the terminal state tamper-evident in the durable row.
  completeContext(sessionToken, contextToken, state = "completed") {
    const ctx = this.#resolveContextLive(sessionToken, contextToken);
    ctx.state = state === "aborted" ? "aborted" : "completed";
    ctx.version += 1;
    ctx.mac = this.#contextMac(ctx);
    // Closing a context revokes its leases (review: a completed/aborted context can no longer read, write,
    // send, or attach), so every operation -- not just the integrity-bearing ones -- fails closed after.
    for (const lease of this.#leases.values()) if (lease.contextId === ctx.contextId) lease.revoked = true;
    return this.#contextPersist(ctx);
  }

  #advanceContext(ctx, newEventId) {
    ctx.currentEventId = newEventId;
    ctx.version += 1;
    ctx.mac = this.#contextMac(ctx);
  }

  // Context-driven SEND (review S9): the caller supplies only {receiver, intent, payload, state,
  // requested_integrity}; the control plane DERIVES the whole envelope from the execution context --
  // run/task/trace, the parent (the context's current event), the authenticated sender, an ALLOCATED
  // sequence (S19, never caller-chosen and strictly after the parent), and the integrity (the context's,
  // optionally LOWERED by requested_integrity but never raised). The new message becomes the context's
  // current event (the execution's outputs chain), recorded as an output. Returns the signed envelope plus
  // persist-ready rows. An ordinary agent thus cannot select run/parent/sequence/integrity/sender.
  composeSend(sessionToken, contextToken, output = {}) {
    const ctx = this.#resolveContextLive(sessionToken, contextToken);
    if (!output || !output.receiver) throw new Error("send_requires_receiver");
    if (!output.intent) throw new Error("send_requires_intent");
    const parent = this.#requireSignedMessage(ctx.currentEventId); // verified current event
    const allocated = this.#store && this.#store.allocateSequence ? this.#store.allocateSequence(ctx.runId) : 0;
    const sequence = Math.max(Number(allocated) || 0, (Number(parent.sequence) || 0) + 1); // strictly after parent
    const integrity = Math.min(ctx.integrity, integrityLevel(output.requested_integrity ?? MAX_LEVEL));
    const env = {
      message_id: token("msg"),
      run_id: ctx.runId, task_id: ctx.taskId, trace_id: ctx.traceId,
      parent_message_id: ctx.currentEventId, correlation_id: null, delegated_from: null,
      sender: ctx.principalId, receiver: output.receiver, intent: output.intent,
      state: output.state ?? "ready", sequence,
      policy_context: parent.policy_context ?? null,
      integrity, payload: output.payload ?? null,
    };
    verifyCausalEdge(parent, env); // temporal happens-before from the current event (fail-closed)
    const sig = this.#sigFor(env);
    this.#advanceContext(ctx, env.message_id);
    const out = { context_id: ctx.contextId, context_version: ctx.version, output_id: env.message_id,
      output_kind: "message", output_digest: this.#envelopeHash(env), output_integrity: integrity };
    return { env: { ...env, envelope_sig: sig }, sig, output: out, ...this.#contextPersist(ctx) };
  }

  // Resolve a context for a READ (review S12): the read's active message IS the context's current event,
  // re-authenticated and MAC-verified, so read/send/write share one execution provenance.
  resolveReadContext(sessionToken, contextToken) {
    const ctx = this.#resolveContextLive(sessionToken, contextToken);
    // (v18 facade-forgery fix) The read-authorization SUBJECT is the message the principal CLAIMED (ctx.inputs[0],
    // verified by principalMayServe at claim) -- NOT the context's advanced current event. composeSend lets an
    // agent author a message with an arbitrary receiver/intent and #advanceContext would otherwise make that
    // self-composed message the active message, letting the agent forge its reader identity and intent (reading
    // records addressed to other receivers/types in its closure). Pinning the anchor to the claimed message
    // closes that forgery; run/task/policy are already context-pinned, and the kernel action path never advances
    // the current event, so it is unaffected.
    const claimed = (ctx.inputs && ctx.inputs[0] && ctx.inputs[0].messageId) ? ctx.inputs[0].messageId : ctx.currentEventId;
    return { activeMessageId: claimed, principalId: ctx.principalId, contextId: ctx.contextId,
      contextVersion: ctx.version, integrity: ctx.integrity };
  }

  // Record a non-message output (a memory write) against a live context WITHOUT advancing the causal
  // current event (a write does not move the execution's message frontier). Returns the output row; the
  // context's authoritative state is unchanged, so no MAC recompute is needed.
  noteContextOutput(leaseOrContextToken, sessionToken, { kind, outputId, digest, integrity }) {
    let ctx = null;
    if (typeof leaseOrContextToken === "string" && leaseOrContextToken.startsWith("ctx-")) {
      ctx = this.#resolveContextLive(sessionToken, leaseOrContextToken);
    } else {
      const lease = this.#leases.get(leaseOrContextToken);
      if (lease && !lease.revoked && lease.contextId) ctx = this.#contexts.get(lease.contextId);
    }
    if (!ctx) return null;
    return { context_id: ctx.contextId, context_version: ctx.version, output_id: outputId ?? digest,
      output_kind: kind, output_digest: digest, output_integrity: integrityLevel(integrity) };
  }

  // The active (non-revoked) lease backing a context's claim -- so the data-plane facade can write/read by
  // CONTEXT while the lease-centric write path (lock/freshness re-verification) is reused underneath.
  primaryLeaseFor(sessionToken, contextToken) {
    const ctx = this.#resolveContextLive(sessionToken, contextToken);
    for (const [tok, lease] of this.#leases) {
      if (lease.contextId === ctx.contextId && !lease.revoked) return tok;
    }
    throw new Error("context_has_no_active_lease");
  }

  // (v20 CE20-01) The FULL input frontier (message ids) the lease's execution context has consumed -- the
  // primary claimed message PLUS every attachContextInput. Returns null for a bare lease with no context (a
  // direct writeMemory has only its source). The write path binds this into the record so the read gate can
  // require every consumed input to be in the reader's closure (a hidden cross-branch input is otherwise
  // invisible: integrity meet summarized its trust but never recorded it as a dependency).
  contextInputFrontierForLease(leaseToken) {
    const lease = this.#leases.get(leaseToken);
    if (!lease || lease.revoked || !lease.contextId) return null;
    const ctx = this.#contexts.get(lease.contextId);
    if (!ctx || !Array.isArray(ctx.inputs)) return null;
    return ctx.inputs.map((i) => i.messageId);
  }

  // The capability token for the context a lease belongs to (claimSpecific returns a bare lease token for
  // backward compatibility; this lets a caller obtain the context handle for attach/complete/send).
  contextTokenForLease(leaseToken) {
    const lease = this.#leases.get(leaseToken);
    if (!lease || lease.revoked || !lease.contextId) return null;
    const ctx = this.#contexts.get(lease.contextId);
    return ctx ? this.#mintContextToken(ctx) : null;
  }

  // Read-only snapshot for a holder of the (verified) capability token -- used by tests/invariant gates.
  contextSnapshot(contextToken) {
    const ctx = this.#verifyContextToken(contextToken);
    return { contextId: ctx.contextId, integrity: ctx.integrity, state: ctx.state, version: ctx.version,
      runId: ctx.runId, principalId: ctx.principalId, inputs: ctx.inputs.length };
  }

  // (v20 CE20-03) Trusted anti-rollback head for a context's monotonic version. The MAC binds the context id
  // to its version (plus the integrity/input-count it carries at that version) under the control-plane key, so
  // the head is meaningful only in the kernel DB and cannot be forged by a memory-file adversary.
  #contextAnchorMac(contextId, version, integrity, inputCount) {
    return `ctxanchor:${createHmac("sha256", this.#key)
      .update(JSON.stringify({ context_id: contextId, version, integrity, input_count: inputCount })).digest("hex")}`;
  }

  // Advance the trusted version head for a context to (at least) `version` and return the durable anchor row
  // the runtime mirrors into kernel.context_anchor. Monotone: a head never moves backward, so even a same-key
  // restart cannot lower a context's recorded version. Called on every persist (create/attach/advance/complete).
  recordContextVersion(contextId, version, integrity, inputCount) {
    const v = Number(version) || 0;
    const prev = this.#contextVersionHead.get(contextId) || 0;
    const head = Math.max(prev, v);
    this.#contextVersionHead.set(contextId, head);
    return { context_id: contextId, version: head, integrity, input_count: inputCount,
      mac: this.#contextAnchorMac(contextId, head, integrity, inputCount) };
  }

  // Restore the trusted version heads from the kernel anchor at startup. Only MAC-valid rows seed a head; a
  // forged/garbage anchor row is ignored (so it cannot fabricate a higher head to abort a legitimate context).
  seedContextHeads(rows) {
    for (const r of rows || []) {
      if (r && r.mac === this.#contextAnchorMac(r.context_id, r.version, r.integrity, r.input_count)) {
        this.#contextVersionHead.set(r.context_id, Math.max(this.#contextVersionHead.get(r.context_id) || 0, Number(r.version) || 0));
      }
    }
  }

  // Restore contexts into TCB memory from the durable mirror at startup (durable profile). Each row's MAC
  // is re-verified under THIS instance's key; an unverifiable/forged context is loaded as 'aborted' (never
  // restored as a usable active execution), so a different-key restart cannot resurrect an execution.
  seedContexts(rows, inputsByContext) {
    for (const row of rows || []) {
      if (this.#contexts.has(row.context_id)) continue;
      const n = Number((String(row.context_id).match(/^ec(\d+)$/) || [])[1]);
      if (Number.isFinite(n) && n > this.#contextSeq) this.#contextSeq = n; // legacy counter ids only
      const inputs = (inputsByContext.get(row.context_id) || []).map((x) => ({ messageId: x.message_id,
        leaseId: x.lease_id, generation: x.claim_generation, envelopeDigest: x.envelope_digest,
        inputIntegrity: x.input_integrity }));
      const ctx = { contextId: row.context_id, principalId: row.principal_id, runId: row.run_id,
        taskId: row.task_id, traceId: row.trace_id, currentEventId: row.current_event_id,
        integrity: row.integrity, state: row.state, version: row.version, inputs, mac: row.context_mac };
      if (this.#contextMac(ctx) !== ctx.mac && ctx.state === "active") ctx.state = "aborted"; // fail closed
      // (v20 CE20-03) ANTI-ROLLBACK: the row's own MAC proves it is an AUTHENTIC past state, but not the FRESH
      // one. Cross-check the (untrusted) row version against the TRUSTED monotonic head. A store adversary that
      // restored a pre-taint snapshot (lower version, valid old MAC) to drop an integrity taint is caught here:
      // row.version < head => the context was rolled back => load as 'aborted' (fail closed). Equal/greater is
      // fresh. The head lives in the kernel DB the memory-file adversary cannot write, so it cannot be lowered.
      const trustedV = this.#contextVersionHead.get(ctx.contextId);
      if (trustedV != null && (Number(ctx.version) || 0) < trustedV && ctx.state === "active") ctx.state = "aborted";
      this.#contexts.set(ctx.contextId, ctx);
    }
  }

  verifyReceipt(memory) {
    if (typeof memory?.write_receipt !== "string") return false;
    const expected = this.#receiptFor(memory);
    const a = Buffer.from(memory.write_receipt);
    const b = Buffer.from(expected);
    if (a.length !== b.length) return false;
    return timingSafeEqual(a, b);
  }

  verifyEnvelope(env) {
    if (typeof env?.envelope_sig !== "string") return false;
    const expected = this.#sigFor(env);
    const a = Buffer.from(env.envelope_sig);
    const b = Buffer.from(expected);
    if (a.length !== b.length) return false;
    return timingSafeEqual(a, b);
  }

  receiptDigest(receipt) {
    return receipt ? `rd:${createHash("sha256").update(String(receipt)).digest("hex").slice(0, 24)}` : null;
  }

  // ---- lifecycle attestation (review M3): lifecycle events are authorization-bearing, so they are
  // MAC-chained like receipts. Each event's MAC covers a monotonic seq and the previous event's MAC, so a
  // deletion or reordering breaks the chain; the read/replay path recomputes the chain and fails closed.
  #lifecycleMac(o) {
    const fields = [o.seq, o.prev_mac ?? "", o.memory_id, o.kind, o.superseded_by ?? null, o.by_principal, o.policy_version];
    return `lcmac:${createHmac("sha256", this.#key).update(JSON.stringify(fields)).digest("hex")}`;
  }

  // Append a lifecycle event onto the chain whose HEAD lives in TCB memory (review: suffix-rollback). The
  // seq/prev_mac come from the in-memory head, not the writable store, so an adversary who deletes events
  // and replays an old valid (count,last_mac) into the store DB cannot roll the head back: the read path
  // compares against this private head. Returns the chained {seq, prev_mac, mac} for the runtime to persist.
  lifecycleAppend(sessionToken, core) {
    const principal = this.authenticate(sessionToken);
    if (!this.principalHasLifecycle(principal)) throw new Error("not_authorized_for_lifecycle");
    if (core?.by_principal !== principal) throw new Error("lifecycle_actor_mismatch");
    const seq = this.#lifecycleHead.lastSeq + 1;
    const prev_mac = this.#lifecycleHead.lastMac;
    const mac = this.#lifecycleMac({ ...core, seq, prev_mac });
    this.#lifecycleHead = { count: this.#lifecycleHead.count + 1, lastSeq: seq, lastMac: mac };
    return { seq, prev_mac, mac };
  }

  // Restore the head from durable protected storage at startup (durable profile). Idempotent: only seeds a
  // fresh (empty) head, so it cannot be used mid-run to roll the live head back.
  seedLifecycle(head) {
    if (this.#lifecycleHead.count === 0 && head && Number.isFinite(head.count)) {
      this.#lifecycleHead = { count: head.count, lastSeq: head.lastSeq ?? 0, lastMac: head.lastMac ?? "" };
    }
  }

  lifecycleHead() { return { ...this.#lifecycleHead }; }

  verifyLifecycle(event) {
    if (typeof event?.mac !== "string") return false;
    const expected = this.#lifecycleMac(event);
    const a = Buffer.from(event.mac);
    const b = Buffer.from(expected);
    if (a.length !== b.length) return false;
    return timingSafeEqual(a, b);
  }

  // ---- Gate 2.0: signed merge-resolution certificates ----------------------------------------------
  // Canonicalize the certificate body so the signature is order-independent over accepted/rejected sets.
  #resolutionCore(o) {
    return JSON.stringify({ logical_key: o.logical_key,
      accepted: [...(o.accepted || [])].sort(), rejected: [...(o.rejected || [])].sort(),
      conflict_set_digest: o.conflict_set_digest ?? "",
      resolver: o.resolver, authority: o.authority, policy_epoch: o.policy_epoch });
  }

  #resolutionSig(core) {
    return `rsig:${createHmac("sha256", this.#key).update(core).digest("hex")}`;
  }

  // Issue a signed resolution certificate for a logical_key. Requires an authenticated principal holding
  // RESOLUTION authority; it names which same-key record(s) are ADOPTED and is bound to the current policy
  // epoch. No public sign method exists, so a certificate cannot be forged.
  issueResolution(sessionToken, { logical_key, accepted = [], rejected = [], conflict_set = [], conflict_set_digest = "" }) {
    const principal = this.authenticate(sessionToken);
    if (!this.principalHasResolution(principal)) throw new Error("not_authorized_to_resolve");
    if (!logical_key) throw new Error("resolution_requires_logical_key");
    // A resolution names THE adopted version (review: "names the adopted one"). Accepting more than one
    // concurrent record would re-admit the conflict it is meant to resolve, so a multi-accept certificate is
    // rejected at issuance. (To merge several inputs, write a new synthesized record and adopt that one.)
    if (!Array.isArray(accepted) || accepted.length !== 1) throw new Error("resolution_requires_single_accepted");
    const cert = { resolution_id: token("res"), logical_key, accepted: [...accepted], rejected: [...rejected],
      conflict_set: [...conflict_set], conflict_set_digest,
      resolver: principal, authority: "policy-resolution", policy_epoch: this.policyVersion };
    cert.resolution_sig = this.#resolutionSig(this.#resolutionCore(cert));
    return cert;
  }

  verifyResolution(cert) {
    if (typeof cert?.resolution_sig !== "string") return false;
    const expected = this.#resolutionSig(this.#resolutionCore(cert));
    const a = Buffer.from(cert.resolution_sig), b = Buffer.from(expected);
    if (a.length !== b.length) return false;
    return timingSafeEqual(a, b);
  }

  // Merge-resolution MAC chain (mirror of the lifecycle chain). The chain mac covers a monotonic seq, the
  // previous mac, and the cert fields, so a deletion / reorder / count-preserving delete+reinsert is detected
  // against the TCB-held head. This is SEPARATE from resolution_sig (which binds the cert contents): the sig
  // proves authenticity, the chain proves freshness + non-deletion + ordering.
  #resolutionChainMac(o) {
    const fields = [o.seq, o.prev_mac ?? "", o.resolution_id, o.logical_key,
      [...(o.accepted || [])].sort(), [...(o.rejected || [])].sort(), o.conflict_set_digest ?? "",
      o.resolver, o.authority, o.policy_epoch];
    return `rcmac:${createHmac("sha256", this.#key).update(JSON.stringify(fields)).digest("hex")}`;
  }

  // Append a resolution onto the chain whose HEAD lives in TCB memory. seq/prev_mac come from the in-memory
  // head, not the writable store, so an adversary who deletes the current resolution and reinserts an old
  // valid copy cannot move the head: the read path compares against this private head and fails closed.
  resolutionAppend(sessionToken, core) {
    const principal = this.authenticate(sessionToken);
    if (!this.principalHasResolution(principal)) throw new Error("not_authorized_to_resolve");
    if (core?.resolver !== principal) throw new Error("resolution_actor_mismatch");
    const seq = this.#resolutionHead.lastSeq + 1;
    const prev_mac = this.#resolutionHead.lastMac;
    const mac = this.#resolutionChainMac({ ...core, seq, prev_mac });
    this.#resolutionHead = { count: this.#resolutionHead.count + 1, lastSeq: seq, lastMac: mac };
    return { seq, prev_mac, mac };
  }

  seedResolution(head) {
    if (this.#resolutionHead.count === 0 && head && Number.isFinite(head.count)) {
      this.#resolutionHead = { count: head.count, lastSeq: head.lastSeq ?? 0, lastMac: head.lastMac ?? "" };
    }
  }

  resolutionHead() { return { ...this.#resolutionHead }; }

  verifyResolutionChain(event) {
    if (typeof event?.mac !== "string") return false;
    const expected = this.#resolutionChainMac(event);
    const a = Buffer.from(event.mac), b = Buffer.from(expected);
    if (a.length !== b.length) return false;
    return timingSafeEqual(a, b);
  }

  // ---- Gate 2.0: signed cross-task delegation certificates -----------------------------------------
  #delegationCore(o) {
    return JSON.stringify({ memory_ids: [...(o.memory_ids || [])].sort(), target_task: o.target_task,
      target_receiver: o.target_receiver, delegator: o.delegator, authority: o.authority, policy_epoch: o.policy_epoch });
  }

  #delegationSig(core) {
    return `dsig:${createHmac("sha256", this.#key).update(core).digest("hex")}`;
  }

  // Authorize named records to be READ by a target task/receiver across the task boundary. Requires a
  // principal with DELEGATION authority; grants read only (integrity is inherited, never raised).
  issueDelegation(sessionToken, { memory_ids = [], target_task, target_receiver }) {
    const principal = this.authenticate(sessionToken);
    if (!this.principalHasDelegation(principal)) throw new Error("not_authorized_to_delegate");
    if (!target_task || !target_receiver) throw new Error("delegation_requires_target");
    const cert = { delegation_id: token("del"), memory_ids: [...memory_ids], target_task, target_receiver,
      delegator: principal, authority: "policy-delegation", policy_epoch: this.policyVersion };
    cert.delegation_sig = this.#delegationSig(this.#delegationCore(cert));
    return cert;
  }

  verifyDelegation(cert) {
    if (typeof cert?.delegation_sig !== "string") return false;
    const expected = this.#delegationSig(this.#delegationCore(cert));
    const a = Buffer.from(cert.delegation_sig), b = Buffer.from(expected);
    if (a.length !== b.length) return false;
    return timingSafeEqual(a, b);
  }

  // ---- Gate 2.0: read-to-use transaction tokens ----------------------------------------------------
  // A prepared read returns a token binding the active message, the EXACT exposed records (id+hash), and the
  // lifecycle/policy/resolution EPOCHS at read time, plus the permitted effect capability and an expiry. At
  // action-commit time the token is verified and the bound epochs are compared to live state; any
  // revocation, policy change, or new resolution since the read makes it stale (read-to-use serializability).
  mintReadToken(payload) {
    const body = Buffer.from(JSON.stringify(payload)).toString("base64");
    const sig = createHmac("sha256", this.#key).update(body).digest("hex");
    return `rtok.${body}.${sig}`;
  }

  verifyReadToken(tokenStr) {
    if (typeof tokenStr !== "string" || !tokenStr.startsWith("rtok.")) throw new Error("read_token_malformed");
    const dot = tokenStr.lastIndexOf(".");
    const body = tokenStr.slice(5, dot);
    const presented = tokenStr.slice(dot + 1);
    const expected = createHmac("sha256", this.#key).update(body).digest("hex");
    const a = Buffer.from(presented), b = Buffer.from(expected);
    if (a.length !== b.length || !timingSafeEqual(a, b)) throw new Error("read_token_invalid");
    return JSON.parse(Buffer.from(body, "base64").toString("utf8"));
  }

  static ENVELOPE_FIELDS = ["message_id", "run_id", "task_id", "trace_id", "parent_message_id",
    "delegated_from", "sender", "receiver", "intent", "sequence", "policy_context", "integrity"];
}
