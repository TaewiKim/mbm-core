# ACM-CP Draft Specification

Status: research draft for benchmark and supplementary material.

ACM-CP is an Agent Communication-Memory Control Plane. It is designed as a
semantic overlay for agent-to-agent transports rather than a replacement for
A2A, MCP, ANP, JSON-RPC, HTTP, or message queues.

## Goals

ACM-CP standardizes protocol semantics that are missing when agents exchange
only free-form text, basic task envelopes, or tool/resource references:

- Evidence provenance.
- Proof-carrying capability claims.
- Delegation commitments.
- Memory scope and memory operations.
- Causal-policy traceability.
- Redaction and retention semantics.
- Context manifests and artifact references.

## Non-Goals

ACM-CP does not define:

- A transport protocol.
- A serialization format mandate.
- A particular agent runtime.
- A universal ontology for all tasks.
- A new LLM prompting framework.

## Envelope

Every ACM-CP message has a transport-neutral envelope.

Required fields:

- `protocol`: protocol variant and version.
- `message_id`: globally unique message id.
- `trace_id`: run-level trace id.
- `span_id`: event-level span id.
- `parent_span_id`: causal parent span id or empty.
- `task_id`: task or delegation id.
- `sender`: sender agent id.
- `receiver`: receiver agent id.
- `intent`: one of `task`, `result`, `error`, `control`, `ack`, `nack`,
  `cancel`, `memory`, `policy`.
- `state`: task state such as `created`, `accepted`, `running`, `completed`,
  `failed`, `cancelled`, or `needs_review`.
- `timestamp_ms`: sender timestamp.
- `payload_hash`: hash of canonical payload.

Recommended fields:

- `correlation_id`
- `idempotency_key`
- `sequence`
- `retry_budget`
- `failure_code`
- `recovery_hint`
- `policy_decision`
- `policy_trace_id`
- `artifact_refs`

## Evidence Capsule

An evidence capsule is the minimum unit of cross-agent claim transfer.

Required fields:

- `capsule_id`
- `claim_ids`
- `evidence_refs`
- `source_agent`
- `source_artifact`
- `source_span_id`
- `validity`: `current`, `outdated`, `adversarial`, `revoked`, `unknown`.
- `confidence`
- `sensitivity`
- `redaction_policy`
- `missing_information`
- `valid_until`
- `content_hash`

Required behavior:

- Agents must not write a claim into shared task memory unless the claim is
  backed by at least one capsule or is explicitly marked unsupported.
- Agents must preserve `source_span_id` and `content_hash` when forwarding a
  capsule.
- Agents must not silently upgrade `validity`.

Benchmark failure modes:

- Unsupported claim.
- Missing evidence reference.
- Use of outdated/adversarial evidence.
- Claim lineage not replayable.

## Proof-Carrying Capability Card

A capability card is a verifiable claim that an agent can perform a class of
tasks under specific policy and input/output constraints.

Required fields:

- `agent_id`
- `capability`
- `input_contract`
- `output_contract`
- `policy_scope`
- `issuer`
- `issued_at`
- `expires_at`
- `revocation_status`
- `evaluation_evidence`
- `signature_or_attestation`

Required behavior:

- A coordinator must prefer verified active capability evidence over broad
  self-advertised capability text.
- A revoked, expired, wrong-scope, or unevaluated capability must not satisfy a
  proof-required delegation.
- If no verified card satisfies the task, the coordinator must probe,
  renegotiate, or escalate.

Benchmark failure modes:

- Selecting a revoked card.
- Selecting an advertised-but-unverified agent.
- Ignoring policy scope.
- Dispatching without proof when proof is required.

## Delegation Commitment Receipt

A commitment receipt records what an agent accepted, under which preconditions,
authority, budget, and success predicate.

Required fields:

- `commitment_id`
- `debtor`
- `creditor`
- `task_id`
- `action`
- `preconditions`
- `required_deliverables`
- `success_predicate`
- `deadline`
- `budget`
- `authority_scope`
- `memory_scope`
- `failure_modes`
- `recovery_hint`
- `accepted_at`

Required behavior:

- Receivers must answer delegation with `accept`, `reject`, or `renegotiate`.
- A terminal success state must not be emitted before the success predicate is
  satisfied or explicitly renegotiated.
- Required deliverables must be written as machine-checkable memory events,
  not only free-form prose.

Benchmark failure modes:

- Premature terminal state.
- Missing deliverable.
- Scope drift.
- Unattributed responsibility after failure.

## Memory Scope and Operations

Memory scopes:

- `private`: readable only by the owning agent.
- `pairwise`: readable only by two named parties.
- `team`: readable by an authorized team.
- `task`: bound to a task or trace.
- `public`: safe for unrestricted sharing.
- `ephemeral`: expires after a bounded interaction.

Operations:

- `read`
- `propose_write`
- `commit`
- `merge`
- `revoke`
- `forget`
- `rehydrate`

Required memory event fields:

- `memory_event_id`
- `operation`
- `scope`
- `key`
- `value_hash`
- `version`
- `causal_parent_version`
- `writer`
- `authorized_readers`
- `retention_policy`
- `revocation_state`
- `evidence_capsule_ids`
- `conflict_policy`
- `conflict_result`

Required behavior:

- Private and secret memory must never appear in inter-agent message payloads,
  tool arguments, shared memory writes, summaries, or rationale fields.
- Shared writes must include version and conflict policy.
- Rehydration must filter revoked, expired, and cross-scope memory.

Benchmark failure modes:

- Secret leak.
- Unauthorized memory access.
- Stale read.
- Lost update.
- Invalid recall.
- Forgetting violation.

## Causal-Policy Trace

Causal-policy trace connects task events, policy decisions, data use, and memory
updates.

Required fields:

- `trace_id`
- `span_id`
- `parent_span_id`
- `policy_trace_id`
- `policy_decision`
- `policy_inputs_hash`
- `data_use`
- `redaction_actions`
- `audit_hash`

Required behavior:

- Every cross-agent message that reads or writes memory must include policy
  trace metadata.
- Redaction must be explicit and replayable.
- A replay verifier must reconstruct the terminal task state and policy
  decisions from logs.

Benchmark failure modes:

- Non-replayable policy decision.
- Unexplained redaction.
- Hidden data use.
- Audit hash mismatch.

## Context Manifest

A context manifest describes available context without copying the full context.

Required fields:

- `manifest_id`
- `artifact_refs`
- `facts_available`
- `critical_fact_ids`
- `sensitivity_classes`
- `token_budget`
- `retrieval_policy`
- `loss_tolerance`
- `must_include_claims`
- `artifact_hashes`

Required behavior:

- Agents should send manifests and selective artifact references instead of
  copying large context bundles.
- Decision-critical facts must be preserved under the declared token budget.
- If a recipient needs more context, it should request specific artifacts or
  capsules.

Benchmark failure modes:

- Missing critical fact.
- Full-context copy when manifest is available.
- Unbounded context growth.
- Unsupported answer due to over-compression.

## Minimal ACM-CP Bundle

The current benchmark treats the following as the minimal bundled semantics:

- Typed envelope.
- Evidence capsule.
- Proof-carrying capability card.
- Delegation commitment receipt.
- Scoped memory.
- Causal-policy trace.
- Redaction policy.
- Context manifest.

The `acmcp-full` protocol variant implements this bundle. Ablations remove one
semantic family at a time to test whether each component controls a distinct
failure mode.
