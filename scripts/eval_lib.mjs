// Shared helpers for the  artifact pipeline.
// Pure Node (no external deps beyond optional @resvg/resvg-js, loaded lazily by callers).
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

export function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

export function readJsonIfExists(path) {
  if (!path || !existsSync(path)) return null;
  try {
    return readJson(path);
  } catch {
    return null;
  }
}

export function writeJson(path, value) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

export function writeText(path, value) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, value, "utf8");
}

export function sha256OfString(text) {
  return `sha256:${createHash("sha256").update(text).digest("hex")}`;
}

export function sha256OfFile(path) {
  if (!existsSync(path)) return null;
  return `sha256:${createHash("sha256").update(readFileSync(path)).digest("hex")}`;
}

export function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (!token.startsWith("--")) continue;
    const key = token.slice(2);
    const next = argv[i + 1];
    if (next === undefined || next.startsWith("--")) {
      args[key] = true;
    } else {
      args[key] = next;
      i += 1;
    }
  }
  return args;
}

// Deterministic seeded RNG (mulberry32).
export function mulberry32(seed) {
  let a = seed >>> 0;
  return function next() {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Extract paired Failure-Free Completion units from a raw live result file.
// Pairs treatment vs baseline on (scenario_id, run_index, model).
// successField defaults to "model_success" (the live FFCR proxy used across the suite).
export function pairedUnits(rawResult, {
  baselineCondition = "C4",
  treatmentCondition = "C5",
  conditionField = "condition",
  successField = "model_success",
} = {}) {
  const cases = rawResult.cases ?? [];
  const byKey = new Map();
  for (const c of cases) {
    if (c.api_error) continue; // drop failed API calls from paired analysis
    const cond = c[conditionField];
    const key = `${c.model}::${c.scenario_id}::${c.run_index}`;
    if (!byKey.has(key)) byKey.set(key, {});
    byKey.get(key)[cond] = c[successField] ? 1 : 0;
  }
  const pairs = [];
  for (const [, rec] of byKey) {
    if (rec[baselineCondition] === undefined || rec[treatmentCondition] === undefined) continue;
    pairs.push({ baseline: rec[baselineCondition], treatment: rec[treatmentCondition] });
  }
  return pairs;
}

export function mean(values) {
  if (values.length === 0) return 0;
  return values.reduce((a, b) => a + b, 0) / values.length;
}

// Paired bootstrap of the treatment-minus-baseline FFCR delta.
export function bootstrapPairedDelta(pairs, { iterations = 5000, seed = 2606, alpha = 0.05 } = {}) {
  const n = pairs.length;
  const baseFFCR = mean(pairs.map((p) => p.baseline));
  const treatFFCR = mean(pairs.map((p) => p.treatment));
  const pointDelta = treatFFCR - baseFFCR;
  if (n === 0) {
    return { n, baseFFCR, treatFFCR, delta: 0, ci95: [0, 0] };
  }
  const rng = mulberry32(seed);
  const deltas = new Array(iterations);
  for (let it = 0; it < iterations; it += 1) {
    let b = 0;
    let t = 0;
    for (let k = 0; k < n; k += 1) {
      const idx = Math.floor(rng() * n);
      b += pairs[idx].baseline;
      t += pairs[idx].treatment;
    }
    deltas[it] = (t - b) / n;
  }
  deltas.sort((x, y) => x - y);
  const lo = deltas[Math.floor((alpha / 2) * iterations)];
  const hi = deltas[Math.min(iterations - 1, Math.floor((1 - alpha / 2) * iterations))];
  return { n, baseFFCR, treatFFCR, delta: pointDelta, ci95: [lo, hi] };
}

// Cluster (block) bootstrap: resample whole CLUSTERS with replacement instead of individual paired
// units. This is the statistically honest CI when units within a cluster (here, the template/family
// variants of a scenario family) are correlated pseudo-replicates -- the per-unit bootstrap above
// treats them as independent and understates uncertainty. The resampling unit is the family.
export function bootstrapClusteredPairedDelta(pairs, { iterations = 10000, seed = 2606, alpha = 0.05, clusterKey = (p) => p.family } = {}) {
  const n = pairs.length;
  const baseFFCR = mean(pairs.map((p) => p.baseline));
  const treatFFCR = mean(pairs.map((p) => p.treatment));
  const pointDelta = treatFFCR - baseFFCR;
  const groups = new Map();
  for (const p of pairs) {
    const k = clusterKey(p);
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(p);
  }
  const clusters = [...groups.values()];
  const C = clusters.length;
  if (n === 0 || C === 0) return { n, clusters: C, baseFFCR, treatFFCR, delta: 0, ci95: [0, 0] };
  const rng = mulberry32(seed);
  const deltas = new Array(iterations);
  for (let it = 0; it < iterations; it += 1) {
    let b = 0;
    let t = 0;
    let m = 0;
    for (let c = 0; c < C; c += 1) {
      const cl = clusters[Math.floor(rng() * C)];
      for (let j = 0; j < cl.length; j += 1) { b += cl[j].baseline; t += cl[j].treatment; m += 1; }
    }
    deltas[it] = m > 0 ? (t - b) / m : 0;
  }
  deltas.sort((x, y) => x - y);
  const lo = deltas[Math.floor((alpha / 2) * iterations)];
  const hi = deltas[Math.min(iterations - 1, Math.floor((1 - alpha / 2) * iterations))];
  return { n, clusters: C, baseFFCR, treatFFCR, delta: pointDelta, ci95: [lo, hi] };
}

// Leave-one-cluster-out robustness: recompute the point delta with each cluster (family) removed in
// turn. Reports the range across folds and whether the sign is stable, guarding against a single
// family driving the effect.
export function leaveOneClusterOut(pairs, { clusterKey = (p) => p.family } = {}) {
  const keys = [...new Set(pairs.map(clusterKey))];
  const folds = [];
  for (const drop of keys) {
    const kept = pairs.filter((p) => clusterKey(p) !== drop);
    if (!kept.length) continue;
    folds.push({ dropped: drop, delta: mean(kept.map((p) => p.treatment)) - mean(kept.map((p) => p.baseline)), n: kept.length });
  }
  const deltas = folds.map((f) => f.delta);
  return { folds, min: deltas.length ? Math.min(...deltas) : 0, max: deltas.length ? Math.max(...deltas) : 0, all_positive: deltas.every((d) => d > 0) };
}

// McNemar exact-ish statistic for paired binary outcomes (discordant pairs).
export function mcnemar(pairs) {
  let b = 0; // baseline success, treatment fail
  let c = 0; // baseline fail, treatment success
  for (const p of pairs) {
    if (p.baseline === 1 && p.treatment === 0) b += 1;
    if (p.baseline === 0 && p.treatment === 1) c += 1;
  }
  const denom = b + c;
  const stat = denom === 0 ? 0 : ((Math.abs(b - c) - 1) ** 2) / denom;
  return { b, c, discordant: denom, statistic: stat };
}

// Holm-Bonferroni step-down correction (review M7: the paper claims it; implement it, do not just
// gate on a CI). Input: array of {key, p}. Returns a Map key -> {adjusted_p, reject} at the given
// family-wise alpha. Adjusted p for the i-th smallest (1-indexed) is (m-i+1)*p, enforced monotone
// non-decreasing and capped at 1; reject iff adjusted_p <= alpha.
export function holmBonferroni(tests, alpha = 0.05) {
  const valid = tests.filter((t) => typeof t.p === "number" && Number.isFinite(t.p));
  const sorted = [...valid].sort((a, b) => a.p - b.p);
  const m = sorted.length;
  const out = new Map();
  let prev = 0;
  sorted.forEach((t, i) => {
    let adj = (m - i) * t.p; // (m - (i+1) + 1) with 0-based i
    adj = Math.min(1, Math.max(adj, prev)); // monotone non-decreasing, capped at 1
    prev = adj;
    out.set(t.key, { adjusted_p: adj, reject: adj <= alpha });
  });
  for (const t of tests) if (!out.has(t.key)) out.set(t.key, { adjusted_p: null, reject: false });
  return out;
}

export function isoStamp(args = {}) {
  // Date.now is fine in scripts (not workflow context). Allow override for reproducibility.
  return args.stamp || new Date().toISOString();
}
