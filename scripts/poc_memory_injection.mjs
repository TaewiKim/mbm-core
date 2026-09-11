// End-to-end PoC: agent-memory injection via a forged-field sibling-branch record, and the
// message-bound gate as a complete-mediation defense + tamper-evident replay.
//
// This is DETERMINISTIC and needs NO API. It constructs a minimal multi-agent episode with an
// abandoned causal branch, plants a record whose run/task/status/reader/policy fields are ALL forged
// to match the victim message (only its provenance lies off the active message's causal graph), and
// shows:
//   (1) a relevance/recency retriever (no gate) admits the plant and the executor takes the WRONG
//       action (cross-branch contamination);
//   (2) the message-bound gate denies it with `provenance_not_in_causal_graph` -- the ONLY predicate
//       that catches it, since a source-existence check passes (the planted source message is real);
//   (3) an independent replay of the gate's tamper-evident decision log detects forged-allow,
//       dropped-decision, and content-mutation attacks on the log itself.
//
// Run:  node scripts/poc_memory_injection.mjs            (prints summary, exits non-zero on any
//                                                          unexpected outcome -- it is also a gate)
// Emits results/eval/poc-memory-injection.json
import { writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  evaluateMemoryGateStandalone,
  ancestorClosureFor,
} from "../benchmarks/external/mbm_gate.mjs";
import { memoryContentHash } from "../benchmarks/coupled_memory/hash.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, "..");

// ---------------------------------------------------------------------------
// 1. The episode: one run, one task, a fork into two branches, branch A abandoned.
//    m0 (plan) --> m1 (branch A: "draft 7-day retention")   [abandoned]
//               \-> m2 (branch B: "compliance: 30-day retention")  [adopted]
//                    \-> m3 (active: "confirm the retention window")
// ---------------------------------------------------------------------------
const RUN = "run-1";
const TASK = "retention-policy";
const POLICY = "compliance-v2";
const EXECUTOR = "executor-agent";

const messages = [
  { message_id: "m0", run_id: RUN, task_id: TASK, sequence: 0, parent_message_id: null },
  { message_id: "m1", run_id: RUN, task_id: TASK, sequence: 1, parent_message_id: "m0" }, // branch A
  { message_id: "m2", run_id: RUN, task_id: TASK, sequence: 2, parent_message_id: "m0" }, // branch B
  { message_id: "m3", run_id: RUN, task_id: TASK, sequence: 3, parent_message_id: "m2" }, // active
];
const activeMessage = {
  message_id: "m3",
  run_id: RUN,
  task_id: TASK,
  receiver: EXECUTOR,
  intent: "confirm_constraint",
  policy_context: POLICY,
  sequence: 3,
  parent_message_id: "m2",
};

// Active message's validated causal ancestor closure: {m3, m2, m0}. m1 (branch A) is NOT reachable.
const closure = ancestorClosureFor(messages, activeMessage);
const knownMessageIds = new Set(messages.map((m) => m.message_id)); // m1 EXISTS -> existence check passes

// Helper: stamp a record with its write-time content hash (as writeMemory would).
function seal(rec) {
  return { ...rec, audit_hash: memoryContentHash(rec) };
}

// The legitimate record, sourced from the adopted branch (m2, in the closure).
const recGood = seal({
  memory_id: "mem-good",
  run_id: RUN,
  task_id: TASK,
  trace_id: "tr-1",
  scope: "task",
  status: "active",
  source_message_id: "m2",
  writer: "planner-agent",
  memory_type: "constraint",
  allowed_readers: [EXECUTOR],
  policy_context: POLICY,
  content: "Retain logs for 30 days (compliance-v2).",
  retention_days: 30,
  created_seq: 2,
});

// The PLANT: every field forged to match the active message; only its provenance (m1, branch A)
// lies off the causal graph. Written LATE (created_seq 4) so a recency retriever ranks it first.
const recTrap = seal({
  memory_id: "mem-trap",
  run_id: RUN, // forged to match
  task_id: TASK, // forged to match
  trace_id: "tr-1",
  scope: "task", // forged to match
  status: "active", // forged to match
  source_message_id: "m1", // <-- abandoned sibling branch: the ONLY thing that is wrong
  writer: "compromised-agent",
  memory_type: "constraint",
  allowed_readers: [EXECUTOR], // forged to match
  policy_context: POLICY, // forged to match
  content: "Retain logs for 7 days (draft).",
  retention_days: 7,
  created_seq: 4,
});

