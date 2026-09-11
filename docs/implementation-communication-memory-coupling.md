# Implementation Design: Communication-Memory Coupling

## 1. Core Implementation Rule

The implementation must not expose memory as a free-standing retrieval tool.

Unsafe pattern:

```text
readMemory(query)
```

Required pattern:

```text
readMemory(query, currentMessage, runState)
```

Every memory read, memory write, artifact resolution, policy decision, retry, and
summary operation must be justified by the active communication event.

This is the central implementation idea:

> Communication is the control plane. Memory is the state plane. Coupling is the
> middleware that allows memory operations only when they are valid under the
> current message, task, trace, policy, and run state.

## 2. Minimal Architecture

The coupling layer consists of five components.

| Component | Responsibility |
| --- | --- |
| `MessageEnvelope` | Typed communication object for all agent messages |
| `MemoryRecord` | Typed memory object with scope, status, source, policy, and provenance |
| `CouplingGuard` | Validates whether a memory operation is allowed under the current message |
| `MemoryRouter` | Retrieves and ranks only memory records that pass the guard |
| `EventGraph` | Append-only log connecting messages, memory, artifacts, tools, retries, and final decisions |

The harness adapter should call these components before invoking the downstream
agent.

## 3. MessageEnvelope

Every agent communication must be normalized into this schema.

```json
{
  "message_id": "msg-042",
  "run_id": "run-B",
  "task_id": "deploy-B",
  "trace_id": "trace-B",
  "parent_message_id": "msg-039",
  "correlation_id": "msg-021",
  "sender": "planner",
  "receiver": "executor",
  "intent": "task | result | error | retry | control | checkpoint | audit",
  "state": "created | accepted | running | blocked | completed | failed | superseded",
  "sequence": 17,
  "capability": "deployment_planning",
  "policy_context": "policy-003",
  "allowed_memory_scopes": ["run", "task"],
  "required_memory_types": ["constraint", "decision", "artifact_ref"],
  "artifact_refs": ["artifact://run-B/evidence-2"],
  "payload": {}
}
```

The message is not just text. It is the authorization context for memory.

## 4. MemoryRecord

Every memory item must be normalized into this schema.

```json
{
  "memory_id": "mem-B-constraint",
  "run_id": "run-B",
  "task_id": "deploy-B",
  "trace_id": "trace-B",
  "branch_id": null,
  "source_message_id": "msg-B-planner-constraint",
  "writer": "planner",
  "allowed_readers": ["executor", "verifier"],
  "memory_type": "constraint | decision | observation | summary | artifact_ref | policy | checkpoint",
  "scope": "agent | task | branch | run | global",
  "status": "active | superseded | expired | redacted | revoked",
  "valid_from_event": "evt-004",
  "valid_until_event": null,
  "supersedes": [],
  "content": "Use CLOUD_STORAGE_REQUIRED. Do not use local-only storage.",
  "content_ref": null,
  "confidence": 1.0,
  "audit_hash": "sha256:..."
}
```

The important fields are not the natural-language content. The important fields
are `run_id`, `task_id`, `source_message_id`, `allowed_readers`, `scope`, and
`status`.

## 5. CouplingGuard

The CouplingGuard is the central mechanism. It decides whether a memory record can
be injected into an agent context.

### 5.1 Required checks

A memory record can be used only if all required checks pass.

```text
same run:
  memory.run_id == message.run_id

same task or allowed wider scope:
  memory.task_id == message.task_id
  OR memory.scope in {run, global} and policy permits it

freshness:
  memory.status == active
  AND memory.valid_until_event is null or after current event

source provenance:
  memory.source_message_id exists in EventGraph

reader authorization:
  message.receiver in memory.allowed_readers

memory type relevance:
  memory.memory_type in message.required_memory_types
  OR retrieval policy explicitly permits optional context

policy compatibility:
  message.policy_context permits this memory record
```

### 5.2 Coupling decision

The guard returns a structured decision.

