// E17 runner — live multi-agent LangGraph experiment over SE-native (real-repo-derived) cases.
// Runs each case through a real LangGraph StateGraph (writer nodes + gate node + live LLM executor),
// C4 (ungated shared memory) vs C5 (message-bound gate), paired. Output: results/eval/e17-langgraph-live.jsonl
import { readFileSync, writeFileSync, appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { OpenAICoupledMemoryClient } from "../benchmarks/coupled_memory/live_model.mjs";
import { runCase } from "../benchmarks/coupled_memory/langgraph_live_multiagent.mjs";

function parseArgs(a){const o={};for(let i=0;i<a.length;i++)if(a[i].startsWith("--")){o[a[i].slice(2)]=a[i+1]&&!a[i+1].startsWith("--")?a[++i]:"true";}return o;}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const model = args.model || "gpt-5.4-nano";
  const dataset = args.dataset || "data/se_native/se_native_100.json";
  const limit = Number(args.limit ?? 0);
  const out = args.out || "results/eval/e17-langgraph-live.jsonl";
  if (!process.env.OPENAI_API_KEY) throw new Error("OPENAI_API_KEY required");
  const raw = JSON.parse(readFileSync(dataset, "utf8"));
  let cases = Array.isArray(raw) ? raw : raw.cases || raw.scenarios;
  if (limit > 0) cases = cases.slice(0, limit);
  const client = new OpenAICoupledMemoryClient({ model });
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, "");
  let n = 0;
  for (const scase of cases) {
    for (const condition of ["C4", "C5"]) {
      const row = await runCase({ scase, condition, client });
      appendFileSync(out, JSON.stringify({ ...row, model }) + "\n");
      n += 1;
      if (n % 20 === 0) console.log(`[E17] ${n}`);
    }
  }
  console.log(`[E17] wrote ${n} rows to ${out}`);
}
main().catch((e) => { console.error(e); process.exit(1); });
