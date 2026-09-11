#!/usr/bin/env node

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { parseArgs } from "node:util";

export const ALIGNMENT_STATUS = "official-adapter";
export const LITERATURE_TARGET = "ProtocolBench / AgentProtocols";
export const OFFICIAL_CODE_URL = "https://github.com/ulab-uiuc/AgentProtocols";

export const AGENTPROTOCOLS_RUNNERS = {
  gaia: {
    anp: ["-m", "scenarios.gaia.runners.run_anp"],
    a2a: ["-m", "scenarios.gaia.runners.run_a2a"],
    acp: ["-m", "scenarios.gaia.runners.run_acp"],
    agora: ["-m", "scenarios.gaia.runners.run_agora"],
    router: ["-m", "scenarios.gaia.runners.run_meta_protocol"],
  },
  streaming_queue: {
    anp: ["-m", "scenarios.streaming_queue.runner.run_anp"],
    a2a: ["-m", "scenarios.streaming_queue.runner.run_a2a"],
    acp: ["-m", "scenarios.streaming_queue.runner.run_acp"],
    agora: ["-m", "scenarios.streaming_queue.runner.run_agora"],
    router: ["-m", "scenarios.streaming_queue.runner.run_meta_network"],
  },
  safety_tech: {
    anp: ["-m", "scenarios.safety_tech.runners.run_unified_security_test_anp"],
    a2a: ["-m", "scenarios.safety_tech.runners.run_unified_security_test_a2a"],
    acp: ["-m", "scenarios.safety_tech.runners.run_unified_security_test_acp"],
    agora: ["-m", "scenarios.safety_tech.runners.run_unified_security_test_agora"],
    router: ["-m", "scenarios.safety_tech.runners.run_s2_meta"],
  },
  fail_storm_recovery: {
    anp: ["-m", "scenarios.fail_storm_recovery.runners.run_anp"],
    a2a: ["-m", "scenarios.fail_storm_recovery.runners.run_a2a"],
    acp: ["-m", "scenarios.fail_storm_recovery.runners.run_acp"],
    agora: ["-m", "scenarios.fail_storm_recovery.runners.run_agora"],
    router: ["-m", "scenarios.fail_storm_recovery.runners.run_meta_network"],
  },
  routerbench: {
    router: ["routerbench/run_benchmark.py"],
  },
};

const SCENARIOS = Object.keys(AGENTPROTOCOLS_RUNNERS);
const PROTOCOLS = ["anp", "a2a", "acp", "agora", "router"];

function repoRoot() {
  return resolve(dirname(fileURLToPath(import.meta.url)), "..");
}

function defaultOfficialRepoPath() {
  return resolve(repoRoot(), "external/official/AgentProtocols");
}

function defaultOutputDir() {
  return resolve(repoRoot(), "results/official_comm");
}

function ensureDir(path) {
  mkdirSync(path, { recursive: true });
}

function slug(value) {
  return String(value).replace(/[^a-zA-Z0-9_.-]/g, "_");
}

function getRunner(scenario, protocol) {
  const scenarioRunners = AGENTPROTOCOLS_RUNNERS[scenario];
  if (!scenarioRunners) {
    throw new Error(`unknown scenario: ${scenario}`);
  }
  const runnerArgs = scenarioRunners[protocol];
  if (!runnerArgs) {
    throw new Error(`protocol ${protocol} is not supported for scenario ${scenario}`);
  }
  return runnerArgs;
}

function buildCommand({ scenario, protocol, python, officialRepoPath, outputDir, limit }) {
  const runnerArgs = getRunner(scenario, protocol);
  if (scenario === "routerbench") {
    const routerOutputDir = resolve(outputDir, `routerbench_${slug(protocol)}`);
    const args = [
      ...runnerArgs,
      "--output",
      routerOutputDir,
    ];
    if (limit !== null && limit !== undefined) {
      args.push("--limit", String(limit));
    }
    return {
      cwd: officialRepoPath,
      command: python,
      args,
      expected_result_file: resolve(routerOutputDir, "benchmark_results.json"),
    };
  }
  return {
    cwd: officialRepoPath,
    command: python,
    args: runnerArgs,
    expected_result_file: null,
  };
}

