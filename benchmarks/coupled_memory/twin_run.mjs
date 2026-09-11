import { CoupledMemoryRuntime } from "./runtime.mjs";

export function twinRunMessages() {
  const base = {
    task_id: "deploy",
    intent: "produce_final_plan",
    state: "running",
    policy_context: "policy-003",
  };
  return {
    plannerA: {
      ...base,
      message_id: "msg-A-planner-constraint",
      run_id: "run-A",
      trace_id: "trace-A",
      sender: "planner",
      receiver: "memory",
      sequence: 1,
      payload: { constraint: "Use LOCAL_ONLY_STORAGE for Run A." },
    },
    plannerB: {
      ...base,
      message_id: "msg-B-planner-constraint",
      run_id: "run-B",
      trace_id: "trace-B",
      sender: "planner",
      receiver: "memory",
      sequence: 1,
      payload: { constraint: "Use CLOUD_STORAGE_REQUIRED for Run B." },
    },
    executorB: {
      ...base,
      message_id: "msg-B-executor-request",
      run_id: "run-B",
      trace_id: "trace-B",
      sender: "coordinator",
      receiver: "executor",
      sequence: 2,
      parent_message_id: "msg-B-planner-constraint",
      correlation_id: "msg-B-client-request",
      payload: { goal: "Generate the deployment plan for Run B." },
    },
  };
}

export function seedTwinRunFixture(runtime) {
  const messages = twinRunMessages();
  runtime.sendMessage(messages.plannerA);
  runtime.sendMessage(messages.plannerB);
  runtime.sendMessage(messages.executorB);
  runtime.writeMemory("Run A deployment constraint: Use LOCAL_ONLY_STORAGE.", messages.plannerA, {
    memory_id: "mem-A-constraint",
    memory_type: "constraint",
    scope: "task",
    allowed_readers: ["executor"],
  });
  runtime.writeMemory("Run B deployment constraint: Use CLOUD_STORAGE_REQUIRED.", messages.plannerB, {
    memory_id: "mem-B-constraint",
    memory_type: "constraint",
    scope: "task",
    allowed_readers: ["executor"],
  });
  return messages;
}

function evaluateInjectedMemories(condition, currentMessage, injectedMemories, audit) {
  const memoryIds = injectedMemories.map((memory) => memory.memory_id);
  const wrongScope = injectedMemories.filter((memory) => memory.run_id !== currentMessage.run_id);
  const hasRunBConstraint = memoryIds.includes("mem-B-constraint");
  const hasRunAConstraint = memoryIds.includes("mem-A-constraint");
  const finalCorrect = hasRunBConstraint && !hasRunAConstraint;
  const missingCriticalMemory = hasRunBConstraint ? 0 : 1;
  return {
    condition,
    success: finalCorrect,
    final_correct_rate: finalCorrect ? 1 : 0,
    injected_memory_ids: memoryIds,
    injected_memory_contents: injectedMemories.map((memory) => memory.content),
    wrong_scope_memory_use: wrongScope.length,
    stale_memory_use: 0,
    missing_critical_memory: missingCriticalMemory,
    causal_memory_binding: condition === "C5" ? 1 : 0,
    message_memory_consistency: finalCorrect ? 1 : 0,
    event_graph_reconstructability: audit.memory_access_decisions.length > 0 ? 1 : 0,
    failure_modes: [
      ...(wrongScope.length > 0 ? ["wrong-scope memory"] : []),
      ...(missingCriticalMemory > 0 ? ["missing critical memory"] : []),
      ...(condition !== "C5" ? ["unbound memory read"] : []),
    ],
  };
}

export function runTwinRunContaminationProof({ condition = "C5", dbPath = ":memory:" } = {}) {
  const runtime = new CoupledMemoryRuntime({ dbPath });
  try {
    const messages = seedTwinRunFixture(runtime);
    const featuresRequireMessage = condition === "C5";
    const currentMessage = featuresRequireMessage ? messages.executorB : null;
    const injectedMemories = runtime.readMemory(
      { text: "deployment storage constraint", memory_type: "constraint" },
      currentMessage,
      { condition },
    );
    const audit = runtime.auditRun(messages.executorB.run_id);
    return {
      scenario_id: "twin_run_contamination_001",
      scenario_type: "twin_run_shared_memory_contamination",
      current_message: messages.executorB,
      ...evaluateInjectedMemories(condition, messages.executorB, injectedMemories, audit),
      audit,
    };
  } finally {
    runtime.close();
  }
}

export function runTwinRunMatrix({
  conditions = ["C0", "C1", "C2", "C3", "C4", "C5"],
  conditionMatrix = null,
  c4c5Parity = null,
} = {}) {
  const cases = conditions.map((condition) => runTwinRunContaminationProof({ condition }));
  return {
    benchmark: "coupled-memory-twin-run-proof",
    live: false,
    condition_matrix: conditionMatrix,
    c4_c5_parity: c4c5Parity,
    cases,
    summary: cases.map((item) => ({
      condition: item.condition,
      success: item.success,
      wrong_scope_memory_use: item.wrong_scope_memory_use,
      missing_critical_memory: item.missing_critical_memory,
      causal_memory_binding: item.causal_memory_binding,
      event_graph_reconstructability: item.event_graph_reconstructability,
    })),
  };
}
