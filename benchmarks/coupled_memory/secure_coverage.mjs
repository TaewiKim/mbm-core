// Secure-profile coverage evaluation (review M4/M5/M6). This is the HEADLINE SECURITY result: it runs
// the full nine-family attack suite end-to-end through the ENFORCED SecureMemoryRuntime -- every write
// goes through an authenticated lease and is attested, every read is lease-authenticated, retirement
// comes from the authoritative lifecycle log, and the strict gate has no bypass. The earlier headline
// ran the legacy seven-predicate gate with attestation/caller-auth OFF; this one does not. It also
// fixes the reviewer's M5 finding (the long-horizon family failed 20/20 under the secure profile
// because a secure write forced status=active): old records are now retired via lifecycle events.
//
// Metrics (no API, fully deterministic):
//   - mediation coverage: number of FORBIDDEN records admitted (must be 0 per family);
//   - selection: every EXPECTED record admitted, no forbidden record admitted (per case);
//   - reconstructability: the attestation-aware secure replay reproduces every decision (ok=true).
import { SecureMemoryRuntime, ControlPlane, memoryContentHash } from "./runtime.mjs";
import { PHASE4_MAIN_SCENARIOS, PHASE4_SCENARIOS, INTEGRITY_FLOW_SCENARIOS, linkCausalParents } from "./scenarios.mjs";

