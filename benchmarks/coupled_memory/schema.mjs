export const COUPLED_MEMORY_SCHEMA = `
CREATE TABLE IF NOT EXISTS runs (
  run_id TEXT PRIMARY KEY,
  status TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  -- Monotonic per-run sequence counter (review S19): the control plane allocates the next sequence for a
  -- context-driven send atomically here, so an ordinary agent cannot choose its own sequence (and thereby
  -- forge happens-before ordering). Ingress/seeding may still supply an explicit sequence.
  next_sequence INTEGER NOT NULL DEFAULT 1,
  metadata_json TEXT NOT NULL DEFAULT '{}'
);

CREATE TABLE IF NOT EXISTS messages (
  message_id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL,
  task_id TEXT NOT NULL,
  trace_id TEXT NOT NULL,
  parent_message_id TEXT,
  correlation_id TEXT,
  delegated_from TEXT,
  sender TEXT NOT NULL,
  receiver TEXT NOT NULL,
  intent TEXT NOT NULL,
  state TEXT NOT NULL,
  sequence INTEGER NOT NULL,
  policy_context TEXT,
  envelope_json TEXT NOT NULL,
  envelope_sig TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS message_queue (
  queue_id INTEGER PRIMARY KEY AUTOINCREMENT,
  message_id TEXT NOT NULL,
  run_id TEXT NOT NULL,
  receiver TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  available_at TEXT NOT NULL,
  locked_by TEXT,
  locked_at TEXT,
  lock_generation INTEGER NOT NULL DEFAULT 0,
  attempts INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS shared_memory (
  memory_id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL,
  task_id TEXT NOT NULL,
  trace_id TEXT,
  source_message_id TEXT NOT NULL,
  writer TEXT NOT NULL,
  memory_type TEXT NOT NULL,
  scope TEXT NOT NULL,
  status TEXT NOT NULL,
  content TEXT,
  content_ref TEXT,
  allowed_readers_json TEXT NOT NULL,
  supersedes_json TEXT NOT NULL DEFAULT '[]',
  valid_from_event TEXT,
  valid_until_event TEXT,
  policy_context TEXT,
  integrity INTEGER,
  -- Logical decision key (Gate 2.0): records sharing a logical_key are competing versions of the SAME
  -- decision (e.g. "retention_period"). The set-level coherent-view gate requires that, among same-key
  -- records reachable from the active message, concurrent (causally incomparable) versions be resolved by
  -- a signed resolution certificate -- ancestry alone does not make a record authoritative.
  logical_key TEXT,
  -- Effect ceiling (Gate 2.0 #4): the set of effect classes this record may JUSTIFY (e.g. ["summarize",
  -- "answer"]). Distinct from visibility: a low-trust record may be observed for reasoning yet not justify
  -- a sensitive action. The view's capability is the MEET (intersection) over all exposed records, so the
  -- action a read justifies is bounded by the least-privileged record in the prompt. For external tools, NULL
  -- is not a positive grant; at least one exposed record must grant the effect class.
  effect_ceiling TEXT,
  -- (v20 CE20-00) Write-EVENT causal position: a monotonic per-run sequence allocated from the SAME counter as
  -- messages AT WRITE TIME, so a record's write is a first-class causal event, not just a label reusing an old
  -- ancestor's id. The read gate requires write_seq <= the active message's sequence, so a record whose write
  -- happened-after the active message (even if sourced at an ancestor) is NOT in the active message's causal past.
  write_seq INTEGER,
  -- (v20 CE20-01) Full input frontier the writing context consumed (JSON array of message ids), bound at write
  -- time. The read gate requires every input to be in the reader's causal closure (or covered by a delegation),
  -- so a record that depended on an input outside the reader's closure is not admitted (integrity meet alone
  -- summarized trust but hid the dependency).
  input_frontier_json TEXT,
  audit_hash TEXT,
  write_receipt TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

-- Signed merge-resolution certificates (Gate 2.0). When a true branch merge brings two concurrent
-- versions of the same logical_key into an active message's causal closure, an authorized resolver issues
-- a certificate naming which version is ADOPTED; the coherent-view gate then admits only the accepted
-- record and denies the rejected ones. Without a certificate, same-key concurrent records are denied
-- (REQUIRE_RESOLUTION). The certificate is HMAC-signed by the control plane and carries a policy epoch so
-- it can be re-validated at action-commit time.
CREATE TABLE IF NOT EXISTS merge_resolutions (
  resolution_id TEXT PRIMARY KEY,
  logical_key TEXT NOT NULL,
  accepted_json TEXT NOT NULL,
  rejected_json TEXT NOT NULL,
  conflict_set_json TEXT NOT NULL DEFAULT '[]',
  conflict_set_digest TEXT NOT NULL DEFAULT '',
  resolver TEXT NOT NULL,
  authority TEXT NOT NULL,
  policy_epoch INTEGER NOT NULL,
  resolution_sig TEXT NOT NULL,
  -- A resolution is authorization-bearing (it decides which concurrent record is adopted), so the log is
  -- MAC-chained exactly like memory_lifecycle_events: seq is monotonic (TCB-assigned), mac covers
  -- (seq, prev_mac, cert fields). A delete+reinsert (resurrecting a superseded resolution) or reorder
  -- breaks the chain against resolution_anchor below and the read/commit/replay paths fail closed. The
  -- authoritative "latest" resolution is chosen by seq (not the writable created_at), so a millisecond
  -- created_at collision can no longer pick the wrong (older) resolution.
  seq INTEGER,
  prev_mac TEXT,
  mac TEXT,
  created_at TEXT NOT NULL
);

-- Read-to-use tokens (Gate 2.0). A prepared read mints a token; the matching action must present it to
-- commit. The row enables ONE-SHOT consumption (CAS consumed 0->1 inside the commit) and expiry, so a token
-- is a single-use, time-bounded capability, not a replayable bearer token. token_id is the binding; the
-- signed payload (principal, active message, per-key epochs, intended effect) is verified separately.
CREATE TABLE IF NOT EXISTS read_tokens (
  token_id TEXT PRIMARY KEY,
  principal TEXT NOT NULL,
  active_message_id TEXT,
  consumed INTEGER NOT NULL DEFAULT 0,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL
);

-- TCB-managed monotonic security versions (security-kernel pivot). The per-key decision epoch used to be
-- COUNT(records):COUNT(resolutions); an add-one-delete-one (insert a same-key record via writeMemory, then a
-- store-write adversary deletes another same-key row) leaves that COUNT unchanged, so a view prepared before
-- the swap would wrongly pass commit-time freshness. Each security domain instead carries an explicit
-- MONOTONIC version, incremented by the control plane on every relevant mutation (write / retire / supersede /
-- resolution); it only ever increases, so any same-key state change strictly advances it and the stale view is
-- detected at commit. scope_key is the domain key (e.g. "<run_id>|<logical_key>" for the 'key' domain). The row
-- is in the writable store, so a fully consistent store-rewriting adversary is out of scope (as elsewhere);
-- what this closes is the count-collision a non-rewriting store-write adversary could exploit.
CREATE TABLE IF NOT EXISTS security_versions (
  domain TEXT NOT NULL,
  scope_key TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (domain, scope_key)
);

-- Monotonic anchor for the merge-resolution MAC chain (mirror of lifecycle_anchor). The TCB-held head is
-- authoritative; the read/replay path requires the rows to match the head's count and chain, so deleting or
-- swapping a resolution row is detected and fails closed.
CREATE TABLE IF NOT EXISTS resolution_anchor (
  id TEXT PRIMARY KEY,
  count INTEGER NOT NULL DEFAULT 0,
  last_mac TEXT,
  last_seq INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL
);

-- Signed cross-task delegation certificates (Gate 2.0 #delegate). By default the gate denies a record whose
-- task differs from the active message (task_scope). A delegation certificate -- issued by a principal with
-- delegation authority -- explicitly authorizes named records to be READ by a target task/receiver. It
-- grants read across the task boundary only; integrity is INHERITED (never raised), so a low-integrity
-- delegated record is still denied by the integrity-flow predicate. HMAC-signed, policy-epoch bound,
-- snapshotted into the read manifest and re-verified on replay.
CREATE TABLE IF NOT EXISTS delegations (
  delegation_id TEXT PRIMARY KEY,
  memory_ids_json TEXT NOT NULL,
  target_task TEXT NOT NULL,
  target_receiver TEXT NOT NULL,
  delegator TEXT NOT NULL,
  authority TEXT NOT NULL,
  policy_epoch INTEGER NOT NULL,
  delegation_sig TEXT NOT NULL,
  created_at TEXT NOT NULL
);

-- Authoritative lifecycle log (review M5). Supersession/expiration/revocation are CONTROL-PLANE
-- events appended by a principal holding lifecycle authority, NOT a writer-declared status string.
-- In secure mode the gate active-status predicate is computed from this log (a record is retired iff
-- it has an expire/revoke event, or a supersede event names it), so a secure writer cannot keep a
-- stale record live by stamping status active, and cannot retire a rival record without authority.
CREATE TABLE IF NOT EXISTS memory_lifecycle_events (
  event_id TEXT PRIMARY KEY,
  memory_id TEXT NOT NULL,
  kind TEXT NOT NULL,            -- 'supersede' | 'expire' | 'revoke'
  superseded_by TEXT,           -- new memory id (supersede only)
  by_principal TEXT NOT NULL,
  policy_version INTEGER NOT NULL,
  -- review M3: lifecycle events are authorization-bearing and MAC-chained. seq is monotonic; mac covers
  -- (seq, prev_mac, event fields) so deletion/reorder/forgery is detected against the anchor below.
  seq INTEGER,
  prev_mac TEXT,
  mac TEXT,
  created_at TEXT NOT NULL
);

-- Monotonic anchor for the lifecycle MAC chain (review M3). Updated in the same transaction as each
-- lifecycle event; the read/replay path requires events to match count and chain head, so deleting a
-- revocation row (which would silently un-retire a record) is detected and fails closed.
CREATE TABLE IF NOT EXISTS lifecycle_anchor (
  id TEXT PRIMARY KEY,
  count INTEGER NOT NULL DEFAULT 0,
  last_mac TEXT,
  last_seq INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL
);

-- ExecutionContext (review: replace the principal x run consumed-input floor with a per-execution unit).
-- A context is created when a principal CLAIMS a message; every message it SENDS and every record it
-- WRITES is bound to the context's accumulated integrity. integrity is the MEET of the claimed message
-- and every input subsequently attached, snapshotted at attach time so it is monotone non-increasing and
-- immune to later store tampering. The row is part of the control-plane TCB: context_mac is an HMAC over
-- the whole context (incl. the input manifest) under the attestation key, so a store-write adversary
-- cannot raise integrity, rewind the version, or resurrect a completed context without breaking the MAC.
-- Persisted (not just in TCB memory) so the durable profile can restore or invalidate a context across
-- restart instead of silently letting a stateless agent keep producing outputs from consumed inputs.
CREATE TABLE IF NOT EXISTS execution_contexts (
  context_id TEXT PRIMARY KEY,
  principal_id TEXT NOT NULL,
  run_id TEXT NOT NULL,
  task_id TEXT NOT NULL,
  trace_id TEXT NOT NULL,
  current_event_id TEXT NOT NULL,
  integrity INTEGER NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('active', 'completed', 'aborted')),
  version INTEGER NOT NULL DEFAULT 1,
  context_mac TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

-- The verified inputs a context has consumed, snapshotted at attach time (review: fail-closed input
-- verification). Each row records the input message, the lease/generation it was consumed under, the
-- exact signed-envelope digest, and the integrity that was meet-ed into the context. The context_mac
-- covers this manifest, so deleting or mutating an input row is detected; the snapshot means a later
-- transient tamper of the source message cannot raise an already-accumulated context.
CREATE TABLE IF NOT EXISTS execution_inputs (
  context_id TEXT NOT NULL,
  message_id TEXT NOT NULL,
  lease_id TEXT NOT NULL,
  claim_generation INTEGER NOT NULL,
  envelope_digest TEXT NOT NULL,
  input_integrity INTEGER NOT NULL,
  observed_at TEXT NOT NULL,
  PRIMARY KEY (context_id, message_id)
);

-- Durable mirror of the TCB authority-membership ledger (v18 P0-1): every authority-bearing record
-- (effect_ceiling / logical_key) by content digest. Restored into control-plane memory at startup so the
-- deletion-omission alarm survives a restart. The mirror is MAC-CHAINED exactly like memory_lifecycle_events
-- / merge_resolutions (v19): seq is monotonic (TCB-assigned by recordAuthorityMember), mac covers
-- (seq, prev_mac, run_id, memory_id, digest). Earlier this table held only (run_id, memory_id, digest) with
-- NO count and NO MAC -- a FALSE parity with the lifecycle/resolution heads: a key-stable restart that
-- DELETED both a restrictive record's shared_memory row AND this mirror row restored a SILENTLY SMALLER
-- ledger, so the deletion-omission alarm never fired and the capability meet widened. The chain + anchor
-- below close that: a shrunk mirror no longer matches the TCB head and the read/replay path fails closed.
CREATE TABLE IF NOT EXISTS authority_membership (
  run_id TEXT NOT NULL,
  memory_id TEXT NOT NULL,
  digest TEXT NOT NULL,
  seq INTEGER,
  prev_mac TEXT,
  mac TEXT,
  PRIMARY KEY (run_id, memory_id)
);

-- Monotonic anchor for the authority-membership MAC chain (mirror of lifecycle_anchor / resolution_anchor,
-- v19). Updated in the same write as each membership append; the read/replay path requires the surviving
-- mirror rows to match this head's count and chain, so deleting a mirror row (which would shrink the
-- authority ledger and widen the capability meet) is detected and fails closed. Like the lifecycle/
-- resolution anchors, the in-instance guarantee is strong (the TCB head is held in control-plane memory and
-- stays AHEAD of the store, so a mid-run suffix-rollback is caught); ACROSS A RESTART the head is restored
-- from this row, so the cross-restart non-deletion guarantee rests on the same assumption those anchors do --
-- that the durable head sits in PROTECTED storage a non-rewriting store-write adversary cannot consistently
-- forge. A fully consistent store-rewriting adversary (who edits the anchor to match a truncated mirror) is
-- out of scope here exactly as it is for lifecycle_anchor/resolution_anchor.
CREATE TABLE IF NOT EXISTS membership_anchor (
  id TEXT PRIMARY KEY,
  count INTEGER NOT NULL DEFAULT 0,
  last_mac TEXT,
  last_seq INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL
);

-- The outputs a context produced (review S3.1/S11): one row per message sent or record written, with the
-- context version at emission and the output digest. This makes the execution's effect auditable/replayable
-- (every output is attributable to a context+version) without trusting the mutable data plane.
CREATE TABLE IF NOT EXISTS execution_outputs (
  context_id TEXT NOT NULL,
  context_version INTEGER NOT NULL,
  output_id TEXT NOT NULL,
  output_kind TEXT NOT NULL,        -- 'message' | 'memory'
  output_digest TEXT NOT NULL,
  output_integrity INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (context_id, output_id)
);

CREATE TABLE IF NOT EXISTS artifacts (
  artifact_id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL,
  task_id TEXT NOT NULL,
  source_message_id TEXT NOT NULL,
  version INTEGER NOT NULL,
  uri TEXT NOT NULL,
  status TEXT NOT NULL,
  allowed_readers_json TEXT NOT NULL,
  metadata_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS events (
  event_id TEXT PRIMARY KEY,
  event_type TEXT NOT NULL,
  run_id TEXT NOT NULL,
  task_id TEXT,
  trace_id TEXT,
  message_id TEXT,
  memory_id TEXT,
  artifact_id TEXT,
  agent TEXT,
  decision TEXT,
  result TEXT,
  payload_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS memory_access_decisions (
  decision_id TEXT PRIMARY KEY,
  read_id TEXT,
  run_id TEXT NOT NULL,
  task_id TEXT NOT NULL,
  message_id TEXT NOT NULL,
  memory_id TEXT NOT NULL,
  reader TEXT NOT NULL,
  decision TEXT NOT NULL,
  reason TEXT NOT NULL,
  memory_content_hash TEXT,
  created_at TEXT NOT NULL
);

-- One row per gated memory read (review M2). Persists everything an INDEPENDENT replay needs to
-- re-run the gate from scratch and detect tampered/missing/duplicate/deleted decisions: the active
-- message snapshot, the candidate-set manifest evaluated, the resulting admitted set, the causal
-- closure used, and the gate configuration. The per-candidate verdicts live in
-- memory_access_decisions keyed by read_id.
CREATE TABLE IF NOT EXISTS memory_reads (
  read_id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL,
  task_id TEXT NOT NULL,
  message_id TEXT NOT NULL,
  reader TEXT NOT NULL,
  condition TEXT,
  active_message_json TEXT NOT NULL,
  candidate_ids_json TEXT NOT NULL,
  admitted_ids_json TEXT NOT NULL,
  ancestor_closure_json TEXT,
  gate_options_json TEXT NOT NULL DEFAULT '{}',
  -- Security profile of the decision (review M6): which monitor/profile/key signed it, the
  -- authenticated principal and lease, the retired-set used, and a per-admitted-record receipt digest
  -- so an INDEPENDENT replay (given the same control-plane key) reproduces attestation-mode decisions
  -- exactly and flags a mutated receipt. Holds no key material (digests only).
  security_json TEXT,
  created_at TEXT NOT NULL
);

-- Monotonic per-run read counter (review M1.4). Bumped in the same transaction as each gated read so
-- an independent replay can tell "no reads happened" from "the read manifest was deleted": if the
-- anchor says N reads but fewer survive, replay flags read_manifest_deleted. The anchor shares the
-- writable store, so a fully consistent store-rewriting adversary can also edit it (stated out of
-- scope); what this removes is the previous FALSE ok=true on a wiped log under an honest substrate.
CREATE TABLE IF NOT EXISTS audit_anchor (
  run_id TEXT PRIMARY KEY,
  reads INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL
);

-- Kernel-mediated action authorization (security-kernel headline). queryMemory() returns an OPAQUE 256-bit
-- view_id handle; ALL authorization state lives here in the trusted store, never in a client-held token, so a
-- leaked handle is inert unless (principal, context) match. The view binds the FULL context snapshot
-- (version + integrity + active-envelope digest) and the coherent view_root, re-validated atomically inside
-- executeAuthorizedAction(); the server-side freshness token (reused from the read-to-use path) is NEVER
-- returned to the caller. state is CAS-consumed (pending->consumed) so a view authorizes at most one dispatch.
CREATE TABLE IF NOT EXISTS prepared_views (
  view_id TEXT PRIMARY KEY,
  principal_id TEXT NOT NULL,
  context_id TEXT,
  context_version INTEGER,
  context_integrity INTEGER,
  active_message_id TEXT,
  active_envelope_digest TEXT,
  lock_generation INTEGER,
  query_digest TEXT,
  view_root TEXT NOT NULL,
  exposed_count INTEGER NOT NULL DEFAULT 0,
  intended_effect TEXT NOT NULL,
  capability_json TEXT,
  token TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'pending' CHECK (state IN ('pending', 'consumed', 'expired')),
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL
);

-- Transactional action outbox: the kernel authorizes the EXACT canonical action, CAS-consumes the view, and
-- records the action here BEFORE a trusted dispatcher (which alone holds tool credentials) executes it. The
-- agent never receives an executable ALLOW, so there is no verify->execute gap to substitute into.
CREATE TABLE IF NOT EXISTS action_outbox (
  action_id TEXT PRIMARY KEY,
  view_id TEXT NOT NULL,
  principal_id TEXT NOT NULL,
  canonical_action_json TEXT NOT NULL,
  action_digest TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  status TEXT NOT NULL,
  dispatch_result_json TEXT,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_messages_run_task ON messages(run_id, task_id);
CREATE INDEX IF NOT EXISTS idx_queue_receiver_status ON message_queue(receiver, status, available_at);
CREATE INDEX IF NOT EXISTS idx_memory_run_task_status ON shared_memory(run_id, task_id, status);
CREATE INDEX IF NOT EXISTS idx_memory_type_status ON shared_memory(memory_type, status);
CREATE INDEX IF NOT EXISTS idx_events_run ON events(run_id, created_at);
CREATE INDEX IF NOT EXISTS idx_decisions_message ON memory_access_decisions(message_id);
-- Idempotency: the kernel keys each authorized action by sha256(view_id:action_digest). This UNIQUE index is
-- the atomic backstop that makes that key actually dedup -- if the one-shot replay state (prepared_views.state
-- + read_tokens.consumed) is ever RESET (store-write adversary, or a buggy retry/crash-recovery path), a second
-- INSERT of the SAME canonical action fails the constraint instead of recording a duplicate effect. The kernel
-- also SELECTs this key inside its write-locked txn BEFORE consuming/inserting (runtime.mjs executeAuthorizedAction).
CREATE UNIQUE INDEX IF NOT EXISTS idx_action_outbox_idempotency ON action_outbox(idempotency_key);
`;