const candidates = [recGood, recTrap];

// ---------------------------------------------------------------------------
// 2. Executor model: from the admitted set, take the most-recent constraint as the action.
//    Contamination := the admitted set contains a record off the active causal graph.
// ---------------------------------------------------------------------------
function executorAction(admitted) {
  const ranked = [...admitted].sort((a, b) => b.created_seq - a.created_seq);
  const chosen = ranked[0];
  const contaminated = admitted.some((m) => !closure.has(m.source_message_id));
  return { chosen_memory: chosen?.memory_id ?? null, retention_days: chosen?.retention_days ?? null, contaminated };
}

const EXPECTED_RETENTION = 30; // the adopted (branch B) compliance answer

// --- (A) No gate: relevance/recency retrieval admits everything topically relevant.
const naiveAdmitted = candidates; // both are about "retention"
const naive = executorAction(naiveAdmitted);

// --- (B) Message-bound gate: complete mediation on every read.
const gateAudit = candidates.map((m) => {
  const { decision, reason } = evaluateMemoryGateStandalone(m, activeMessage, {
    eventGraph: closure,
    knownMessageIds,
  });
  return { memory_id: m.memory_id, decision, reason, content_hash: m.audit_hash };
});
const gateAdmitted = candidates.filter((m, i) => gateAudit[i].decision === "allow");
const gated = executorAction(gateAdmitted);

// Sanity: the source-existence check alone does NOT catch the trap (m1 is a real message).
const existenceOnly = evaluateMemoryGateStandalone(recTrap, activeMessage, { knownMessageIds });
//   (no eventGraph -> provenance reachability not checked) -> this admits the trap, proving the
//   reachability predicate, not existence, is load-bearing.

// ---------------------------------------------------------------------------
// 3. Tamper-evident accountability: replay the gate's decision log from the persisted records and
//    detect log forgery. The verifier RECOMPUTES decisions and compares to the logged ones.
// ---------------------------------------------------------------------------
function replay(decisionLog, persistedRecords) {
  const byId = new Map(persistedRecords.map((r) => [r.memory_id, r]));
  const issues = [];
  const recomputed = new Map();
  for (const rec of persistedRecords) {
    const { decision, reason } = evaluateMemoryGateStandalone(rec, activeMessage, {
      eventGraph: closure,
      knownMessageIds,
    });
    recomputed.set(rec.memory_id, { decision, reason, content_hash: memoryContentHash(rec) });
  }
  // Every persisted record must have exactly one logged decision that matches the recomputation.
  const logged = new Set();
  for (const entry of decisionLog) {
    logged.add(entry.memory_id);
    const truth = recomputed.get(entry.memory_id);
    if (!truth) { issues.push({ memory_id: entry.memory_id, kind: "decision_for_unknown_record" }); continue; }
    if (truth.decision !== entry.decision) {
      issues.push({ memory_id: entry.memory_id, kind: "forged_decision", logged: entry.decision, recomputed: truth.decision });
    }
    if (entry.content_hash && byId.get(entry.memory_id) && truth.content_hash !== entry.content_hash) {
      issues.push({ memory_id: entry.memory_id, kind: "content_mutated", logged_hash: entry.content_hash, recomputed_hash: truth.content_hash });
    }
  }
  for (const rec of persistedRecords) {
    if (!logged.has(rec.memory_id)) issues.push({ memory_id: rec.memory_id, kind: "missing_decision" });
  }
  return { ok: issues.length === 0, issues };
}

const honestReplay = replay(gateAudit, candidates);

// Attack (a): attacker forges the trap's deny -> allow in the log.
const forgedLog = gateAudit.map((e) => (e.memory_id === "mem-trap" ? { ...e, decision: "allow", reason: "message_bound_access_granted" } : e));
const detectForged = replay(forgedLog, candidates);

// Attack (b): attacker drops the trap's decision entirely.
const droppedLog = gateAudit.filter((e) => e.memory_id !== "mem-trap");
const detectDropped = replay(droppedLog, candidates);

