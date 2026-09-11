// Deterministic gate-validation of generated long-running episodes.
// Keeps an episode ONLY if, under its active_context, the message-bound gate ADMITS every expected
// record and DENIES every forbidden record (so C5 genuinely separates), and it is structurally a
// long-running multi-agent episode (>=4 turns, >=3 distinct agent roles, >=1 forbidden record).
import { readFileSync, writeFileSync } from "node:fs";
import { evaluateMemoryGateStandalone } from "../benchmarks/external/mbm_gate.mjs";

function load(p){ const j=JSON.parse(readFileSync(p,"utf8")); return Array.isArray(j)?j:(j.episodes||[]); }

const inPath = process.argv[2] || "data/longrun/episodes_generated_raw.json";
const outPath = process.argv[3] || "data/longrun/episodes_generated.json";
const eps = load(inPath);
const kept = [];
const rej = [];
for (const ep of eps) {
  const reasons = [];
  const roles = new Set((ep.turns||[]).map((t)=>t.agent));
  if ((ep.turns||[]).length < 4) reasons.push("turns<4");
  if (roles.size < 3) reasons.push("roles<3");
  if (!(ep.forbidden_memory_ids||[]).length) reasons.push("no forbidden");
  const active = ep.active_context||{};
  const eg = new Set(ep.event_graph||[]);
  const byId = Object.fromEntries((ep.seed_memory||[]).map((m)=>[m.memory_id,m]));
  for (const id of ep.expected_memory_ids||[]) {
    const m = byId[id]; if(!m){reasons.push("expected missing "+id);continue;}
    if (evaluateMemoryGateStandalone(m, active, {eventGraph:eg}).decision !== "allow") reasons.push("gate denies expected "+id);
  }
  for (const id of ep.forbidden_memory_ids||[]) {
    const m = byId[id]; if(!m){reasons.push("forbidden missing "+id);continue;}
    if (evaluateMemoryGateStandalone(m, active, {eventGraph:eg}).decision !== "deny") reasons.push("gate ADMITS forbidden "+id);
  }
  if (reasons.length) rej.push({id:ep.episode_id,reasons}); else kept.push(ep);
}
writeFileSync(outPath, JSON.stringify(kept, null, 2)+"\n");
console.log(`[validate] kept ${kept.length}/${eps.length} episodes -> ${outPath}`);
if (rej.length) console.log("[validate] rejected:", JSON.stringify(rej.slice(0,20)));