// (v19 P1) TRUSTED/UNTRUSTED store separation. The reviewer noted that one-shot consumption and anti-rollback/
// omission guarantees rest on the kernel-state DB being integrity-protected and inaccessible to the memory-store
// adversary, but the single-DB prototype did not ENFORCE that split. These tables -- the read-to-use/view
// consumption state, the monotonic decision versions, the MAC-chain anchor heads, and the action outbox -- are
// exactly the state whose deletion/rollback the omission (#1) and one-shot/rollback (#6) attacks target. The
// runtime now creates them in a SEPARATE ATTACHed `kernel` database (a distinct, protected file in deployment;
// a private in-memory DB by default) and DROPs the `main` copies, so a store-write adversary holding only the
// untrusted memory DB file cannot read, delete, or roll back any of them. SQLite resolves the existing
// unqualified table names to the attached kernel DB, and one BEGIN IMMEDIATE still spans both DBs atomically
// (so the row+membership+anchor write stays one transaction). The MAC-chained EVENT tables (authority_membership,
// memory_lifecycle_events, merge_resolutions) remain in the memory DB: their integrity is enforced by the anchor
// HEADS, which are now in the protected kernel DB, so rolling them back is detected (log_tampered), not silent.
export const KERNEL_TABLES = ["read_tokens", "security_versions", "resolution_anchor", "lifecycle_anchor", "membership_anchor", "context_anchor", "run_clock", "audit_anchor", "prepared_views", "action_outbox"];