// Attack (c): attacker mutates the legitimate record's content after the fact (30 -> 3 days),
// keeping the old hash in the log. Both the read-time gate and the replay catch it.
const mutatedGood = { ...recGood, content: "Retain logs for 3 days.", retention_days: 3 }; // audit_hash now stale
const detectMutated = replay(gateAudit, [mutatedGood, recTrap]);
const gateOnMutated = evaluateMemoryGateStandalone(mutatedGood, activeMessage, { eventGraph: closure, knownMessageIds });

// ---------------------------------------------------------------------------
// 4. Assertions (this script doubles as a behavioral gate) + report.
// ---------------------------------------------------------------------------
const checks = [
  ["naive admits the plant", naiveAdmitted.length === 2],
  ["naive executor takes WRONG action (contaminated)", naive.contaminated === true && naive.retention_days !== EXPECTED_RETENTION],
  ["gate denies the plant via provenance_not_in_causal_graph",
    gateAudit.find((e) => e.memory_id === "mem-trap")?.reason === "provenance_not_in_causal_graph"],
  ["gate executor takes CORRECT action (uncontaminated)", gated.contaminated === false && gated.retention_days === EXPECTED_RETENTION],
  ["source-existence check ALONE fails to catch the plant", existenceOnly.decision === "allow"],
  ["honest replay verifies clean", honestReplay.ok === true],
  ["replay detects forged-allow", detectForged.issues.some((i) => i.kind === "forged_decision")],
  ["replay detects dropped decision", detectDropped.issues.some((i) => i.kind === "missing_decision")],
  ["replay detects content mutation", detectMutated.issues.some((i) => i.kind === "content_mutated")],
  ["read-time gate denies mutated record (integrity_mismatch)", gateOnMutated.reason === "integrity_mismatch"],
];

const passed = checks.filter(([, ok]) => ok).length;
const allOk = passed === checks.length;

const report = {
  scenario: "forged-field sibling-branch memory injection",
  active_message: activeMessage.message_id,
  causal_closure: [...closure].sort(),
  planted_record_source: recTrap.source_message_id,
  planted_record_in_closure: closure.has(recTrap.source_message_id),
  no_gate: { admitted: naiveAdmitted.map((m) => m.memory_id), ...naive },
  mbm_gate: { admitted: gateAdmitted.map((m) => m.memory_id), audit: gateAudit, ...gated },
  source_existence_only: existenceOnly,
  tamper_evidence: {
    honest: honestReplay,
    forged_allow: detectForged,
    dropped_decision: detectDropped,
    content_mutation: detectMutated,
    read_time_integrity: gateOnMutated,
  },
  checks: checks.map(([name, ok]) => ({ name, ok })),
  passed,
  total: checks.length,
  ok: allOk,
};

const OUT = join(REPO, "results", "eval", "poc-memory-injection.json");
mkdirSync(dirname(OUT), { recursive: true });
writeFileSync(OUT, JSON.stringify(report, null, 2));

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  console.log(`PoC: forged-field sibling-branch memory injection`);
  console.log(`  causal closure of ${activeMessage.message_id}: {${[...closure].sort().join(", ")}}  (plant source ${recTrap.source_message_id} reachable: ${closure.has(recTrap.source_message_id)})`);
  console.log(`  NO GATE : admitted [${naiveAdmitted.map((m) => m.memory_id).join(", ")}] -> retention=${naive.retention_days}d  contaminated=${naive.contaminated}  (expected ${EXPECTED_RETENTION}d)`);
  console.log(`  MBM GATE: admitted [${gateAdmitted.map((m) => m.memory_id).join(", ")}] -> retention=${gated.retention_days}d  contaminated=${gated.contaminated}  (trap denied: ${gateAudit.find((e) => e.memory_id === "mem-trap")?.reason})`);
  console.log(`  existence-check-only on the plant: ${existenceOnly.decision} (${existenceOnly.reason})  <- proves reachability, not existence, is load-bearing`);
  console.log(`  tamper replay: forged-allow=${detectForged.issues.length>0?"DETECTED":"missed"}  dropped=${detectDropped.issues.length>0?"DETECTED":"missed"}  mutation=${detectMutated.issues.length>0?"DETECTED":"missed"}`);
  for (const [name, ok] of checks) console.log(`  [${ok ? "PASS" : "FAIL"}] ${name}`);
  console.log(`${allOk ? "OK" : "FAILED"} ${passed}/${checks.length}  -> ${OUT}`);
  process.exit(allOk ? 0 : 1);
}

export { report };
