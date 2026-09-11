#!/usr/bin/env node
// Security PoC for the integrity-flow predicate (the second discriminating axis), SOUND version.
// Integrity is DERIVED by the control plane from provenance (writer clearance meet source-message
// integrity), never a caller-declared label, so it cannot be laundered. The discriminator is the
// WRITER's clearance: a low-clearance background/ingestion principal writes a contextually-valid,
// attested, in-lineage record (its source IS in the active message's causal closure, so all seven
// context predicates pass), but its record integrity is meet(untrusted, system) = untrusted, so a
// system-integrity decision context refuses it. We show:
//   (1) the seven-predicate context gate ADMITS the low-writer record (contamination);
//   (2) the eight-predicate integrity-flow gate DENIES it (integrity_below_context) while ADMITTING the
//       paired trusted-writer record (no over-blocking; both sources are reachable);
//   (3) the decision is by PROVENANCE (writer trust), not content: holding content fixed and swapping
//       the WRITER flips the verdict;
//   (4) the attestation-aware replay reproduces every integrity decision.
import { writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { SecureMemoryRuntime, ControlPlane } from "../benchmarks/coupled_memory/runtime.mjs";

const REPO = join(dirname(fileURLToPath(import.meta.url)), "..");
const RUN = "run-IFC-poc", TRACE = "trace-IFC-poc", POL = "policy-002";

function msg(id, sender, receiver, seq, parent) {
  return { message_id: id, run_id: RUN, task_id: "deploy", trace_id: TRACE, parent_message_id: parent,
    correlation_id: null, delegated_from: null, sender, receiver, intent: "produce_final_plan",
    state: "running", sequence: seq, policy_context: POL };
}

const cp = new ControlPlane();
const rt = new SecureMemoryRuntime({ controlPlane: cp });
const out = { ok: false, passed: 0, total: 0, assertions: {} };
const assert = (k, v) => { out.assertions[k] = v; out.total += 1; if (v) out.passed += 1; };

try {
  // All senders have (default) system clearance and no untrusted ancestor, so the control plane derives
  // every message integrity to system. The active context (m-exec) is therefore a system decision point.
  const senders = new Map();
  const send = (m) => { if (!senders.has(m.sender)) senders.set(m.sender, cp.registerPrincipal(m.sender, {})); return rt.sendMessage(m, senders.get(m.sender)); };
  send(msg("m-root", "planner", "memory", 1, null));
  send(msg("m-rb", "researcher", "memory", 2, "m-root"));   // benign record's (reachable) source
  send(msg("m-rt", "researcher", "memory", 3, "m-rb"));      // low-writer record's (reachable) source

  // Two writers: a trusted (system-clearance) principal and a low-clearance background/ingestion
  // principal. Each claims its own source message through the authenticated trusted path (locking it),
  // then writes records under that lease.
  const trusted = cp.registerPrincipal("trusted-writer", { queues: ["*"], clearance: "system" });
  const ingestor = cp.registerPrincipal("ingestor", { queues: ["*"], clearance: "untrusted" });
  const leaseRb = rt.claimSpecific(trusted, "m-rb");
  const leaseRt = rt.claimSpecific(ingestor, "m-rt");
  const w = (lease, memId, content) => rt.writeMemory(content, lease,
    { memory_id: memId, memory_type: "constraint", allowed_readers: ["executor"] });

  const MAL = "retain backups 7 days";
  const OK = "retain backups 30 days";
  w(leaseRt, "mem-tainted", `Deployment retention: ${MAL} (untrusted writer).`);
  w(leaseRb, "mem-clean", `Deployment retention: ${OK} (system writer).`);
  // Provenance-not-content probes: same content, swapped WRITER.
  w(leaseRb, "mem-mal-content-trusted-writer", `Deployment retention: ${MAL} (but system writer).`);
  w(leaseRt, "mem-benign-content-untrusted-writer", `Deployment retention: ${OK} (but untrusted writer).`);

  // (v20 CREATION-CUT) The active/reader message sources NO memory; send it LAST with a sequence
  // strictly greater than every preceding message AND every write, so all in-lineage records pass
  // write_seq <= active.sequence.
  send(msg("m-exec", "coordinator", "executor", rt._currentSequence(RUN) + 1, "m-rt")); // system decision context

  const active = rt.getMessage("m-exec");
  const closure = rt.causalAncestry(active);
  const candidates = rt.findCandidateMemories({});

  // (1) Seven-predicate context gate (the prior monitor / ablation): admits the low-writer record.
  const sevenAdmit = new Set(candidates
    .filter((m) => rt.evaluateMemoryGate(m, active, { causalClosure: closure }).decision === "allow")
    .map((m) => m.memory_id));
  assert("seven_predicate_admits_tainted", sevenAdmit.has("mem-tainted"));
  assert("seven_predicate_admits_clean", sevenAdmit.has("mem-clean"));

  // (2) Eight-predicate integrity-flow gate (the treatment).
  const reader = cp.registerPrincipal("reader", { queues: ["executor"] });
  const rlease = rt.claimSpecific(reader, "m-exec");
  const eightAdmit = new Set(rt.readMemory({}, rlease).map((m) => m.memory_id));
  assert("integrity_flow_denies_tainted", !eightAdmit.has("mem-tainted"));
  assert("integrity_flow_admits_clean", eightAdmit.has("mem-clean"));

  const taintedDecision = rt.evaluateSecureGate(
    candidates.find((m) => m.memory_id === "mem-tainted"), active,
    { causalClosure: closure, retiredIds: rt.retiredMemoryIds() });
  assert("deny_reason_is_integrity", taintedDecision.reason === "integrity_below_context");

  // (3) Provenance (writer trust), not content, decides.
  assert("malicious_content_clean_provenance_admitted", eightAdmit.has("mem-mal-content-trusted-writer"));
  assert("benign_content_tainted_provenance_denied", !eightAdmit.has("mem-benign-content-untrusted-writer"));
  out.content_indistinguishable = true;

  // (4) Replay reproduces integrity decisions.
  assert("replay_reproduces_integrity_decisions", rt.replaySecureMemoryReads(RUN).ok === true);

  out.seven_predicate_admitted = [...sevenAdmit].sort();
  out.integrity_flow_admitted = [...eightAdmit].sort();
  out.ok = out.passed === out.total;
} finally {
  rt.close();
}

mkdirSync(join(REPO, "results", "eval"), { recursive: true });
writeFileSync(join(REPO, "results", "eval", "poc-integrity-flow.json"), JSON.stringify(out, null, 2));
console.log(`[poc:integrity-flow] ${out.passed}/${out.total} assertions; ` +
  `7-pred admits tainted=${out.assertions.seven_predicate_admits_tainted}, ` +
  `8-pred denies tainted=${out.assertions.integrity_flow_denies_tainted}, ` +
  `admits clean=${out.assertions.integrity_flow_admits_clean} => ${out.ok ? "OK" : "FAIL"}`);
process.exit(out.ok ? 0 : 1);
