#!/usr/bin/env node
/**
 * Fetch the third-party datasets this benchmark builds on, then regenerate the
 * derived fixtures from them.
 *
 * These datasets are NOT redistributed in this repository: they carry their own
 * licences and attribution requirements, which are not this repository's to
 * grant. See data/THIRD_PARTY.md before you use or redistribute anything this
 * script downloads.
 *
 * Usage:
 *   node scripts/fetch_third_party_data.mjs           # download + build derived fixtures
 *   node scripts/fetch_third_party_data.mjs --check   # report what is present, download nothing
 *   node scripts/fetch_third_party_data.mjs --force   # re-download files that already exist
 *
 * Requires Node 20+ (global fetch) and network access. Nothing here calls a
 * model API, and no result in the paper depends on it: the no-API replay
 * (`node reproduce.mjs --values-only`) reads the committed result logs instead.
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = dirname(HERE);

const HF_ROWS = "https://datasets-server.huggingface.co/rows";

const DOWNLOADS = [
  {
    id: "hotpotqa",
    name: "HotpotQA (distractor / validation)",
    out: "data/raw_sources/hotpotqa_distractor_validation_rows20.json",
    url: `${HF_ROWS}?${new URLSearchParams({
      dataset: "hotpotqa/hotpot_qa",
      config: "distractor",
      split: "validation",
      offset: "0",
      length: "20",
    })}`,
    expect: (d) => Array.isArray(d?.rows) && d.rows.length === 20,
  },
  {
    id: "magpie",
    name: "MAGPIE (train)",
    out: "data/raw_sources/magpie_train_rows20.json",
    url: `${HF_ROWS}?${new URLSearchParams({
      dataset: "jaypasnagasai/magpie",
      config: "default",
      split: "train",
      offset: "0",
      length: "20",
    })}`,
    expect: (d) => Array.isArray(d?.rows) && d.rows.length === 20,
  },
  {
    id: "locomo",
    name: "LoCoMo (10 conversations)",
    out: "data/external/locomo10.json",
    url: "https://raw.githubusercontent.com/snap-research/locomo/main/data/locomo10.json",
    expect: (d) => Array.isArray(d) && d.length === 10,
  },
];

// Derived fixtures, rebuilt from the downloads above. Each is a transformation
// of upstream content and inherits the upstream licence.
const BUILDS = [
  ["scripts/convert_hotpotqa_rows.mjs",
   ["--input", "data/raw_sources/hotpotqa_distractor_validation_rows20.json",
    "--output", "data/raw_derived/protocol_memory_hotpotqa_evidence_context_20.json",
    "--limit", "20", "--mode", "both", "--compact"]],
  ["scripts/build_raw_derived_hard_cases.mjs",
   ["--hotpot", "data/raw_sources/hotpotqa_distractor_validation_rows20.json",
    "--magpie", "data/raw_sources/magpie_train_rows20.json",
    "--output", "data/raw_derived/protocol_memory_raw_derived_hard10.json",
    "--limit", "10"]],
  ["scripts/build_raw_derived_hard_cases.mjs",
   ["--hotpot", "data/raw_sources/hotpotqa_distractor_validation_rows20.json",
    "--magpie", "data/raw_sources/magpie_train_rows20.json",
    "--output", "data/raw_derived/protocol_memory_raw_derived_hard20.json",
    "--limit", "20", "--compact"]],
];

const argv = new Set(process.argv.slice(2));

async function download(item, { force }) {
  const dest = join(ROOT, item.out);
  if (existsSync(dest) && !force) {
    console.log(`  = ${item.out} (already present)`);
    return;
  }
  process.stdout.write(`  . ${item.out} ... `);
  const res = await fetch(item.url, {
    headers: { "User-Agent": "mbm-core/1.0 (dataset fetch)" },
  });
  if (!res.ok) {
    throw new Error(`${item.name}: HTTP ${res.status} ${res.statusText}\n    ${item.url}`);
  }
  const data = await res.json();
  if (!item.expect(data)) {
    throw new Error(
      `${item.name}: the response did not have the expected shape. The upstream ` +
      `dataset may have moved or changed; see data/THIRD_PARTY.md.`);
  }
  mkdirSync(dirname(dest), { recursive: true });
  writeFileSync(dest, JSON.stringify(data, null, 2) + "\n", "utf8");
  console.log("ok");
}

function build([script, args]) {
  const out = args[args.indexOf("--output") + 1];
  process.stdout.write(`  . ${out} ... `);
  // The converters write straight to --output; on a fresh clone data/raw_derived/
  // does not exist yet, because nothing in it is committed.
  mkdirSync(dirname(join(ROOT, out)), { recursive: true });
  execFileSync(process.execPath, [join(ROOT, script), ...args], { cwd: ROOT, stdio: "pipe" });
  console.log("ok");
}

function report() {
  let missing = 0;
  for (const item of [...DOWNLOADS.map((d) => d.out),
                      ...BUILDS.map(([, a]) => a[a.indexOf("--output") + 1])]) {
    const present = existsSync(join(ROOT, item));
    if (!present) missing += 1;
    console.log(`  ${present ? "present" : "MISSING"}  ${item}`);
  }
  return missing;
}

async function main() {
  if (argv.has("--check")) {
    const missing = report();
    console.log(missing
      ? `\n${missing} file(s) missing. Run: npm run data:fetch`
      : "\nAll third-party datasets and derived fixtures are present.");
    process.exit(missing ? 1 : 0);
  }

  console.log("Downloading third-party datasets (not redistributed in this repository):");
  for (const item of DOWNLOADS) await download(item, { force: argv.has("--force") });

  console.log("\nRebuilding derived fixtures:");
  for (const b of BUILDS) build(b);

  console.log(
    "\nDone. These datasets are governed by their own licences and attribution\n" +
    "requirements -- see data/THIRD_PARTY.md. The MIT licence of this repository\n" +
    "covers this repository's own code and generated files, not the downloaded data.");
}

main().catch((err) => {
  console.error(`\n! ${err.message}`);
  process.exit(1);
});
