export function makeDecisionSchema() {
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
    ],
  };
}
