// E13 — Mechanism-blind End-Task Correctness (ETC).
// Re-scores EXISTING E1/E3 traces with a judge that sees ONLY {query, candidate answer, reference fact}.
// The judge is blind to runs/tasks/provenance/reader/policy, memory ids, the condition label, and any
// "binding" vocabulary. ETC therefore measures end-task answer correctness, NOT the mechanism-defined FFCR.
// Pre-registered in docs/prereg_E13_E16.md (frozen). E7 holdout is intentionally NOT scored
// (its records are content-neutralized by construction -> answer is not content-decidable).
//
// Usage:
//   node scripts/rescore_blind_outcome.mjs --source e1 --limit 0 --out results/eval/e13-etc-e1.jsonl
//   node scripts/rescore_blind_outcome.mjs --source e3 --limit 0 --out results/eval/e13-etc-e3.jsonl
import { appendFileSync, mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { dirname } from "node:path";

import { PHASE4_MAIN_SCENARIOS, runPhase4Scenario } from "../benchmarks/coupled_memory/scenarios.mjs";

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i].startsWith("--")) {
      const key = argv[i].slice(2);
      const val = argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[(i += 1)] : "true";
      args[key] = val;
    }
  }
  return args;
}

// judge model must differ from the subject model (a clear size/version difference)
const JUDGE_FOR = {
  "gpt-5.4-nano": "gpt-5.4-mini", "gpt-5.4-mini": "gpt-5.4-nano",
  "gpt-5-nano": "gpt-5.4-mini", "gpt-5-mini": "gpt-5.4-nano",
};

function judgeSchema() {
  return {
    type: "object",
    additionalProperties: false,
    properties: { correct: { type: "boolean" }, reason: { type: "string" } },
    required: ["correct", "reason"],
  };
}

async function judge({ apiKey, model, query, answer, reference }) {
  // Deliberately mechanism-free framing: no runs/tasks/provenance/binding terms.
  const body = {
    model,
    instructions: [
      "You grade whether a candidate answer correctly conveys a reference fact for a question.",
      "Judge ONLY substantive correctness: does the answer state the same fact as the reference and not contradict it?",
      "Ignore style, length, extra commentary, and any process the answer describes.",
      "Return exactly one compact JSON object matching the schema.",
    ].join("\n"),
    input: [{
      role: "user",
      content: `Question: ${query}\n\nReference fact (ground truth): ${reference}\n\nCandidate answer: ${answer}\n\nIs the candidate answer substantively correct with respect to the reference fact?`,
    }],
    text: { format: { type: "json_schema", name: "etc_grade", strict: true, schema: judgeSchema() } },
  };
  const res = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`OpenAI ${res.status}: ${JSON.stringify(data).slice(0, 200)}`);
  const text = data.output_text ?? (data.output ?? []).flatMap((o) => (o.content ?? []).map((c) => c.text || "")).join("");
  return JSON.parse(text);
}

// scenario_id -> { query, idToContent, expectedIds }
function buildE1GoldIndex() {
  const idx = new Map();
  for (const s of PHASE4_MAIN_SCENARIOS) {
    const d = runPhase4Scenario({ scenario: s, condition: "C4" }); // C4 injects the full candidate set
    const idToContent = {};
    (d.injected_memory_ids || []).forEach((id, i) => { idToContent[id] = (d.injected_memory_contents || [])[i]; });
    idx.set(s.scenario_id, {
      query: s.query?.text ?? JSON.stringify(s.query),
      idToContent,
      expectedIds: d.expected_memory_ids || [],
    });
  }
  return idx;
}

function buildE3GoldIndex() {
  const raw = JSON.parse(readFileSync("data/se_native/se_native_100.json", "utf8"));
  const arr = Array.isArray(raw) ? raw : raw.cases || raw.scenarios;
  const idx = new Map();
  for (const s of arr) {
    const idToContent = {};
    for (const m of s.memories || []) idToContent[m.memory_id] = m.content;
    idx.set(s.scenario_id, {
      query: s.query?.text ?? JSON.stringify(s.query),
      idToContent,
      expectedIds: s.expected_memory_ids || [],
    });
  }
  return idx;
}

function loadTraceCases(source) {
  const file = source === "e1"
    ? "results/coupled-memory-phase6-live-main40-r3-combined-2models.json"
    : "results/eval/e3-se-native-combined.json";
  const d = JSON.parse(readFileSync(file, "utf8"));
  return (d.cases || []).filter((c) => (c.condition === "C4" || c.condition === "C5") && !c.api_error && c.model_answer);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const source = args.source || "e1";
  const limit = Number(args.limit ?? 0);
  const out = args.out || `results/eval/e13-etc-${source}.jsonl`;
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) throw new Error("OPENAI_API_KEY required");

  const goldIdx = source === "e1" ? buildE1GoldIndex() : buildE3GoldIndex();
  let cases = loadTraceCases(source);
  if (limit > 0) cases = cases.slice(0, limit);

  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, "");
  let done = 0, skipped = 0;
  for (const c of cases) {
    const g = goldIdx.get(c.scenario_id);
    const expIds = (c.expected_memory_ids && c.expected_memory_ids.length ? c.expected_memory_ids : g?.expectedIds) || [];
    const reference = g ? expIds.map((id) => g.idToContent[id]).filter(Boolean).join(" ") : "";
    if (!g || !reference) { skipped += 1; continue; }
    const judgeModel = JUDGE_FOR[c.model] || "gpt-5.4-mini";
    let verdict = null, err = "";
    try {
      verdict = await judge({ apiKey, model: judgeModel, query: g.query, answer: c.model_answer, reference });
    } catch (e) { err = e.message; }
    const row = {
      experiment: "E13", source, scenario_id: c.scenario_id, scenario_type: c.scenario_type,
      condition: c.condition, subject_model: c.model, judge_model: judgeModel, run_index: c.run_index,
      ffcr_success: !!c.model_success, etc_correct: verdict ? !!verdict.correct : null,
      etc_reason: verdict ? verdict.reason : "", judge_error: err,
    };
    appendFileSync(out, JSON.stringify(row) + "\n");
    done += 1;
    if (done % 25 === 0) console.log(`[E13:${source}] ${done}/${cases.length} (skipped ${skipped})`);
  }
  console.log(`[E13:${source}] wrote ${done} rows to ${out} (skipped ${skipped} missing gold)`);
}

main().catch((e) => { console.error(e); process.exit(1); });