function parseRouterbenchResults(filePath) {
  if (!filePath || !existsSync(filePath)) {
    return null;
  }
  const raw = JSON.parse(readFileSync(filePath, "utf8"));
  const overall = raw.overall_statistics ?? {};
  return {
    official_result_type: "routerbench",
    official_result_file: filePath,
    overall_scenario_accuracy: overall.overall_scenario_accuracy ?? null,
    individual_module_accuracy: overall.individual_module_accuracy ?? null,
    a2a_acp_confusion_count: overall.a2a_acp_confusion_count ?? null,
    total_scenarios: overall.total_scenarios ?? null,
    total_modules: overall.total_modules ?? null,
    difficulty_statistics: raw.difficulty_statistics ?? null,
    confusion_matrix: raw.confusion_matrix ?? null,
  };
}

function inferSuccess({ status, stdout, stderr, normalizedOfficialResults }) {
  if (status !== 0) {
    return false;
  }
  if (normalizedOfficialResults?.official_result_type === "routerbench") {
    return true;
  }
  const combined = `${stdout}\n${stderr}`.toLowerCase();
  if (combined.includes("traceback") || combined.includes("exception") || combined.includes("error:")) {
    return false;
  }
  return true;
}

function runOneOfficialBenchmark(args) {
  const officialRepoPath = resolve(args.officialRepoPath);
  const outputDir = resolve(args.outputDir);
  ensureDir(outputDir);
  const commandSpec = buildCommand({
    scenario: args.scenario,
    protocol: args.protocol,
    python: args.python,
    officialRepoPath,
    outputDir,
    limit: args.limit,
  });
  const started = performance.now();
  if (args.dryRun) {
    return {
      alignment_status: ALIGNMENT_STATUS,
      literature_target: LITERATURE_TARGET,
      official_code_url: OFFICIAL_CODE_URL,
      uses_official_dataset: args.scenario === "routerbench",
      uses_official_runner: true,
      uses_official_metrics: args.scenario === "routerbench",
      scenario: args.scenario,
      protocol: args.protocol,
      dry_run: true,
      cwd: commandSpec.cwd,
      command: commandSpec.command,
      args: commandSpec.args,
      expected_result_file: commandSpec.expected_result_file,
    };
  }
  if (!existsSync(officialRepoPath)) {
    throw new Error(
      `official AgentProtocols repo not found at ${officialRepoPath}. Run: npm run official:download -- --target agentprotocols`,
    );
  }
  const proc = spawnSync(commandSpec.command, commandSpec.args, {
    cwd: commandSpec.cwd,
    encoding: "utf8",
    env: {
      ...process.env,
      ...(args.openaiApiKey ? { OPENAI_API_KEY: args.openaiApiKey } : {}),
      ...(args.openaiBaseUrl ? { OPENAI_BASE_URL: args.openaiBaseUrl } : {}),
    },
    timeout: args.timeoutMs,
  });
  const wallClockSeconds = Number(((performance.now() - started) / 1000).toFixed(6));
  const normalizedOfficialResults = args.scenario === "routerbench"
    ? parseRouterbenchResults(commandSpec.expected_result_file)
    : null;
  const result = {
    alignment_status: ALIGNMENT_STATUS,
    literature_target: LITERATURE_TARGET,
    official_code_url: OFFICIAL_CODE_URL,
    uses_official_dataset: args.scenario === "routerbench",
    uses_official_runner: true,
    uses_official_metrics: args.scenario === "routerbench",
    metric_compatibility_notes:
      args.scenario === "routerbench"
        ? "Runs AgentProtocols routerbench/run_benchmark.py and normalizes its evaluator output."
        : "Runs the official AgentProtocols scenario runner. Metrics are limited to process status and captured logs unless the upstream runner emits structured results.",
    scenario: args.scenario,
    protocol: args.protocol,
    dry_run: false,
    cwd: commandSpec.cwd,
    command: commandSpec.command,
    args: commandSpec.args,
    expected_result_file: commandSpec.expected_result_file,
    exit_status: proc.status,
    signal: proc.signal,
    success: inferSuccess({
      status: proc.status,
      stdout: proc.stdout ?? "",
      stderr: proc.stderr ?? "",
      normalizedOfficialResults,
    }),
    wall_clock_seconds: wallClockSeconds,
    stdout_tail: String(proc.stdout ?? "").split("\n").slice(-80).join("\n"),
    stderr_tail: String(proc.stderr ?? "").split("\n").slice(-80).join("\n"),
    normalized_official_results: normalizedOfficialResults,
  };
  const resultPath = resolve(
    outputDir,
    `${slug(args.scenario)}_${slug(args.protocol)}_${Date.now()}_normalized.json`,
  );
  writeFileSync(resultPath, `${JSON.stringify(result, null, 2)}\n`, "utf8");
  return { ...result, normalized_result_file: resultPath };
}

