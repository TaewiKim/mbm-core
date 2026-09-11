// E16 pilot — proves the external wrapper (a) hooks a stateful task's memory read and (b) is NOT a
// no-op: on a synthetic multi-session task with cross-context shared memory, the unwrapped read leaks
// a stale/wrong-run record (native task FAILS), while the wrapped read admits only the valid record
// (native task SUCCEEDS). This is a connectivity/no-op sanity check that runs WITHOUT internet; the
// full E16 swaps this synthetic store for tau-bench / LoCoMo (see README — blocked here by no internet).
import { wrapMemoryRead } from "./mbm_gate.mjs";

// Synthetic stateful workflow: session 2 must answer under the CURRENT run/policy. The store also holds
// a contradictory record from a prior run and a superseded record — classic cross-context shared memory.
// Ordered by content "relevance" as an external retriever would return them: a wrong-run record ranks
// first (most lexically relevant), so a binding-blind model grounds on it. This is the realistic trap.
const STORE = [
  { memory_id: "m_wrong_run", run_id: "run1", task_id: "ship", status: "active", source_message_id: "msg1",
    allowed_readers: ["*"], policy_context: "p2", content: "Ship target: region US, replicas=1" },
  { memory_id: "m_superseded", run_id: "run2", task_id: "ship", status: "superseded", source_message_id: "msg2",
    allowed_readers: ["*"], policy_context: "p1", content: "Ship target: region EU, replicas=9" },
  { memory_id: "m_valid", run_id: "run2", task_id: "ship", status: "active", source_message_id: "msg2",
    allowed_readers: ["*"], policy_context: "p2", content: "Ship target: region EU, replicas=3" },
];
const ACTIVE_MESSAGE = { run_id: "run2", task_id: "ship", receiver: "deployer", policy_context: "p2", intent: "deploy" };
const EVENT_GRAPH = new Set(["msg1", "msg2"]);
const GOLD = "region EU, replicas=3"; // native task success = final answer grounded on the valid record

const rawRead = () => STORE; // an external store returns all candidates by content relevance

function nativeAnswer(records) {
  // simulate a model that grounds on the first/"most relevant" record it is given (no binding)
  const top = records[0];
  return top ? top.content : "(no memory)";
}
const success = (ans) => ans.includes(GOLD);

// Condition A: native (gate OFF) — store returns all; model grounds on a wrong-run record -> FAIL
const nativeRecords = rawRead();
const nativeAns = nativeAnswer(nativeRecords);

// Condition B: native + MBM (gate ON) — only the valid record is admitted -> SUCCESS
const gatedRead = wrapMemoryRead(rawRead, { eventGraph: EVENT_GRAPH });
const { admitted, audit } = gatedRead(ACTIVE_MESSAGE);
const gatedAns = nativeAnswer(admitted);

const result = {
  experiment: "E16-pilot",
  note: "Synthetic stateful-store pilot proving the wrapper hooks and is not a no-op (no internet needed). Replace STORE/rawRead with tau-bench / LoCoMo for the full run.",
  native_off: { candidates: nativeRecords.length, answer: nativeAns, native_success: success(nativeAns) },
  native_plus_mbm: { admitted: admitted.length, answer: gatedAns, native_success: success(gatedAns), audit },
  not_a_no_op: nativeRecords.length !== admitted.length && success(gatedAns) && !success(nativeAns),
};
console.log(JSON.stringify(result, null, 2));