export const KERNEL_SCHEMA = `
CREATE TABLE IF NOT EXISTS kernel.read_tokens (
  token_id TEXT PRIMARY KEY, principal TEXT NOT NULL, active_message_id TEXT,
  consumed INTEGER NOT NULL DEFAULT 0, expires_at TEXT NOT NULL, created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS kernel.security_versions (
  domain TEXT NOT NULL, scope_key TEXT NOT NULL, version INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL, PRIMARY KEY (domain, scope_key)
);
CREATE TABLE IF NOT EXISTS kernel.resolution_anchor (
  id TEXT PRIMARY KEY, count INTEGER NOT NULL DEFAULT 0, last_mac TEXT, last_seq INTEGER NOT NULL DEFAULT 0, updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS kernel.lifecycle_anchor (
  id TEXT PRIMARY KEY, count INTEGER NOT NULL DEFAULT 0, last_mac TEXT, last_seq INTEGER NOT NULL DEFAULT 0, updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS kernel.membership_anchor (
  id TEXT PRIMARY KEY, count INTEGER NOT NULL DEFAULT 0, last_mac TEXT, last_seq INTEGER NOT NULL DEFAULT 0, updated_at TEXT NOT NULL
);
-- (v20 CE20-03) Anti-rollback head for execution contexts. One row per context records its monotonic latest
-- version under a TRUSTED MAC, in the kernel DB the memory-file adversary cannot reach. The execution_contexts
-- row itself lives in the untrusted main DB; at restart its (untrusted) version is cross-checked against this
-- (trusted) head -- a row rolled back to a pre-taint version is loaded as 'aborted' (authentic != fresh).
CREATE TABLE IF NOT EXISTS kernel.context_anchor (
  context_id TEXT PRIMARY KEY, version INTEGER NOT NULL DEFAULT 0, integrity INTEGER, input_count INTEGER NOT NULL DEFAULT 0,
  mac TEXT NOT NULL, updated_at TEXT NOT NULL
);
-- (v20 round-12) The write-event clock. The CE20-00 creation-cut compares a record's write_seq against the
-- active message's signed sequence; both are drawn from this per-run monotonic counter. It MUST be in the
-- trusted kernel DB (the memory-file adversary cannot write it), else a store-write rollback of the counter
-- lets a late write allocate a LOW write_seq and launder a post-hoc record into a fixed victim's past. The main
-- runs.next_sequence is kept as an advisory mirror; allocation reads MAX(main, kernel) and writes both.
CREATE TABLE IF NOT EXISTS kernel.run_clock (
  run_id TEXT PRIMARY KEY, next_seq INTEGER NOT NULL DEFAULT 1, updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS kernel.audit_anchor (
  run_id TEXT PRIMARY KEY, reads INTEGER NOT NULL DEFAULT 0, updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS kernel.prepared_views (
  view_id TEXT PRIMARY KEY, principal_id TEXT NOT NULL, context_id TEXT, context_version INTEGER,
  context_integrity INTEGER, active_message_id TEXT, active_envelope_digest TEXT, lock_generation INTEGER,
  query_digest TEXT, view_root TEXT NOT NULL, exposed_count INTEGER NOT NULL DEFAULT 0, intended_effect TEXT NOT NULL,
  capability_json TEXT, token TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'pending' CHECK (state IN ('pending', 'consumed', 'expired')),
  expires_at TEXT NOT NULL, created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS kernel.action_outbox (
  action_id TEXT PRIMARY KEY, view_id TEXT NOT NULL, principal_id TEXT NOT NULL, canonical_action_json TEXT NOT NULL,
  action_digest TEXT NOT NULL, idempotency_key TEXT NOT NULL, status TEXT NOT NULL, dispatch_result_json TEXT, created_at TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS kernel.idx_action_outbox_idempotency ON action_outbox(idempotency_key);
`;
