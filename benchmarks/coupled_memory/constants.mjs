export const COUPLED_MEMORY_CONDITIONS = ["C0", "C1", "C2", "C3", "C4", "C5"];

// NULL-PROTOTYPE lookup (parity with TOOL_REGISTRY in runtime.mjs): a plain object literal would let a
// condition named "constructor"/"toString"/"__proto__" etc. resolve to an inherited Object.prototype member,
// so `CONDITION_FEATURES[condition]` would return a truthy function and skip the fail-closed `unknown condition`
// guard. Object.create(null) makes any non-own name fall through to that guard cleanly.
export const CONDITION_FEATURES = Object.assign(Object.create(null), {
  C0: {
    name: "transcript-only",
    typedEnvelope: false,
    sharedMemory: false,
    scopedMemory: false,
    causalEnvelope: false,
    messageBoundMemory: false,
  },
  C1: {
    name: "typed-envelope-only",
    typedEnvelope: true,
    sharedMemory: false,
    scopedMemory: false,
    causalEnvelope: false,
    messageBoundMemory: false,
  },
  C2: {
    name: "transcript-plus-unbound-retrieval",
    typedEnvelope: false,
    sharedMemory: true,
    scopedMemory: false,
    causalEnvelope: false,
    messageBoundMemory: false,
  },
  C3: {
    name: "stateful-envelope-plus-weak-retrieval",
    typedEnvelope: true,
    sharedMemory: true,
    scopedMemory: false,
    causalEnvelope: false,
    messageBoundMemory: false,
  },
  C4: {
    // C4 is the UNGATED control: a causal envelope but an unbound shared-memory read (review A3 -- the
    // earlier "scoped-memory" label was inaccurate; C4 applies no run/task scoping at read time).
    name: "causal-envelope-ungated-memory-uncoupled",
    typedEnvelope: true,
    sharedMemory: true,
    scopedMemory: false,
    causalEnvelope: true,
    messageBoundMemory: false,
  },
  C5: {
    name: "causal-envelope-governed-message-bound-memory",
    typedEnvelope: true,
    sharedMemory: true,
    scopedMemory: false,
    causalEnvelope: true,
    messageBoundMemory: true,
  },
});

export const REQUIRED_ENVELOPE_FIELDS = [
  "message_id",
  "run_id",
  "task_id",
  "trace_id",
  "sender",
  "receiver",
  "intent",
  "state",
  "sequence",
];

// NULL-PROTOTYPE lookup (parity with TOOL_REGISTRY in runtime.mjs): a plain object literal would let an intent
// named "constructor"/"toString"/"__proto__"/"hasOwnProperty" etc. resolve to a truthy inherited Object.prototype
// member, which would bypass the gates' fail-closed `intent_unknown` guard and then throw "allowedTypes.has is not
// a function". Object.create(null) makes any non-own intent resolve to undefined -> clean fail-closed deny.
export const INTENT_MEMORY_TYPES = Object.assign(Object.create(null), {
  produce_final_plan: new Set(["constraint", "decision", "summary", "policy", "artifact_reference"]),
  verify_final_plan: new Set(["constraint", "decision", "summary", "policy", "artifact_reference"]),
  summarize_private_memory: new Set(["summary", "policy"]),
  resolve_artifact: new Set(["artifact_reference", "constraint", "policy"]),
  audit_run: new Set(["constraint", "decision", "summary", "policy", "artifact_reference"]),
});
