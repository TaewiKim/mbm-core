// Gate 2.0 COST micro-benchmark (reviewer v19: "Gate 2.0 cost not measured"). Measures the kernel's
// per-operation wall-clock cost on the hot paths -- queryMemory (read + coherent view) and
// executeAuthorizedAction (commit-time recompute + one-shot consume + dispatch) -- against an UNGATED baseline
// (a raw store SELECT, i.e. what relevance retrieval costs), and how it scales with the closure size |C(m)|.
// Pure local computation (no model/API). Emits results/eval/gate2-cost.json for paper macros (no hand-typed #s).
import { writeFileSync, mkdirSync } from "node:fs";
import { performance } from "node:perf_hooks";
import { createSecureMemorySystem, ControlPlane } from "../benchmarks/coupled_memory/runtime.mjs";

const env = (o) => ({ run_id: "R", task_id: "T", trace_id: "tr", intent: "produce_final_plan", state: "running",
  policy_context: "P", correlation_id: null, delegated_from: null, parent_message_id: null, ...o });
const ctxOf = (rt, s, m) => rt.controlPlane.contextTokenForLease(rt.claimSpecific(s, m));

const SIZES = [1, 10, 25, 50, 100];   // number of authority-bearing records in the active message's closure
const WARMUP = 20, ITERS = 80;

function median(xs) { const s = [...xs].sort((a, b) => a - b); const m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; }
function pctl(xs, p) { const s = [...xs].sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.floor(p * s.length))]; }
function timeIt(fn, iters) { const ts = []; for (let i = 0; i < iters; i += 1) { const t0 = performance.now(); fn(i); ts.push(performance.now() - t0); } return ts; }

function buildRun(n) {
  const cp = new ControlPlane();
  const sys = createSecureMemorySystem({ controlPlane: cp, destinationPolicy: () => true });
  const rt = sys.admin, facade = sys.runtime;
  rt.sendMessage(env({ message_id: "m0", sender: "p", receiver: "memory", sequence: 1 }), cp.registerPrincipal("p", {}));
  const w = cp.registerPrincipal("w", { queues: ["*"] }); const ex = cp.registerPrincipal("ex", { queues: ["executor"] });
  // n authority-bearing records, all readable by the executor and sourced at m0 (so in mx's closure). All permit
  // send so the action ALLOWs and the full commit+dispatch path is exercised.
  for (let i = 0; i < n; i += 1) {
    rt.writeMemory(`fact-${i}`, rt.claimSpecific(w, "m0"), { memory_id: `mem-${i}`, logical_key: `K${i}`, memory_type: "constraint", allowed_readers: ["executor"], effect_ceiling: ["send"] });
  }
  // The active reader must be created after the writes: the secure gate authorizes the actual write event, not
  // just the reusable source-message label, so write_seq must be <= the reader's signed creation sequence.
  rt.sendMessage(env({ message_id: "mx", sender: "c", receiver: "executor", sequence: rt._currentSequence("R") + 1, parent_message_id: "m0" }), cp.registerPrincipal("c", {}));
  const ctx = ctxOf(rt, ex, "mx");
  return { cp, rt, facade, ex, ctx };
}

const rows = [];
for (const n of SIZES) {
  const { rt, facade, ex, ctx } = buildRun(n);
  // Ungated baseline: a raw store read of the run's records (what a relevance retriever does) + JSON parse.
  const baseRead = () => rt.db.prepare("SELECT * FROM shared_memory WHERE run_id='R'").all().map((r) => JSON.parse(r.allowed_readers_json));
  // Gated read: full coherent view + opaque view handle.
  const gatedQuery = () => facade.queryMemory(ex, ctx, {}, "send");
  // Gated end-to-end authorize+commit one external action (fresh one-shot view each time).
  const gatedAction = () => facade.executeAuthorizedAction(ex, ctx, facade.queryMemory(ex, ctx, {}, "send").viewId, { effect: "send", tool: "notify", parameters: { to: "ops@corp" } });

  for (const fn of [baseRead, gatedQuery, gatedAction]) timeIt(fn, WARMUP);
  const base = timeIt(baseRead, ITERS);
  const query = timeIt(gatedQuery, ITERS);
  const action = timeIt(gatedAction, ITERS);
  // sanity: the action path actually ALLOWed (dispatched), so we measured the full hot path.
  const sample = facade.executeAuthorizedAction(ex, ctx, facade.queryMemory(ex, ctx, {}, "send").viewId, { effect: "send", tool: "notify", parameters: { to: "ops@corp" } });
  rows.push({
    n,
    base_ms_median: median(base), base_ms_p95: pctl(base, 0.95),
    query_ms_median: median(query), query_ms_p95: pctl(query, 0.95),
    action_ms_median: median(action), action_ms_p95: pctl(action, 0.95),
    query_overhead_x: median(query) / median(base),
    dispatched: sample.status === "dispatched",
  });
  rt.close();
}

// Linear-fit slope of gated-read median latency vs n (per-record marginal cost, to back the O(|C(m)|) claim).
const xs = rows.map((r) => r.n), ys = rows.map((r) => r.query_ms_median);
const xbar = xs.reduce((a, b) => a + b, 0) / xs.length, ybar = ys.reduce((a, b) => a + b, 0) / ys.length;
const slope = xs.reduce((a, x, i) => a + (x - xbar) * (ys[i] - ybar), 0) / xs.reduce((a, x) => a + (x - xbar) ** 2, 0);
const intercept = ybar - slope * xbar;
// R^2 of the linear fit (is the per-read cost well-described as linear in |C(m)|?).
const ssTot = ys.reduce((a, y) => a + (y - ybar) ** 2, 0);
const ssRes = ys.reduce((a, y, i) => a + (y - (slope * xs[i] + intercept)) ** 2, 0);
const r2 = ssTot === 0 ? 1 : 1 - ssRes / ssTot;

const big = rows[rows.length - 1];
const out = {
  generated_by: "scripts/bench_gate2_cost.mjs", iters: ITERS, warmup: WARMUP, sizes: SIZES,
  rows,
  per_record_marginal_us: slope * 1000, fit_r2: r2,
  largest_n: big.n,
  largest_query_ms: big.query_ms_median, largest_action_ms: big.action_ms_median,
  largest_query_overhead_x: big.query_overhead_x,
  query_throughput_per_s: 1000 / big.query_ms_median,
  action_throughput_per_s: 1000 / big.action_ms_median,
  node_version: process.version,
};
mkdirSync("results/eval", { recursive: true });
writeFileSync("results/eval/gate2-cost.json", JSON.stringify(out, null, 2));
console.log("[gate2-cost] wrote results/eval/gate2-cost.json");
console.log(`  per-record marginal read cost ~= ${(slope * 1000).toFixed(2)} us  (linear fit R^2=${r2.toFixed(3)})`);
for (const r of rows) console.log(`  n=${String(r.n).padStart(3)}  base=${r.base_ms_median.toFixed(3)}ms  query=${r.query_ms_median.toFixed(3)}ms (${r.query_overhead_x.toFixed(1)}x)  action=${r.action_ms_median.toFixed(3)}ms  dispatched=${r.dispatched}`);
console.log(`  at n=${big.n}: query ${Math.round(1000 / big.query_ms_median)} ops/s, action ${Math.round(1000 / big.action_ms_median)} ops/s`);
if (!rows.every((r) => r.dispatched)) { console.error("FAIL: an action did not dispatch (cost path not fully exercised)"); process.exit(1); }
process.exit(0);