// Records whose declared source message is NOT part of the scenario graph model an out-of-band store
// injection (e.g. the audit orphan). They cannot pass through the trusted write path; we inject them
// raw (valid content hash, NO receipt) so the gate denies them for lack of attestation/provenance.
function injectUnattested(rt, item, source) {
  const full = {
    memory_id: item.memory_id, run_id: source.run_id, task_id: item.task_id ?? source.task_id,
    trace_id: source.trace_id, source_message_id: item.source_message_id, writer: source.sender,
    memory_type: item.memory_type, scope: item.scope, status: item.status, content: item.content,
    content_ref: item.content_ref ?? null, allowed_readers: item.allowed_readers, supersedes: [],
    valid_from_event: null, valid_until_event: null, policy_context: item.policy_context ?? source.policy_context,
  };
  const ts = new Date().toISOString();
  rt.db.prepare(`INSERT INTO shared_memory (memory_id, run_id, task_id, trace_id, source_message_id,
    writer, memory_type, scope, status, content, content_ref, allowed_readers_json, supersedes_json,
    valid_from_event, valid_until_event, policy_context, audit_hash, write_receipt, created_at, updated_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
    full.memory_id, full.run_id, full.task_id, full.trace_id, full.source_message_id, full.writer,
    full.memory_type, full.scope, full.status, full.content, full.content_ref,
    JSON.stringify(full.allowed_readers), "[]", null, null, full.policy_context,
    memoryContentHash(full), null, ts, ts);
}

export function runSecureCoverageScenario(scenario) {
  const cp = new ControlPlane();
  const rt = new SecureMemoryRuntime({ controlPlane: cp });
  try {
    linkCausalParents(scenario.messages);
    const byMessage = new Map(scenario.messages.map((m) => [m.message_id, m]));
    // A legitimately-authorized seed writer (may serve every queue) and a lifecycle controller. These
    // model the trusted control plane's own writers; adversary capabilities are tested separately
    // (write_attestation.test.mjs / RG17--RG19), so here we exercise the GATE under the full profile.
    const seed = cp.registerPrincipal("seed-writer", { queues: ["*"] });
    const lc = cp.registerPrincipal("lifecycle-controller", { queues: [], lifecycle: true });
    // Each message is sent through the trusted path so its envelope is SIGNED (the digital fingerprint):
    // the sender authenticates and the control plane signs run/task/policy/parent, so the read-time
    // authorization context is verified provenance, not trusted store text.
    const senderSess = new Map();
    for (const s of new Set(scenario.messages.map((m) => m.sender))) senderSess.set(s, cp.registerPrincipal(s, {}));
    // (v20 CE20-00 creation-cut) A read only sees writes that happened-BEFORE its active message was created.
    // The natural scenario model -- send every message, then write memory -- would place every write after the
    // reader, so we send all NON-active messages first, write the memory into that graph, THEN create the reader
    // (active) message last with a sequence after the writes. This mirrors a producer-before-consumer flow: the
    // memory a reader consumes existed before the reader's turn. (The active message is the reader/leaf and
    // sources no memory, so deferring it does not affect any record's provenance.)
    const activeId = scenario.active_message_id;
    for (const m of scenario.messages) if (m.message_id !== activeId) rt.sendMessage(m, senderSess.get(m.sender));

    const retire = []; // { oldId, newId|null, kind }
    for (const item of scenario.memories) {
      const source = byMessage.get(item.source_message_id);
      if (!source) {
        // declared source not in the graph => out-of-band injection (denied by attestation/provenance)
        injectUnattested(rt, item, {
          run_id: item.run_id ?? scenario.messages[0].run_id,
          task_id: item.task_id ?? scenario.messages[0].task_id,
          trace_id: scenario.messages[0].trace_id, sender: "orphan",
          policy_context: item.policy_context ?? "policy-003",
        });
        continue;
      }
      // Write through the trusted path under the record's own source message. A record may declare a
      // lower writer clearance to model a background/ingestion principal (integrity-flow family): its
      // record integrity is then meet(writer clearance, source integrity), so a system context refuses
      // it even though it is reachable and attested.
      const writerSess = item.writer_clearance
        ? cp.registerPrincipal(`writer-${item.memory_id}`, { queues: ["*"], clearance: item.writer_clearance })
        : seed;
      const lease = rt.claimSpecific(writerSess, item.source_message_id);
      // task_id/scope/run/policy are derived authoritatively from the source message inside
      // writeMemory (review M1.2); each record is written under its own source message, so the
      // authoritative task equals the scenario's intended task. Only content/type/readers are passed.
      rt.writeMemory(item.content, lease, {
        memory_id: item.memory_id, memory_type: item.memory_type,
        content_ref: item.content_ref ?? null, allowed_readers: item.allowed_readers,
      });
      // A scenario record marked superseded/expired models a retired record; in secure mode that fact
      // is an AUTHORITATIVE lifecycle event, not a writer-declared status string (review M5).
      if (item.status === "superseded") retire.push({ oldId: item.memory_id, newId: scenario.expected_memory_ids[0], kind: "supersede" });
      else if (item.status === "expired") retire.push({ oldId: item.memory_id, kind: "expire" });
    }
    for (const r of retire) {
      if (r.kind === "supersede") rt.supersede(lc, r.oldId, r.newId);
      else rt.expire(lc, r.oldId);
    }

    // Create the reader (active) message LAST, sequenced after every write so the creation-cut admits the
    // memory written before it (a record written AFTER the reader is still excluded -- repro_v20 CE20-00).
    const active = byMessage.get(scenario.active_message_id);
    active.sequence = rt._currentSequence(active.run_id) + 1;
    rt.sendMessage(active, senderSess.get(active.sender));
    const rlease = rt.claimSpecific(rt.controlPlane.registerPrincipal("reader", { queues: [active.receiver] }), scenario.active_message_id);
    const admitted = rt.readMemory(scenario.query, rlease).map((m) => m.memory_id);

    const missing = scenario.expected_memory_ids.filter((id) => !admitted.includes(id));
    const invalidAdmissions = scenario.forbidden_memory_ids.filter((id) => admitted.includes(id));
    const recon = rt.replaySecureMemoryReads(active.run_id).ok ? 1 : 0;
    const pass = missing.length === 0 && invalidAdmissions.length === 0 && recon === 1;
    return {
      scenario_id: scenario.scenario_id, scenario_type: scenario.scenario_type,
      admitted, expected: scenario.expected_memory_ids, forbidden: scenario.forbidden_memory_ids,
      missing, invalid_admissions: invalidAdmissions, reconstructable: recon, pass,
    };
  } finally {
    rt.close();
  }
}

export function runSecureCoverage({ scenarios = PHASE4_MAIN_SCENARIOS, benchmark = "coupled-memory-secure-coverage-main" } = {}) {
  const cases = scenarios.map(runSecureCoverageScenario);
  const byFamily = new Map();
  for (const c of cases) {
    if (!byFamily.has(c.scenario_type)) byFamily.set(c.scenario_type, { family: c.scenario_type, n: 0, passed: 0, invalid_admissions: 0, unreconstructable: 0 });
    const f = byFamily.get(c.scenario_type);
    f.n += 1; f.passed += c.pass ? 1 : 0; f.invalid_admissions += c.invalid_admissions.length;
    f.unreconstructable += c.reconstructable ? 0 : 1;
  }
  const families = [...byFamily.values()];
  const summary = {
    benchmark, profile: "secure",
    cases: cases.length,
    passed: cases.filter((c) => c.pass).length,
    total_invalid_admissions: cases.reduce((a, c) => a + c.invalid_admissions.length, 0),
    total_unreconstructable: cases.filter((c) => c.reconstructable === 0).length,
    families,
    full_mediation: cases.every((c) => c.invalid_admissions.length === 0),
    full_reconstructable: cases.every((c) => c.reconstructable === 1),
    full_selection: cases.every((c) => c.missing.length === 0 && c.invalid_admissions.length === 0),
  };
  return { ...summary, results: cases };
}

export { PHASE4_MAIN_SCENARIOS, PHASE4_SCENARIOS, INTEGRITY_FLOW_SCENARIOS };
