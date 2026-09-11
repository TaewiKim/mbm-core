import {
  CONDITION_FEATURES,
  COUPLED_MEMORY_CONDITIONS,
} from "./constants.mjs";

const CONDITION_DESCRIPTIONS = {
  C0: {
    communication: "transcript",
    shared_memory: "none",
    coupling: "none",
    purpose: "ad hoc baseline",
  },
  C1: {
    communication: "typed envelope",
    shared_memory: "none",
    coupling: "none",
    purpose: "communication-only baseline",
  },
  C2: {
    communication: "transcript",
    shared_memory: "unbound retrieval memory",
    coupling: "none",
    purpose: "memory-only retrieval baseline",
  },
  C3: {
    communication: "stateful envelope",
    shared_memory: "unbound retrieval memory",
    coupling: "weak",
    purpose: "state plus retrieval baseline",
  },
  C4: {
    communication: "causal-reliable envelope",
    shared_memory: "scoped shared memory",
    coupling: "uncoupled",
    purpose: "strong modules without message binding",
  },
  C5: {
    communication: "causal-reliable envelope",
    shared_memory: "governed shared memory",
    coupling: "message-bound",
    purpose: "proposed coupled condition",
  },
};

export function normalizeCondition(condition) {
  const normalized = String(condition ?? "").trim().toUpperCase();
  if (!COUPLED_MEMORY_CONDITIONS.includes(normalized)) {
    throw new Error(`unknown condition: ${condition}`);
  }
  return normalized;
}

export function getConditionSpec(condition) {
  const id = normalizeCondition(condition);
  return {
    id,
    ...CONDITION_DESCRIPTIONS[id],
    features: { ...CONDITION_FEATURES[id] },
  };
}

export function buildConditionMatrix(conditions = COUPLED_MEMORY_CONDITIONS) {
  return conditions.map((condition) => getConditionSpec(condition));
}

export function assertC4C5OnlyDifferByBinding() {
  const c4 = getConditionSpec("C4").features;
  const c5 = getConditionSpec("C5").features;
  const differences = Object.keys(c5)
    .filter((key) => key !== "name")
    .filter((key) => c4[key] !== c5[key]);
  if (differences.length !== 1 || differences[0] !== "messageBoundMemory") {
    throw new Error(`C4/C5 parity violated: ${differences.join(",")}`);
  }
  return {
    c4: "readMemory(query)",
    c5: "readMemory(query, currentMessage, runState)",
    differing_feature: "messageBoundMemory",
  };
}
