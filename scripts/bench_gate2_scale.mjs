// Gate 2.0 SCALABILITY evaluation (reviewer v19 P1: latency/throughput/storage/recovery as the run grows).
// LATENCY/THROUGHPUT are measured in-process (:memory:) so they reflect the GATE's compute cost (the coherent
// view + bidirectional ledger tamper scan + capability meet recomputed per read), isolated from disk I/O; the
// headline is the LINEAR fit in run size N (= ledger length), which backs the O(|C(m)|) design claim and lets the
// 10^4-10^6 regime be extrapolated (the prototype recomputes per read with no caching). STORAGE and CRASH-RECOVERY
// are measured once on a file-backed DB. Conflict-width sweeps the coherent-view grouping cost. No model/API.
import { writeFileSync, mkdirSync, mkdtempSync, statSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { createSecureMemorySystem, ControlPlane } from "../benchmarks/coupled_memory/runtime.mjs";

const env = (o) => ({ run_id: "R", task_id: "T", trace_id: "tr", intent: "produce_final_plan", state: "running",
  policy_context: "P", correlation_id: null, delegated_from: null, parent_message_id: null, ...o });
const ctxOf = (rt, s, m) => rt.controlPlane.contextTokenForLease(rt.claimSpecific(s, m));
const KEY = Buffer.alloc(32, 11);
const median = (xs) => { const s = [...xs].sort((a, b) => a - b); const m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };
const timeIt = (fn, iters) => { const ts = []; for (let i = 0; i < iters; i += 1) { const t0 = performance.now(); fn(i); ts.push(performance.now() - t0); } return ts; };

const N_SWEEP = [100, 250, 500, 1000];   // records (= keyed authority rows = ledger length) per run
const W_SWEEP = [2, 5, 10, 25, 50];      // logical-key conflict width (concurrent same-key versions)
const WARM = 2, ITERS = 9;

// Build a run with `n` DISTINCT-key authority records (ledger length n), all readable by the executor, sourced at
// m0. dbPath optional (file-backed for storage/recovery; :memory: otherwise).
function buildRun(n, dbPath) {
  const cp = new ControlPlane({ keyBytes: KEY });
  const sys = createSecureMemorySystem(dbPath ? { dbPath, controlPlane: cp, destinationPolicy: () => true } : { controlPlane: cp, destinationPolicy: () => true });
  const rt = sys.admin, facade = sys.runtime;
  rt.sendMessage(env({ message_id: "m0", sender: "p", receiver: "memory", sequence: 1 }), cp.registerPrincipal("p", {}));
  const w = cp.registerPrincipal("w", { queues: ["*"] }); const ex = cp.registerPrincipal("ex", { queues: ["executor"] });
  for (let i = 0; i < n; i += 1) {
    rt.writeMemory(`fact-${i}`, rt.claimSpecific(w, "m0"), { memory_id: `mem-${i}`, logical_key: `K${i}`, memory_type: "constraint", allowed_readers: ["executor"], effect_ceiling: ["send"] });
  }
  // Create the reader after every measured write so the creation-cut includes the actual write events.
  rt.sendMessage(env({ message_id: "mx", sender: "c", receiver: "executor", sequence: rt._currentSequence("R") + 1, parent_message_id: "m0" }), cp.registerPrincipal("c", {}));
  return { cp, rt, facade, ex };
}

mkdirSync("results/eval", { recursive: true });

// ---- (1) latency / throughput sweep over N, in :memory: (gate compute cost, no disk I/O) ----
const recordRows = [];
for (const n of N_SWEEP) {
  const { rt, facade, ex } = buildRun(n);
  const ctx = ctxOf(rt, ex, "mx");
  const query = () => facade.queryMemory(ex, ctx, {}, "send");
  const action = () => facade.executeAuthorizedAction(ex, ctx, facade.queryMemory(ex, ctx, {}, "send").viewId, { effect: "send", tool: "notify", parameters: { to: "ops@corp" } });
  timeIt(query, WARM); const q = median(timeIt(query, ITERS));
  timeIt(action, WARM); const a = median(timeIt(action, ITERS));
  rt.close();
  recordRows.push({ n, query_ms: q, action_ms: a, query_qps: 1000 / q, action_qps: 1000 / a });
  process.stderr.write(`  N=${n}: query ${q.toFixed(1)}ms action ${a.toFixed(1)}ms\n`);
}

// ---- (2) conflict-width sweep (coherent-view grouping cost), :memory: ----
const widthRows = [];
for (const wdt of W_SWEEP) {
  const cp = new ControlPlane({ keyBytes: KEY });
  const sys = createSecureMemorySystem({ controlPlane: cp, destinationPolicy: () => true });
  const rt = sys.admin, facade = sys.runtime;
  rt.sendMessage(env({ message_id: "m0", sender: "p", receiver: "memory", sequence: 1 }), cp.registerPrincipal("p", {}));
  const parents = []; const w = cp.registerPrincipal("w", { queues: ["*"] });
  for (let i = 0; i < wdt; i += 1) {
    rt.sendMessage(env({ message_id: `mb${i}`, sender: `s${i}`, receiver: "memory", sequence: 2 + i, parent_message_id: "m0" }), cp.registerPrincipal(`s${i}`, {}));
    rt.writeMemory(`v${i}`, rt.claimSpecific(w, `mb${i}`), { memory_id: `cw-${i}`, logical_key: "K", memory_type: "constraint", allowed_readers: ["executor"], effect_ceiling: ["send"] });
    parents.push({ id: `mb${i}`, type: "depends" });
  }
  rt.sendMessage(env({ message_id: "mM", sender: "c", receiver: "executor", sequence: rt._currentSequence("R") + 1, parents }), cp.registerPrincipal("c", {}));
  const ex = cp.registerPrincipal("ex", { queues: ["executor"] });
  const ctx = cp.contextTokenForLease(rt.claimSpecific(ex, "mM"));
  const query = () => facade.queryMemory(ex, ctx, {}, "send");
  timeIt(query, WARM);
  widthRows.push({ width: wdt, query_ms: median(timeIt(query, ITERS)) });
  rt.close();
}

// ---- (3) storage + crash-recovery at one point (file-backed DB), N = max ----
const NREC = N_SWEEP[N_SWEEP.length - 1];
const dir = mkdtempSync(join(tmpdir(), "mbm-scale-"));
const dbPath = join(dir, "shared.db");
{ const { rt } = buildRun(NREC, dbPath); rt.close(); }
const storageKB = statSync(dbPath).size / 1024;
// Crash-recovery = restoring the TRUSTED state: construct over the same db+key (seedMembership reads the durable
// anchor+mirror) and verify the MAC-chained ledger over all N entries. This is the restore cost; the subsequent
// first authoritative read then pays the ordinary query latency above, so we time the restore in isolation.
const t0 = performance.now();
const cp2 = new ControlPlane({ keyBytes: KEY });
const sys2 = createSecureMemorySystem({ dbPath, controlPlane: cp2, destinationPolicy: () => true });
sys2.admin._verifiedMembership(); // force the membership MAC-chain verification over the restored ledger
const recoveryMs = performance.now() - t0;
sys2.admin.close();
rmSync(dir, { recursive: true, force: true });

// linear fit of query latency vs N (per-record marginal + R^2)
const xs = recordRows.map((r) => r.n), ys = recordRows.map((r) => r.query_ms);
const xb = xs.reduce((a, b) => a + b, 0) / xs.length, yb = ys.reduce((a, b) => a + b, 0) / ys.length;
const slope = xs.reduce((a, x, i) => a + (x - xb) * (ys[i] - yb), 0) / xs.reduce((a, x) => a + (x - xb) ** 2, 0);
const intercept = yb - slope * xb;
const ssTot = ys.reduce((a, y) => a + (y - yb) ** 2, 0);
const ssRes = ys.reduce((a, y, i) => a + (y - (slope * xs[i] + intercept)) ** 2, 0);
const r2 = ssTot === 0 ? 1 : 1 - ssRes / ssTot;
const big = recordRows[recordRows.length - 1];

const out = {
  generated_by: "scripts/bench_gate2_scale.mjs", iters: ITERS, warmup: WARM,
  record_sweep: recordRows, width_sweep: widthRows,
  query_per_record_us: slope * 1000, query_fit_r2: r2,
  largest_n: big.n, largest_query_ms: big.query_ms, largest_action_ms: big.action_ms,
  largest_query_qps: big.query_qps, largest_action_qps: big.action_qps,
  storage_n: NREC, storage_kb: storageKB, storage_per_record_kb: storageKB / NREC, recovery_ms: recoveryMs,
  node_version: process.version,
};
writeFileSync("results/eval/gate2-scale.json", JSON.stringify(out, null, 2));
console.log("[gate2-scale] wrote results/eval/gate2-scale.json");
console.log(`  query latency linear in N: ~${(slope * 1000).toFixed(1)} us/record (R^2=${r2.toFixed(3)})`);
for (const r of recordRows) console.log(`  N=${String(r.n).padStart(4)}  query=${r.query_ms.toFixed(1)}ms (${Math.round(r.query_qps)}q/s)  action=${r.action_ms.toFixed(1)}ms`);
for (const r of widthRows) console.log(`  conflict width=${String(r.width).padStart(2)}  query=${r.query_ms.toFixed(2)}ms`);
console.log(`  storage @N=${NREC}: ${Math.round(storageKB)}KB (${(storageKB / NREC).toFixed(2)}KB/record); crash-recovery: ${recoveryMs.toFixed(0)}ms`);
process.exit(0);
