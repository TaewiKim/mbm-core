#!/usr/bin/env node
// Independent audit replay + integrity verification (review M2/M5). This is a SEPARATE entry point
// from the runtime that produced the log: it opens a fresh runtime over the persisted database and
// asks it to RE-RUN the gate for every logged read (CoupledMemoryRuntime.replayMemoryReads), then
// reports any inconsistency. It does NOT trust the logged allow-set -- it reconstructs the active
// message, candidate set, and causal closure from the database, recomputes each verdict, and
// compares. A tampered verdict, a missing/duplicate/deleted decision, an altered candidate, or a
// content edit shows up as an issue and forces ok=false.
//
// `node scripts/audit_replay.mjs --self-test` runs every counterexample the reviewer used:
//   (a) baseline clean run, (b) content tamper, (c) allow->deny flip with a bogus reason,
//   (d) delete one decision, (e) delete ALL decisions. Each tamper must be caught.
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { parseArgs } from "node:util";

import { CoupledMemoryRuntime } from "../benchmarks/coupled_memory/runtime.mjs";

// Replay one run by re-running the gate from persisted state in a fresh runtime instance.
export function replayRun(dbPath, runId) {
  const rt = new CoupledMemoryRuntime({ dbPath });
  try {
    return rt.replayMemoryReads(runId);
  } finally {
    rt.close();
  }
}

function seedCleanRun(dbPath) {
  const rt = new CoupledMemoryRuntime({ dbPath });
  const runId = "run-tamper";
  rt.ensureRun(runId);
  const msg = rt.sendMessage({
    message_id: "m1", run_id: runId, task_id: "t1", trace_id: "tr1", sender: "a", receiver: "b",
    intent: "share", state: "active", sequence: 1, policy_context: "P1",
  });
  // A genuinely wrong-run message (its own run), so the deny record is created legitimately rather
  // than by forging run_id at write time (which message-bound write now rejects, review M1).
  rt.ensureRun("other-run");
  const otherMsg = rt.sendMessage({
    message_id: "m1-other", run_id: "other-run", task_id: "t1", trace_id: "tr1", sender: "a",
    receiver: "b", intent: "share", state: "active", sequence: 1, policy_context: "P1",
  });
  // Two memories: one admissible, one wrong-run (denied) -- gives both an allow and a deny to verify.
  rt.writeMemory("ADMIT", msg, { memory_id: "mem-ok", allowed_readers: ["*"] });
  rt.writeMemory("DENY", otherMsg, { memory_id: "mem-bad", allowed_readers: ["*"] });
  const admitted = rt.readMemory({}, msg, { condition: "C5" });
  rt.close();
  return { runId, admitted: admitted.map((m) => m.memory_id) };
}

function selfTest() {
  const results = [];
  const check = (label, ok) => { results.push({ label, ok }); console.log(`  [${ok ? "PASS" : "FAIL"}] ${label}`); };

  // (a) clean baseline replays ok.
  {
    const dbPath = join(mkdtempSync(join(tmpdir(), "audit-clean-")), "t.db");
    const { runId, admitted } = seedCleanRun(dbPath);
    const r = replayRun(dbPath, runId);
    check(`clean run replays ok (reads=${r.reads}, admitted=${admitted.join(",")})`, r.ok && r.reads === 1);
  }
  // (b) content tamper: edit content, keep old hash -> content_tampered + admitted_set_mismatch.
  {
    const dbPath = join(mkdtempSync(join(tmpdir(), "audit-tamper-")), "t.db");
    const { runId } = seedCleanRun(dbPath);
    const db = new DatabaseSync(dbPath);
    db.prepare("UPDATE shared_memory SET content = 'FORGED' WHERE memory_id = 'mem-ok'").run();
    db.close();
    const r = replayRun(dbPath, runId);
    check("content tamper is caught", !r.ok && r.issues.some((i) => i.kind === "content_tampered"));
  }
  // (c) flip a logged allow to deny with a bogus reason -> decision_mismatch.
  {
    const dbPath = join(mkdtempSync(join(tmpdir(), "audit-flip-")), "t.db");
    const { runId } = seedCleanRun(dbPath);
    const db = new DatabaseSync(dbPath);
    db.prepare("UPDATE memory_access_decisions SET decision='deny', reason='forged' WHERE memory_id='mem-ok'").run();
    db.close();
    const r = replayRun(dbPath, runId);
    check("allow->deny flip is caught", !r.ok && r.issues.some((i) => i.kind === "decision_mismatch"));
  }
  // (d) delete a single decision row -> missing_decision.
  {
    const dbPath = join(mkdtempSync(join(tmpdir(), "audit-del1-")), "t.db");
    const { runId } = seedCleanRun(dbPath);
    const db = new DatabaseSync(dbPath);
    db.prepare("DELETE FROM memory_access_decisions WHERE memory_id='mem-ok'").run();
    db.close();
    const r = replayRun(dbPath, runId);
    check("single decision deletion is caught", !r.ok && r.issues.some((i) => i.kind === "missing_decision"));
  }
  // (e) delete ALL decision rows -> every candidate missing (the reviewer's "ok:true" counterexample).
  {
    const dbPath = join(mkdtempSync(join(tmpdir(), "audit-delall-")), "t.db");
    const { runId } = seedCleanRun(dbPath);
    const db = new DatabaseSync(dbPath);
    db.prepare("DELETE FROM memory_access_decisions WHERE run_id = ?").run(runId);
    db.close();
    const r = replayRun(dbPath, runId);
    check("full decision-log deletion is caught", !r.ok && r.issues.some((i) => i.kind === "missing_decision"));
  }
  // (f) delete the ENTIRE read manifest AND decisions (review M1.4: total wipe must not look like "no
  // activity"). The monotonic audit anchor records that reads happened, so replay flags deletion.
  {
    const dbPath = join(mkdtempSync(join(tmpdir(), "audit-wipe-")), "t.db");
    const { runId } = seedCleanRun(dbPath);
    const db = new DatabaseSync(dbPath);
    db.prepare("DELETE FROM memory_reads WHERE run_id = ?").run(runId);
    db.prepare("DELETE FROM memory_access_decisions WHERE run_id = ?").run(runId);
    db.close();
    const r = replayRun(dbPath, runId);
    check("full read-manifest wipe is caught (anchor)", !r.ok && r.issues.some((i) => i.kind === "read_manifest_deleted"));
  }

  const pass = results.every((r) => r.ok);
  console.log(`[audit-replay self-test] ${results.filter((r) => r.ok).length}/${results.length} => ${pass ? "PASS" : "FAIL"}`);
  process.exitCode = pass ? 0 : 1;
}

const { values } = parseArgs({ options: { "self-test": { type: "boolean" }, db: { type: "string" }, run: { type: "string" } } });
if (values["self-test"]) selfTest();
else if (values.db && values.run) console.log(JSON.stringify(replayRun(values.db, values.run), null, 2));
else console.log("usage: audit_replay.mjs --self-test | --db <path> --run <runId>");
