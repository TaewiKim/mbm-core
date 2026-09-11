// E17 — LIVE multi-agent LangGraph experiment.
// A real @langchain/langgraph StateGraph with multiple agent nodes that SHARE a memory store
// (via the graph state + MemorySaver). Multiple "writer" agents (one per source run/task) deposit
// stamped records into the shared store; an "executor" agent then READS the shared store to decide.
// The message-bound gate sits at the executor's read:
//   C4 (baseline)  : executor sees ALL shared records (no binding).
//   C5 (treatment) : executor sees only gate-admitted records (bound to the active message).
// The executor is a LIVE LLM (OpenAI). Task success = correct record grounded (selected expected,
// no forbidden) -> this is a genuine multi-agent shared-memory workflow, not single-agent QA.
import { Annotation, END, MemorySaver, START, StateGraph } from "@langchain/langgraph";
import { OpenAICoupledMemoryClient } from "./live_model.mjs";
import { evaluateMemoryGateStandalone, ancestorClosureFor } from "../external/mbm_gate.mjs";

const State = Annotation.Root({
  scase: Annotation(), condition: Annotation(), client: Annotation(),
  store: Annotation(), admitted: Annotation(), decision: Annotation(), evaluation: Annotation(),
});

function activeMessageOf(scase) {
  const msgs = scase.messages || [];
  return msgs.find((m) => m.message_id === scase.active_message_id) || msgs[msgs.length - 1] || {};
}

// node: each source run/agent writes its records into the SHARED store (stamped with provenance).
async function writersNode(state) {
  const msgs = state.scase.messages || [];
  const srcRun = Object.fromEntries(msgs.map((m) => [m.message_id, m.run_id]));
  const store = [];
  for (const m of state.scase.memories) {
    store.push({ ...m, run_id: m.run_id ?? srcRun[m.source_message_id] });
  }
  return { store };
}

// node: the message-bound gate filters the shared store for the active message (C5 only).
async function gateNode(state) {
  if (state.condition !== "C5") return { admitted: state.store };
  const active = activeMessageOf(state.scase);
  // Provenance is checked against the active message's DIRECTED causal ancestor closure -- the same
  // happens-before semantics as the runtime -- not a flat set of every message id (review M3/M7).
  const eventGraph = ancestorClosureFor(state.scase.messages || [], active);
  const admitted = state.store.filter((mem) =>
    evaluateMemoryGateStandalone(mem, active, { eventGraph }).decision === "allow");
  // Fail closed. If the gate admits nothing, the executor sees nothing. We must NEVER fall back
  // to the benchmark ground truth (expected_memory_ids): that leaks the answer the deployed system
  // cannot know and inflates C5. An empty admitted set is a real (and scoreable) gate outcome.
  return { admitted };
}

// node: the executor agent (LIVE LLM) reads the (gated) shared store and decides.
async function executorNode(state) {
  const active = activeMessageOf(state.scase);
  const payload = {
    scenario_id: state.scase.scenario_id, scenario_type: state.scase.scenario_type,
    query: state.scase.query,
    candidate_memories: (state.admitted || []).map((m) => ({ memory_id: m.memory_id, content: m.content })),
    protocol_rule: state.condition === "C5"
      ? "These memory records are bound to the active message; select the ones that should govern the answer."
      : "These are the shared-memory candidates; select the ones that should govern the answer.",
  };
  let decision = null, err = "";
  try { decision = await state.client.decidePayload(payload); } catch (e) { err = e.message; }
  return { decision: decision || { selected_memory_ids: [], answer: "", _error: err } };
}

// node: deterministic scoring of the executor's selection.
async function scoreNode(state) {
  const exp = new Set(state.scase.expected_memory_ids || []);
  const forb = new Set(state.scase.forbidden_memory_ids || []);
  const sel = state.decision.selected_memory_ids || [];
  const se = sel.filter((id) => exp.has(id)).length;
  const sf = sel.filter((id) => forb.has(id)).length;
  return { evaluation: { success: se === exp.size && sf === 0, selected_forbidden: sf, error: state.decision._error || "" } };
}

function buildGraph() {
  return new StateGraph(State)
    .addNode("writers", writersNode)
    .addNode("gate", gateNode)
    .addNode("executor", executorNode)
    .addNode("score", scoreNode)
    .addEdge(START, "writers").addEdge("writers", "gate").addEdge("gate", "executor")
    .addEdge("executor", "score").addEdge("score", END)
    .compile({ checkpointer: new MemorySaver(), name: "coupled-memory-langgraph-live-multiagent" });
}

export async function runCase({ scase, condition, client }) {
  const graph = buildGraph();
  const out = await graph.invoke({ scase, condition, client },
    { configurable: { thread_id: `${scase.scenario_id}:${condition}` } });
  return {
    harness: "langgraph-live-multiagent", live: true, scenario_id: scase.scenario_id,
    scenario_type: scase.scenario_type, condition,
    store_size: out.store.length, admitted_size: (out.admitted || []).length,
    model_success: out.evaluation.success, selected_forbidden: out.evaluation.selected_forbidden,
    api_error: out.evaluation.error,
  };
}