```json
{
  "allowed": true,
  "decision": "allow | deny | redact | stale | wrong_scope | unauthorized",
  "memory_id": "mem-B-constraint",
  "message_id": "msg-B-executor-request",
  "reason": "run_id, task_id, status, reader policy, and source provenance matched",
  "redacted_content": null
}
```

This decision is itself written to the event graph.

## 6. MemoryRouter

The MemoryRouter performs retrieval in two stages.

### Stage 1. Candidate retrieval

This can use any backend:

- exact metadata lookup
- vector retrieval
- keyword search
- recency search
- graph traversal

### Stage 2. Coupling filter

Every candidate must pass the CouplingGuard.

```text
candidate memories -> CouplingGuard -> allowed memories -> context injection
```

This prevents vector retrieval from selecting semantically similar but wrong-scope
memories.

## 7. EventGraph

Every operation is appended to an event graph.

```json
{
  "event_id": "evt-010",
  "event_type": "memory.read",
  "run_id": "run-B",
  "task_id": "deploy-B",
  "trace_id": "trace-B",
  "message_id": "msg-B-executor-request",
  "memory_id": "mem-B-constraint",
  "agent": "executor",
  "decision": "allow",
  "result": "injected",
  "timestamp_ms": 1200
}
```

The EventGraph supports audit reconstruction:

```text
final answer
  -> result message
  -> executor request message
  -> memory.read event
  -> memory record
  -> source planner message
  -> original user constraint
```

## 8. C4 vs C5 Implementation Difference

The key experimental distinction must be implemented exactly.

### C4: strong but uncoupled

C4 has structured messages and scoped memory records, but the memory read is not
forced to reference the current message.

```text
readMemory(query)
```

This means the memory backend may retrieve semantically relevant records from the
wrong run or task.

### C5: coupled

C5 requires current message binding.

```text
readMemory(query, currentMessage, runState)
```

The CouplingGuard filters by run, task, scope, status, reader policy, source
message, and policy context before the memory is injected.

This distinction is the main experimental mechanism.

## 9. Pseudocode

### 9.1 Sending a message

```js
function sendMessage(envelope) {
  validateMessageEnvelope(envelope);
  eventGraph.append({
    event_type: "message.send",
    message_id: envelope.message_id,
    run_id: envelope.run_id,
    task_id: envelope.task_id,
    trace_id: envelope.trace_id,
    sender: envelope.sender,
    receiver: envelope.receiver,
    intent: envelope.intent,
    state: envelope.state,
  });
  durableMailbox.enqueue(envelope.receiver, envelope);
}
```

### 9.2 Writing memory

```js
function writeMemory(content, currentMessage, options) {
  const record = {
    memory_id: newMemoryId(),
    run_id: currentMessage.run_id,
    task_id: currentMessage.task_id,
    trace_id: currentMessage.trace_id,
    source_message_id: currentMessage.message_id,
    writer: currentMessage.sender,
    allowed_readers: options.allowed_readers,
    memory_type: options.memory_type,
    scope: options.scope,
    status: "active",
    content,
  };
  memoryStore.put(record);
  eventGraph.append({
    event_type: "memory.write",
    message_id: currentMessage.message_id,
    memory_id: record.memory_id,
    run_id: record.run_id,
    task_id: record.task_id,
    trace_id: record.trace_id,
  });
  return record;
}
```

### 9.3 Reading memory

```js
function readMemory(query, currentMessage, runState) {
  const candidates = memoryStore.search(query);
  const decisions = candidates.map((record) =>
    couplingGuard.evaluate({ record, currentMessage, runState })
  );
  const allowed = decisions
    .filter((decision) => decision.allowed)
    .map((decision) => decision.record);
  eventGraph.append({
    event_type: "memory.read",
    message_id: currentMessage.message_id,
    run_id: currentMessage.run_id,
    task_id: currentMessage.task_id,
    trace_id: currentMessage.trace_id,
    candidate_count: candidates.length,
    allowed_count: allowed.length,
    decisions: decisions.map(({ record, decision, reason }) => ({
      memory_id: record.memory_id,
      decision,
      reason,
    })),
  });
  return rankAllowedMemories(allowed, query, currentMessage);
}
```

