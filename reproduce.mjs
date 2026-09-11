#!/usr/bin/env node
/**
 * One-command reproduction driver for
 *   "Reachable Is Not Adopted: Set-Level Authorization for Shared Memory in LLM Agent Workflows".
 *
 * It orchestrates the deterministic, no-API replay path: run the deterministic tests and
 * security gates, recompute the paired-bootstrap analyses, regenerate every table/figure/macro
 * from committed result logs, and run the evidence-check gate that verifies figure hashes,
 * paper<->manifest coverage, the
 * forbidden-claim / anonymization audits, and the scoped-claim evidence gates (G1..G10).
 *
 * Nothing here calls a paid API. The live experiments (which DO call the OpenAI API) are
 * documented in README.md / EXPERIMENTS.md and gated behind OPENAI_API_KEY; this driver only
 * replays their committed outputs.
 *
 * Usage:
 *   node reproduce.mjs              # full no-API replay (tests -> secure -> analyses -> tables -> figures -> check)
 *   node reproduce.mjs --values-only # regenerate result VALUES only (analyze -> tables -> check), no figures/Python
 *   node reproduce.mjs --install    # run `npm ci` first
 *   node reproduce.mjs --check-only  # only re-verify committed artifacts (Node only, no Python)
 *   node reproduce.mjs --help
 *
 * Exit code is non-zero if any step fails, so it is CI-friendly.
 */
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
// Walk upward from this driver to the first directory that contains package.json. This makes the
// script robust to nesting depth: it works in a full clone (./) and in a
// repackaged artifact ZIP where the driver may sit at a different depth relative to the repo root.
let ROOT = HERE;
while (ROOT !== dirname(ROOT) && !existsSync(join(ROOT, "package.json"))) {
  ROOT = dirname(ROOT);
}
const argv = new Set(process.argv.slice(2));

if (argv.has("--help") || argv.has("-h")) {
  const doc = readFileSync(fileURLToPath(import.meta.url), "utf8").split("\n").slice(2, 25)
    .map((l) => l.replace(/^\s*\*\/?/, "").replace(/^ /, "")).join("\n").trim();
  console.log(doc);
  process.exit(0);
}

// npm is a .cmd shim on Windows, which Node refuses to spawn without a shell. We therefore run
// every step as a single command STRING with shell:true. Passing a string (not an args array)
// with shell:true also sidesteps the DEP0190 "args with shell" warning. All args below are
// space-free relative tokens; the only path with spaces (the repo root) is passed via cwd.
function run(label, cmd, args, opts = {}) {
  const full = [cmd, ...args].join(" ");
  console.log(`\n→ ${label}\n  $ ${full}`);
  const r = spawnSync(full, { cwd: opts.cwd ?? ROOT, stdio: "inherit", shell: true });
  if (r.status !== 0) {
    console.error(`\n✗ step failed: ${label} (exit ${r.status ?? "signal"})`);
    process.exit(r.status || 1);
  }
}

function tool(name) {
  const r = spawnSync(`${name} --version`, { stdio: "pipe", shell: true });
  return r.status === 0 ? String(r.stdout || r.stderr).split("\n")[0].trim() : null;
}

// ---- environment report ---------------------------------------------------
console.log("=".repeat(72));
console.log("Reproduction: Message-Bound Shared Memory ()");
console.log("=".repeat(72));
console.log(`repo root : ${ROOT}`);
console.log(`node      : ${process.version}`);
const py = tool("python") || tool("python3");
console.log(`python    : ${py || "NOT FOUND (needed for figures; see README requirements.txt)"}`);
const tex = tool("pdflatex");

if (!existsSync(join(ROOT, "package.json"))) {
  console.error("\n✗ could not find package.json in any parent directory; run this from inside the full artifact repository (the one containing package.json, benchmarks/, scripts/, data/, results/, tools/).");
  process.exit(1);
}

// ---- steps ----------------------------------------------------------------
if (argv.has("--install")) run("install dependencies", "npm", ["ci"]);

if (argv.has("--check-only")) {
  // Node-only: re-verify the committed figures/tables/gates without rebuilding anything.
  run("verify committed artifacts (evidence gate)", "npm", ["run", "eval:check"]);
} else if (argv.has("--values-only") || argv.has("--no-figures")) {
  // Node-only: recompute every numeric result (analyses + macros + tables) and run the evidence
  // gate, WITHOUT the matplotlib figure step. No Python required. Figure hashes in the gate are
  // verified against the already-committed figures.
  run("regenerate result values (analyze -> tables -> evidence check, no figures)", "npm", ["run", "eval:values"]);
} else {
  // Full deterministic no-API replay.
  run("no-API replay (tests -> secure -> analyses -> tables -> figures -> evidence check)", "npm", ["run", "eval:artifact:check"]);
}

if (argv.has("--paper")) {
  console.error("\n✗ --paper is not available here: the manuscript sources are not part of");
  console.error("  this repository. See the accompanying preprint for the paper itself.");
  process.exit(1);
}

// ---- summary --------------------------------------------------------------
const evPath = join(ROOT, "results", "eval", "evidence-check.json");
if (existsSync(evPath)) {
  try {
    const ev = JSON.parse(readFileSync(evPath, "utf8"));
    console.log("\n" + "=".repeat(72));
    console.log(`evidence check : ${ev.overall ?? "?"}`);
    for (const c of ev.checks ?? ev.results ?? []) {
      console.log(`  [${(c.status || "").toUpperCase()}] ${c.id || c.name}: ${c.detail || c.message || ""}`);
    }
    console.log("=".repeat(72));
  } catch { /* best-effort summary */ }
}
console.log("\n✓ reproduction complete. See reproduction/EXPECTED_RESULTS pointers in README.md.");
