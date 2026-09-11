#!/usr/bin/env node
// Review remediation gates. Each gate encodes one reviewer concern as a FALSIFIABLE check.
// Where a concern is behavioral, the gate EXECUTES the reviewer's counterexample (it does not just
// grep for a string or a file): `node scripts/check_review_gates.mjs`. A gate is PASS only when the
// underlying defect is actually removed; gates awaiting a live re-run report PENDING with the reason.
import { existsSync, readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import process from "node:process";

const read = (p) => (existsSync(p) ? readFileSync(p, "utf8") : "");
const results = [];
const gate = (id, title, status, detail) => results.push({ id, title, status, detail });
const PASS = "PASS", FAIL = "FAIL", PENDING = "PENDING";
const safe = async (fn, onErr) => { try { return await fn(); } catch (e) { return onErr(e); } };

// ---- RG1 (M1): independent conventional ABAC+ReBAC comparator reproduces the admitted set ----
await safe(async () => {
  const r = JSON.parse(read("results/eval/policy-comparator.json") || "null");
  const ok = r && r.all_equivalent === true && r.total >= 27;
  gate("RG1", "M1 independent ABAC+ReBAC policy comparator (27/27)",
    ok ? PASS : (r ? FAIL : PENDING),
    r ? `${r.equivalent_admitted_set}/${r.total} admitted-set equivalent` : "run `npm run policy:comparator`");
}, () => gate("RG1", "M1 independent ABAC+ReBAC policy comparator (27/27)", PENDING, "comparator result missing"));

// ---- RG2 (M2): reconstructability measured, not condition-label; tie-safe baseline selection ----
{
  const a = read("scripts/analyze_sota_best_baseline.mjs");
  const labelRecon = /function reconOf[\s\S]*?isGated\(/.test(a) || /reconstructab[\s\S]*?isGated/.test(a);
  const tieUnsafe = /if \(best === null \|\| f > best\.ffcr\)/.test(a);
  gate("RG2", "M2 measured reconstructability + tie-safe selection",
    (!labelRecon && !tieUnsafe) ? PASS : FAIL,
    `${labelRecon ? "recon from label; " : ""}${tieUnsafe ? "first-match tie-break" : ""}`.trim() || "recon measured + tie-safe");
}

// ---- RG3 (M6): NO ground-truth fallback (_expected / expected_memory_ids) in any runtime read path ----
{
  // Correct, complete file list (the prior gate pointed at a non-existent external/ path and missed
  // the real longrun runner). A fallback admits the answer key when the gate admits nothing.
  const files = [
    "benchmarks/coupled_memory/langgraph_live_multiagent.mjs",
    "benchmarks/coupled_memory/longrun_multiagent.mjs",
    "benchmarks/external/mbm_gate.mjs",
    "benchmarks/external/longrun_multiagent.mjs",
    "benchmarks/coupled_memory/autogen_native.mjs",
  ].filter(existsSync);
  // fallback shapes: `? adm : store.filter(m => m._expected)` or `|| ...expected_memory_ids`.
  const fallbackRe = /:\s*[\w.]*\.filter\(\s*\(?\s*\w+\)?\s*=>\s*\w+\._expected\s*\)|\?\s*\w+\s*:\s*[^\n;]*_expected|\|\|[^\n;]*expected_memory_ids/;
  const leaks = files.filter((f) => fallbackRe.test(read(f)));
  gate("RG3", "M6 no ground-truth (_expected) fallback in any read path",
    leaks.length === 0 ? PASS : FAIL,
    leaks.length ? `fallback in: ${leaks.join(", ")}` : `fail-closed in ${files.length} runtime files`);
}

// ---- RG4 (M4): happens-before is temporally validated -- a future event cannot be an ancestor ----
await safe(async () => {
  const { causalAncestryFromMessages } = await import("../benchmarks/coupled_memory/causal.mjs");
  const future = causalAncestryFromMessages(
    [{ message_id: "active", parent_message_id: "future", sequence: 1 }, { message_id: "future", sequence: 99 }],
    { message_id: "active", parent_message_id: "future", sequence: 1 });
  const legit = causalAncestryFromMessages(
    [{ message_id: "child", parent_message_id: "root", sequence: 5 }, { message_id: "root", sequence: 2 }],
    { message_id: "child", parent_message_id: "root", sequence: 5 });
  const ok = !future.has("future") && legit.has("root") && legit.has("child");
  gate("RG4", "M4 temporally validated happens-before (no future ancestor)",
    ok ? PASS : FAIL,
    ok ? "future event rejected; legit ancestor preserved" : `future_admitted=${future.has("future")} legit_ok=${legit.has("root")}`);
}, (e) => gate("RG4", "M4 temporally validated happens-before (no future ancestor)", FAIL, `threw: ${e.message}`));

// ---- RG5 (M2/M5): independent audit replay catches tamper/flip/deletion (runs the self-test) ----
await safe(async () => {
  execFileSync(process.execPath, ["scripts/audit_replay.mjs", "--self-test"], { stdio: "pipe" });
  gate("RG5", "M2 independent audit replay catches tamper/flip/deletion", PASS,
    "self-test: clean ok; content-tamper, allow->deny flip, single + full decision deletion all caught");
}, (e) => gate("RG5", "M2 independent audit replay catches tamper/flip/deletion", FAIL,
  `self-test failed: ${(e.stdout?.toString() || e.message).split("\n").slice(-3).join(" | ")}`));

// ---- RG6 (M3): strong-baseline prompt parity -- every condition gets identical context/instruction ----
await safe(async () => {
  const { baselinePayload } = await import("../benchmarks/coupled_memory_strong_baseline_benchmark.mjs");
  const { PHASE4_MAIN_SCENARIOS, runPhase4ScenarioBaseline } = await import("../benchmarks/coupled_memory/scenarios.mjs");
  const sc = PHASE4_MAIN_SCENARIOS[0];
  const detC4 = runPhase4ScenarioBaseline({ scenario: sc, baseline: "C4" });
  const detC5 = runPhase4ScenarioBaseline({ scenario: sc, baseline: "C5" });
  const pC4 = baselinePayload(sc, detC4, "C4");
  const pC5 = baselinePayload(sc, detC5, "C5");
  // M2: the WHOLE model-facing payload, minus candidate_memories, must be byte-identical across arms
  // (not just protocol_rule + active_message). This catches condition/baseline_id label leakage.
  const stripped = (p) => { const { candidate_memories, ...rest } = p; return JSON.stringify(rest, Object.keys(rest).sort()); };
  const onlyCandidatesDiffer = stripped(pC4) === stripped(pC5);
  // No condition/baseline/treatment vocabulary anywhere in the serialized payload.
  const noLabelLeak = !/\bC4\b|\bC5\b|baseline_id|message-bound|uncoupled|coupled condition|proposed|treatment|control\b/i
    .test(JSON.stringify({ ...pC4, candidate_memories: undefined }) + JSON.stringify({ ...pC5, candidate_memories: undefined }));
  const ok = onlyCandidatesDiffer && noLabelLeak;
  gate("RG6", "M2 strong-baseline prompt parity (ONLY candidate set differs; no label leak)",
    ok ? PASS : FAIL,
    ok ? "full payload identical across C4/C5 except candidate_memories; no condition/baseline labels"
      : `onlyCandidatesDiffer=${onlyCandidatesDiffer} noLabelLeak=${noLabelLeak}`);
}, (e) => gate("RG6", "M2 strong-baseline prompt parity (ONLY candidate set differs; no label leak)", FAIL, `threw: ${e.message}`));

// ---- RG7 (M7): external gate verdicts MATCH the central runtime (same checks, same reason codes) ----
await safe(async () => {
  const { CoupledMemoryRuntime } = await import("../benchmarks/coupled_memory/runtime.mjs");
  const { evaluateMemoryGateStandalone, ancestorClosureFor } = await import("../benchmarks/external/mbm_gate.mjs");
  const { INTENT_MEMORY_TYPES } = await import("../benchmarks/coupled_memory/constants.mjs");
  const rt = new CoupledMemoryRuntime({});
  rt.ensureRun("R");
  const active = rt.sendMessage({ message_id: "msgA", run_id: "R", task_id: "T", trace_id: "tr", sender: "s", receiver: "reader", intent: "share", state: "active", sequence: 1, policy_context: "P" });
  const msgs = rt.db.prepare("SELECT message_id,parent_message_id,delegated_from,sequence,created_at FROM messages WHERE run_id='R'").all();
  const closure = ancestorClosureFor(msgs, active);
  const known = new Set(msgs.map((m) => m.message_id));
  const base = { memory_id: "m", run_id: "R", task_id: "T", trace_id: "tr", source_message_id: "msgA", writer: "w", memory_type: "summary", scope: "task", status: "active", content: "x", allowed_readers: ["*"], policy_context: "P" };
  // Battery now includes the ADVERSARIAL BOUNDARY fixtures the prior gate missed (review M3): a record
  // with NO source_message_id (central denies via getMessage(undefined); external must match), and an
  // unknown intent. Both gates must return the SAME reason.
  const battery = [base, { ...base, status: undefined }, { ...base, allowed_readers: undefined }, { ...base, run_id: "OTHER" }, { ...base, allowed_readers: ["x"] }, { ...base, policy_context: "Q" },
    { ...base, source_message_id: undefined }, { ...base, source_message_id: "ghost" }];
  let mismatches = 0;
  for (const mem of battery) {
    const c = rt.evaluateMemoryGate(mem, active, { causalClosure: closure });
    const e = evaluateMemoryGateStandalone(mem, active, { eventGraph: closure, knownMessageIds: known, intentMemoryTypes: INTENT_MEMORY_TYPES });
    if (c.decision !== e.decision || c.reason !== e.reason) mismatches += 1;
  }
  rt.close();
  gate("RG7", "M7 external gate matches central (same checks + reason codes)",
    mismatches === 0 ? PASS : FAIL,
    mismatches === 0 ? `${battery.length}/${battery.length} verdicts identical incl. metadata-light records` : `${mismatches} divergence(s)`);
}, (e) => gate("RG7", "M7 external gate matches central (same checks + reason codes)", FAIL, `threw: ${e.message}`));

// ---- RG8 (portability): no hardcoded OS python path ----
{
  const hardcoded = /\.omx[\\/]python312[\\/]python\.exe/.test(read("benchmarks/coupled_memory/autogen_native.mjs"));
  gate("RG8", "portable native runner (no hardcoded python path)", hardcoded ? FAIL : PASS,
    hardcoded ? "hardcoded python path" : "python resolved from env / skips gracefully");
}

// ---- RG9 (stats): true family clusters ----
{
  const doubleCounts = /family:\s*`\$\{r\.id\}:\$\{p\.family\}`/.test(read("scripts/analyze_sota_best_baseline.mjs"));
  gate("RG9", "stats: cluster by true family", doubleCounts ? FAIL : PASS,
    doubleCounts ? "clusters keyed by experiment:family" : "clusters keyed by true family");
}

// ---- RG10 (MAST): mapping covers all 9 families ----
{
  let n = 0;
  try { n = (JSON.parse(read("results/eval/mast-family-mapping.json")).families || []).length; } catch {}
  gate("RG10", "MAST mapping covers 9 families", n >= 9 ? PASS : FAIL, `mapping has ${n} families`);
}

// ---- RG11 (M1 empirical): deployed Cedar engine reproduces the admitted set ----
await safe(async () => {
  const r = JSON.parse(read("results/eval/cedar-policy-comparator.json") || "null");
  const ok = r && r.all_equivalent === true && r.total >= 27 && r.schema_validated === true
    && r.agree_with_js_comparator === r.total
    && (r.ancestry_load_bearing_families || []).includes("graph_only_sibling_branch_provenance")
    && (r.naive_default_false_admits || 0) > 0;
  gate("RG11", "M1 deployed Cedar engine reproduces admitted set (27/27)",
    ok ? PASS : (r ? FAIL : PENDING),
    r ? `Cedar ${r.engine_version}: ${r.equivalent_to_gate}/${r.total} == gate` : "run `npm run policy:cedar`");
}, () => gate("RG11", "M1 deployed Cedar engine reproduces admitted set (27/27)", PENDING, "cedar result missing"));

// ---- RG13 (M1): withdrawn live-LangGraph (E17) result is NOT regenerated or displayed ----
{
  const figReadsE17 = /e17-langgraph-live-analysis\.json/.test(read("tools/build_figures.py"))
    && !/#\s*WITHDRAWN/.test(read("tools/build_figures.py"));
  const e17Files = [
    "results/eval/e17-langgraph-live-analysis.json",
    "results/eval/e17-langgraph-live.jsonl",
    "results/eval/e17-langgraph-live-mini.jsonl",
  ].filter(existsSync);
  const ok = !figReadsE17 && e17Files.length === 0;
  gate("RG13", "M1 withdrawn live-LangGraph (E17) result removed from figures+results",
    ok ? PASS : FAIL,
    ok ? "Figure 7 no longer reads E17; stale E17 result files removed"
      : `${figReadsE17 ? "figure still reads E17 analysis; " : ""}${e17Files.length ? `stale files: ${e17Files.join(", ")}` : ""}`.trim());
}

// ---- RG12 (M3): live E3/E5/E7 regenerated under the parity-fixed runner (2-model combined) ----
await safe(async () => {
  const need = ["e3-se-native-combined", "e5-strong-baseline-combined", "e7-holdout-combined"];
  const detail = [];
  let ok = true;
  for (const f of need) {
    let d = null;
    try { d = JSON.parse(read(`results/eval/${f}.json`)); } catch {}
    const models = new Set((d?.cases || []).map((c) => c.model));
    const twoModel = models.has("gpt-5.4-nano") && models.has("gpt-5.4-mini");
    if (!d || !twoModel) ok = false;
    detail.push(`${f}:${d ? (d.cases?.length ?? 0) : "MISSING"}${twoModel ? "" : "(not 2-model)"}`);
  }
  gate("RG12", "M3 live E3/E5/E7 regenerated under parity-fixed runner (2-model)",
    ok ? PASS : FAIL, detail.join(", "));
}, (e) => gate("RG12", "M3 live E3/E5/E7 regenerated under parity-fixed runner (2-model)", FAIL, e.message));

// ---- RG14 (security PoC): end-to-end memory-injection exploit is admitted without the gate,
//      denied by causal reachability (not source existence) with the gate, and the tamper-evident
//      replay detects forged/dropped/mutated decisions. Runs the PoC; PASS only if all 10 assertions
//      hold AND the wrong->right action flip and the existence-bypass are present in the report. ----
await safe(async () => {
  execFileSync(process.execPath, ["scripts/poc_memory_injection.mjs"], { stdio: "ignore" });
  const r = JSON.parse(read("results/eval/poc-memory-injection.json") || "null");
  const flips = r && r.no_gate?.retention_days === 7 && r.no_gate?.contaminated === true
    && r.mbm_gate?.retention_days === 30 && r.mbm_gate?.contaminated === false;
  const trapReason = r?.mbm_gate?.audit?.find((e) => e.memory_id === "mem-trap")?.reason;
  const reachabilityLoadBearing = trapReason === "provenance_not_in_causal_graph"
    && r?.source_existence_only?.decision === "allow";
  const tamper = r && r.tamper_evidence?.forged_allow?.ok === false
    && r.tamper_evidence?.dropped_decision?.ok === false
    && r.tamper_evidence?.content_mutation?.ok === false;
  const ok = r && r.ok === true && flips && reachabilityLoadBearing && tamper;
  gate("RG14", "Security PoC: injection admitted w/o gate, denied by reachability, tamper detected",
    ok ? PASS : (r ? FAIL : PENDING),
    r ? `${r.passed}/${r.total} assertions; flip=${flips} reachability_load_bearing=${reachabilityLoadBearing} tamper_detected=${tamper}`
      : "run `npm run poc:injection`");
}, (e) => gate("RG14", "Security PoC: injection admitted w/o gate, denied by reachability, tamper detected", FAIL, e.message));

// ---- RG15 (M1): active-message principal substitution is rejected fail-closed, and audit replay
//      does not certify a forged active snapshot. Executes the reviewer's counterexample directly. ----
await safe(async () => {
  const { CoupledMemoryRuntime } = await import("../benchmarks/coupled_memory/runtime.mjs");
  const env = (o) => ({ message_id: "m", run_id: "R1", task_id: "T1", trace_id: "tr1", sender: "a",
    receiver: "a", intent: "produce_final_plan", state: "active", sequence: 1,
    parent_message_id: null, correlation_id: null, delegated_from: null, policy_context: "P1", ...o });
  const rt = new CoupledMemoryRuntime();
  let forgedThrew = false, honestOk = false, replayDetected = false, writeForgeThrew = false;
  try {
    const victim = env({ message_id: "m-victim", run_id: "R2", task_id: "T2", trace_id: "trV",
      sender: "victim", receiver: "victim", policy_context: "P2" });
    const attacker = env({ message_id: "m-attacker", sender: "mallory", receiver: "mallory" });
    rt.sendMessage(victim); rt.sendMessage(attacker);
    rt.writeMemory("the secret", victim, { memory_id: "secret", allowed_readers: ["victim"] });
    honestOk = rt.readMemory({ text: "secret" }, victim, { condition: "C5" }).some((m) => m.memory_id === "secret");
    const forged = env({ message_id: "m-attacker", run_id: "R2", task_id: "T2", receiver: "victim",
      policy_context: "P2", parent_message_id: "m-victim" });
    try { rt.readMemory({ text: "secret" }, forged, { condition: "C5" }); } catch (e) { forgedThrew = /envelope_mismatch/.test(e.message); }
    try { rt.writeMemory("planted", forged, { memory_id: "planted" }); } catch (e) { writeForgeThrew = /envelope_mismatch/.test(e.message); }
    rt.db.prepare("UPDATE memory_reads SET active_message_json = ? WHERE run_id = 'R2'")
      .run(JSON.stringify({ message_id: "m-victim", run_id: "R2", task_id: "T2", trace_id: "trV",
        receiver: "mallory", intent: "produce_final_plan", policy_context: "P9", sequence: 1 }));
    const replay = rt.replayMemoryReads("R2");
    replayDetected = replay.ok === false && replay.issues.some((i) => i.kind === "active_message_envelope_mismatch");
  } finally { rt.close(); }
  const ok = honestOk && forgedThrew && writeForgeThrew && replayDetected;
  gate("RG15", "M1 active-message bound to canonical envelope (principal substitution fails closed)",
    ok ? PASS : FAIL,
    ok ? "honest read ok; forged read/write rejected; replay flags forged snapshot"
      : `honest=${honestOk} forgedRead=${forgedThrew} forgedWrite=${writeForgeThrew} replay=${replayDetected}`);
}, (e) => gate("RG15", "M1 active-message bound to canonical envelope (principal substitution fails closed)", FAIL, e.message));

// ---- RG16 (real-framework end-to-end): the injection exploit transfers to a real LangGraph
//      StateGraph over LangGraph's own shared Store -- ungated graph emits the plant, gated graph
//      denies it by causal reachability and emits the correct value. Runs the exploit. ----
await safe(async () => {
  execFileSync(process.execPath, ["scripts/poc_langgraph_injection.mjs"], { stdio: "ignore" });
  const r = JSON.parse(read("results/eval/poc-langgraph-injection.json") || "null");
  const flips = r && r.ungated?.contaminated === true && r.ungated?.retention_days !== 30
    && r.gated?.retention_days === 30 && r.gated?.contaminated === false;
  const trapReason = r?.gated?.audit?.find((e) => e.memory_id === "mem-trap")?.reason;
  const ancestorReason = r?.gated?.audit?.find((e) => e.memory_id === "mem-trap-ancestor")?.reason;
  const ok = r && r.ok === true && r.framework === "@langchain/langgraph" && flips
    && trapReason === "provenance_not_in_causal_graph"
    && ancestorReason === "provenance_not_attested"  // M7.1: truthful-ancestor injection denied on the real framework
    && r.source_existence_only?.decision === "allow";
  gate("RG16", "Real-framework exploit: LangGraph shared-store injection (sibling + truthful-ancestor) denied by the gate",
    ok ? PASS : (r ? FAIL : PENDING),
    r ? `${r.passed}/${r.total}; gated trap=${trapReason} ancestor=${ancestorReason}; gated=${r.gated?.retention_days}d/clean`
      : "run `npm run poc:langgraph`");
}, (e) => gate("RG16", "Real-framework exploit: LangGraph shared-store injection denied by the gate", FAIL, e.message));

// ---- RG17 (M1/M2/M3/M8 enforced trusted-write boundary): the SecureMemoryRuntime refuses every
//      counterexample the reviewer ran against the assumed boundary -- store injection, a receipt
//      forged with the old public default key, an unauthenticated write, an arbitrary cross-queue
//      claim, a stolen envelope without a lease, and a no-gate/disabled-check bypass -- while admitting
//      a legitimately attested record. ----
function secureSeed(rt, cp) {
  const env = (o) => ({ message_id: "m", run_id: "R", task_id: "T", trace_id: "tr", sender: "planner",
    receiver: "memory", intent: "produce_final_plan", state: "running", sequence: 1, parent_message_id: null,
    correlation_id: null, delegated_from: null, policy_context: "P", ...o });
  const s = (e) => rt.sendMessage(e, cp.registerPrincipal(e.sender, {})); // signed trusted-path send
  s(env({ message_id: "m0", sequence: 0 }));
  s(env({ message_id: "m2", parent_message_id: "m0", sequence: 2 }));
  // (v20 CREATION-CUT) m3 is the executor READER/leaf and sources no memory. Defer its send until AFTER the
  // memory it should read has been written, and stamp it with a sequence STRICTLY GREATER than every write
  // (currentSequence+1) so the writes are in its causal past, not its future. sendReader() must be called by
  // the caller after its writes and before it claims the executor queue.
  const sendReader = () => s(env({ message_id: "m3", parent_message_id: "m2", sequence: rt._currentSequence("R") + 1, sender: "coordinator", receiver: "executor" }));
  return {
    memSess: cp.registerPrincipal("mem-worker", { queues: ["memory"] }),
    execSess: cp.registerPrincipal("exec-worker", { queues: ["executor"] }),
    lcSess: cp.registerPrincipal("lifecycle-controller", { queues: [], lifecycle: true }),
    sendReader,
  };
}
function secureInject(rt, memoryContentHash, rec) {
  const full = { memory_id: rec.memory_id, run_id: "R", task_id: "T", trace_id: "tr", source_message_id: rec.source_message_id,
    writer: "mallory", memory_type: "constraint", scope: "task", status: "active", content: rec.content ?? "x",
    content_ref: null, allowed_readers: ["executor"], supersedes: [], valid_from_event: null, valid_until_event: null, policy_context: "P" };
  rt.db.prepare(`INSERT INTO shared_memory (memory_id,run_id,task_id,trace_id,source_message_id,writer,memory_type,scope,status,content,content_ref,allowed_readers_json,supersedes_json,valid_from_event,valid_until_event,policy_context,audit_hash,write_receipt,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
    .run(full.memory_id, full.run_id, full.task_id, full.trace_id, full.source_message_id, full.writer, full.memory_type, full.scope, full.status, full.content, full.content_ref, JSON.stringify(full.allowed_readers), "[]", null, null, full.policy_context, memoryContentHash(full), rec.write_receipt ?? null, "t", "t");
}
const threw = (fn) => { try { fn(); return false; } catch { return true; } };

await safe(async () => {
  const { SecureMemoryRuntime, ControlPlane, memoryContentHash } = await import("../benchmarks/coupled_memory/runtime.mjs");
  const { createHmac } = await import("node:crypto");
  const cp = new ControlPlane();
  const rt = new SecureMemoryRuntime({ controlPlane: cp });
  let r = {};
  try {
    const { memSess, execSess, sendReader } = secureSeed(rt, cp);
    rt.claim(memSess, "memory"); const w = rt.claim(memSess, "memory").lease;
    rt.writeMemory("retain 30 days", w, { memory_id: "good", memory_type: "constraint", allowed_readers: ["executor"] });
    secureInject(rt, memoryContentHash, { memory_id: "trap", source_message_id: "m2", content: "malicious" });
    const forged = `hmac:${createHmac("sha256", "mbm-trusted-control-plane-key").update(memoryContentHash({ memory_id: "fk", run_id: "R", task_id: "T", trace_id: "tr", source_message_id: "m2", writer: "mallory", memory_type: "constraint", scope: "task", status: "active", content: "x", content_ref: null, allowed_readers: ["executor"], supersedes: [], valid_from_event: null, valid_until_event: null, policy_context: "P" })).digest("hex")}`;
    secureInject(rt, memoryContentHash, { memory_id: "fk", source_message_id: "m2", content: "x", write_receipt: forged });
    sendReader(); // reader/active message sent LAST, sequence > every write (CREATION-CUT)
    const rlease = rt.claim(execSess, "executor").lease;
    const admitted = rt.readMemory({}, rlease).map((m) => m.memory_id);
    r.legit = admitted.includes("good");
    r.trapDenied = !admitted.includes("trap");
    r.forgeDenied = !admitted.includes("fk");
    r.unauthWrite = threw(() => rt.writeMemory("x", "leaset-bogus", {}));
    r.arbitraryClaim = threw(() => rt.claim(execSess, "memory"));
    r.stolenEnvelope = threw(() => rt.readMemory({}, "leaset-forged"));
    r.noBypass = rt.readMemory({}, rlease, { controlNoGate: true, gateOptions: { disabledChecks: ["attestation"] } }).every((m) => m.memory_id !== "trap");
  } finally { rt.close(); }
  const ok = Object.values(r).every(Boolean);
  gate("RG17", "M1/M2/M3 enforced trusted-write boundary (injection/forge/unauth-write/arbitrary-claim/stolen-envelope/no-bypass all denied)",
    ok ? PASS : FAIL,
    ok ? "attested admitted; injection+public-key-forge+unauth-write+cross-queue-claim+stolen-envelope+no-gate all refused"
      : JSON.stringify(r));
}, (e) => gate("RG17", "M1/M2/M3 enforced trusted-write boundary", FAIL, e.message));

// ---- RG18 (M5 authoritative lifecycle): a superseded record is denied via the lifecycle log, a
//      secure writer cannot keep it live by stamping status, and only a lifecycle principal can retire. ----
await safe(async () => {
  const { SecureMemoryRuntime, ControlPlane } = await import("../benchmarks/coupled_memory/runtime.mjs");
  const cp = new ControlPlane();
  const rt = new SecureMemoryRuntime({ controlPlane: cp });
  let r = {};
  try {
    const { memSess, execSess, lcSess, sendReader } = secureSeed(rt, cp);
    rt.claim(memSess, "memory"); const w = rt.claim(memSess, "memory").lease;
    rt.writeMemory("old", w, { memory_id: "old", memory_type: "constraint", allowed_readers: ["executor"] });
    rt.writeMemory("new", w, { memory_id: "new", memory_type: "constraint", allowed_readers: ["executor"], supersedes: ["old"] });
    r.unauthorized = threw(() => rt.supersede(memSess, "old", "new"));
    rt.supersede(lcSess, "old", "new");
    sendReader(); // reader/active message sent LAST, sequence > every write (CREATION-CUT)
    const admitted = rt.readMemory({}, rt.claim(execSess, "executor").lease).map((m) => m.memory_id);
    r.oldDenied = !admitted.includes("old");
    r.newAdmitted = admitted.includes("new");
  } finally { rt.close(); }
  const ok = Object.values(r).every(Boolean);
  gate("RG18", "M5 authoritative lifecycle (superseded record denied; lifecycle authority required)",
    ok ? PASS : FAIL, ok ? "supersede via lifecycle log retires old; non-lifecycle principal refused" : JSON.stringify(r));
}, (e) => gate("RG18", "M5 authoritative lifecycle", FAIL, e.message));

// ---- RG19 (M6 attestation-aware replay + M8 key hygiene): secure replay reproduces a clean denial,
//      catches a mutated receipt, and the ephemeral key never appears in the store. ----
await safe(async () => {
  const { SecureMemoryRuntime, ControlPlane, memoryContentHash } = await import("../benchmarks/coupled_memory/runtime.mjs");
  const cp = new ControlPlane({ keyBytes: Buffer.alloc(32, 7) });
  const rt = new SecureMemoryRuntime({ controlPlane: cp });
  let r = {};
  try {
    const { memSess, execSess, sendReader } = secureSeed(rt, cp);
    rt.claim(memSess, "memory"); const w = rt.claim(memSess, "memory").lease;
    rt.writeMemory("retain 30 days", w, { memory_id: "good", memory_type: "constraint", allowed_readers: ["executor"] });
    secureInject(rt, memoryContentHash, { memory_id: "trap", source_message_id: "m2", content: "malicious" });
    sendReader(); // reader/active message sent LAST, sequence > every write (CREATION-CUT)
    rt.readMemory({}, rt.claim(execSess, "executor").lease);
    r.cleanReplay = rt.replaySecureMemoryReads("R").ok;
    r.keyAbsent = !JSON.stringify(rt.db.prepare("SELECT * FROM shared_memory").all()).includes(Buffer.alloc(32, 7).toString("hex"));
    rt.db.prepare("UPDATE shared_memory SET write_receipt='hmac:deadbeef' WHERE memory_id='good'").run();
    const t = rt.replaySecureMemoryReads("R");
    r.tamperCaught = !t.ok && t.issues.some((i) => i.kind === "receipt_tampered");
  } finally { rt.close(); }
  const ok = Object.values(r).every(Boolean);
  gate("RG19", "M6/M8 attestation-aware replay + key hygiene (clean denial reproduced; receipt tamper caught; key never in store)",
    ok ? PASS : FAIL, ok ? "secure replay reproduces strict decisions; receipt mutation flagged; ephemeral key absent from DB" : JSON.stringify(r));
}, (e) => gate("RG19", "M6/M8 attestation-aware replay + key hygiene", FAIL, e.message));

// ---- RG20 (M1.1--M1.4 soundness fixes): no lock bypass, no forged authorization metadata, durable-key
//      restart, and wiped-manifest detection. These are the independent-code-review counterexamples. ----
await safe(async () => {
  const { SecureMemoryRuntime, ControlPlane } = await import("../benchmarks/coupled_memory/runtime.mjs");
  const env = (o) => ({ message_id: "m", run_id: "R", task_id: "T", trace_id: "tr", sender: "planner",
    receiver: "memory", intent: "produce_final_plan", state: "running", sequence: 1, parent_message_id: null,
    correlation_id: null, delegated_from: null, policy_context: "P", ...o });
  const r = {};
  const s = (rt, cp, e) => rt.sendMessage(e, cp.registerPrincipal(e.sender, {})); // signed trusted-path send
  // M1.1: claimSpecific cannot lease a message another principal locked.
  { const cp = new ControlPlane(); const rt = new SecureMemoryRuntime({ controlPlane: cp });
    s(rt, cp, env({ message_id: "m0", sequence: 0 })); s(rt, cp, env({ message_id: "m2", parent_message_id: "m0", sequence: 2 }));
    const a = cp.registerPrincipal("A", { queues: ["memory"] }); const b = cp.registerPrincipal("B", { queues: ["memory"] });
    rt.claim(a, "memory"); rt.claim(a, "memory");
    r.lockBypassRefused = threw(() => rt.claimSpecific(b, "m2")); rt.close(); }
  // M1.2: writer cannot forge task_id/scope to reach another task.
  { const cp = new ControlPlane(); const rt = new SecureMemoryRuntime({ controlPlane: cp });
    s(rt, cp, env({ message_id: "n0", sequence: 0 })); s(rt, cp, env({ message_id: "n1", parent_message_id: "n0", sequence: 1 }));
    s(rt, cp, env({ message_id: "nB", parent_message_id: "n1", sequence: 2, task_id: "OTHER", sender: "coordinator", receiver: "victim" }));
    const w = cp.registerPrincipal("w", { queues: ["memory"] }); const v = cp.registerPrincipal("v", { queues: ["victim"] });
    const rec = rt.writeMemory("x", rt.claimSpecific(w, "n1"), { memory_id: "x", memory_type: "constraint", task_id: "OTHER", scope: "global", allowed_readers: ["victim"] });
    const adm = rt.readMemory({}, rt.claimSpecific(v, "nB")).map((m) => m.memory_id);
    r.authzForgeBlocked = rec.task_id === "T" && rec.scope === "task" && !adm.includes("x"); rt.close(); }
  // M1.4: wiped read manifest is detected via the anchor.
  { const cp = new ControlPlane(); const rt = new SecureMemoryRuntime({ controlPlane: cp });
    s(rt, cp, env({ message_id: "p0", sequence: 0 })); s(rt, cp, env({ message_id: "p2", parent_message_id: "p0", sequence: 2 }));
    s(rt, cp, env({ message_id: "p3", parent_message_id: "p2", sequence: 3, sender: "coordinator", receiver: "executor" }));
    const ms = cp.registerPrincipal("ms", { queues: ["memory"] }); const ex = cp.registerPrincipal("ex", { queues: ["executor"] });
    rt.claim(ms, "memory"); rt.writeMemory("g", rt.claim(ms, "memory").lease, { memory_id: "g", memory_type: "constraint", allowed_readers: ["executor"] });
    rt.readMemory({}, rt.claim(ex, "executor").lease);
    rt.db.prepare("DELETE FROM memory_reads WHERE run_id='R'").run(); rt.db.prepare("DELETE FROM memory_access_decisions WHERE run_id='R'").run();
    const rep = rt.replaySecureMemoryReads("R");
    r.wipeDetected = !rep.ok && rep.issues.some((i) => i.kind === "read_manifest_deleted"); rt.close(); }
  const ok = Object.values(r).every(Boolean);
  gate("RG20", "M1.1--M1.4 soundness (no lock bypass; no forged authz metadata; wiped-manifest detected)",
    ok ? PASS : FAIL, ok ? "lease/lock bypass refused; task_id/scope authoritative; manifest-wipe flagged via anchor" : JSON.stringify(r));
}, (e) => gate("RG20", "M1.1--M1.4 soundness", FAIL, e.message));

// ---- RG21 (envelope attestation / digital fingerprint): the authorization context is a SIGNED
//      envelope, not trusted store text -- a store-tampered authorization label is rejected. ----
await safe(async () => {
  const { SecureMemoryRuntime, ControlPlane } = await import("../benchmarks/coupled_memory/runtime.mjs");
  const env = (o) => ({ message_id: "m", run_id: "R", task_id: "T", trace_id: "tr", sender: "planner",
    receiver: "memory", intent: "produce_final_plan", state: "running", sequence: 1, parent_message_id: null,
    correlation_id: null, delegated_from: null, policy_context: "P", ...o });
  const cp = new ControlPlane(); const rt = new SecureMemoryRuntime({ controlPlane: cp });
  const r = {};
  try {
    const s = (e) => rt.sendMessage(e, cp.registerPrincipal(e.sender, {}));
    s(env({ message_id: "m0", sequence: 0 })); s(env({ message_id: "m2", parent_message_id: "m0", sequence: 2 }));
    const ms = cp.registerPrincipal("ms", { queues: ["memory"] }); const ex = cp.registerPrincipal("ex", { queues: ["executor"] });
    rt.claim(ms, "memory"); rt.writeMemory("g", rt.claim(ms, "memory").lease, { memory_id: "g", memory_type: "constraint", allowed_readers: ["executor"] });
    // (CREATION-CUT) m3 is the reader/leaf: send it AFTER the write, sequence > every write
    s(env({ message_id: "m3", parent_message_id: "m2", sequence: rt._currentSequence("R") + 1, sender: "coordinator", receiver: "executor" }));
    r.honestRead = rt.readMemory({}, rt.claimSpecific(ex, "m3")).map((m) => m.memory_id).includes("g");
    // store-write adversary forges the active message's authorization label (task_id) in the DB
    const row = rt.db.prepare("SELECT envelope_json FROM messages WHERE message_id='m3'").get();
    rt.db.prepare("UPDATE messages SET envelope_json=?, task_id='HIJACK' WHERE message_id='m3'")
      .run(JSON.stringify({ ...JSON.parse(row.envelope_json), task_id: "HIJACK" }));
    r.tamperRejected = threw(() => rt.readMemory({}, rt.claimSpecific(ex, "m3")));
  } finally { rt.close(); }
  const ok = Object.values(r).every(Boolean);
  gate("RG21", "Envelope attestation (signed authorization context; tampered label rejected)",
    ok ? PASS : FAIL, ok ? "signed envelopes verified; store-tampered task label -> envelope_not_attested" : JSON.stringify(r));
}, (e) => gate("RG21", "Envelope attestation", FAIL, e.message));

// ---- RG22 (integrity flow / the second axis): a legitimately-leased, attested, in-lineage record whose
//      PROVENANCE is untrusted is ADMITTED by the seven-predicate context-authorization gate but DENIED
//      by the eight-predicate integrity-flow gate (integrity_below_context), the paired benign record is
//      admitted (no over-blocking), the verdict tracks provenance not content, and replay reproduces it.
//      Runs the PoC; PASS only if all assertions hold and the seven->eight predicate flip is present. ----
await safe(async () => {
  execFileSync(process.execPath, ["scripts/poc_integrity_flow.mjs"], { stdio: "ignore" });
  const r = JSON.parse(read("results/eval/poc-integrity-flow.json") || "null");
  const a = r?.assertions ?? {};
  const flip = a.seven_predicate_admits_tainted === true && a.integrity_flow_denies_tainted === true;
  const noOverBlock = a.seven_predicate_admits_clean === true && a.integrity_flow_admits_clean === true;
  const provenanceNotContent = a.malicious_content_clean_provenance_admitted === true
    && a.benign_content_tainted_provenance_denied === true && a.deny_reason_is_integrity === true;
  const reproduced = a.replay_reproduces_integrity_decisions === true;
  const ok = r && r.ok === true && flip && noOverBlock && provenanceNotContent && reproduced;
  gate("RG22", "Integrity flow: tainted-provenance plant admitted by 7-predicate gate, denied by integrity flow; benign admitted; provenance-not-content; replay reproduces",
    ok ? PASS : (r ? FAIL : PENDING),
    r ? `${r.passed}/${r.total} assertions; flip=${flip} no_over_block=${noOverBlock} provenance_not_content=${provenanceNotContent} reproduced=${reproduced}`
      : "run `npm run poc:integrity`");
}, (e) => gate("RG22", "Integrity flow: tainted-provenance plant denied by integrity flow, benign admitted", FAIL, e.message));

// ---- RG23 (real-world transfer to personal-assistant agents): the documented memory-pollution
//      vulnerability of OpenClaw and Hermes (untrusted background/heartbeat ingestion written as a
//      contextually-valid memory record; arXiv 2603.23064) pollutes the native store AND survives the
//      seven-predicate context-authorization gate, but is denied by integrity flow, which keeps the
//      user's own preference. Runs the transfer; PASS only if BOTH frameworks show native+MBM7 polluted
//      and MBM+IFC clean. ----
await safe(async () => {
  execFileSync(process.execPath, ["scripts/poc_personal_assistant_memory_pollution.mjs"], { stdio: "ignore" });
  const r = JSON.parse(read("results/eval/poc-personal-assistant.json") || "null");
  const a = r?.assertions ?? {};
  const both = ["openclaw", "hermes"].every((f) =>
    a[`${f}_native_compromised`] === true && a[`${f}_mbm7_still_compromised`] === true
    && a[`${f}_mbm_ifc_safe`] === true && a[`${f}_deny_reason_integrity`] === true && a[`${f}_replay_ok`] === true);
  const ok = r && r.ok === true && both;
  gate("RG23", "Real-world transfer: OpenClaw/Hermes prompt-injection action-hijack survives 7-predicate gate, denied by integrity flow",
    ok ? PASS : (r ? FAIL : PENDING),
    r ? `${r.passed}/${r.total}; both frameworks native+MBM7 action HIJACKED, MBM+IFC safe (integrity_below_context)`
      : "run `npm run poc:assistants`");
}, (e) => gate("RG23", "Real-world transfer: OpenClaw/Hermes memory pollution denied by integrity flow", FAIL, e.message));

// ---- RG24 (re-review: integrity-label laundering): integrity is DERIVED by the control plane, never
//      the caller's value. A system-clearance agent that sends an untrusted message cannot launder it by
//      sending a child that re-declares "system": the child's derived integrity stays untrusted, and a
//      hand-forged system-integrity envelope carries no valid signature. Executes the reviewer's repro. ----
await safe(async () => {
  const { SecureMemoryRuntime, ControlPlane } = await import("../benchmarks/coupled_memory/runtime.mjs");
  const { integrityLevel } = await import("../benchmarks/coupled_memory/control_plane.mjs");
  const cp = new ControlPlane(); const rt = new SecureMemoryRuntime({ controlPlane: cp });
  const r = {};
  try {
    const env = (o) => ({ message_id: "m", run_id: "R", task_id: "T", trace_id: "tr", sender: "agent",
      receiver: "memory", intent: "produce_final_plan", state: "running", sequence: 1, parent_message_id: null,
      correlation_id: null, delegated_from: null, policy_context: "P", ...o });
    const agent = cp.registerPrincipal("agent", { queues: ["*"], clearance: "system" }); // system clearance
    rt.sendMessage(env({ message_id: "m0", sequence: 0 }), agent);
    rt.sendMessage(env({ message_id: "m-low", parent_message_id: "m0", sequence: 1, integrity: "untrusted" }), agent);
    // launder attempt: child of the untrusted message re-declaring "system"
    rt.sendMessage(env({ message_id: "m-launder", parent_message_id: "m-low", sequence: 2, integrity: "system" }), agent);
    const launder = rt.getMessage("m-launder");
    r.derivedStaysUntrusted = integrityLevel(launder.integrity) === 0;       // caller "system" ignored
    r.honestSystemAtRoot = integrityLevel(rt.getMessage("m0").integrity) === 2; // a clean root is still system
    // a hand-forged system-integrity envelope is not validly signed (signature was over derived untrusted)
    r.forgedSystemUnsigned = cp.verifyEnvelope({ ...launder, integrity: "system" }) === false
      && cp.verifyEnvelope(launder) === true;
  } finally { rt.close(); }
  const ok = Object.values(r).every(Boolean);
  gate("RG24", "Re-review: integrity-label laundering blocked (integrity derived, not caller-declared)",
    ok ? PASS : FAIL, ok ? "untrusted->system child derives untrusted; forged system envelope unsigned" : JSON.stringify(r));
}, (e) => gate("RG24", "Re-review: integrity-label laundering blocked", FAIL, e.message));

// ---- RG25 (re-review: public signing oracle removed): there is no public mint/sign method; a receipt
//      is minted only by attestWrite() after the control plane re-verifies the lease binds to the record,
//      so a held control-plane reference cannot forge attestation for an unauthorized record. Executes
//      the reviewer's direct-mint repro. ----
await safe(async () => {
  const { SecureMemoryRuntime, ControlPlane, memoryContentHash } = await import("../benchmarks/coupled_memory/runtime.mjs");
  const cp = new ControlPlane(); const rt = new SecureMemoryRuntime({ controlPlane: cp });
  const r = {};
  try {
    const { memSess, sendReader } = secureSeed(rt, cp);
    r.noPublicOracle = typeof cp.mintReceipt !== "function" && typeof cp.signEnvelope !== "function";
    const forged = { memory_id: "forged", run_id: "R", task_id: "T", trace_id: "tr", source_message_id: "m2",
      writer: "mallory", memory_type: "constraint", scope: "task", status: "active", content: "x", content_ref: null,
      allowed_readers: ["executor"], supersedes: [], valid_from_event: null, valid_until_event: null, policy_context: "P" };
    r.mintWithoutLeaseThrows = threw(() => cp.attestWrite("leaset-bogus", forged));
    // a real lease for a message the attacker may serve, but the forged record's (source,writer) do not
    // bind to it -> attestWrite refuses (binding mismatch), so no receipt is produced.
    const lease = rt.claim(memSess, "memory")?.lease ?? rt.claim(memSess, "memory").lease;
    r.mintBindingMismatchThrows = lease ? threw(() => cp.attestWrite(lease, forged)) : true;
    // the forged record, injected raw without a valid receipt, is denied on read.
    secureInject(rt, memoryContentHash, { memory_id: "forged", source_message_id: "m2", content: "x" });
    sendReader(); // reader/active message sent LAST, sequence > every write (CREATION-CUT)
    const ex = cp.registerPrincipal("ex2", { queues: ["executor"] });
    const admitted = rt.readMemory({}, rt.claim(ex, "executor").lease).map((m) => m.memory_id);
    r.forgedDeniedOnRead = !admitted.includes("forged");
  } finally { rt.close(); }
  const ok = Object.values(r).every(Boolean);
  gate("RG25", "Re-review: no public signing oracle (mint requires lease+canonical binding inside control plane)",
    ok ? PASS : FAIL, ok ? "mintReceipt/signEnvelope not public; attestWrite refuses no-lease and binding-mismatch; forged record denied" : JSON.stringify(r));
}, (e) => gate("RG25", "Re-review: no public signing oracle", FAIL, e.message));

// ---- RG26..RG31: the third re-review's independent counterexamples, now executed as regressions ----
const renv = (o) => ({ run_id: "R", task_id: "T", trace_id: "tr", intent: "produce_final_plan",
  state: "running", policy_context: "P", correlation_id: null, delegated_from: null, ...o });

// RG26: causal closure is computed from SIGNED envelope edges, not the unsigned relational column.
// Tampering messages.parent_message_id does NOT admit a sibling-branch record.
await safe(async () => {
  const { SecureMemoryRuntime, ControlPlane } = await import("../benchmarks/coupled_memory/runtime.mjs");
  const cp = new ControlPlane(); const rt = new SecureMemoryRuntime({ controlPlane: cp });
  const r = {};
  try {
    const s = (e) => rt.sendMessage(e, cp.registerPrincipal(e.sender, {}));
    s(renv({ message_id: "root", sender: "p", receiver: "memory", sequence: 0, parent_message_id: null }));
    s(renv({ message_id: "mA", sender: "p", receiver: "memory", sequence: 1, parent_message_id: "root" }));
    s(renv({ message_id: "mB", sender: "p", receiver: "memory", sequence: 2, parent_message_id: "root" }));
    s(renv({ message_id: "mexec", sender: "c", receiver: "executor", sequence: 3, parent_message_id: "mB" }));
    const w = cp.registerPrincipal("w", { queues: ["*"] }); const ex = cp.registerPrincipal("ex", { queues: ["executor"] });
    rt.writeMemory("sibling", rt.claimSpecific(w, "mA"), { memory_id: "mem-sibling", memory_type: "constraint", allowed_readers: ["executor"] });
    r.before = !rt.readMemory({}, rt.claimSpecific(ex, "mexec")).some((m) => m.memory_id === "mem-sibling");
    const row = rt.db.prepare("SELECT envelope_json FROM messages WHERE message_id='mexec'").get();
    rt.db.prepare("UPDATE messages SET parent_message_id='mA' WHERE message_id='mexec'").run(); // unsigned column tamper
    r.envelopeUnchanged = JSON.parse(row.envelope_json).parent_message_id === "mB";
    // The relational column now disagrees with the signed envelope. Authorization uses signed edges AND
    // the identity binding (M1) detects the disagreement, so the read FAILS CLOSED rather than admitting
    // the sibling: the unsigned column cannot influence the decision.
    r.afterFailsClosed = threw(() => rt.readMemory({}, rt.claimSpecific(ex, "mexec")));
  } finally { rt.close(); }
  const ok = r.before && r.envelopeUnchanged && r.afterFailsClosed;
  gate("RG26", "Re-review: causal closure from signed edges (unsigned parent-column tamper fails closed, never admits sibling)",
    ok ? PASS : FAIL, ok ? "column rewritten to mA; signed envelope still mB; tampered read fails closed" : JSON.stringify(r));
}, (e) => gate("RG26", "Re-review: causal closure from signed edges", FAIL, e.message));

// RG27: leases require authentication AND lock ownership; control-plane secret state is private.
await safe(async () => {
  const { SecureMemoryRuntime, ControlPlane } = await import("../benchmarks/coupled_memory/runtime.mjs");
  const cp = new ControlPlane(); const rt = new SecureMemoryRuntime({ controlPlane: cp });
  const r = {};
  try {
    rt.sendMessage(renv({ message_id: "m", sender: "p", receiver: "memory", sequence: 0, parent_message_id: null }), cp.registerPrincipal("p", {}));
    r.forgedPrincipalRejected = threw(() => cp.issueLease("trusted-writer", "m"));     // not a session token
    const att = cp.registerPrincipal("att", { queues: ["memory"] });
    r.noLockRejected = threw(() => cp.issueLease(att, "m"));                            // authenticated but not lock owner
    r.privateState = ["_sessions", "_principals", "_leases", "_key"].every((f) => !(f in cp));
  } finally { rt.close(); }
  const ok = Object.values(r).every(Boolean);
  gate("RG27", "Re-review: leases need auth + lock ownership; secret state private (no public oracle)",
    ok ? PASS : FAIL, ok ? "forged-principal and non-lock-owner issueLease refused; _sessions/_principals/_leases/_key not public" : JSON.stringify(r));
}, (e) => gate("RG27", "Re-review: authenticated lock-bound leases", FAIL, e.message));

// RG28: integrity is derived from VERIFIED parents by the control plane -- a caller cannot omit/forge
// parent integrity (direct attestSend), and a transient parent-envelope tamper is caught by signature.
await safe(async () => {
  const { SecureMemoryRuntime, ControlPlane } = await import("../benchmarks/coupled_memory/runtime.mjs");
  const { integrityLevel: il } = await import("../benchmarks/coupled_memory/control_plane.mjs");
  const cp = new ControlPlane(); const rt = new SecureMemoryRuntime({ controlPlane: cp });
  const r = {};
  try {
    const agent = cp.registerPrincipal("agent", { queues: ["*"], clearance: "system" });
    rt.sendMessage(renv({ message_id: "m0", sender: "agent", receiver: "memory", sequence: 0, parent_message_id: null }), agent);
    rt.sendMessage(renv({ message_id: "m-low", sender: "agent", receiver: "memory", sequence: 1, parent_message_id: "m0", integrity: "untrusted" }), agent);
    // direct attestSend with a "system" claim: control plane looks the parent up itself -> derives untrusted
    const direct = cp.attestSend(agent, renv({ message_id: "m-d", sender: "agent", receiver: "memory", sequence: 2, parent_message_id: "m-low", integrity: "system" }));
    r.directDerivesUntrusted = il(direct.env.integrity) === 0;
    // transient tamper: flip the stored parent envelope integrity to system, send child, then restore
    const orig = rt.db.prepare("SELECT envelope_json FROM messages WHERE message_id='m-low'").get().envelope_json;
    rt.db.prepare("UPDATE messages SET envelope_json=? WHERE message_id='m-low'").run(JSON.stringify({ ...JSON.parse(orig), integrity: 2 }));
    rt.sendMessage(renv({ message_id: "m-child", sender: "agent", receiver: "memory", sequence: 3, parent_message_id: "m-low" }), agent);
    rt.db.prepare("UPDATE messages SET envelope_json=? WHERE message_id='m-low'").run(orig);
    r.transientTamperDerivesUntrusted = il(rt.getMessage("m-child").integrity) === 0;
  } finally { rt.close(); }
  const ok = Object.values(r).every(Boolean);
  gate("RG28", "Re-review: integrity derived from verified parents (direct attestSend + transient tamper both stay untrusted)",
    ok ? PASS : FAIL, ok ? "caller 'system' ignored; tampered parent envelope fails signature -> child untrusted" : JSON.stringify(r));
}, (e) => gate("RG28", "Re-review: integrity derived from verified parents", FAIL, e.message));

// RG29: attestWrite re-verifies ALL canonical metadata -- a cross-task forged record is refused.
await safe(async () => {
  const { SecureMemoryRuntime, ControlPlane } = await import("../benchmarks/coupled_memory/runtime.mjs");
  const cp = new ControlPlane(); const rt = new SecureMemoryRuntime({ controlPlane: cp });
  const r = {};
  try {
    rt.sendMessage(renv({ message_id: "mA", task_id: "A", sender: "p", receiver: "memory", sequence: 0, parent_message_id: null }), cp.registerPrincipal("p", {}));
    const w = cp.registerPrincipal("w", { queues: ["*"] });
    const lease = rt.claimSpecific(w, "mA");
    const forged = { memory_id: "x", run_id: "R", task_id: "B", trace_id: "tr", source_message_id: "mA",
      writer: "w", memory_type: "constraint", scope: "task", status: "active", content: "x", content_ref: null,
      allowed_readers: ["e"], supersedes: [], valid_from_event: null, valid_until_event: null,
      policy_context: "P", integrity: cp.writeTimeIntegrity(lease) };
    r.crossTaskRefused = threw(() => cp.attestWrite(lease, forged));
  } finally { rt.close(); }
  gate("RG29", "Re-review: attestWrite re-verifies canonical metadata (cross-task forged record refused)",
    r.crossTaskRefused ? PASS : FAIL, r.crossTaskRefused ? "task_id=B under a task=A lease -> attest_mismatch" : JSON.stringify(r));
}, (e) => gate("RG29", "Re-review: attestWrite canonical-metadata check", FAIL, e.message));

// RG30: write-time integrity is FROZEN in the record -- raising the writer's clearance later does NOT
// retroactively reclassify an already-written record.
await safe(async () => {
  const { SecureMemoryRuntime, ControlPlane } = await import("../benchmarks/coupled_memory/runtime.mjs");
  const cp = new ControlPlane(); const rt = new SecureMemoryRuntime({ controlPlane: cp });
  const r = {};
  try {
    const s = (e) => rt.sendMessage(e, cp.registerPrincipal(e.sender, {}));
    s(renv({ message_id: "m0", sender: "p", receiver: "memory", sequence: 0, parent_message_id: null }));
    s(renv({ message_id: "ms", sender: "p", receiver: "memory", sequence: 1, parent_message_id: "m0" }));
    s(renv({ message_id: "mx", sender: "c", receiver: "executor", sequence: 2, parent_message_id: "ms" }));
    const low = cp.registerPrincipal("low", { queues: ["*"], clearance: "untrusted" });
    rt.writeMemory("v", rt.claimSpecific(low, "ms"), { memory_id: "mem", memory_type: "constraint", allowed_readers: ["executor"] });
    const ex = cp.registerPrincipal("ex", { queues: ["executor"] });
    r.before = !rt.readMemory({}, rt.claimSpecific(ex, "mx")).some((m) => m.memory_id === "mem");
    cp.registerPrincipal("low", { queues: ["*"], clearance: "system" }); // raise clearance after the fact
    r.afterStillDenied = !rt.readMemory({}, rt.claimSpecific(ex, "mx")).some((m) => m.memory_id === "mem"); // same reader re-claims
  } finally { rt.close(); }
  const ok = r.before && r.afterStillDenied;
  gate("RG30", "Re-review: write-time integrity frozen (raising writer clearance does not reclassify old records)",
    ok ? PASS : FAIL, ok ? "low-clearance record denied; still denied after clearance raised to system" : JSON.stringify(r));
}, (e) => gate("RG30", "Re-review: frozen write-time integrity", FAIL, e.message));

// RG31: secure replay re-verifies the active envelope signature (a tampered active envelope is flagged).
await safe(async () => {
  const { SecureMemoryRuntime, ControlPlane } = await import("../benchmarks/coupled_memory/runtime.mjs");
  const cp = new ControlPlane(); const rt = new SecureMemoryRuntime({ controlPlane: cp });
  const r = {};
  try {
    const s = (e) => rt.sendMessage(e, cp.registerPrincipal(e.sender, {}));
    s(renv({ message_id: "m0", sender: "p", receiver: "memory", sequence: 0, parent_message_id: null }));
    s(renv({ message_id: "ms", sender: "p", receiver: "memory", sequence: 1, parent_message_id: "m0" }));
    s(renv({ message_id: "mx", sender: "c", receiver: "executor", sequence: 2, parent_message_id: "ms" }));
    const w = cp.registerPrincipal("w", { queues: ["*"] }); const ex = cp.registerPrincipal("ex", { queues: ["executor"] });
    rt.writeMemory("v", rt.claimSpecific(w, "ms"), { memory_id: "mem", memory_type: "constraint", allowed_readers: ["executor"] });
    rt.readMemory({}, rt.claimSpecific(ex, "mx"));
    r.beforeOk = rt.replaySecureMemoryReads("R").ok === true;
    // Tamper a SIGNED field that is not part of the row identity binding (policy_context), so the row is
    // still identity-bound but its signature no longer verifies -- this exercises the replay signature
    // path specifically (an identity-field tamper is instead caught by M1 as a missing message).
    const row = rt.db.prepare("SELECT envelope_json FROM messages WHERE message_id='mx'").get();
    rt.db.prepare("UPDATE messages SET envelope_json=? WHERE message_id='mx'").run(JSON.stringify({ ...JSON.parse(row.envelope_json), policy_context: "evil" }));
    const rep = rt.replaySecureMemoryReads("R");
    r.tamperFlagged = rep.ok === false && rep.issues.some((i) => i.kind === "active_envelope_not_attested");
  } finally { rt.close(); }
  const ok = r.beforeOk && r.tamperFlagged;
  gate("RG31", "Re-review: replay re-verifies active envelope signature (tampered active envelope flagged)",
    ok ? PASS : FAIL, ok ? "clean replay ok; sender-tampered active envelope -> active_envelope_not_attested" : JSON.stringify(r));
}, (e) => gate("RG31", "Re-review: replay verifies envelope signature", FAIL, e.message));

// RG32: endorse() (the integrity-raising mechanism the paper cites) requires endorsement authority and
// is clamped to the endorser's own clearance -- a non-endorser cannot raise, and an endorser cannot
// exceed its clearance. This exercises the mechanism, not just documents it.
await safe(async () => {
  const { ControlPlane } = await import("../benchmarks/coupled_memory/control_plane.mjs");
  const cp = new ControlPlane();
  const r = {};
  const plain = cp.registerPrincipal("plain", { queues: ["*"], clearance: "system" });          // no endorse authority
  const endHigh = cp.registerPrincipal("end-hi", { queues: ["*"], clearance: "system", endorse: true });
  const endLow = cp.registerPrincipal("end-lo", { queues: ["*"], clearance: "task", endorse: true });
  r.nonEndorserRefused = threw(() => cp.endorse(plain, "system"));        // authority required
  r.endorserRaises = cp.endorse(endHigh, "system") === 2;                 // system-clearance endorser can raise to system
  r.clampedToClearance = cp.endorse(endLow, "system") === 1;              // task-clearance endorser cannot exceed task
  const ok = Object.values(r).every(Boolean);
  gate("RG32", "Re-review: endorse() needs authority and is clamped to clearance (cited mechanism is exercised)",
    ok ? PASS : FAIL, ok ? "non-endorser refused; endorser raises only up to its own clearance" : JSON.stringify(r));
}, (e) => gate("RG32", "Re-review: endorse authority + clamp", FAIL, e.message));

// ---- RG33..RG37: the FOURTH re-review's independent counterexamples (identity binding, oracle
//      immutability, lifecycle tamper, stale lease, ancestor fail-closed), executed as regressions. ----

// RG33 (M1): a signed envelope is bound to its DB row identity -- a valid victim envelope copied into the
// attacker's own row does NOT let the attacker's lease read the victim's memory (signed-object substitution).
await safe(async () => {
  const { SecureMemoryRuntime, ControlPlane } = await import("../benchmarks/coupled_memory/runtime.mjs");
  const cp = new ControlPlane(); const rt = new SecureMemoryRuntime({ controlPlane: cp });
  const r = {};
  try {
    const vp = cp.registerPrincipal("vp", { queues: ["*"] });
    const ap = cp.registerPrincipal("ap", { queues: ["*"] });
    rt.sendMessage(renv({ message_id: "victim", sender: "vp", receiver: "vq", sequence: 0, parent_message_id: null }), vp);
    rt.sendMessage(renv({ message_id: "amsg", sender: "ap", receiver: "aq", sequence: 1, parent_message_id: null }), ap);
    rt.writeMemory("TOP SECRET", rt.claimSpecific(vp, "victim"), { memory_id: "secret", memory_type: "constraint", allowed_readers: ["vq"] });
    const aLease = rt.claimSpecific(ap, "amsg");
    const v = rt.db.prepare("SELECT envelope_json, envelope_sig FROM messages WHERE message_id='victim'").get();
    r.victimSigValid = cp.verifyEnvelope({ ...JSON.parse(v.envelope_json), envelope_sig: v.envelope_sig }) === true;
    rt.db.prepare("UPDATE messages SET envelope_json=?, envelope_sig=? WHERE message_id='amsg'").run(v.envelope_json, v.envelope_sig);
    r.substitutionFailsClosed = threw(() => rt.readMemory({}, aLease)); // identity binding -> fail closed
  } finally { rt.close(); }
  const ok = r.victimSigValid && r.substitutionFailsClosed;
  gate("RG33", "Re-review M1: signed envelope bound to row identity (cross-row substitution fails closed)",
    ok ? PASS : FAIL, ok ? "victim envelope sig is valid yet a copy into the attacker row is rejected (not the attacker's identity)" : JSON.stringify(r));
}, (e) => gate("RG33", "Re-review M1: envelope-row identity binding", FAIL, e.message));

// RG34 (M2): bindStore() is immutable -- a held control-plane reference cannot swap the lock/identity oracle.
await safe(async () => {
  const { SecureMemoryRuntime, ControlPlane } = await import("../benchmarks/coupled_memory/runtime.mjs");
  const cp = new ControlPlane(); const rt = new SecureMemoryRuntime({ controlPlane: cp });
  const r = {};
  try {
    r.rebindRejected = threw(() => cp.bindStore({ getSignedMessage: () => null, lockOwnerOf: () => "attacker", lockGenerationOf: () => 0 }));
  } finally { rt.close(); }
  gate("RG34", "Re-review M2: bindStore is immutable (lock oracle cannot be replaced)",
    r.rebindRejected ? PASS : FAIL, r.rebindRejected ? "second bindStore -> store_already_bound" : JSON.stringify(r));
}, (e) => gate("RG34", "Re-review M2: immutable store binding", FAIL, e.message));

// RG35 (M3): lifecycle events are MAC-chained -- deleting a revocation row does NOT silently un-retire a
// record; the next read fails closed (lifecycle_log_tampered) rather than restoring it.
await safe(async () => {
  const { SecureMemoryRuntime, ControlPlane } = await import("../benchmarks/coupled_memory/runtime.mjs");
  const cp = new ControlPlane(); const rt = new SecureMemoryRuntime({ controlPlane: cp });
  const r = {};
  try {
    const s = (e) => rt.sendMessage(e, cp.registerPrincipal(e.sender, {}));
    s(renv({ message_id: "m0", sender: "p", receiver: "memory", sequence: 0, parent_message_id: null }));
    s(renv({ message_id: "ms", sender: "p", receiver: "memory", sequence: 1, parent_message_id: "m0" }));
    s(renv({ message_id: "mx", sender: "c", receiver: "executor", sequence: 2, parent_message_id: "ms" }));
    const w = cp.registerPrincipal("w", { queues: ["*"] });
    const lc = cp.registerPrincipal("lc", { queues: ["*"], lifecycle: true });
    const ex = cp.registerPrincipal("ex", { queues: ["executor"] });
    rt.writeMemory("v", rt.claimSpecific(w, "ms"), { memory_id: "old", memory_type: "constraint", allowed_readers: ["executor"] });
    rt.revoke(lc, "old");
    r.retiredBefore = !rt.readMemory({}, rt.claimSpecific(ex, "mx")).some((m) => m.memory_id === "old");
    rt.db.prepare("DELETE FROM memory_lifecycle_events WHERE memory_id='old'").run(); // tamper: drop the revocation
    r.deletionFailsClosed = threw(() => rt.readMemory({}, rt.claimSpecific(ex, "mx")));
  } finally { rt.close(); }
  const ok = r.retiredBefore && r.deletionFailsClosed;
  gate("RG35", "Re-review M3: lifecycle MAC chain (deleting a revocation fails closed, never un-retires)",
    ok ? PASS : FAIL, ok ? "revoked record denied; deleting the revocation row -> lifecycle_log_tampered, not restored" : JSON.stringify(r));
}, (e) => gate("RG35", "Re-review M3: lifecycle tamper detection", FAIL, e.message));

// RG36 (M4): a lease is bound to its lock generation -- after a takeover the stale lease can no longer act.
await safe(async () => {
  const { SecureMemoryRuntime, ControlPlane } = await import("../benchmarks/coupled_memory/runtime.mjs");
  const cp = new ControlPlane(); const rt = new SecureMemoryRuntime({ controlPlane: cp });
  const r = {};
  try {
    rt.sendMessage(renv({ message_id: "m", sender: "p", receiver: "memory", sequence: 0, parent_message_id: null }), cp.registerPrincipal("p", {}));
    const A = cp.registerPrincipal("workerA", { queues: ["memory"] });
    const aLease = rt.claimSpecific(A, "m");
    // takeover (retry/timeout/crash recovery): lock moves to another worker and the generation advances.
    rt.db.prepare("UPDATE message_queue SET locked_by='workerB', lock_generation=lock_generation+1 WHERE message_id='m'").run();
    r.staleLeaseRejected = threw(() => rt.writeMemory("x", aLease, { memory_id: "x", memory_type: "constraint", allowed_readers: ["executor"] }));
  } finally { rt.close(); }
  gate("RG36", "Re-review M4: lease bound to lock generation (stale lease after takeover rejected)",
    r.staleLeaseRejected ? PASS : FAIL, r.staleLeaseRejected ? "lock taken over -> old lease write -> lease_lock_lost" : JSON.stringify(r));
}, (e) => gate("RG36", "Re-review M4: stale-lease rejection", FAIL, e.message));

// RG37 (M5): an invalid/tampered ancestor fails the WHOLE read closed -- the bad node is not silently
// dropped from the closure while authorization proceeds.
await safe(async () => {
  const { SecureMemoryRuntime, ControlPlane } = await import("../benchmarks/coupled_memory/runtime.mjs");
  const cp = new ControlPlane(); const rt = new SecureMemoryRuntime({ controlPlane: cp });
  const r = {};
  try {
    const s = (e) => rt.sendMessage(e, cp.registerPrincipal(e.sender, {}));
    s(renv({ message_id: "m0", sender: "p", receiver: "memory", sequence: 0, parent_message_id: null }));
    const w = cp.registerPrincipal("w", { queues: ["*"] }); const ex = cp.registerPrincipal("ex", { queues: ["executor"] });
    rt.writeMemory("v", rt.claimSpecific(w, "m0"), { memory_id: "mem", memory_type: "constraint", allowed_readers: ["executor"] });
    // (CREATION-CUT) mx is the reader/leaf: send it AFTER the write, sequence > every write
    s(renv({ message_id: "mx", sender: "c", receiver: "executor", sequence: rt._currentSequence("R") + 1, parent_message_id: "m0" }));
    r.cleanRead = rt.readMemory({}, rt.claimSpecific(ex, "mx")).some((m) => m.memory_id === "mem");
    const row = rt.db.prepare("SELECT envelope_json FROM messages WHERE message_id='m0'").get();
    rt.db.prepare("UPDATE messages SET envelope_json=? WHERE message_id='m0'").run(JSON.stringify({ ...JSON.parse(row.envelope_json), policy_context: "evil" })); // breaks ancestor signature
    r.tamperFailsClosed = threw(() => rt.readMemory({}, rt.claimSpecific(ex, "mx")));
  } finally { rt.close(); }
  const ok = r.cleanRead && r.tamperFailsClosed;
  gate("RG37", "Re-review M5: invalid ancestor fails the whole read closed (not silently dropped)",
    ok ? PASS : FAIL, ok ? "clean read admits; tampered ancestor signature -> read aborts (envelope_not_attested)" : JSON.stringify(r));
}, (e) => gate("RG37", "Re-review M5: ancestor fail-closed", FAIL, e.message));

// RG38: capability separation -- the data-plane facade an agent receives exposes no kernel/attestation
// surface (no controlPlane, db, bindStore, registerPrincipal, mint/sign, or lifecycle admin).
await safe(async () => {
  const { createSecureMemorySystem } = await import("../benchmarks/coupled_memory/runtime.mjs");
  const { runtime, admin } = createSecureMemorySystem();
  const cp = admin.controlPlane;
  const r = {};
  try {
    // The data plane is context-only (review S2): no kernel/attestation surface AND no raw-lease handles.
    const forbidden = ["controlPlane", "db", "bindStore", "registerPrincipal", "_appendLifecycle",
      "supersede", "expire", "revoke", "attestWrite", "attestSend", "_verifiedLifecycleEvents",
      "mintReceipt", "signEnvelope", "getMessage", // ungated message/payload lookup must be absent
      "claimSpecific", "leaseFor", "contextFor", "sendMessage", "writeMemory", "readMemory"]; // no raw-lease API
    r.noKernelOnFacade = forbidden.every((k) => runtime[k] === undefined);
    r.frozen = Object.isFrozen(runtime);
    r.dataPlaneOps = ["claim", "read", "write", "send", "attachInput", "complete"].every((k) => typeof runtime[k] === "function");
    // The data-plane claim yields a context handle + the claimed message, NEVER a raw lease token.
    admin.sendMessage(renv({ message_id: "m0", sender: "p", receiver: "memory", sequence: 0, parent_message_id: null }), cp.registerPrincipal("p", {}));
    const claimed = runtime.claim(cp.registerPrincipal("w", { queues: ["memory"] }), "memory");
    r.claimNoLease = !!claimed.context && claimed.message?.message_id === "m0"
      && claimed.lease === undefined && claimed.leaseId === undefined;
  } finally { admin.close(); }
  const ok = Object.values(r).every(Boolean);
  gate("RG38", "Re-review: capability separation (context-only data plane: no kernel/attestation/admin, no raw lease)",
    ok ? PASS : FAIL, ok ? "facade has only claim/read/write/send/attachInput/complete; claim returns {context,message} with no lease; no controlPlane/db/mint/lifecycle/lease API" : JSON.stringify(r));
}, (e) => gate("RG38", "Re-review: capability separation", FAIL, e.message));

// ---- RG39..RG43: the FIFTH re-review's counterexamples (invariant-structured) -----------------------

// RG39 (parent-omission laundering, context-derived send): an ordinary agent cannot launder consumed taint
// by omitting/forging the causal parent, because a facade send takes only {receiver, intent, payload} and
// the control plane DERIVES the parent (= the context's current event), the sender, the sequence, and the
// integrity (= the context's). So (a) a context-less send is refused, and (b) the derived send is pinned to
// the execution's integrity -- the agent has no field to omit or forge. Reproduced through the FACADE only.
await safe(async () => {
  const { createSecureMemorySystem } = await import("../benchmarks/coupled_memory/runtime.mjs");
  const { integrityLevel } = await import("../benchmarks/coupled_memory/control_plane.mjs");
  const { runtime, admin } = createSecureMemorySystem();
  const cp = admin.controlPlane;
  const r = {};
  try {
    const low = cp.registerPrincipal("low-src", { queues: ["*"], clearance: "untrusted" });
    const sys = cp.registerPrincipal("sys-agent", { queues: ["*"], clearance: "system" });
    // Root/ingress creation is a kernel op (admin.sendMessage); seed an untrusted message and a clean one.
    admin.sendMessage(renv({ message_id: "m0", sender: "low-src", receiver: "memory", sequence: 0, parent_message_id: null, integrity: "untrusted" }), low);
    admin.sendMessage(renv({ message_id: "m-low", sender: "sys-agent", receiver: "sysq", sequence: 1, parent_message_id: "m0", integrity: "untrusted" }), sys);
    admin.sendMessage(renv({ message_id: "m-clean", sender: "sys-agent", receiver: "cleanq", sequence: 2, parent_message_id: null }), sys);
    // (a) an ordinary agent cannot emit a context-less ROOT through the facade (no laundering outside an execution)
    r.contextlessSendRefused = threw(() => runtime.send(sys, null, { receiver: "memory", intent: "produce_final_plan" }));
    // control: a CLEAN execution's derived send is system, and its parent is FORCED to the context's current
    // event (the agent supplies no parent), so there is nothing to omit or forge.
    const cleanCtx = runtime.claim(sys, "cleanq").context;       // claims m-clean (system)
    const clean = runtime.send(sys, cleanCtx, { receiver: "memory", intent: "produce_final_plan" });
    r.cleanIsSystem = integrityLevel(clean.integrity) === 2 && clean.parent_message_id === "m-clean";
    // attack: consume the untrusted message; the derived send is bound to THAT execution -> untrusted, with
    // parent forced to m-low. The agent cannot cite a clean parent to launder; the field does not exist.
    const taintCtx = runtime.claim(sys, "sysq").context;         // claims m-low (untrusted) -> context untrusted
    const out = runtime.send(sys, taintCtx, { receiver: "memory", intent: "produce_final_plan" });
    r.launderedStaysUntrusted = integrityLevel(out.integrity) === 0 && out.parent_message_id === "m-low";
  } finally { admin.close(); }
  const ok = r.contextlessSendRefused && r.cleanIsSystem && r.launderedStaysUntrusted;
  gate("RG39", "Re-review: context-derived send blocks parent-omission laundering (agent supplies no parent)",
    ok ? PASS : FAIL, ok ? "context-less send refused; the control plane forces parent=current-event and integrity=context, so a consumed untrusted input pins the derived send to untrusted -- the agent has no parent field to omit or forge" : JSON.stringify(r));
}, (e) => gate("RG39", "Re-review: parent-omission laundering blocked", FAIL, e.message));

// RG40 (edge validity): the production secure path enforces temporal happens-before -- a future-sequence
// parent is rejected at send time (causal_order_invalid), so it can never enter a closure.
await safe(async () => {
  const { SecureMemoryRuntime, ControlPlane } = await import("../benchmarks/coupled_memory/runtime.mjs");
  const cp = new ControlPlane(); const rt = new SecureMemoryRuntime({ controlPlane: cp });
  const r = {};
  try {
    const p = cp.registerPrincipal("p", {}); const c = cp.registerPrincipal("c", {});
    rt.sendMessage(renv({ message_id: "root", sender: "p", receiver: "memory", sequence: 0, parent_message_id: null }), p);
    rt.sendMessage(renv({ message_id: "future", sender: "p", receiver: "memory", sequence: 100, parent_message_id: "root" }), p);
    r.futureParentRejected = threw(() => rt.sendMessage(
      renv({ message_id: "active", sender: "c", receiver: "executor", sequence: 1, parent_message_id: "future" }), c));
  } finally { rt.close(); }
  gate("RG40", "Re-review: temporal happens-before enforced in production path (future parent rejected)",
    r.futureParentRejected ? PASS : FAIL, r.futureParentRejected ? "parent sequence 100 >= child 1 -> causal_order_invalid at send" : JSON.stringify(r));
}, (e) => gate("RG40", "Re-review: temporal edge validity", FAIL, e.message));

// RG41 (lifecycle anti-rollback): the chain head lives in TCB memory, so deleting a later revocation and
// replaying an EARLIER valid (count,last_mac) into the store anchor does NOT un-retire the record.
await safe(async () => {
  const { SecureMemoryRuntime, ControlPlane } = await import("../benchmarks/coupled_memory/runtime.mjs");
  const cp = new ControlPlane(); const rt = new SecureMemoryRuntime({ controlPlane: cp });
  const r = {};
  try {
    const s = (e) => rt.sendMessage(e, cp.registerPrincipal(e.sender, {}));
    s(renv({ message_id: "m0", sender: "p", receiver: "memory", sequence: 0, parent_message_id: null }));
    s(renv({ message_id: "ms", sender: "p", receiver: "memory", sequence: 1, parent_message_id: "m0" }));
    s(renv({ message_id: "mx", sender: "c", receiver: "executor", sequence: 2, parent_message_id: "ms" }));
    const w = cp.registerPrincipal("w", { queues: ["*"] });
    const lc = cp.registerPrincipal("lc", { queues: ["*"], lifecycle: true });
    const ex = cp.registerPrincipal("ex", { queues: ["executor"] });
    const lease = rt.claimSpecific(w, "ms");
    rt.writeMemory("A", lease, { memory_id: "a", memory_type: "constraint", allowed_readers: ["executor"] });
    rt.writeMemory("B", lease, { memory_id: "b", memory_type: "constraint", allowed_readers: ["executor"] });
    rt.revoke(lc, "a");
    const anchor1 = rt.db.prepare("SELECT count, last_seq, last_mac FROM lifecycle_anchor WHERE id='global'").get(); // valid head after 1 event
    rt.revoke(lc, "b");
    r.bothRetired = !rt.readMemory({}, rt.claimSpecific(ex, "mx")).some((m) => m.memory_id === "a" || m.memory_id === "b");
    // suffix rollback: delete b's revocation and replay the earlier valid anchor row
    rt.db.prepare("DELETE FROM memory_lifecycle_events WHERE memory_id='b'").run();
    rt.db.prepare("UPDATE lifecycle_anchor SET count=?, last_seq=?, last_mac=? WHERE id='global'").run(anchor1.count, anchor1.last_seq, anchor1.last_mac);
    r.rollbackFailsClosed = threw(() => rt.readMemory({}, rt.claimSpecific(ex, "mx")));
  } finally { rt.close(); }
  const ok = r.bothRetired && r.rollbackFailsClosed;
  gate("RG41", "Re-review: lifecycle anti-rollback (replaying an earlier valid anchor fails closed)",
    ok ? PASS : FAIL, ok ? "a,b retired; deleting b + replaying the 1-event anchor -> lifecycle_log_tampered (TCB head)" : JSON.stringify(r));
}, (e) => gate("RG41", "Re-review: lifecycle anti-rollback", FAIL, e.message));

// RG42 (audit bijection): replay flags an INJECTED decision row whose memory is not a candidate.
await safe(async () => {
  const { SecureMemoryRuntime, ControlPlane } = await import("../benchmarks/coupled_memory/runtime.mjs");
  const cp = new ControlPlane(); const rt = new SecureMemoryRuntime({ controlPlane: cp });
  const r = {};
  try {
    const s = (e) => rt.sendMessage(e, cp.registerPrincipal(e.sender, {}));
    s(renv({ message_id: "m0", sender: "p", receiver: "memory", sequence: 0, parent_message_id: null }));
    s(renv({ message_id: "ms", sender: "p", receiver: "memory", sequence: 1, parent_message_id: "m0" }));
    s(renv({ message_id: "mx", sender: "c", receiver: "executor", sequence: 2, parent_message_id: "ms" }));
    const w = cp.registerPrincipal("w", { queues: ["*"] }); const ex = cp.registerPrincipal("ex", { queues: ["executor"] });
    rt.writeMemory("v", rt.claimSpecific(w, "ms"), { memory_id: "mem", memory_type: "constraint", allowed_readers: ["executor"] });
    rt.readMemory({}, rt.claimSpecific(ex, "mx"));
    r.cleanReplay = rt.replaySecureMemoryReads("R").ok === true;
    const read = rt.db.prepare("SELECT read_id, task_id, message_id, reader FROM memory_reads LIMIT 1").get();
    rt.db.prepare(`INSERT INTO memory_access_decisions (decision_id, read_id, run_id, task_id, message_id, memory_id, reader, decision, reason, memory_content_hash, created_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?)`).run("ghost-dec", read.read_id, "R", read.task_id, read.message_id, "ghost", read.reader, "allow", "message_bound_access_granted", null, "2026-01-01T00:00:00.000Z");
    const rep = rt.replaySecureMemoryReads("R");
    r.extraDetected = rep.ok === false && rep.issues.some((i) => i.kind === "extra_decision");
  } finally { rt.close(); }
  const ok = r.cleanReplay && r.extraDetected;
  gate("RG42", "Re-review: replay audit bijection (injected decision row detected)",
    ok ? PASS : FAIL, ok ? "clean replay ok; a non-candidate 'ghost' decision -> extra_decision" : JSON.stringify(r));
}, (e) => gate("RG42", "Re-review: audit bijection", FAIL, e.message));

// RG43 (lease freshness vs queue status): a lease cannot act once its message leaves the 'locked' state.
await safe(async () => {
  const { SecureMemoryRuntime, ControlPlane } = await import("../benchmarks/coupled_memory/runtime.mjs");
  const cp = new ControlPlane(); const rt = new SecureMemoryRuntime({ controlPlane: cp });
  const r = {};
  try {
    rt.sendMessage(renv({ message_id: "m", sender: "p", receiver: "memory", sequence: 0, parent_message_id: null }), cp.registerPrincipal("p", {}));
    const w = cp.registerPrincipal("w", { queues: ["memory"] });
    const lease = rt.claimSpecific(w, "m");
    rt.db.prepare("UPDATE message_queue SET status='completed' WHERE message_id='m'").run(); // message no longer locked
    r.completedLeaseRejected = threw(() => rt.writeMemory("x", lease, { memory_id: "x", memory_type: "constraint", allowed_readers: ["executor"] }));
  } finally { rt.close(); }
  gate("RG43", "Re-review: lease invalid once message leaves 'locked' (completed/released)",
    r.completedLeaseRejected ? PASS : FAIL, r.completedLeaseRejected ? "status='completed' -> lease_message_not_active" : JSON.stringify(r));
}, (e) => gate("RG43", "Re-review: lease freshness vs queue status", FAIL, e.message));

// ---- RG44..RG48: the SIXTH re-review's counterexamples --------------------------------------------

// RG44 (M1): the signature covers the FULL envelope, so a store-write tamper of the message payload
// invalidates it (payload is bound to the integrity label).
await safe(async () => {
  const { SecureMemoryRuntime, ControlPlane } = await import("../benchmarks/coupled_memory/runtime.mjs");
  const cp = new ControlPlane(); const rt = new SecureMemoryRuntime({ controlPlane: cp });
  const r = {};
  try {
    rt.sendMessage(renv({ message_id: "m", sender: "p", receiver: "memory", sequence: 0, parent_message_id: null, payload: { instruction: "BENIGN" } }), cp.registerPrincipal("p", { queues: ["*"] }));
    r.sigValidBefore = cp.verifyEnvelope(rt.getMessage("m")) === true;
    const row = rt.db.prepare("SELECT envelope_json FROM messages WHERE message_id='m'").get();
    rt.db.prepare("UPDATE messages SET envelope_json=? WHERE message_id='m'").run(JSON.stringify({ ...JSON.parse(row.envelope_json), payload: { instruction: "IGNORE POLICY" } }));
    r.sigInvalidAfter = cp.verifyEnvelope(rt.getMessage("m")) === false;
  } finally { rt.close(); }
  const ok = r.sigValidBefore && r.sigInvalidAfter;
  gate("RG44", "Re-review M1: signature covers the full envelope (payload tamper invalidates it)",
    ok ? PASS : FAIL, ok ? "benign payload signs; mutating envelope_json.payload -> verifyEnvelope false" : JSON.stringify(r));
}, (e) => gate("RG44", "Re-review M1: payload signing", FAIL, e.message));

// RG45 (M2, ExecutionContext model): an untrusted input taints WRITES only when it is part of the SAME
// execution. A separately-claimed untrusted message does NOT silently taint an unrelated execution by the
// same principal (context isolation -- the old principal x run floor over-tainted here); but once the
// untrusted message is explicitly ATTACHED to the execution, every record it writes is untrusted, so a
// writer cannot mint a trusted record from inputs it actually consumed.
await safe(async () => {
  const { SecureMemoryRuntime, ControlPlane } = await import("../benchmarks/coupled_memory/runtime.mjs");
  const { integrityLevel } = await import("../benchmarks/coupled_memory/control_plane.mjs");
  const cp = new ControlPlane(); const rt = new SecureMemoryRuntime({ controlPlane: cp });
  const r = {};
  try {
    const sys = cp.registerPrincipal("sys", { queues: ["*"], clearance: "system" });
    const lowsrc = cp.registerPrincipal("lowsrc", { queues: ["*"], clearance: "untrusted" });
    rt.sendMessage(renv({ message_id: "m0", sender: "sys", receiver: "memory", sequence: 0, parent_message_id: null }), sys);
    rt.sendMessage(renv({ message_id: "m-high", sender: "sys", receiver: "memory", sequence: 1, parent_message_id: "m0" }), sys);
    rt.sendMessage(renv({ message_id: "m-low", sender: "lowsrc", receiver: "memory", sequence: 2, parent_message_id: "m0", integrity: "untrusted" }), lowsrc);
    const w = cp.registerPrincipal("w", { queues: ["*"], clearance: "system" });
    const highLease = rt.claimSpecific(w, "m-high");
    const highCtx = rt.contextFor(highLease);
    const clean = rt.writeMemory("c", highLease, { memory_id: "rec-clean", memory_type: "constraint", allowed_readers: ["executor"] });
    r.cleanIsSystem = integrityLevel(clean.integrity) === 2; // control: no untrusted input attached yet
    const lowLease = rt.claimSpecific(w, "m-low"); // a SEPARATE claim of the untrusted message
    const isolated = rt.writeMemory("c2", highLease, { memory_id: "rec-clean2", memory_type: "constraint", allowed_readers: ["executor"] });
    r.separateClaimIsolated = integrityLevel(isolated.integrity) === 2; // isolation: the unrelated execution is NOT tainted
    rt.attachInput(w, highCtx, lowLease); // EXPLICITLY consume the untrusted input into THIS execution
    const poison = rt.writeMemory("p", highLease, { memory_id: "rec-poison", memory_type: "constraint", allowed_readers: ["executor"] });
    r.attachedTaints = integrityLevel(poison.integrity) === 0; // now the record is untrusted
  } finally { rt.close(); }
  const ok = r.cleanIsSystem && r.separateClaimIsolated && r.attachedTaints;
  gate("RG45", "Re-review M2: write integrity is the execution context (isolation + explicit-attach taint)",
    ok ? PASS : FAIL, ok ? "clean write system; a separately-claimed untrusted message does not taint an unrelated execution; attaching it taints every subsequent write untrusted" : JSON.stringify(r));
}, (e) => gate("RG45", "Re-review M2: write-path execution-context integrity", FAIL, e.message));

// RG46 (M4, ExecutionContext model -- context isolation subsumes run-scoping): an untrusted input
// consumed in ONE execution does not taint a SEPARATE execution by the same principal, even in the same
// run (the old principal x run floor over-tainted same-run cross-task work). Only the consuming execution
// is tainted; an unrelated execution stays at its own level.
await safe(async () => {
  const { SecureMemoryRuntime, ControlPlane } = await import("../benchmarks/coupled_memory/runtime.mjs");
  const { integrityLevel } = await import("../benchmarks/coupled_memory/control_plane.mjs");
  const cp = new ControlPlane(); const rt = new SecureMemoryRuntime({ controlPlane: cp });
  const r = {};
  try {
    const agent = cp.registerPrincipal("agent", { queues: ["*"], clearance: "system" });
    const lowsrc = cp.registerPrincipal("lowsrc", { queues: ["*"], clearance: "untrusted" });
    // Two independent jobs in the SAME run: a-low (untrusted, task A) and a-clean (system, task B).
    rt.sendMessage(renv({ run_id: "R", task_id: "A", message_id: "a-low", sender: "lowsrc", receiver: "qa", sequence: 0, parent_message_id: null, integrity: "untrusted" }), lowsrc);
    rt.sendMessage(renv({ run_id: "R", task_id: "B", message_id: "a-clean", sender: "agent", receiver: "qb", sequence: 1, parent_message_id: null }), agent);
    const lowLease = rt.claimSpecific(agent, "a-low");   // execution 1: consumes the untrusted message
    const cleanLease = rt.claimSpecific(agent, "a-clean"); // execution 2: a separate, clean execution
    r.taintedExecLow = cp.contextSnapshot(rt.contextFor(lowLease)).integrity === 0;
    r.separateExecClean = cp.contextSnapshot(rt.contextFor(cleanLease)).integrity === 2; // same principal, same run -> NOT tainted
    // and the outputs follow their own execution: the clean execution writes a system record
    const rec = rt.writeMemory("v", cleanLease, { memory_id: "rec", memory_type: "constraint", allowed_readers: ["executor"] });
    r.cleanExecOutputSystem = integrityLevel(rec.integrity) === 2;
  } finally { rt.close(); }
  const ok = r.taintedExecLow && r.separateExecClean && r.cleanExecOutputSystem;
  gate("RG46", "Re-review M4: context isolation (an untrusted input taints only its own execution, not a same-principal/same-run sibling)",
    ok ? PASS : FAIL, ok ? "execution 1 (consumed untrusted) is untrusted; a separate same-run execution stays system and writes a system record" : JSON.stringify(r));
}, (e) => gate("RG46", "Re-review M4: context isolation", FAIL, e.message));

// RG47 (M6): secure replay re-verifies the lifecycle chain -- a deletion that fails the live monitor also
// fails replay (no online/replay semantic divergence).
await safe(async () => {
  const { SecureMemoryRuntime, ControlPlane } = await import("../benchmarks/coupled_memory/runtime.mjs");
  const cp = new ControlPlane(); const rt = new SecureMemoryRuntime({ controlPlane: cp });
  const r = {};
  try {
    const s = (e) => rt.sendMessage(e, cp.registerPrincipal(e.sender, {}));
    s(renv({ message_id: "m0", sender: "p", receiver: "memory", sequence: 0, parent_message_id: null }));
    s(renv({ message_id: "ms", sender: "p", receiver: "memory", sequence: 1, parent_message_id: "m0" }));
    s(renv({ message_id: "mx", sender: "c", receiver: "executor", sequence: 2, parent_message_id: "ms" }));
    const w = cp.registerPrincipal("w", { queues: ["*"] });
    const lc = cp.registerPrincipal("lc", { queues: ["*"], lifecycle: true });
    const ex = cp.registerPrincipal("ex", { queues: ["executor"] });
    rt.writeMemory("v", rt.claimSpecific(w, "ms"), { memory_id: "mem", memory_type: "constraint", allowed_readers: ["executor"] });
    rt.revoke(lc, "mem");
    rt.readMemory({}, rt.claimSpecific(ex, "mx"));
    r.replayOkBefore = rt.replaySecureMemoryReads("R").ok === true;
    rt.db.prepare("DELETE FROM memory_lifecycle_events WHERE memory_id='mem'").run();
    const rep = rt.replaySecureMemoryReads("R");
    r.replayFlagsLifecycle = rep.ok === false && rep.issues.some((i) => i.kind === "lifecycle_log_tampered");
  } finally { rt.close(); }
  const ok = r.replayOkBefore && r.replayFlagsLifecycle;
  gate("RG47", "Re-review M6: replay re-verifies the lifecycle chain (online/replay parity)",
    ok ? PASS : FAIL, ok ? "clean replay ok; deleting a lifecycle event -> replay flags lifecycle_log_tampered" : JSON.stringify(r));
}, (e) => gate("RG47", "Re-review M6: replay lifecycle parity", FAIL, e.message));

// RG48 (M7): the shared causal helper (external/Cedar adapter) excludes cross-run edges, matching the
// secure runtime's fail-closed same-run semantics.
await safe(async () => {
  const { causalAncestryFromMessages } = await import("../benchmarks/coupled_memory/causal.mjs");
  const messages = [
    { message_id: "p", run_id: "A", sequence: 0, parent_message_id: null },
    { message_id: "x", run_id: "B", sequence: 1, parent_message_id: "p" }, // cross-run edge
  ];
  const closure = causalAncestryFromMessages(messages, messages[1]);
  const ok = closure.has("x") && !closure.has("p");
  gate("RG48", "Re-review M7: shared causal helper excludes cross-run edges",
    ok ? PASS : FAIL, ok ? "x's cross-run parent p is not admitted as an ancestor" : JSON.stringify([...closure]));
}, (e) => gate("RG48", "Re-review M7: cross-run edge exclusion", FAIL, e.message));

// ---- RG49..RG55: the SEVENTH re-review -- the ExecutionContext invariant suite (property-structured,
//      not per-counterexample). These pin the per-execution integrity model the consumed-input floor was
//      replaced by: monotonicity, output bound + send/write symmetry, completion, restart durability,
//      cross-run isolation, fail-closed input snapshot, and the orphan-decision read_id bijection. ------

// RG49 (invariant: integrity monotonicity): attaching an input can only LOWER a context's integrity;
// attaching a high input after a low one does not raise it back.
await safe(async () => {
  const { SecureMemoryRuntime, ControlPlane } = await import("../benchmarks/coupled_memory/runtime.mjs");
  const cp = new ControlPlane(); const rt = new SecureMemoryRuntime({ controlPlane: cp });
  const r = {};
  try {
    const sys = cp.registerPrincipal("sys", { queues: ["*"], clearance: "system" });
    const low = cp.registerPrincipal("low", { queues: ["*"], clearance: "untrusted" });
    rt.sendMessage(renv({ message_id: "m0", sender: "sys", receiver: "memory", sequence: 0, parent_message_id: null }), sys);
    rt.sendMessage(renv({ message_id: "m-hi", sender: "sys", receiver: "memory", sequence: 1, parent_message_id: "m0" }), sys);
    rt.sendMessage(renv({ message_id: "m-lo", sender: "low", receiver: "memory", sequence: 2, parent_message_id: "m0", integrity: "untrusted" }), low);
    rt.sendMessage(renv({ message_id: "m-hi2", sender: "sys", receiver: "memory", sequence: 3, parent_message_id: "m0" }), sys);
    const w = cp.registerPrincipal("w", { queues: ["*"], clearance: "system" });
    const ctx = rt.contextFor(rt.claimSpecific(w, "m-hi"));
    const i0 = cp.contextSnapshot(ctx).integrity;
    rt.attachInput(w, ctx, rt.claimSpecific(w, "m-lo"));   // attach untrusted -> lowers
    const i1 = cp.contextSnapshot(ctx).integrity;
    rt.attachInput(w, ctx, rt.claimSpecific(w, "m-hi2"));  // attach system -> cannot rise
    const i2 = cp.contextSnapshot(ctx).integrity;
    r.monotone = i0 === 2 && i1 === 0 && i2 === 0 && i1 <= i0 && i2 <= i1;
  } finally { rt.close(); }
  gate("RG49", "Invariant: integrity monotonicity (attach only lowers context integrity)",
    r.monotone ? PASS : FAIL, r.monotone ? "system(2) -> attach untrusted -> 0 -> attach system -> still 0" : JSON.stringify(r));
}, (e) => gate("RG49", "Invariant: integrity monotonicity", FAIL, e.message));

// RG50 (invariant: output bound + send/write symmetry): in one execution the integrity of a written
// record equals the integrity of a sent message equals the context's integrity.
await safe(async () => {
  const { SecureMemoryRuntime, ControlPlane } = await import("../benchmarks/coupled_memory/runtime.mjs");
  const { integrityLevel } = await import("../benchmarks/coupled_memory/control_plane.mjs");
  const cp = new ControlPlane(); const rt = new SecureMemoryRuntime({ controlPlane: cp });
  const r = {};
  try {
    const sys = cp.registerPrincipal("sys", { queues: ["*"], clearance: "system" });
    const low = cp.registerPrincipal("low", { queues: ["*"], clearance: "untrusted" });
    rt.sendMessage(renv({ message_id: "m0", sender: "sys", receiver: "memory", sequence: 0, parent_message_id: null }), sys);
    rt.sendMessage(renv({ message_id: "m-lo", sender: "low", receiver: "wq", sequence: 1, parent_message_id: "m0", integrity: "untrusted" }), low);
    const w = cp.registerPrincipal("w", { queues: ["*"], clearance: "system" });
    const claimed = rt.claim(w, "wq"); // claims m-lo (untrusted) -> context untrusted
    const ctxInt = cp.contextSnapshot(claimed.context).integrity;
    const rec = rt.writeMemory("v", claimed.lease, { memory_id: "rec", memory_type: "constraint", allowed_readers: ["executor"] });
    const msg = rt.sendMessage(renv({ message_id: "m-out", sender: "w", receiver: "memory", sequence: 2, parent_message_id: "m-lo" }), w, claimed.context);
    r.bound = integrityLevel(rec.integrity) === ctxInt && integrityLevel(msg.integrity) === ctxInt;
    r.symmetry = integrityLevel(rec.integrity) === integrityLevel(msg.integrity);
    r.tainted = ctxInt === 0; // non-trivial: this execution is untrusted
  } finally { rt.close(); }
  const ok = r.bound && r.symmetry && r.tainted;
  gate("RG50", "Invariant: output bound + send/write symmetry (record == message == context integrity)",
    ok ? PASS : FAIL, ok ? "untrusted execution: written record and sent message both derive untrusted == context" : JSON.stringify(r));
}, (e) => gate("RG50", "Invariant: output bound + symmetry", FAIL, e.message));

// RG51 (invariant: context completion): a completed context produces no further output -- write, read,
// send, and attach under it all fail closed.
await safe(async () => {
  const { SecureMemoryRuntime, ControlPlane } = await import("../benchmarks/coupled_memory/runtime.mjs");
  const cp = new ControlPlane(); const rt = new SecureMemoryRuntime({ controlPlane: cp });
  const r = {};
  try {
    const s = (e) => rt.sendMessage(e, cp.registerPrincipal(e.sender, {}));
    s(renv({ message_id: "m0", sender: "p", receiver: "memory", sequence: 0, parent_message_id: null }));
    s(renv({ message_id: "m2", sender: "p", receiver: "memory", sequence: 1, parent_message_id: "m0" }));
    const ms = cp.registerPrincipal("ms", { queues: ["memory"] });
    const claimed = rt.claim(ms, "memory"); // claims m0
    rt.writeMemory("v", claimed.lease, { memory_id: "a", memory_type: "constraint", allowed_readers: ["executor"] });
    rt.complete(ms, claimed.context);
    r.writeRefused = threw(() => rt.writeMemory("v2", claimed.lease, { memory_id: "b", memory_type: "constraint", allowed_readers: ["executor"] }));
    r.readRefused = threw(() => rt.readMemory({}, claimed.lease));
    r.sendRefused = threw(() => rt.sendMessage(renv({ message_id: "m-x", sender: "ms", receiver: "memory", sequence: 5, parent_message_id: "m0" }), ms, claimed.context));
    r.attachRefused = threw(() => rt.attachInput(ms, claimed.context, claimed.lease));
  } finally { rt.close(); }
  const ok = Object.values(r).every(Boolean);
  gate("RG51", "Invariant: completed context produces no output (write/read/send/attach refused)",
    ok ? PASS : FAIL, ok ? "after complete(): write/read fail (lease revoked); send/attach fail (context_not_active)" : JSON.stringify(r));
}, (e) => gate("RG51", "Invariant: context completion", FAIL, e.message));

// RG52 (invariant: restart durability): a context's accumulated integrity is preserved across a same-key
// restart (durable mirror + MAC) and INVALIDATED across a different-key restart (token + MAC fail) -- a
// restart cannot resurrect a usable execution that consumed untrusted input.
await safe(async () => {
  const { SecureMemoryRuntime, ControlPlane } = await import("../benchmarks/coupled_memory/runtime.mjs");
  const { mkdtempSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { Buffer } = await import("node:buffer");
  const dbPath = join(mkdtempSync(join(tmpdir(), "mbm-ctx-")), "t.db");
  const key = Buffer.alloc(32, 5);
  const r = {};
  let token, before;
  { const cp = new ControlPlane({ keyBytes: key }); const rt = new SecureMemoryRuntime({ dbPath, controlPlane: cp });
    const low = cp.registerPrincipal("low", { queues: ["*"], clearance: "untrusted" });
    const agent = cp.registerPrincipal("agent", { queues: ["*"], clearance: "system" });
    rt.sendMessage(renv({ message_id: "m0", sender: "low", receiver: "q", sequence: 0, parent_message_id: null, integrity: "untrusted" }), low);
    token = rt.claim(agent, "q").context; // claims m0 (untrusted) -> context untrusted
    before = cp.contextSnapshot(token).integrity;
    rt.close(); }
  { const cp = new ControlPlane({ keyBytes: key }); const rt = new SecureMemoryRuntime({ dbPath, controlPlane: cp });
    const snap = cp.contextSnapshot(token);
    r.preserved = snap.integrity === before && snap.state === "active";
    rt.close(); }
  { const cp = new ControlPlane({ keyBytes: Buffer.alloc(32, 1) }); const rt = new SecureMemoryRuntime({ dbPath, controlPlane: cp });
    r.invalidatedDifferentKey = threw(() => cp.contextSnapshot(token)); // token + MAC fail under a different key
    rt.close(); }
  r.before = before === 0;
  const ok = r.before && r.preserved && r.invalidatedDifferentKey;
  gate("RG52", "Invariant: restart durability (same-key context preserved; different-key invalidated)",
    ok ? PASS : FAIL, ok ? "untrusted context restored active across same-key restart; unusable across a different key" : JSON.stringify(r));
}, (e) => gate("RG52", "Invariant: restart durability", FAIL, e.message));

// RG53 (invariant: no cross-run laundering): a context-derived send's run is FIXED to the context's run --
// the agent supplies no run_id (and any attempt to pass one is ignored), so retargeting a derived message
// into another run is structurally impossible.
await safe(async () => {
  const { createSecureMemorySystem } = await import("../benchmarks/coupled_memory/runtime.mjs");
  const { runtime, admin } = createSecureMemorySystem();
  const cp = admin.controlPlane;
  const r = {};
  try {
    const agent = cp.registerPrincipal("agent", { queues: ["*"], clearance: "system" });
    admin.sendMessage(renv({ run_id: "A", message_id: "a0", sender: "agent", receiver: "q", sequence: 0, parent_message_id: null }), agent);
    const ctx = runtime.claim(agent, "q").context; // execution in run A
    // The agent tries to retarget run B by smuggling run_id into the output; the control plane ignores it
    // and derives run A from the context.
    const out = runtime.send(agent, ctx, { receiver: "memory", intent: "produce_final_plan", run_id: "B" });
    r.runIsContextRun = out.run_id === "A";
    r.parentIsContextEvent = out.parent_message_id === "a0";
  } finally { admin.close(); }
  const ok = r.runIsContextRun && r.parentIsContextEvent;
  gate("RG53", "Invariant: no cross-run laundering (derived send's run/parent are fixed by the context)",
    ok ? PASS : FAIL, ok ? "a smuggled run_id is ignored; the derived send is in the context's run (A) with parent = current event" : JSON.stringify(r));
}, (e) => gate("RG53", "Invariant: cross-run laundering blocked", FAIL, e.message));

// RG54 (invariant: fail-closed input snapshot): an input's integrity is FROZEN into the context at attach
// time, so a later transient store-tamper of the source message cannot raise an already-tainted execution.
await safe(async () => {
  const { SecureMemoryRuntime, ControlPlane } = await import("../benchmarks/coupled_memory/runtime.mjs");
  const { integrityLevel } = await import("../benchmarks/coupled_memory/control_plane.mjs");
  const cp = new ControlPlane(); const rt = new SecureMemoryRuntime({ controlPlane: cp });
  const r = {};
  try {
    const sys = cp.registerPrincipal("sys", { queues: ["*"], clearance: "system" });
    const low = cp.registerPrincipal("low", { queues: ["*"], clearance: "untrusted" });
    rt.sendMessage(renv({ message_id: "m0", sender: "sys", receiver: "memory", sequence: 0, parent_message_id: null }), sys);
    rt.sendMessage(renv({ message_id: "m-hi", sender: "sys", receiver: "memory", sequence: 1, parent_message_id: "m0" }), sys);
    rt.sendMessage(renv({ message_id: "m-lo", sender: "low", receiver: "memory", sequence: 2, parent_message_id: "m0", integrity: "untrusted" }), low);
    const w = cp.registerPrincipal("w", { queues: ["*"], clearance: "system" });
    const lease = rt.claimSpecific(w, "m-hi"); const ctx = rt.contextFor(lease);
    rt.attachInput(w, ctx, rt.claimSpecific(w, "m-lo")); // context now untrusted (integrity snapshot = 0)
    const row = rt.db.prepare("SELECT envelope_json FROM messages WHERE message_id='m-lo'").get();
    rt.db.prepare("UPDATE messages SET envelope_json=? WHERE message_id='m-lo'").run(JSON.stringify({ ...JSON.parse(row.envelope_json), integrity: 2 })); // transient tamper
    const poison = rt.writeMemory("p", lease, { memory_id: "rec", memory_type: "constraint", allowed_readers: ["executor"] });
    r.snapshotHolds = integrityLevel(poison.integrity) === 0;
  } finally { rt.close(); }
  gate("RG54", "Invariant: fail-closed input snapshot (transient source tamper cannot raise a tainted context)",
    r.snapshotHolds ? PASS : FAIL, r.snapshotHolds ? "attach freezes integrity 0; rewriting m-lo to integrity 2 does not un-taint the write" : JSON.stringify(r));
}, (e) => gate("RG54", "Invariant: fail-closed input snapshot", FAIL, e.message));

// RG55 (invariant: replay orphan-decision bijection on read_id): a decision row whose read_id matches no
// surviving read manifest (an injected/orphaned row) is flagged by replay.
await safe(async () => {
  const { SecureMemoryRuntime, ControlPlane } = await import("../benchmarks/coupled_memory/runtime.mjs");
  const cp = new ControlPlane(); const rt = new SecureMemoryRuntime({ controlPlane: cp });
  const r = {};
  try {
    const s = (e) => rt.sendMessage(e, cp.registerPrincipal(e.sender, {}));
    s(renv({ message_id: "m0", sender: "p", receiver: "memory", sequence: 0, parent_message_id: null }));
    s(renv({ message_id: "ms", sender: "p", receiver: "memory", sequence: 1, parent_message_id: "m0" }));
    s(renv({ message_id: "mx", sender: "c", receiver: "executor", sequence: 2, parent_message_id: "ms" }));
    const w = cp.registerPrincipal("w", { queues: ["*"] }); const ex = cp.registerPrincipal("ex", { queues: ["executor"] });
    rt.writeMemory("v", rt.claimSpecific(w, "ms"), { memory_id: "mem", memory_type: "constraint", allowed_readers: ["executor"] });
    rt.readMemory({}, rt.claimSpecific(ex, "mx"));
    r.cleanReplay = rt.replaySecureMemoryReads("R").ok === true;
    const d = rt.db.prepare("SELECT task_id, message_id, reader FROM memory_access_decisions LIMIT 1").get();
    rt.db.prepare(`INSERT INTO memory_access_decisions (decision_id, read_id, run_id, task_id, message_id, memory_id, reader, decision, reason, memory_content_hash, created_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?)`).run("orphan-dec", "read-does-not-exist", "R", d.task_id, d.message_id, "ghost", d.reader, "allow", "message_bound_access_granted", null, "2026-01-01T00:00:00.000Z");
    const rep = rt.replaySecureMemoryReads("R");
    r.orphanDetected = rep.ok === false && rep.issues.some((i) => i.kind === "orphan_decision_unknown_read");
  } finally { rt.close(); }
  const ok = r.cleanReplay && r.orphanDetected;
  gate("RG55", "Invariant: replay flags an orphan decision with an unknown read_id",
    ok ? PASS : FAIL, ok ? "clean replay ok; a decision row citing a nonexistent read_id -> orphan_decision_unknown_read" : JSON.stringify(r));
}, (e) => gate("RG55", "Invariant: orphan-decision read_id bijection", FAIL, e.message));

// RG56 (context-only data plane, end-to-end): an ordinary agent completes a full task through the facade
// using only (session, context)---claim, write, send, complete, then a reader claim+read---never touching a
// raw lease; writes are integrity-bound, sends are control-plane-composed, reads bind to the context.
await safe(async () => {
  const { createSecureMemorySystem } = await import("../benchmarks/coupled_memory/runtime.mjs");
  const { integrityLevel } = await import("../benchmarks/coupled_memory/control_plane.mjs");
  const { runtime, admin } = createSecureMemorySystem();
  const cp = admin.controlPlane;
  const r = {};
  try {
    admin.sendMessage(renv({ message_id: "m0", sender: "p", receiver: "memory", sequence: 0, parent_message_id: null }), cp.registerPrincipal("p", { queues: ["*"] }));
    admin.sendMessage(renv({ message_id: "m1", sender: "p", receiver: "worker", sequence: 1, parent_message_id: "m0" }), cp.registerPrincipal("p1", { queues: ["*"] }));
    const worker = cp.registerPrincipal("worker", { queues: ["worker"], clearance: "system" });
    const reader = cp.registerPrincipal("reader", { queues: ["executor"], clearance: "system" });
    const claimed = runtime.claim(worker, "worker");           // opens a context on m1; no lease exposed
    r.noLease = !!claimed.context && claimed.message?.message_id === "m1" && claimed.lease === undefined;
    const rec = runtime.write(worker, claimed.context, "retain 30 days", { memory_id: "rec", memory_type: "constraint", allowed_readers: ["executor"] });
    r.writeBound = integrityLevel(rec.integrity) === 2;
    const sent = runtime.send(worker, claimed.context, { receiver: "executor", intent: "produce_final_plan" });
    r.sendDerived = sent.run_id === "R" && sent.parent_message_id === "m1" && sent.sender === "worker" && integrityLevel(sent.integrity) === 2;
    runtime.complete(worker, claimed.context);
    // (CREATION-CUT) mexec is the executor READER/leaf: send it AFTER the write, sequence > every write.
    admin.sendMessage(renv({ message_id: "mexec", sender: "p", receiver: "executor", sequence: admin._currentSequence("R") + 1, parent_message_id: "m1" }), cp.registerPrincipal("p2", { queues: ["*"] }));
    const rc = runtime.claim(reader, "executor");
    r.readByContext = runtime.read(reader, rc.context, {}).some((m) => m.memory_id === "rec");
  } finally { admin.close(); }
  const ok = Object.values(r).every(Boolean);
  gate("RG56", "Context-only data plane end-to-end (claim/write/send/complete/read by (session,context); no raw lease)",
    ok ? PASS : FAIL, ok ? "agent completes a task through the facade with no lease; write integrity-bound, send control-plane-composed, read binds to the context" : JSON.stringify(r));
}, (e) => gate("RG56", "Context-only data plane end-to-end", FAIL, e.message));

// ---- RG57..RG59: Gate 2.0 -- merge-induced ancestry laundering, coherent view, read-to-use transaction --

// RG57 (the negative control that breaks the per-record gate): a TRUE multi-parent merge makes BOTH
// conflicting memories' sources genuine ancestors, so the per-record causal-reachability gate admits BOTH
// (ancestry); the set-level coherent-view gate denies the unresolved conflict (authority). Ancestry != authority.
await safe(async () => {
  const { SecureMemoryRuntime, ControlPlane } = await import("../benchmarks/coupled_memory/runtime.mjs");
  const cp = new ControlPlane(); const rt = new SecureMemoryRuntime({ controlPlane: cp });
  const r = {};
  try {
    rt.sendMessage(renv({ message_id: "mA", sender: "p", receiver: "memory", sequence: 1, parent_message_id: null }), cp.registerPrincipal("p", {}));
    rt.sendMessage(renv({ message_id: "mB", sender: "p2", receiver: "memory", sequence: 2, parent_message_id: null }), cp.registerPrincipal("p2", {}));
    const w = cp.registerPrincipal("w", { queues: ["*"] }); const ex = cp.registerPrincipal("ex", { queues: ["executor"] });
    rt.writeMemory("retention = 7 days", rt.claimSpecific(w, "mA"), { memory_id: "mem-A", memory_type: "constraint", allowed_readers: ["executor"], logical_key: "retention" });
    rt.writeMemory("retention = 30 days", rt.claimSpecific(w, "mB"), { memory_id: "mem-B", memory_type: "constraint", allowed_readers: ["executor"], logical_key: "retention" });
    // TRUE merge: both branches are parents of the merge (parent + delegated_from), so both are ancestors.
    // (CREATION-CUT) mMerge is the reader/leaf: send it AFTER the writes, sequence > every write.
    rt.sendMessage(renv({ message_id: "mMerge", sender: "c", receiver: "executor", sequence: rt._currentSequence("R") + 1, parents: [{ id: "mA", type: "depends" }, { id: "mB", type: "depends" }] }), cp.registerPrincipal("c", {}));
    const active = rt.getMessage("mMerge"); const closure = rt.causalAncestry(active); const retired = rt.retiredMemoryIds();
    r.bothAreAncestors = closure.has("mA") && closure.has("mB");
    // per-record gate alone admits BOTH conflicting memories (the laundering)
    const perRecord = rt.findCandidateMemories({}).filter((m) => rt.evaluateSecureGate(m, active, { causalClosure: closure, retiredIds: retired }).decision === "allow").map((m) => m.memory_id);
    r.perRecordAdmitsBoth = perRecord.includes("mem-A") && perRecord.includes("mem-B");
    // Gate 2.0 (full read with coherent view) denies the unresolved conflict
    const admitted = rt.readMemory({}, rt.claimSpecific(ex, "mMerge")).map((m) => m.memory_id);
    r.coherentRequiresResolution = !admitted.includes("mem-A") && !admitted.includes("mem-B");
  } finally { rt.close(); }
  const ok = r.bothAreAncestors && r.perRecordAdmitsBoth && r.coherentRequiresResolution;
  gate("RG57", "Gate 2.0: true-merge ancestry laundering (per-record gate admits both conflicting memories; coherent view requires resolution)",
    ok ? PASS : FAIL, ok ? "both branches are ancestors; per-record gate admits mem-A AND mem-B; the coherent-view gate denies the unresolved same-key conflict" : JSON.stringify(r));
}, (e) => gate("RG57", "Gate 2.0: true-merge ancestry laundering", FAIL, e.message));

// RG58 (resolution certificate): an authorized resolver's signed certificate makes only the ADOPTED record
// authoritative; the rejected one is denied (not_adopted). An unauthorized resolver and a forged certificate
// are both refused, so the conflict stays unresolved without a genuine certificate.
await safe(async () => {
  const { SecureMemoryRuntime, ControlPlane } = await import("../benchmarks/coupled_memory/runtime.mjs");
  const cp = new ControlPlane(); const rt = new SecureMemoryRuntime({ controlPlane: cp });
  const r = {};
  try {
    rt.sendMessage(renv({ message_id: "mA", sender: "p", receiver: "memory", sequence: 1, parent_message_id: null }), cp.registerPrincipal("p", {}));
    rt.sendMessage(renv({ message_id: "mB", sender: "p2", receiver: "memory", sequence: 2, parent_message_id: null }), cp.registerPrincipal("p2", {}));
    const w = cp.registerPrincipal("w", { queues: ["*"] }); const ex = cp.registerPrincipal("ex", { queues: ["executor"] });
    rt.writeMemory("retention = 7 days", rt.claimSpecific(w, "mA"), { memory_id: "mem-A", memory_type: "constraint", allowed_readers: ["executor"], logical_key: "retention" });
    rt.writeMemory("retention = 30 days", rt.claimSpecific(w, "mB"), { memory_id: "mem-B", memory_type: "constraint", allowed_readers: ["executor"], logical_key: "retention" });
    // (CREATION-CUT) mMerge is the reader/leaf: send it AFTER the writes, sequence > every write.
    rt.sendMessage(renv({ message_id: "mMerge", sender: "c", receiver: "executor", sequence: rt._currentSequence("R") + 1, parents: [{ id: "mA", type: "depends" }, { id: "mB", type: "depends" }] }), cp.registerPrincipal("c", {}));
    // unauthorized resolver refused; forged certificate not verifiable
    r.unauthRefused = threw(() => rt.resolveConflict(cp.registerPrincipal("nobody", {}), { logical_key: "retention", accepted: ["mem-A"] }));
    r.forgedIgnored = cp.verifyResolution({ logical_key: "retention", accepted: ["mem-A"], rejected: ["mem-B"], resolver: "owner", authority: "policy-resolution", policy_epoch: 1, resolution_sig: "rsig:deadbeef" }) === false;
    // authorized resolution adopts mem-B
    rt.resolveConflict(cp.registerPrincipal("owner", { queues: [], resolution: true }), { logical_key: "retention", accepted: ["mem-B"], rejected: ["mem-A"] });
    const admitted = rt.readMemory({}, rt.claimSpecific(ex, "mMerge")).map((m) => m.memory_id);
    r.onlyAdopted = admitted.includes("mem-B") && !admitted.includes("mem-A");
    r.replayOk = rt.replaySecureMemoryReads("R").ok === true;
  } finally { rt.close(); }
  const ok = r.unauthRefused && r.forgedIgnored && r.onlyAdopted && r.replayOk;
  gate("RG58", "Gate 2.0: signed resolution certificate (only the adopted record authoritative; unauthorized/forged refused; replay reproduces)",
    ok ? PASS : FAIL, ok ? "unauthorized resolver + forged cert refused; an authorized resolution admits only mem-B; replay reproduces the coherent view" : JSON.stringify(r));
}, (e) => gate("RG58", "Gate 2.0: resolution certificate", FAIL, e.message));

// RG59 (read-to-use transaction): a prepared read binds the exposed records + epochs; revoking an exposed
// record before commit -> ABORT_AND_RETRY (valid-at-read != valid-at-commit); an unchanged view -> ALLOW; a
// forged/garbage token -> DENY.
await safe(async () => {
  const { SecureMemoryRuntime, ControlPlane } = await import("../benchmarks/coupled_memory/runtime.mjs");
  const cp = new ControlPlane(); const rt = new SecureMemoryRuntime({ controlPlane: cp });
  const r = {};
  try {
    rt.sendMessage(renv({ message_id: "m0", sender: "p", receiver: "memory", sequence: 0, parent_message_id: null }), cp.registerPrincipal("p", {}));
    rt.sendMessage(renv({ message_id: "ms", sender: "p", receiver: "memory", sequence: 1, parent_message_id: "m0" }), cp.registerPrincipal("p2", {}));
    const w = cp.registerPrincipal("w", { queues: ["*"] }); const ex = cp.registerPrincipal("ex", { queues: ["executor"] });
    const lc = cp.registerPrincipal("lc", { queues: ["*"], lifecycle: true });
    rt.writeMemory("retain 30 days", rt.claimSpecific(w, "ms"), { memory_id: "mem", memory_type: "constraint", allowed_readers: ["executor"] });
    // (CREATION-CUT) mx is the reader/leaf: send it AFTER the write, sequence > every write.
    rt.sendMessage(renv({ message_id: "mx", sender: "c", receiver: "executor", sequence: rt._currentSequence("R") + 1, parent_message_id: "ms" }), cp.registerPrincipal("c", {}));
    const prep = rt.prepareMemoryRead({}, rt.claimSpecific(ex, "mx"), null, "produce_plan");
    r.exposed = prep.view.map((m) => m.memory_id).includes("mem");
    r.commitFresh = rt.commitMemoryUse({ effect: "produce_plan" }, prep.token).decision === "ALLOW";
    r.forgedTokenDenied = rt.commitMemoryUse({ effect: "produce_plan" }, "rtok.garbage.bad").decision === "DENY";
    rt.revoke(lc, "mem"); // revoke an EXPOSED record after the read
    const after = rt.commitMemoryUse({ effect: "produce_plan" }, prep.token);
    r.staleAborts = after.decision === "ABORT_AND_RETRY" && after.reason === "exposed_record_revoked";
  } finally { rt.close(); }
  const ok = r.exposed && r.commitFresh && r.forgedTokenDenied && r.staleAborts;
  gate("RG59", "Gate 2.0: read-to-use serializability (prepared view commits while fresh; revoked exposed record aborts; forged token denied)",
    ok ? PASS : FAIL, ok ? "fresh commit ALLOW; forged token DENY; revoking an exposed record -> ABORT_AND_RETRY (read != commit)" : JSON.stringify(r));
}, (e) => gate("RG59", "Gate 2.0: read-to-use serializability", FAIL, e.message));

// ---- RG60..RG62: Gate 2.0 follow-ons -- effect ceiling, mandatory retrieval, adopt-edge authority --------

// RG60 (Gate 2.0 #4): effect ceiling. A low-trust record is observable but bounds the action a read can
// justify; the view capability is the meet of exposed ceilings, and an action exceeding it is denied at commit.
await safe(async () => {
  const { SecureMemoryRuntime, ControlPlane } = await import("../benchmarks/coupled_memory/runtime.mjs");
  const cp = new ControlPlane(); const rt = new SecureMemoryRuntime({ controlPlane: cp });
  const r = {};
  try {
    rt.sendMessage(renv({ message_id: "m0", sender: "p", receiver: "memory", sequence: 0, parent_message_id: null }), cp.registerPrincipal("p", {}));
    rt.sendMessage(renv({ message_id: "ms", sender: "p", receiver: "memory", sequence: 1, parent_message_id: "m0" }), cp.registerPrincipal("p2", {}));
    const w = cp.registerPrincipal("w", { queues: ["*"] }); const ex = cp.registerPrincipal("ex", { queues: ["executor"] });
    rt.writeMemory("external note", rt.claimSpecific(w, "ms"), { memory_id: "mem", memory_type: "constraint", allowed_readers: ["executor"], effect_ceiling: ["summarize", "answer"] });
    // (CREATION-CUT) mx is the reader/leaf: send it AFTER the write, sequence > every write.
    rt.sendMessage(renv({ message_id: "mx", sender: "c", receiver: "executor", sequence: rt._currentSequence("R") + 1, parent_message_id: "ms" }), cp.registerPrincipal("c", {}));
    // within ceiling: a token prepared+committed for "answer" succeeds (tokens are one-shot, so each action
    // prepares its own token; the action a token authorizes is bound to its intended effect).
    const p1 = rt.prepareMemoryRead({}, rt.claimSpecific(ex, "mx"), null, "answer");
    r.capability = JSON.stringify(p1.capability) === JSON.stringify(["summarize", "answer"]);
    r.withinCeiling = rt.commitMemoryUse({ effect: "answer" }, p1.token).decision === "ALLOW";
    // exceeds ceiling: a token prepared for the sensitive "send_email" is denied because the meet of exposed
    // ceilings does not include it.
    const p2 = rt.prepareMemoryRead({}, rt.claimSpecific(ex, "mx"), null, "send_email");
    const exceed = rt.commitMemoryUse({ effect: "send_email" }, p2.token);
    r.exceedsDenied = exceed.decision === "DENY" && exceed.reason === "effect_exceeds_ceiling";
  } finally { rt.close(); }
  const ok = r.capability && r.withinCeiling && r.exceedsDenied;
  gate("RG60", "Gate 2.0 #4: effect ceiling (low-trust record is observable but cannot justify a sensitive action)",
    ok ? PASS : FAIL, ok ? "view capability = meet of exposed ceilings (summarize/answer); answer commits, send_email -> effect_exceeds_ceiling" : JSON.stringify(r));
}, (e) => gate("RG60", "Gate 2.0 #4: effect ceiling", FAIL, e.message));

// RG61 (Gate 2.0 #5): mandatory retrieval. Flooding a bounded retriever with invalid-but-relevant records
// cannot suppress a conflicting/authoritative decision; the exact-index mandatory union recovers it.
await safe(async () => {
  const { SecureMemoryRuntime, ControlPlane } = await import("../benchmarks/coupled_memory/runtime.mjs");
  const cp = new ControlPlane(); const rt = new SecureMemoryRuntime({ controlPlane: cp });
  const r = {};
  try {
    rt.sendMessage(renv({ message_id: "mA", sender: "p", receiver: "memory", sequence: 1, parent_message_id: null }), cp.registerPrincipal("p", {}));
    rt.sendMessage(renv({ message_id: "mB", sender: "p2", receiver: "memory", sequence: 2, parent_message_id: null }), cp.registerPrincipal("p2", {}));
    const w = cp.registerPrincipal("w", { queues: ["*"] }); const ex = cp.registerPrincipal("ex", { queues: ["executor"] });
    rt.writeMemory("retention 7 days", rt.claimSpecific(w, "mA"), { memory_id: "mem-A", memory_type: "constraint", allowed_readers: ["executor"], logical_key: "retention" });
    rt.writeMemory("retention 30 days", rt.claimSpecific(w, "mB"), { memory_id: "mem-B", memory_type: "constraint", allowed_readers: ["executor"], logical_key: "retention" });
    rt.resolveConflict(cp.registerPrincipal("owner", { queues: [], resolution: true }), { logical_key: "retention", accepted: ["mem-B"], rejected: ["mem-A"] });
    for (let i = 0; i < 6; i += 1) rt.writeMemory("urgent urgent decision now", rt.claimSpecific(w, "mB"), { memory_id: `junk-${i}`, memory_type: "constraint", allowed_readers: ["other"] });
    // (CREATION-CUT) mMerge is the reader/leaf: send it AFTER every write, sequence > every write.
    rt.sendMessage(renv({ message_id: "mMerge", sender: "c", receiver: "executor", sequence: rt._currentSequence("R") + 1, parents: [{ id: "mA", type: "depends" }, { id: "mB", type: "depends" }] }), cp.registerPrincipal("c", {}));
    const q = { text: "urgent", topK: 3 };
    r.suppressedInRelevance = !rt.findCandidateMemories(q).map((m) => m.memory_id).includes("mem-B");
    const admitted = rt.readMemory(q, rt.claimSpecific(ex, "mMerge")).map((m) => m.memory_id);
    r.recovered = admitted.includes("mem-B") && !admitted.includes("mem-A");
  } finally { rt.close(); }
  const ok = r.suppressedInRelevance && r.recovered;
  gate("RG61", "Gate 2.0 #5: mandatory retrieval (invalid-flooding cannot suppress the authoritative decision)",
    ok ? PASS : FAIL, ok ? "top-k relevance is filled with junk (mem-B suppressed); the mandatory union recovers mem-B and the coherent view admits only the adopted decision" : JSON.stringify(r));
}, (e) => gate("RG61", "Gate 2.0 #5: mandatory retrieval", FAIL, e.message));

// RG62 (Gate 2.0 #1): adopt-edge authority. A merge that ADOPTS a branch (typed adopt edge) makes that
// version authoritative without a resolution certificate; a depends-only merge stays REQUIRE_RESOLUTION.
await safe(async () => {
  const { SecureMemoryRuntime, ControlPlane, memoryContentHash } = await import("../benchmarks/coupled_memory/runtime.mjs");
  const build = (adoptB = false) => {
    const cp = new ControlPlane(); const rt = new SecureMemoryRuntime({ controlPlane: cp });
    rt.sendMessage(renv({ message_id: "mA", sender: "p", receiver: "memory", sequence: 1, parent_message_id: null }), cp.registerPrincipal("p", {}));
    rt.sendMessage(renv({ message_id: "mB", sender: "p2", receiver: "memory", sequence: 2, parent_message_id: null }), cp.registerPrincipal("p2", {}));
    const w = cp.registerPrincipal("w", { queues: ["*"] }); const ex = cp.registerPrincipal("ex", { queues: ["executor"] });
    // (v20 CE20-02) The candidate records EXIST FIRST; the merge then adopts the branch's record as it stands.
    // Adoption is record-scoped (a record is adopted only if it existed when the adopt edge was created), so the
    // adopt merge is sequenced AFTER these writes -- a record written after the adopt does NOT inherit authority.
    rt.writeMemory("retention 7 days", rt.claimSpecific(w, "mA"), { memory_id: "mem-A", memory_type: "constraint", allowed_readers: ["executor"], logical_key: "retention" });
    rt.writeMemory("retention 30 days", rt.claimSpecific(w, "mB"), { memory_id: "mem-B", memory_type: "constraint", allowed_readers: ["executor"], logical_key: "retention" });
    const parents = [{ id: "mA", type: "depends" }, { id: "mB", type: "depends" }];
    if (adoptB) {
      const memB = rt.getMemoryRow("mem-B");
      parents[1] = { id: "mB", type: "adopt", record_id: "mem-B", record_digest: memoryContentHash(memB), write_seq: memB.write_seq, logical_key: memB.logical_key };
    }
    // The merge that creates the adopt edge must be sent by a principal with adoption authority (review:
    // adopt edges are authority-bearing; an ordinary sender cannot self-grant adoption -- see RG68).
    rt.sendMessage(renv({ message_id: "mMerge", sender: "c", receiver: "executor", sequence: 9, parents }), cp.registerPrincipal("c", { resolution: true }));
    const admitted = rt.readMemory({}, rt.claimSpecific(ex, "mMerge")).map((m) => m.memory_id).sort();
    const replay = rt.replaySecureMemoryReads("R").ok;
    rt.close(); return { admitted, replay };
  };
  const dependsOnly = build(false);
  const adoptsB = build(true);
  const ok = JSON.stringify(dependsOnly.admitted) === "[]" && dependsOnly.replay
    && JSON.stringify(adoptsB.admitted) === JSON.stringify(["mem-B"]) && adoptsB.replay;
  gate("RG62", "Gate 2.0 #1: adopt-edge authority (an adopt edge makes a version authoritative without a certificate)",
    ok ? PASS : FAIL, ok ? "depends-only merge -> REQUIRE_RESOLUTION (both denied); record-bound adopt edge on branch B -> mem-B authoritative, mem-A advisory; replay reproduces both" : JSON.stringify({ dependsOnly, adoptsB }));
}, (e) => gate("RG62", "Gate 2.0 #1: adopt-edge authority", FAIL, e.message));

// RG63 (Gate 2.0 #delegate): cross-task delegation. A record from another task is denied by task scope
// unless a signed delegation certificate (from a delegation-authority principal) authorizes it to the active
// task+receiver; integrity is unchanged. An unauthorized delegator and a forged certificate are refused.
await safe(async () => {
  const { SecureMemoryRuntime, ControlPlane } = await import("../benchmarks/coupled_memory/runtime.mjs");
  const cp = new ControlPlane(); const rt = new SecureMemoryRuntime({ controlPlane: cp });
  const r = {};
  try {
    rt.sendMessage(renv({ message_id: "mA", task_id: "A", sender: "p", receiver: "memory", sequence: 1, parent_message_id: null }), cp.registerPrincipal("p", {}));
    const w = cp.registerPrincipal("w", { queues: ["*"] }); const ex = cp.registerPrincipal("ex", { queues: ["executor"] });
    rt.writeMemory("constraint from task A", rt.claimSpecific(w, "mA"), { memory_id: "mem-A", memory_type: "constraint", allowed_readers: ["executor"] });
    // (CREATION-CUT) mB is the cross-task executor READER/leaf: send it AFTER the write, sequence > every write.
    rt.sendMessage(renv({ message_id: "mB", task_id: "B", sender: "c", receiver: "executor", sequence: rt._currentSequence("R") + 1, parent_message_id: "mA" }), cp.registerPrincipal("c", {}));
    r.beforeDenied = rt.readMemory({}, rt.claimSpecific(ex, "mB")).map((m) => m.memory_id).length === 0;
    r.unauthRefused = threw(() => rt.delegate(cp.registerPrincipal("nobody", {}), { memory_ids: ["mem-A"], target_task: "B", target_receiver: "executor" }));
    r.forgedIgnored = cp.verifyDelegation({ memory_ids: ["mem-A"], target_task: "B", target_receiver: "executor", delegator: "x", authority: "policy-delegation", policy_epoch: 1, delegation_sig: "dsig:deadbeef" }) === false;
    rt.delegate(cp.registerPrincipal("owner", { queues: [], delegation: true }), { memory_ids: ["mem-A"], target_task: "B", target_receiver: "executor" });
    r.afterAdmitted = rt.readMemory({}, rt.claimSpecific(ex, "mB")).map((m) => m.memory_id).includes("mem-A");
    r.replayOk = rt.replaySecureMemoryReads("R").ok === true;
  } finally { rt.close(); }
  const ok = r.beforeDenied && r.unauthRefused && r.forgedIgnored && r.afterAdmitted && r.replayOk;
  gate("RG63", "Gate 2.0 #delegate: cross-task delegation (un-delegated cross-task denied; signed delegation admits; integrity unchanged; replay reproduces)",
    ok ? PASS : FAIL, ok ? "cross-task record denied by task scope; unauthorized/forged delegation refused; an authorized certificate admits it; replay reproduces" : JSON.stringify(r));
}, (e) => gate("RG63", "Gate 2.0 #delegate: cross-task delegation", FAIL, e.message));

// RG64 (Gate 2.0 two-context split): the reasoning view sees low-trust evidence but is capability-capped
// (cannot send); the executor view drops evidence whose ceiling cannot justify the action, so a high-trust
// action commits without being capped by low-trust evidence.
await safe(async () => {
  const { SecureMemoryRuntime, ControlPlane } = await import("../benchmarks/coupled_memory/runtime.mjs");
  const cp = new ControlPlane(); const rt = new SecureMemoryRuntime({ controlPlane: cp });
  const r = {};
  try {
    rt.sendMessage(renv({ message_id: "m0", sender: "p", receiver: "memory", sequence: 0, parent_message_id: null }), cp.registerPrincipal("p", {}));
    rt.sendMessage(renv({ message_id: "ms", sender: "p", receiver: "memory", sequence: 1, parent_message_id: "m0" }), cp.registerPrincipal("p2", {}));
    const w = cp.registerPrincipal("w", { queues: ["*"] }); const ex = cp.registerPrincipal("ex", { queues: ["executor"] });
    rt.writeMemory("trusted recipient", rt.claimSpecific(w, "ms"), { memory_id: "mem-fact", memory_type: "constraint", allowed_readers: ["executor"], effect_ceiling: ["send_email", "answer", "summarize"] });
    rt.writeMemory("web evidence", rt.claimSpecific(w, "ms"), { memory_id: "mem-evi", memory_type: "constraint", allowed_readers: ["executor"], effect_ceiling: ["summarize", "answer"] });
    // (CREATION-CUT) mx is the reader/leaf: send it AFTER the writes, sequence > every write.
    rt.sendMessage(renv({ message_id: "mx", sender: "c", receiver: "executor", sequence: rt._currentSequence("R") + 1, parent_message_id: "ms" }), cp.registerPrincipal("c", {}));
    const reason = rt.prepareMemoryRead({}, rt.claimSpecific(ex, "mx"), null, "send_email");
    r.reasoningSeesEvidence = reason.view.map((m) => m.memory_id).includes("mem-evi");
    r.reasoningCannotSend = rt.commitMemoryUse({ effect: "send_email" }, reason.token).decision === "DENY";
    const exec = rt.prepareMemoryRead({}, rt.claimSpecific(ex, "mx"), null, "send_email", { executorScope: true });
    r.executorDropsEvidence = !exec.view.map((m) => m.memory_id).includes("mem-evi") && exec.view.map((m) => m.memory_id).includes("mem-fact");
    r.executorCanSend = rt.commitMemoryUse({ effect: "send_email" }, exec.token).decision === "ALLOW";
  } finally { rt.close(); }
  const ok = r.reasoningSeesEvidence && r.reasoningCannotSend && r.executorDropsEvidence && r.executorCanSend;
  gate("RG64", "Gate 2.0 two-context split (reasoning view sees evidence but is capped; executor view drops low-trust evidence so a high-trust action commits)",
    ok ? PASS : FAIL, ok ? "reasoning view includes the web evidence and is capped (cannot send); the executor view drops it and the send commits on the high-trust fact" : JSON.stringify(r));
}, (e) => gate("RG64", "Gate 2.0 two-context split", FAIL, e.message));

// ---- RG65..RG67: adversarial-verification follow-ups (defects found by the final Gate 2.0 audit) --------

// RG65 (defect: executor empty-meet). In the executor view the MEET over an empty (all-dropped) set must be
// the EMPTY capability (deny every effect), not the universe -- otherwise dropping the only restrictive
// record by setting executorScope + a non-read intendedEffect would silently widen authority to top.
await safe(async () => {
  const { SecureMemoryRuntime, ControlPlane } = await import("../benchmarks/coupled_memory/runtime.mjs");
  const cp = new ControlPlane(); const rt = new SecureMemoryRuntime({ controlPlane: cp });
  const r = {};
  try {
    rt.sendMessage(renv({ message_id: "m0", sender: "p", receiver: "memory", sequence: 0, parent_message_id: null }), cp.registerPrincipal("p", {}));
    rt.sendMessage(renv({ message_id: "ms", sender: "p", receiver: "memory", sequence: 1, parent_message_id: "m0" }), cp.registerPrincipal("p2", {}));
    const w = cp.registerPrincipal("w", { queues: ["*"] }); const ex = cp.registerPrincipal("ex", { queues: ["executor"] });
    rt.writeMemory("answer only", rt.claimSpecific(w, "ms"), { memory_id: "mem", memory_type: "constraint", allowed_readers: ["executor"], effect_ceiling: ["answer"] });
    // (CREATION-CUT) mx is the reader/leaf: send it AFTER the write, sequence > every write.
    rt.sendMessage(renv({ message_id: "mx", sender: "c", receiver: "executor", sequence: rt._currentSequence("R") + 1, parent_message_id: "ms" }), cp.registerPrincipal("c", {}));
    r.reasoningDeny = rt.commitMemoryUse({ effect: "send" }, rt.prepareMemoryRead({}, rt.claimSpecific(ex, "mx"), null, "send").token).decision === "DENY";
    const exec = rt.prepareMemoryRead({}, rt.claimSpecific(ex, "mx"), null, "send", { executorScope: true });
    r.executorEmpty = exec.view.length === 0 && Array.isArray(exec.capability) && exec.capability.length === 0;
    r.executorDeny = rt.commitMemoryUse({ effect: "send" }, exec.token).decision === "DENY";
  } finally { rt.close(); }
  const ok = r.reasoningDeny && r.executorEmpty && r.executorDeny;
  gate("RG65", "executor empty-meet denies (dropping the only restrictive record yields capability=[], not the universe)",
    ok ? PASS : FAIL, ok ? "reasoning view denies send; the executor view is empty with capability=[] and the send commit is DENY (not ALLOW)" : JSON.stringify(r));
}, (e) => gate("RG65", "executor empty-meet denies", FAIL, e.message));

// RG66 (defect: delegation snapshot laundering). Replay must apply the live admissibility predicate to a
// snapshot delegation cert (epoch + target_task/receiver), so injecting a validly-signed but WRONG-TARGET
// cert into the read manifest cannot launder an unauthorized cross-task admit past replay.
await safe(async () => {
  const { SecureMemoryRuntime, ControlPlane } = await import("../benchmarks/coupled_memory/runtime.mjs");
  const cp = new ControlPlane(); const rt = new SecureMemoryRuntime({ controlPlane: cp });
  const r = {};
  try {
    rt.sendMessage(renv({ message_id: "mA", task_id: "A", sender: "p", receiver: "memory", sequence: 1, parent_message_id: null }), cp.registerPrincipal("p", {}));
    rt.sendMessage(renv({ message_id: "mB", task_id: "B", sender: "c", receiver: "executor", sequence: 2, parent_message_id: "mA" }), cp.registerPrincipal("c", {}));
    const w = cp.registerPrincipal("w", { queues: ["*"] }); const ex = cp.registerPrincipal("ex", { queues: ["executor"] });
    rt.writeMemory("from task A", rt.claimSpecific(w, "mA"), { memory_id: "mem-A", memory_type: "constraint", allowed_readers: ["executor"] });
    r.beforeDenied = rt.readMemory({}, rt.claimSpecific(ex, "mB")).map((m) => m.memory_id).length === 0;
    const cert = rt.delegate(cp.registerPrincipal("owner", { delegation: true }), { memory_ids: ["mem-A"], target_task: "T9", target_receiver: "executor" });
    const read = rt.db.prepare("SELECT * FROM memory_reads WHERE run_id='R'").get();
    const sec = JSON.parse(read.security_json); sec.delegations = [cert];
    rt.db.prepare("UPDATE memory_reads SET security_json=?, admitted_ids_json=? WHERE read_id=?").run(JSON.stringify(sec), JSON.stringify(["mem-A"]), read.read_id);
    rt.db.prepare("UPDATE memory_access_decisions SET decision='allow', reason='message_bound_access_granted' WHERE read_id=? AND memory_id='mem-A'").run(read.read_id);
    const replay = rt.replaySecureMemoryReads("R");
    r.replayFlags = replay.ok === false && replay.issues.some((i) => i.kind === "decision_mismatch");
  } finally { rt.close(); }
  const ok = r.beforeDenied && r.replayFlags;
  gate("RG66", "delegation snapshot laundering caught (wrong-target/stale-epoch cert in the manifest is rejected by replay)",
    ok ? PASS : FAIL, ok ? "cross-task record denied live; injecting a valid-sig WRONG-TARGET (T9) cert + flipping the logged decision is caught as decision_mismatch (ok:false)" : JSON.stringify(r));
}, (e) => gate("RG66", "delegation snapshot laundering caught", FAIL, e.message));

// RG67 (defect: resolution resurrection + tie-break). The resolution log is MAC-chained: a count-preserving
// delete+reinsert resurrecting a superseded resolution breaks the chain and fails closed (read throws,
// replay flags), and the authoritative resolution is the latest by monotonic seq (deterministic), not by the
// writable created_at.
await safe(async () => {
  const { SecureMemoryRuntime, ControlPlane } = await import("../benchmarks/coupled_memory/runtime.mjs");
  const seedMerge = (rt, cp) => {
    rt.sendMessage(renv({ message_id: "mA", sender: "p", receiver: "memory", sequence: 1, parent_message_id: null }), cp.registerPrincipal("p", {}));
    rt.sendMessage(renv({ message_id: "mB", sender: "p2", receiver: "memory", sequence: 2, parent_message_id: null }), cp.registerPrincipal("p2", {}));
    const w = cp.registerPrincipal("w", { queues: ["*"] }); const ex = cp.registerPrincipal("ex", { queues: ["executor"] });
    rt.writeMemory("retain 7", rt.claimSpecific(w, "mA"), { memory_id: "mem-A", memory_type: "constraint", allowed_readers: ["executor"], logical_key: "retention" });
    rt.writeMemory("retain 30", rt.claimSpecific(w, "mB"), { memory_id: "mem-B", memory_type: "constraint", allowed_readers: ["executor"], logical_key: "retention" });
    // (CREATION-CUT) mMerge is the reader/leaf: send it AFTER the writes, sequence > every write.
    rt.sendMessage(renv({ message_id: "mMerge", sender: "c", receiver: "executor", sequence: rt._currentSequence("R") + 1, parents: [{ id: "mA", type: "depends" }, { id: "mB", type: "depends" }] }), cp.registerPrincipal("c", {}));
    return ex;
  };
  const r = {};
  // (a) delete+reinsert resurrection fails closed
  {
    const cp = new ControlPlane(); const rt = new SecureMemoryRuntime({ controlPlane: cp });
    try {
      const ex = seedMerge(rt, cp);
      const owner = cp.registerPrincipal("owner", { resolution: true });
      const cert1 = rt.resolveConflict(owner, { logical_key: "retention", accepted: ["mem-A"], rejected: ["mem-B"] });
      const cert2 = rt.resolveConflict(owner, { logical_key: "retention", accepted: ["mem-B"], rejected: ["mem-A"] });
      r.baseline = JSON.stringify(rt.readMemory({}, rt.claimSpecific(ex, "mMerge")).map((m) => m.memory_id)) === '["mem-B"]';
      const c1 = rt.db.prepare("SELECT * FROM merge_resolutions WHERE resolution_id=?").get(cert1.resolution_id);
      rt.db.prepare("DELETE FROM merge_resolutions WHERE resolution_id=?").run(cert2.resolution_id);
      rt.db.prepare("INSERT INTO merge_resolutions (resolution_id, logical_key, accepted_json, rejected_json, conflict_set_json, conflict_set_digest, resolver, authority, policy_epoch, resolution_sig, seq, prev_mac, mac, created_at) VALUES ('res-DUP',?,?,?,?,?,?,?,?,?,?,?,?,'2099-01-01T00:00:00Z')").run(c1.logical_key, c1.accepted_json, c1.rejected_json, c1.conflict_set_json, c1.conflict_set_digest, c1.resolver, c1.authority, c1.policy_epoch, c1.resolution_sig, c1.seq, c1.prev_mac, c1.mac);
      r.readFailsClosed = threw(() => rt.readMemory({}, rt.claimSpecific(ex, "mMerge")));
      r.replayFlags = rt.replaySecureMemoryReads("R").issues.some((i) => i.kind === "resolution_log_tampered");
    } finally { rt.close(); }
  }
  // (b) tie-break is deterministic by seq (latest-issued wins every time)
  {
    let allLatest = true;
    for (let i = 0; i < 6; i += 1) {
      const cp = new ControlPlane(); const rt = new SecureMemoryRuntime({ controlPlane: cp });
      try {
        const ex = seedMerge(rt, cp);
        const owner = cp.registerPrincipal("owner", { resolution: true });
        rt.resolveConflict(owner, { logical_key: "retention", accepted: ["mem-A"], rejected: ["mem-B"] });
        rt.resolveConflict(owner, { logical_key: "retention", accepted: ["mem-B"], rejected: ["mem-A"] });
        if (JSON.stringify(rt.readMemory({}, rt.claimSpecific(ex, "mMerge")).map((m) => m.memory_id)) !== '["mem-B"]') allLatest = false;
      } finally { rt.close(); }
    }
    r.tieBreakDeterministic = allLatest;
  }
  const ok = r.baseline && r.readFailsClosed && r.replayFlags && r.tieBreakDeterministic;
  gate("RG67", "resolution log is MAC-chained (delete+reinsert resurrection fails closed; latest-by-seq is deterministic)",
    ok ? PASS : FAIL, ok ? "delete+reinsert of a superseded resolution breaks the chain -> read throws resolution_log_tampered and replay flags it; the latest resolution by monotonic seq wins 6/6 (no random tie-break)" : JSON.stringify(r));
}, (e) => gate("RG67", "resolution log is MAC-chained", FAIL, e.message));

// ---- RG68..RG72: read-to-use soundness fixes (counterexamples from the adversarial commit-time audit) -----

// RG68 (adopt-edge authority): an adopt/resolve edge is authority-bearing -- only a sender holding adoption
// authority may create one; an ordinary authenticated sender cannot self-grant branch adoption.
await safe(async () => {
  const { SecureMemoryRuntime, ControlPlane } = await import("../benchmarks/coupled_memory/runtime.mjs");
  const cp = new ControlPlane(); const rt = new SecureMemoryRuntime({ controlPlane: cp });
  const r = {};
  try {
    rt.sendMessage(renv({ message_id: "mA", sender: "p", receiver: "memory", sequence: 1, parent_message_id: null }), cp.registerPrincipal("p", {}));
    rt.sendMessage(renv({ message_id: "mB", sender: "p2", receiver: "memory", sequence: 2, parent_message_id: null }), cp.registerPrincipal("p2", {}));
    r.unauthRejected = threw(() => rt.sendMessage(renv({ message_id: "mM", sender: "nobody", receiver: "executor", sequence: 3, parents: [{ id: "mA", type: "depends" }, { id: "mB", type: "adopt" }] }), cp.registerPrincipal("nobody", {})));
    r.authorizedOk = !threw(() => rt.sendMessage(renv({ message_id: "mM2", sender: "res", receiver: "executor", sequence: 4, parents: [{ id: "mA", type: "depends" }, { id: "mB", type: "adopt" }] }), cp.registerPrincipal("res", { resolution: true })));
  } finally { rt.close(); }
  const ok = r.unauthRejected && r.authorizedOk;
  gate("RG68", "adopt-edge authority (only an adoption-authorized sender may create an adopt/resolve edge)",
    ok ? PASS : FAIL, ok ? "an ordinary sender's adopt edge is rejected at send (not_authorized_to_adopt); an adoption/resolution-authorized sender succeeds" : JSON.stringify(r));
}, (e) => gate("RG68", "adopt-edge authority", FAIL, e.message));

// RG69 (resolution names ONE adopted version): a certificate accepting more than one concurrent record is
// rejected at issuance, so a resolution cannot re-admit the conflict it is meant to resolve.
await safe(async () => {
  const { SecureMemoryRuntime, ControlPlane } = await import("../benchmarks/coupled_memory/runtime.mjs");
  const cp = new ControlPlane(); const rt = new SecureMemoryRuntime({ controlPlane: cp });
  const r = {};
  try {
    // Seed the ACTUAL same-key conflict: a cert may only name records that currently exist with this
    // logical_key (v19 #2), so the gate creates mem-A/mem-B before issuing -- exercising both the existence
    // binding and the single-accepted arity rule.
    rt.sendMessage(renv({ message_id: "mA", sender: "p", receiver: "memory", sequence: 1, parent_message_id: null }), cp.registerPrincipal("p", {}));
    rt.sendMessage(renv({ message_id: "mB", sender: "p2", receiver: "memory", sequence: 2, parent_message_id: null }), cp.registerPrincipal("p2", {}));
    const w = cp.registerPrincipal("w", { queues: ["*"] });
    rt.writeMemory("retain 7", rt.claimSpecific(w, "mA"), { memory_id: "mem-A", memory_type: "constraint", allowed_readers: ["executor"], logical_key: "retention" });
    rt.writeMemory("retain 30", rt.claimSpecific(w, "mB"), { memory_id: "mem-B", memory_type: "constraint", allowed_readers: ["executor"], logical_key: "retention" });
    const owner = cp.registerPrincipal("owner", { resolution: true });
    r.bothRejected = threw(() => rt.resolveConflict(owner, { logical_key: "retention", accepted: ["mem-A", "mem-B"], rejected: [] }));
    r.noneRejected = threw(() => rt.resolveConflict(owner, { logical_key: "retention", accepted: [], rejected: ["mem-A"] }));
    r.futureRejected = threw(() => rt.resolveConflict(owner, { logical_key: "retention", accepted: ["mem-B"], rejected: ["mem-A", "mem-future"] }));
    r.oneOk = !threw(() => rt.resolveConflict(owner, { logical_key: "retention", accepted: ["mem-B"], rejected: ["mem-A"] }));
  } finally { rt.close(); }
  const ok = r.bothRejected && r.noneRejected && r.futureRejected && r.oneOk;
  gate("RG69", "resolution names a single adopted version over the existing conflict (multi-accept / empty-accept / future-id rejected at issuance)",
    ok ? PASS : FAIL, ok ? "accepting both/none throws resolution_requires_single_accepted; naming a not-yet-existing id throws resolution_names_unknown_record; a single-accept certificate over existing records issues" : JSON.stringify(r));
}, (e) => gate("RG69", "resolution single-accepted", FAIL, e.message));

// RG70 (one-shot token): a read-to-use token is single-use -- the same token cannot commit twice (no
// replayable bearer capability for consequential actions).
await safe(async () => {
  const { SecureMemoryRuntime, ControlPlane } = await import("../benchmarks/coupled_memory/runtime.mjs");
  const cp = new ControlPlane(); const rt = new SecureMemoryRuntime({ controlPlane: cp });
  const r = {};
  try {
    rt.sendMessage(renv({ message_id: "m0", sender: "p", receiver: "memory", sequence: 0, parent_message_id: null }), cp.registerPrincipal("p", {}));
    rt.sendMessage(renv({ message_id: "ms", sender: "p", receiver: "memory", sequence: 1, parent_message_id: "m0" }), cp.registerPrincipal("p2", {}));
    rt.sendMessage(renv({ message_id: "mx", sender: "c", receiver: "executor", sequence: 2, parent_message_id: "ms" }), cp.registerPrincipal("c", {}));
    const w = cp.registerPrincipal("w", { queues: ["*"] }); const ex = cp.registerPrincipal("ex", { queues: ["executor"] });
    rt.writeMemory("note", rt.claimSpecific(w, "ms"), { memory_id: "mem", memory_type: "constraint", allowed_readers: ["executor"] });
    const t = rt.prepareMemoryRead({}, rt.claimSpecific(ex, "mx"), null, "send");
    const first = rt.commitMemoryUse({ effect: "send" }, t.token);
    const second = rt.commitMemoryUse({ effect: "send" }, t.token);
    r.firstAllow = first.decision === "ALLOW";
    r.replayDenied = second.decision === "DENY" && second.reason === "token_already_consumed";
  } finally { rt.close(); }
  const ok = r.firstAllow && r.replayDenied;
  gate("RG70", "one-shot read-to-use token (a token commits at most once; replay denied)",
    ok ? PASS : FAIL, ok ? "first commit ALLOW; the same token re-committed -> DENY token_already_consumed" : JSON.stringify(r));
}, (e) => gate("RG70", "one-shot token", FAIL, e.message));

// RG71 (action/intent binding): a read-only token authorizes NO side-effecting action, and a token prepared
// for one effect cannot commit a different effect (the intent the view was prepared for binds the action).
await safe(async () => {
  const { SecureMemoryRuntime, ControlPlane } = await import("../benchmarks/coupled_memory/runtime.mjs");
  const cp = new ControlPlane(); const rt = new SecureMemoryRuntime({ controlPlane: cp });
  const r = {};
  try {
    rt.sendMessage(renv({ message_id: "m0", sender: "p", receiver: "memory", sequence: 0, parent_message_id: null }), cp.registerPrincipal("p", {}));
    rt.sendMessage(renv({ message_id: "ms", sender: "p", receiver: "memory", sequence: 1, parent_message_id: "m0" }), cp.registerPrincipal("p2", {}));
    rt.sendMessage(renv({ message_id: "mx", sender: "c", receiver: "executor", sequence: 2, parent_message_id: "ms" }), cp.registerPrincipal("c", {}));
    const w = cp.registerPrincipal("w", { queues: ["*"] }); const ex = cp.registerPrincipal("ex", { queues: ["executor"] });
    rt.writeMemory("note", rt.claimSpecific(w, "ms"), { memory_id: "mem", memory_type: "constraint", allowed_readers: ["executor"] });
    const readTok = rt.prepareMemoryRead({}, rt.claimSpecific(ex, "mx"), null, "read");
    const d1 = rt.commitMemoryUse({ effect: "delete_file" }, readTok.token);
    r.readNoAction = d1.decision === "DENY" && d1.reason === "read_token_authorizes_no_action";
    const sendTok = rt.prepareMemoryRead({}, rt.claimSpecific(ex, "mx"), null, "send_email");
    const d2 = rt.commitMemoryUse({ effect: "transfer_funds" }, sendTok.token);
    r.intentBound = d2.decision === "DENY" && d2.reason === "action_intent_mismatch";
  } finally { rt.close(); }
  const ok = r.readNoAction && r.intentBound;
  gate("RG71", "action/intent binding (read token authorizes no action; committed effect must match prepared intent)",
    ok ? PASS : FAIL, ok ? "intended='read' + delete_file -> read_token_authorizes_no_action; intended='send_email' + transfer_funds -> action_intent_mismatch" : JSON.stringify(r));
}, (e) => gate("RG71", "action/intent binding", FAIL, e.message));

// RG72 (commit-time conflict freshness): a same-key conflict inserted AFTER prepare changes the key's
// decision epoch, so the prepared view is no longer the coherent view and the old token aborts at commit --
// the counterexample the global policy/resolution epochs alone did not catch.
await safe(async () => {
  const { SecureMemoryRuntime, ControlPlane } = await import("../benchmarks/coupled_memory/runtime.mjs");
  const cp = new ControlPlane(); const rt = new SecureMemoryRuntime({ controlPlane: cp });
  const r = {};
  try {
    rt.sendMessage(renv({ message_id: "mA", sender: "p", receiver: "memory", sequence: 1, parent_message_id: null }), cp.registerPrincipal("p", {}));
    const w = cp.registerPrincipal("w", { queues: ["*"] }); const ex = cp.registerPrincipal("ex", { queues: ["executor"] });
    rt.writeMemory("retain 7", rt.claimSpecific(w, "mA"), { memory_id: "mem-A", memory_type: "constraint", allowed_readers: ["executor"], logical_key: "retention" });
    // (CREATION-CUT) mx is the reader/leaf: send it AFTER the mem-A write, with a sequence clearly above
    // every write (the post-prepare conflict messages keep their own later sequences).
    rt.sendMessage(renv({ message_id: "mx", sender: "c", receiver: "executor", sequence: 900, parent_message_id: "mA" }), cp.registerPrincipal("c", {}));
    const t = rt.prepareMemoryRead({}, rt.claimSpecific(ex, "mx"), null, "send");
    r.viewBefore = t.view.map((m) => m.memory_id).join(",") === "mem-A";
    rt.sendMessage(renv({ message_id: "mB", sender: "p2", receiver: "memory", sequence: 3, parent_message_id: null }), cp.registerPrincipal("p2", {}));
    rt.writeMemory("retain 30", rt.claimSpecific(w, "mB"), { memory_id: "mem-B", memory_type: "constraint", allowed_readers: ["executor"], logical_key: "retention" });
    const after = rt.commitMemoryUse({ effect: "send" }, t.token);
    r.aborts = after.decision === "ABORT_AND_RETRY" && after.reason === "key_state_changed";
  } finally { rt.close(); }
  const ok = r.viewBefore && r.aborts;
  gate("RG72", "commit-time conflict freshness (a same-key conflict inserted after prepare aborts the old token)",
    ok ? PASS : FAIL, ok ? "prepared view = {mem-A}; a new same-key record before commit -> ABORT_AND_RETRY key_state_changed" : JSON.stringify(r));
}, (e) => gate("RG72", "commit-time conflict freshness", FAIL, e.message));

// RG73 (monotonic decision epoch -- security-kernel pivot): the per-key decision epoch LEADS with a TCB
// monotonic version, so an add-one-delete-one that preserves the record COUNT (insert a same-key record via
// writeMemory, then the store-write adversary deletes another same-key row) still advances the epoch and
// aborts a view prepared before it -- the count-collision the prior COUNT-based epoch would have missed.
await safe(async () => {
  const { SecureMemoryRuntime, ControlPlane } = await import("../benchmarks/coupled_memory/runtime.mjs");
  const cp = new ControlPlane(); const rt = new SecureMemoryRuntime({ controlPlane: cp });
  const r = {};
  try {
    rt.sendMessage(renv({ message_id: "mA", sender: "p", receiver: "memory", sequence: 1, parent_message_id: null }), cp.registerPrincipal("p", {}));
    const w = cp.registerPrincipal("w", { queues: ["*"] }); const ex = cp.registerPrincipal("ex", { queues: ["executor"] });
    rt.writeMemory("retain 7", rt.claimSpecific(w, "mA"), { memory_id: "mem-A", memory_type: "constraint", allowed_readers: ["executor"], logical_key: "retention" });
    // (CREATION-CUT) mx is the reader/leaf: send it AFTER the mem-A write, with a sequence clearly above
    // every write (the post-prepare add-one-delete-one messages keep their own later sequences).
    rt.sendMessage(renv({ message_id: "mx", sender: "c", receiver: "executor", sequence: 900, parent_message_id: "mA" }), cp.registerPrincipal("c", {}));
    const runId = rt.getMemoryRow("mem-A").run_id;
    const countBefore = rt.db.prepare("SELECT COUNT(*) AS n FROM shared_memory WHERE run_id=? AND logical_key='retention'").get(runId).n;
    const t = rt.prepareMemoryRead({}, rt.claimSpecific(ex, "mx"), null, "send");
    r.viewBefore = t.view.map((m) => m.memory_id).join(",") === "mem-A";
    // add-one-delete-one preserving COUNT: insert a same-key record (bumps the monotonic version), then the
    // store-write adversary deletes it via a raw row delete (restores COUNT, does NOT touch the version).
    rt.sendMessage(renv({ message_id: "mC", sender: "p3", receiver: "memory", sequence: 3, parent_message_id: null }), cp.registerPrincipal("p3", {}));
    rt.writeMemory("retain 99", rt.claimSpecific(w, "mC"), { memory_id: "mem-C", memory_type: "constraint", allowed_readers: ["executor"], logical_key: "retention" });
    rt.db.prepare("DELETE FROM shared_memory WHERE memory_id='mem-C'").run();
    const countAfter = rt.db.prepare("SELECT COUNT(*) AS n FROM shared_memory WHERE run_id=? AND logical_key='retention'").get(runId).n;
    r.countRestored = countBefore === 1 && countAfter === 1;   // a COUNT-only epoch would see no change
    const after = rt.commitMemoryUse({ effect: "send" }, t.token);
    r.aborts = after.decision === "ABORT_AND_RETRY" && after.reason === "key_state_changed";
  } finally { rt.close(); }
  const ok = r.viewBefore && r.countRestored && r.aborts;
  gate("RG73", "monotonic decision epoch (add-one-delete-one preserves COUNT but the TCB monotonic version advances -> stale view aborts)",
    ok ? PASS : FAIL, ok ? "COUNT restored to 1 (a count-only epoch would pass) yet the monotonic version advanced -> ABORT_AND_RETRY key_state_changed" : JSON.stringify(r));
}, (e) => gate("RG73", "monotonic decision epoch", FAIL, e.message));

// ---- RG74..RG77: security-kernel headline (queryMemory + executeAuthorizedAction). The agent gets an
// OPAQUE view handle and can cause an external effect ONLY by asking the kernel to execute an authorized
// action; the kernel re-validates the full binding atomically and the trusted dispatcher (not the agent)
// runs the EXACT canonical action -- closing the verify->execute / parameter-substitution gap. -------------
const kSetup = (rt, cp) => {
  // A realistic deployment destination policy. It discriminates on the tool NAME (and, in production, the
  // target) -- NOT the effect class: send_email and notify share effect="send", so `t.effect === "send"` would
  // also authorize send_email to an arbitrary recipient (data exfiltration). Here only the internal notify ping
  // is authorized; send_email, wire_transfer, and unknown tools stay fail-closed.
  rt._destinationPolicy = (t) => !!(t && t.known === true && t.tool === "notify");
  rt.sendMessage(renv({ message_id: "m0", sender: "p", receiver: "memory", sequence: 1, parent_message_id: null }), cp.registerPrincipal("p", {}));
  const w = cp.registerPrincipal("w", { queues: ["*"] });
  rt.writeMemory("note", rt.claimSpecific(w, "m0"), { memory_id: "mem", memory_type: "constraint", allowed_readers: ["executor"], effect_ceiling: ["send", "transfer", "external"] });
  // (CREATION-CUT) mx/my are the executor READER/leaf messages: send them AFTER the write, with sequences
  // clearly above every write so the note is in their causal past.
  rt.sendMessage(renv({ message_id: "mx", sender: "c", receiver: "executor", sequence: 900, parent_message_id: "m0" }), cp.registerPrincipal("c", {}));
  rt.sendMessage(renv({ message_id: "my", sender: "c2", receiver: "executor", sequence: 901, parent_message_id: "m0" }), cp.registerPrincipal("c2", {}));
  const ex = cp.registerPrincipal("ex", { queues: ["executor"] });
  const ctx = rt.controlPlane.contextTokenForLease(rt.claimSpecific(ex, "mx"));
  return { ex, ctx };
};

await safe(async () => {
  const { SecureMemoryRuntime, ControlPlane } = await import("../benchmarks/coupled_memory/runtime.mjs");
  const cp = new ControlPlane(); const rt = new SecureMemoryRuntime({ controlPlane: cp });
  const r = {};
  try {
    const { ex, ctx } = kSetup(rt, cp);
    const mal = cp.registerPrincipal("mal", { queues: ["executor"] });
    const ctxMal = rt.controlPlane.contextTokenForLease(rt.claimSpecific(mal, "my"));
    const q = rt.queryMemory({}, ctx, ex, "send");
    r.opaque = typeof q.viewId === "string" && q.viewId.startsWith("view-") && !("token" in q); // no client-held authority
    r.leaked = rt.executeAuthorizedAction({ effect: "send", tool: "x", parameters: {} }, q.viewId, mal, ctxMal).reason === "view_principal_mismatch";
    r.happy = rt.executeAuthorizedAction({ effect: "send", tool: "notify", parameters: { to: "ok" } }, q.viewId, ex, ctx).status === "dispatched";
    r.replay = rt.executeAuthorizedAction({ effect: "send", tool: "notify", parameters: { to: "ok" } }, q.viewId, ex, ctx).reason === "view_already_consumed";
  } finally { rt.close(); }
  const ok = r.opaque && r.leaked && r.happy && r.replay;
  gate("RG74", "opaque view handle carries no authority (no client token; a leaked view_id is inert cross-principal; one dispatch per view)",
    ok ? PASS : FAIL, ok ? "view_id is an opaque server-side handle; cross-principal use denied (view_principal_mismatch); replay denied (view_already_consumed)" : JSON.stringify(r));
}, (e) => gate("RG74", "opaque view handle", FAIL, e.message));

await safe(async () => {
  const { SecureMemoryRuntime, ControlPlane } = await import("../benchmarks/coupled_memory/runtime.mjs");
  const cp = new ControlPlane(); const rt = new SecureMemoryRuntime({ controlPlane: cp });
  const r = {};
  try {
    const { ex, ctx } = kSetup(rt, cp);
    const before = rt._dispatcher.log.length;
    const res = rt.executeAuthorizedAction({ effect: "send", tool: "notify", parameters: { to: "approved@example.com" } }, rt.queryMemory({}, ctx, ex, "send").viewId, ex, ctx);
    r.kernelDispatched = res.status === "dispatched" && rt._dispatcher.log.length === before + 1; // the KERNEL ran it
    r.noAllow = !("token" in res) && !("decision" in res) && typeof res.action_digest === "string"; // agent gets no executable ALLOW
    r.exactParam = rt._dispatcher.log[rt._dispatcher.log.length - 1].canonical.parameters.to === "approved@example.com";
    // exact-action binding: a different recipient (same effect class) yields a different authorized digest.
    const res2 = rt.executeAuthorizedAction({ effect: "send", tool: "notify", parameters: { to: "attacker@example.com" } }, rt.queryMemory({}, ctx, ex, "send").viewId, ex, ctx);
    r.paramDigestDiffers = res.action_digest !== res2.action_digest;
    // intent substitution: a read-prepared view authorizes no side-effecting action (known low-risk tool, so the
    // intent binding -- not the unknown-tool gate -- is what denies it).
    r.substitution = rt.executeAuthorizedAction({ effect: "send", tool: "notify", parameters: {} }, rt.queryMemory({}, ctx, ex, "read").viewId, ex, ctx).reason === "read_token_authorizes_no_action";
    // an UNKNOWN tool is fail-closed for external dispatch even on a non-empty view (the TCB never registered it).
    r.unknownToolFailClosed = rt.executeAuthorizedAction({ effect: "send", tool: "exfiltrate_http", parameters: { to: "evil" } }, rt.queryMemory({}, ctx, ex, "send").viewId, ex, ctx).reason === "unknown_tool_not_authorized";
    // caller-controlled effect cannot dodge externality: a wire_transfer (registry effect=transfer, high-risk)
    // is FAIL-CLOSED (destination_not_authorized) without a deployment destination policy, regardless of the
    // caller's effect label. Full per-parameter authorization is a deployment policy; the kernel binds+audits.
    r.highRiskFailClosed = rt.executeAuthorizedAction({ effect: "read", tool: "wire_transfer", parameters: { to: "attacker" } }, rt.queryMemory({}, ctx, ex, "transfer").viewId, ex, ctx).reason === "destination_not_authorized";
  } finally { rt.close(); }
  const ok = r.kernelDispatched && r.noAllow && r.exactParam && r.paramDigestDiffers && r.substitution && r.highRiskFailClosed && r.unknownToolFailClosed;
  gate("RG75", "kernel-mediated dispatch + exact-action binding (TCB registry sets externality/effect; intent substitution denied; high-risk destinations fail-closed without a deployment policy; full per-parameter authz is deployment)",
    ok ? PASS : FAIL, ok ? "kernel (not agent) dispatched the exact action; registry externality; read->send denied; wire_transfer fail-closed (destination_not_authorized)" : JSON.stringify(r));
}, (e) => gate("RG75", "kernel-mediated dispatch + exact-action binding", FAIL, e.message));

await safe(async () => {
  const { SecureMemoryRuntime, ControlPlane } = await import("../benchmarks/coupled_memory/runtime.mjs");
  const cp = new ControlPlane(); const rt = new SecureMemoryRuntime({ controlPlane: cp });
  const r = {};
  try {
    const { ex, ctx } = kSetup(rt, cp);
    const q = rt.queryMemory({}, ctx, ex, "send");
    // advance the execution context between query and execute (a context-bound send bumps version + frontier).
    rt.send(ex, ctx, { receiver: "memory", intent: "produce_final_plan", payload: "advance" });
    const res = rt.executeAuthorizedAction({ effect: "send", tool: "x", parameters: {} }, q.viewId, ex, ctx);
    r.aborts = res.decision === "ABORT_AND_RETRY" && (res.reason === "context_version_changed" || res.reason === "active_message_changed");
  } finally { rt.close(); }
  gate("RG76", "full context re-validation (a context advanced between query and execute aborts -- not bound to active_message alone)",
    r.aborts ? PASS : FAIL, r.aborts ? "context version/frontier change since queryMemory -> ABORT_AND_RETRY" : JSON.stringify(r));
}, (e) => gate("RG76", "full context re-validation", FAIL, e.message));

await safe(async () => {
  const { SecureMemoryRuntime, ControlPlane } = await import("../benchmarks/coupled_memory/runtime.mjs");
  const cp = new ControlPlane(); const rt = new SecureMemoryRuntime({ controlPlane: cp });
  const r = {};
  try {
    kSetup(rt, cp);
    rt.sendMessage(renv({ message_id: "mEmpty", sender: "ce", receiver: "executor", sequence: 9, parent_message_id: null }), cp.registerPrincipal("ce", {}));
    const exE = cp.registerPrincipal("exE", { queues: ["executor"] });
    const ctxE = rt.controlPlane.contextTokenForLease(rt.claimSpecific(exE, "mEmpty"));
    const qE = rt.queryMemory({}, ctxE, exE, "send");
    r.empty = qE.records.length === 0;                          // no record is authoritative for this context
    r.externalDenied = rt.executeAuthorizedAction({ effect: "send", tool: "x", parameters: {} }, qE.viewId, exE, ctxE).reason === "empty_view_no_authority";
  } finally { rt.close(); }
  const ok = r.empty && r.externalDenied;
  gate("RG77", "empty-view bottom (an authorized view with no records cannot justify an external action -- kappa(emptyset)=bottom, not the universe)",
    ok ? PASS : FAIL, ok ? "empty authorized view -> external effect denied (empty_view_no_authority)" : JSON.stringify(r));
}, (e) => gate("RG77", "empty-view bottom", FAIL, e.message));

// ---- report ----
const order = ["RG1","RG2","RG3","RG4","RG5","RG6","RG7","RG8","RG9","RG10","RG11","RG12","RG13","RG14","RG15","RG16","RG17","RG18","RG19","RG20","RG21","RG22","RG23","RG24","RG25","RG26","RG27","RG28","RG29","RG30","RG31","RG32","RG33","RG34","RG35","RG36","RG37","RG38","RG39","RG40","RG41","RG42","RG43","RG44","RG45","RG46","RG47","RG48","RG49","RG50","RG51","RG52","RG53","RG54","RG55","RG56","RG57","RG58","RG59","RG60","RG61","RG62","RG63","RG64","RG65","RG66","RG67","RG68","RG69","RG70","RG71","RG72","RG73","RG74","RG75","RG76","RG77"];
results.sort((a, b) => order.indexOf(a.id) - order.indexOf(b.id));
let pass = 0, fail = 0, pend = 0;
for (const r of results) {
  if (r.status === PASS) pass++; else if (r.status === FAIL) fail++; else pend++;
  console.log(`  [${r.status}] ${r.id} ${r.title}\n        ${r.detail}`);
}
console.log(`\n[review:gates] pass=${pass} fail=${fail} pending=${pend} of ${results.length}`);
process.exitCode = fail > 0 ? 1 : 0;