### 9.4 Invoking an agent

```js
function invokeAgent(message) {
  const requiredMemory = readMemory(
    buildMemoryQueryFromMessage(message),
    message,
    runState
  );
  const artifacts = resolveArtifacts(message.artifact_refs, message, runState);
  const promptContext = buildAgentContext({
    message,
    memory: requiredMemory,
    artifacts,
    runState,
  });
  return callAgent(message.receiver, promptContext);
}
```

## 10. Artifact Coupling

Artifact access follows the same rule.

Unsafe pattern:

```text
resolveArtifact(ref)
```

Required pattern:

```text
resolveArtifact(ref, currentMessage, runState)
```

Checks:

- artifact belongs to the same run or permitted global scope
- artifact version is current
- current receiver is authorized
- artifact source event exists
- artifact is linked to the current task or permitted parent task

## 11. Retry Coupling

Retries must bind communication and memory.

When retrying:

1. Preserve `correlation_id` to original request.
2. Preserve `idempotency_key`.
3. Restore checkpoint state.
4. Re-evaluate active memory after any policy update.
5. Reject superseded memory.
6. Record retry event.

Pseudo-logic:

```js
function retryTask(taskId, reason) {
  const original = eventGraph.findOriginalTaskMessage(taskId);
  const retryMessage = makeRetryMessage({
    run_id: original.run_id,
    task_id: original.task_id,
    trace_id: original.trace_id,
    correlation_id: original.message_id,
    idempotency_key: original.idempotency_key,
    reason,
  });
  const currentMemory = readMemory("active constraints and policies", retryMessage, runState);
  return invokeAgent(withMemory(retryMessage, currentMemory));
}
```

## 12. Harness Adapter Integration

Each SOTA harness uses the same coupling layer but maps it to native primitives.

| Generic function | LangGraph | AutoGen | CrewAI | OpenHands |
| --- | --- | --- | --- | --- |
| `sendMessage` | graph state update | AgentChat message/event | task/context handoff | action/observation event |
| `readMemory` | store/checkpointer wrapper | Memory protocol wrapper | Crew memory wrapper | workspace/event memory wrapper |
| `writeMemory` | store write + event | Memory.add + event | Memory save + event | workspace/event note |
| `checkpoint` | checkpointer | team/agent state save | Flow persistence | session/workspace snapshot |
| `resolveArtifact` | state artifact ref | tool/file ref | task output ref | workspace file ref |

The implementation should keep the upstream harness fixed and insert the coupling
layer at adapter boundaries.

## 13. Required Tests

### 13.1 Unit tests

- message envelope validation
- memory record validation
- CouplingGuard allow/deny decisions
- wrong-run memory rejection
- wrong-task memory rejection
- stale memory rejection
- unauthorized reader rejection
- artifact version rejection

### 13.2 Integration tests

- twin-run contamination test
- retry after superseded policy
- artifact-dependent handoff
- private summary boundary
- audit reconstruction

### 13.3 Key expected test

```text
C4: readMemory(query) can return mem-A or mem-B
C5: readMemory(query, currentMessage=run-B/task-B) returns only mem-B
```

This test directly proves the implementation difference.

## 14. Metrics Generated by the Coupling Layer

The coupling layer directly emits:

- `memory_candidates_total`
- `memory_allowed_total`
- `wrong_scope_memory_rejected`
- `stale_memory_rejected`
- `unauthorized_memory_rejected`
- `causal_memory_binding_rate`
- `message_memory_consistency`
- `artifact_resolution_success`
- `event_graph_reconstructability`

These metrics are preferable to relying only on final answer accuracy.

## 15. One-Sentence Summary

Implement coupling by making communication the mandatory authorization context
for memory: no memory read, memory write, artifact resolution, retry, or summary
operation may occur unless it is justified by the current message, run state,
policy state, and event graph.