export function runOfficialCommunicationBenchmark(args) {
  const scenarioNames = args.scenario === "all" ? SCENARIOS : [args.scenario];
  const protocolNames = args.protocol === "all" ? PROTOCOLS : [args.protocol];
  const results = [];
  for (const scenario of scenarioNames) {
    for (const protocol of protocolNames) {
      if (!AGENTPROTOCOLS_RUNNERS[scenario][protocol]) {
        continue;
      }
      results.push(runOneOfficialBenchmark({ ...args, scenario, protocol }));
    }
  }
  return {
    benchmark: "official-agentprotocols-communication",
    alignment_status: ALIGNMENT_STATUS,
    literature_target: LITERATURE_TARGET,
    official_code_url: OFFICIAL_CODE_URL,
    official_repo_path: resolve(args.officialRepoPath),
    scenarios: scenarioNames,
    protocols: protocolNames,
    dry_run: args.dryRun,
    results,
  };
}

export function cliArgs(argv = process.argv.slice(2)) {
  const parsed = parseArgs({
    args: argv,
    options: {
      scenario: { type: "string", default: "routerbench" },
      protocol: { type: "string", default: "router" },
      "official-repo": { type: "string", default: defaultOfficialRepoPath() },
      "output-dir": { type: "string", default: defaultOutputDir() },
      python: { type: "string", default: "python" },
      limit: { type: "string" },
      "timeout-ms": { type: "string", default: "1800000" },
      "dry-run": { type: "boolean", default: false },
      json: { type: "string" },
      "openai-api-key": { type: "string" },
      "openai-base-url": { type: "string" },
    },
  });
  if (!["all", ...SCENARIOS].includes(parsed.values.scenario)) {
    throw new Error(`--scenario must be one of: all, ${SCENARIOS.join(", ")}`);
  }
  if (!["all", ...PROTOCOLS].includes(parsed.values.protocol)) {
    throw new Error(`--protocol must be one of: all, ${PROTOCOLS.join(", ")}`);
  }
  const limit = parsed.values.limit === undefined ? null : Number.parseInt(parsed.values.limit, 10);
  if (limit !== null && (!Number.isInteger(limit) || limit < 1)) {
    throw new Error("--limit must be a positive integer");
  }
  const timeoutMs = Number.parseInt(parsed.values["timeout-ms"], 10);
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1) {
    throw new Error("--timeout-ms must be a positive integer");
  }
  return {
    scenario: parsed.values.scenario,
    protocol: parsed.values.protocol,
    officialRepoPath: parsed.values["official-repo"],
    outputDir: parsed.values["output-dir"],
    python: parsed.values.python,
    limit,
    timeoutMs,
    dryRun: parsed.values["dry-run"],
    json: parsed.values.json,
    openaiApiKey: parsed.values["openai-api-key"] ?? null,
    openaiBaseUrl: parsed.values["openai-base-url"] ?? null,
  };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  try {
    const args = cliArgs();
    const result = runOfficialCommunicationBenchmark(args);
    const text = JSON.stringify(result, null, 2);
    console.log(text);
    if (args.json) {
      ensureDir(dirname(resolve(args.json)));
      writeFileSync(args.json, `${text}\n`, "utf8");
    }
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
