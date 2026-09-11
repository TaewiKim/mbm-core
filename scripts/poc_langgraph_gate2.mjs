// Gate 2.0 on a REAL framework: a LangGraph StateGraph with a genuine FORK-JOIN. START fans out to two
// parallel branch agents (branch_a, branch_b) that each write a CONFLICTING same-logical_key record into
// LangGraph's shared cross-thread Store; both edges join at a merge_executor node whose active message is a
// true multi-parent merge of the two branches. This is exactly the merge-induced ancestry-laundering setting,
// arising naturally from LangGraph's own parallel-branch topology (not our harness).
//
// Without the gate the executor reads BOTH conflicting records (laundered: both branch sources are genuine
// ancestors of the merge). With MBM-Core's Gate 2.0 read at the join, the set-level coherent view denies both
// (reachable != adopted -> REQUIRE_RESOLUTION); after a signed resolution adopts one branch, only that record
// is admitted. DETERMINISTIC, no API. Run: node scripts/poc_langgraph_gate2.mjs (also a behavioral gate).
//
// HONESTY: this is a REAL framework on a CONSTRUCTED multi-agent workload, not ecological prevalence -- it
// shows Gate 2.0's mechanisms operate end-to-end inside LangGraph's real fork-join + shared Store.
import { writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { Annotation, END, InMemoryStore, MemorySaver, START, StateGraph } from "@langchain/langgraph";
import { SecureMemoryRuntime, ControlPlane } from "../benchmarks/coupled_memory/runtime.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, "..");
const NS = ["shared_memory"];
const RUN = "run-1", TASK = "retention", POLICY = "compliance-v2", EXEC = "executor-agent";

const cp = new ControlPlane();
const rt = new SecureMemoryRuntime({ controlPlane: cp });
const env = (id, parents, seq, sender, receiver = "memory") => ({
  message_id: id, run_id: RUN, task_id: TASK, trace_id: "tr-1", sender, receiver,
  intent: "produce_final_plan", state: "running", sequence: seq,
  parent_message_id: Array.isArray(parents) ? null : parents,
  ...(Array.isArray(parents) ? { parents } : {}),
  correlation_id: null, delegated_from: null, policy_context: POLICY,
});
const planner = cp.registerPrincipal("planner", { queues: ["*"] });
const wA = cp.registerPrincipal("agent-A", { queues: ["*"] });
const wB = cp.registerPrincipal("agent-B", { queues: ["*"] });
const ex = cp.registerPrincipal("executor", { queues: [EXEC] });
const owner = cp.registerPrincipal("policy-owner", { queues: [], resolution: true });

// Message graph: m0 forks to two CONCURRENT branches mA, mB; mMerge is a TRUE multi-parent merge of both.
// (v20 CREATION-CUT) Send the branch SOURCE messages first, write their memory, THEN send the reader
// (mMerge) LAST with a sequence strictly greater than every preceding message and every write, so the
// merge's signed creation sequence sits AFTER the branch writes (write_seq <= active sequence holds).
rt.sendMessage(env("m0", null, 0, "planner"), planner);
rt.sendMessage(env("mA", "m0", 1, "agent-A"), wA);
rt.sendMessage(env("mB", "m0", 2, "agent-B"), wB);

// Branch agents write conflicting same-key records through the trusted path (attested).
const rA = rt.writeMemory("Retain logs 7 days (branch A).", rt.claimSpecific(wA, "mA"),
  { memory_id: "rA", memory_type: "constraint", allowed_readers: [EXEC], logical_key: "retention" });
const rB = rt.writeMemory("Retain logs 30 days (branch B).", rt.claimSpecific(wB, "mB"),
  { memory_id: "rB", memory_type: "constraint", allowed_readers: [EXEC], logical_key: "retention" });

rt.sendMessage(env("mMerge", [{ id: "mA", type: "depends" }, { id: "mB", type: "depends" }], 90, "planner", EXEC), planner);
const exHandle = rt.claimSpecific(ex, "mMerge"); // the executor's lease on the merge message (reused per arm)
const RET = { rA: 7, rB: 30 };

const GraphState = Annotation.Root({
  gate: Annotation(), resolved: Annotation(), admitted: Annotation(),
  retention: Annotation(), laundered: Annotation(),
});

function buildGraph() {
  return new StateGraph(GraphState)
    .addNode("branch_a", async (_s, config) => { await config.store.put(NS, "rA", { ...rA, retention: 7 }); return {}; })
    .addNode("branch_b", async (_s, config) => { await config.store.put(NS, "rB", { ...rB, retention: 30 }); return {}; })
    .addNode("merge_executor", async (state, config) => {
      if (state.resolved) rt.resolveConflict(owner, { logical_key: "retention", accepted: ["rB"], rejected: ["rA"] });
      let admitted;
      if (state.gate) {
        admitted = rt.readMemory({}, exHandle).map((m) => m.memory_id).sort(); // Gate 2.0 at the join
      } else {
        admitted = (await config.store.search(NS)).map((it) => it.value.memory_id).sort(); // ungated store read
      }
      const vals = [...new Set(admitted.map((id) => RET[id]))];
      return {
        admitted,
        retention: admitted.length === 0 ? null : (vals.length === 1 ? vals[0] : "AMBIGUOUS"),
        laundered: admitted.includes("rA") && admitted.includes("rB"),
      };
    })
    .addEdge(START, "branch_a")     // fork: START fans out to both branches in parallel
    .addEdge(START, "branch_b")
    .addEdge("branch_a", "merge_executor")  // join: both branches converge on the executor
    .addEdge("branch_b", "merge_executor")
    .addEdge("merge_executor", END)
    .compile({ store: new InMemoryStore(), checkpointer: new MemorySaver(), name: "mbm-gate2-forkjoin" });
}
const runArm = (state, tag) => buildGraph().invoke(state, { configurable: { thread_id: tag } });

async function main() {
  const ungated = await runArm({ gate: false, resolved: false }, "ungated");
  const gatedUnresolved = await runArm({ gate: true, resolved: false }, "gated-unresolved");
  const gatedResolved = await runArm({ gate: true, resolved: true }, "gated-resolved");

  const checks = [
    ["ungated merge launders BOTH conflicting branch records", ungated.laundered === true && ungated.retention === "AMBIGUOUS"],
    ["Gate 2.0 (unresolved) admits NEITHER -- coherent view denies the merge laundering", gatedUnresolved.admitted.length === 0 && gatedUnresolved.laundered === false],
    ["Gate 2.0 (resolved) admits ONLY the adopted branch -> correct 30-day retention", JSON.stringify(gatedResolved.admitted) === JSON.stringify(["rB"]) && gatedResolved.retention === 30],
    ["replay reconstructs the in-framework reads", rt.replaySecureMemoryReads(RUN).ok === true],
  ];
  const passed = checks.filter(([, ok]) => ok).length;
  const ok = passed === checks.length;
  const report = {
    framework: "@langchain/langgraph", store: "InMemoryStore (cross-thread shared store)",
    topology: "fork-join: START -> {branch_a || branch_b} -> merge_executor", api: false,
    scope: "REAL framework + real fork-join topology on a CONSTRUCTED multi-agent workload (not ecological prevalence)",
    active_message: "mMerge (true multi-parent merge of mA, mB)",
    ungated: { admitted: ungated.admitted, retention: ungated.retention, laundered: ungated.laundered },
    gated_unresolved: { admitted: gatedUnresolved.admitted, retention: gatedUnresolved.retention },
    gated_resolved: { admitted: gatedResolved.admitted, retention: gatedResolved.retention },
    checks: checks.map(([name, v]) => ({ name, ok: v })), passed, total: checks.length, ok,
  };
  const OUT = join(REPO, "results", "eval", "poc-langgraph-gate2.json");
  mkdirSync(dirname(OUT), { recursive: true });
  writeFileSync(OUT, JSON.stringify(report, null, 2));
  rt.close();

  if (import.meta.url === pathToFileURL(process.argv[1]).href) {
    console.log("PoC: Gate 2.0 merge laundering on a REAL LangGraph fork-join (shared InMemoryStore, no API)");
    console.log("  topology: START -> {branch_a || branch_b} -> merge_executor (mMerge = merge of mA, mB)");
    console.log(`  UNGATED merge: admitted [${ungated.admitted.join(", ")}] -> retention=${ungated.retention} laundered=${ungated.laundered}`);
    console.log(`  GATE2 unresolved: admitted [${gatedUnresolved.admitted.join(", ")}] -> retention=${gatedUnresolved.retention} (coherent view denies both)`);
    console.log(`  GATE2 resolved:   admitted [${gatedResolved.admitted.join(", ")}] -> retention=${gatedResolved.retention} (only the adopted branch)`);
    for (const [name, v] of checks) console.log(`  [${v ? "PASS" : "FAIL"}] ${name}`);
    console.log(`${ok ? "OK" : "FAILED"} ${passed}/${checks.length} -> ${OUT}`);
    process.exit(ok ? 0 : 1);
  }
  return report;
}
await main();
