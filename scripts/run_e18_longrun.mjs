// E18 runner — long-running multi-agent workflow benchmark, C4 vs C5, end-to-end scored.
import { readFileSync, writeFileSync, appendFileSync, mkdirSync, readdirSync } from "node:fs";
import { dirname } from "node:path";
import { runEpisode } from "../benchmarks/coupled_memory/longrun_multiagent.mjs";

function parseArgs(a){const o={};for(let i=0;i<a.length;i++)if(a[i].startsWith("--")){o[a[i].slice(2)]=a[i+1]&&!a[i+1].startsWith("--")?a[++i]:"true";}return o;}

function loadEpisodes(spec) {
  // spec is a file or a dir; a dir loads all *.json and concatenates
  const fs = spec;
  let files = [];
  try { if (readdirSync(fs)) files = readdirSync(fs).filter((f) => f.endsWith(".json")).map((f) => `${fs}/${f}`); }
  catch { files = [fs]; }
  const eps = [];
  for (const f of files) { const j = JSON.parse(readFileSync(f, "utf8")); eps.push(...(Array.isArray(j) ? j : [j])); }
  return eps;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const model = args.model || "gpt-5.4-nano", judgeModel = args.judge || "gpt-5.4-mini";
  const spec = args.episodes || "data/longrun/episodes_seed.json";
  const out = args.out || "results/eval/e18-longrun.jsonl";
  const apiKey = process.env.OPENAI_API_KEY; if (!apiKey) throw new Error("OPENAI_API_KEY required");
  let eps = loadEpisodes(spec);
  if (args.limit) eps = eps.slice(0, Number(args.limit));
  mkdirSync(dirname(out), { recursive: true }); writeFileSync(out, "");
  let n = 0;
  for (const episode of eps) {
    for (const condition of ["C4", "C5"]) {
      const row = await runEpisode({ episode, condition, apiKey, model, judgeModel });
      appendFileSync(out, JSON.stringify(row) + "\n");
      n += 1; console.log(`[E18] ${episode.episode_id} ${condition}: success=${row.end_to_end_success} (ans=${row.answer_correct}, contam=${row.contaminated})`);
    }
  }
  console.log(`[E18] wrote ${n} rows (${eps.length} episodes) to ${out}`);
}
main().catch((e) => { console.error(e); process.exit(1); });
