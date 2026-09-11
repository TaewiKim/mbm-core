#!/usr/bin/env node

import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { parseArgs } from "node:util";

export const OFFICIAL_BENCHMARK_REPOS = {
  agentprotocols: {
    name: "AgentProtocols",
    category: "official-communication-benchmark",
    literature_target: "ProtocolBench / Which LLM Multi-Agent Protocol to Choose?",
    url: "https://github.com/ulab-uiuc/AgentProtocols.git",
    default_ref: "main",
    license: "MIT",
    local_dir: "external/official/AgentProtocols",
    adapter: "benchmarks/official_comm_benchmark_adapter.mjs",
    status: "official-adapter-target",
  },
  silobench: {
    name: "SILO-BENCH",
    category: "official-communication-benchmark",
    literature_target: "SILO-BENCH: Communication-Reasoning Gap in LLM Multi-Agent Systems",
    url: "https://github.com/jwyjohn/acl26-silo-bench.git",
    default_ref: "master",
    license: "check-upstream",
    local_dir: "external/official/acl26-silo-bench",
    adapter: "pending",
    status: "download-only",
  },
  marble: {
    name: "MARBLE / MultiAgentBench",
    category: "official-multi-agent-benchmark",
    literature_target: "MultiAgentBench / MARBLE",
    url: "https://github.com/MultiagentBench/MARBLE.git",
    default_ref: "main",
    license: "check-upstream",
    local_dir: "external/official/MARBLE",
    adapter: "pending",
    status: "download-only",
  },
  langgraph: {
    name: "LangGraph",
    category: "sota-agent-harness",
    literature_target: "Long-running stateful agent harness substrate",
    url: "https://github.com/langchain-ai/langgraph.git",
    default_ref: "main",
    license: "check-upstream",
    local_dir: "external/official/langgraph",
    adapter: "pending: fixed-harness protocol-swap adapter",
    status: "sota-harness-download-target",
  },
  autogen: {
    name: "Microsoft AutoGen",
    category: "sota-agent-harness",
    literature_target: "Multi-agent conversation and orchestration harness substrate",
    url: "https://github.com/microsoft/autogen.git",
    default_ref: "main",
    license: "check-upstream",
    local_dir: "external/official/autogen",
    adapter: "pending: fixed-harness protocol-swap adapter",
    status: "sota-harness-download-target",
  },
  crewai: {
    name: "CrewAI",
    category: "sota-agent-harness",
    literature_target: "Role/task-based multi-agent orchestration harness substrate",
    url: "https://github.com/crewAIInc/crewAI.git",
    default_ref: "main",
    license: "check-upstream",
    local_dir: "external/official/crewAI",
    adapter: "pending: fixed-harness protocol-swap adapter",
    status: "sota-harness-download-target",
  },
  openhands: {
    name: "OpenHands",
    category: "sota-agent-harness",
    literature_target: "Software-agent execution harness substrate",
    url: "https://github.com/OpenHands/OpenHands.git",
    default_ref: "main",
    license: "check-upstream",
    local_dir: "external/official/OpenHands",
    adapter: "pending: fixed-harness protocol-swap adapter",
    status: "sota-harness-download-target",
  },
};

export const DOWNLOAD_GROUPS = {
  benchmarks: ["agentprotocols", "silobench", "marble"],
  harnesses: ["langgraph", "autogen", "crewai", "openhands"],
  sota_harnesses: ["langgraph", "autogen", "crewai", "openhands"],
  all: Object.keys(OFFICIAL_BENCHMARK_REPOS),
};

function repoRoot() {
  return resolve(dirname(fileURLToPath(import.meta.url)), "..");
}

function runGit(args, options = {}) {
  const result = spawnSync("git", args, {
    encoding: "utf8",
    stdio: options.stdio ?? "pipe",
    cwd: options.cwd ?? repoRoot(),
  });
  if (result.status !== 0) {
    const command = `git ${args.join(" ")}`;
    const errorText = [result.stdout, result.stderr].filter(Boolean).join("\n");
    throw new Error(`${command} failed\n${errorText}`);
  }
  return result.stdout.trim();
}

function ensureParent(path) {
  mkdirSync(dirname(path), { recursive: true });
}

function resolveTargets(target) {
  if (DOWNLOAD_GROUPS[target]) {
    return DOWNLOAD_GROUPS[target];
  }
  if (OFFICIAL_BENCHMARK_REPOS[target]) {
    return [target];
  }
  throw new Error(
    `unknown download target: ${target}. Use one of: ${[
      ...Object.keys(OFFICIAL_BENCHMARK_REPOS),
      ...Object.keys(DOWNLOAD_GROUPS),
    ].join(", ")}`,
  );
}

function installRepo({ key, ref, force }) {
  const spec = OFFICIAL_BENCHMARK_REPOS[key];
  if (!spec) {
    throw new Error(`unknown official benchmark target: ${key}`);
  }
  const root = repoRoot();
  const localPath = resolve(root, spec.local_dir);
  const checkoutRef = ref ?? spec.default_ref;
  if (existsSync(localPath) && force) {
    rmSync(localPath, { recursive: true, force: true });
  }
  if (!existsSync(localPath)) {
    ensureParent(localPath);
    runGit(["clone", "--depth", "1", "--branch", checkoutRef, spec.url, localPath], { stdio: "inherit" });
  } else {
    runGit(["fetch", "--depth", "1", "origin", checkoutRef], { cwd: localPath, stdio: "inherit" });
    runGit(["checkout", "FETCH_HEAD"], { cwd: localPath, stdio: "inherit" });
  }
  const commit = runGit(["rev-parse", "HEAD"], { cwd: localPath });
  return {
    ...spec,
    key,
    requested_ref: checkoutRef,
    checked_out_commit: commit,
    absolute_path: localPath,
  };
}

function writeManifest(records) {
  const manifestPath = resolve(repoRoot(), "external/official/manifest.json");
  ensureParent(manifestPath);
  let previous = {};
  if (existsSync(manifestPath)) {
    previous = JSON.parse(readFileSync(manifestPath, "utf8"));
  }
  const manifest = {
    generated_at: new Date().toISOString(),
    repositories: {
      ...(previous.repositories ?? {}),
    },
  };
  for (const record of records) {
    manifest.repositories[record.key] = record;
  }
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  return manifestPath;
}

export function downloadOfficialBenchmarks({ target = "agentprotocols", ref = null, force = false } = {}) {
  const keys = resolveTargets(target);
  const records = keys.map((key) => installRepo({ key, ref, force }));
  const manifestPath = writeManifest(records);
  return { manifestPath, records };
}

export function cliArgs(argv = process.argv.slice(2)) {
  const parsed = parseArgs({
    args: argv,
    options: {
      target: { type: "string", default: "agentprotocols" },
      ref: { type: "string" },
      force: { type: "boolean", default: false },
      list: { type: "boolean", default: false },
    },
  });
  if (parsed.values.list) {
    return { list: true };
  }
  return {
    target: parsed.values.target,
    ref: parsed.values.ref ?? null,
    force: parsed.values.force,
  };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  try {
    const args = cliArgs();
    if (args.list) {
      console.log(JSON.stringify({ OFFICIAL_BENCHMARK_REPOS, DOWNLOAD_GROUPS }, null, 2));
    } else {
      const result = downloadOfficialBenchmarks(args);
      console.log(JSON.stringify(result, null, 2));
    }
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
