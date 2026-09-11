import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";

import { assertC4C5OnlyDifferByBinding } from "./coupled_memory/conditions.mjs";
import { buildPhase4Scenarios, runPhase4Scenario } from "./coupled_memory/scenarios.mjs";

const WRAPPERS = {
  "legacy-shared-memory": {
    condition: "C4",
    description: "existing agent app with strong but unbound shared-memory protocol",
  },
  "acmcp-message-bound": {
    condition: "C5",
    description: "same agent app with ACM-CP message-bound memory protocol wrapper",
  },
};

const SAME_AGENT_CONTROLS = {
  agent_app: "fixed-three-agent-deployment-workflow",
  agent_roles: ["planner", "memory", "executor"],
  task_policy: "deterministic-agent-policy-v1",
  model_policy: "same-model-output-policy",
  memory_backend: "node:sqlite",
  tools: ["message_queue", "shared_memory_read", "shared_memory_write"],
};

function parseList(value, allowed, label) {
  const items = value === "all" ? allowed : String(value).split(",").map((item) => item.trim()).filter(Boolean);
  for (const item of items) {
    if (!allowed.includes(item)) {
      throw new Error(`unknown ${label}: ${item}`);
    }
  }
  return items;
}

function summarize(cases) {
  const byWrapper = new Map();
  for (const item of cases) {
    const current = byWrapper.get(item.protocol_wrapper) ?? {
      protocol_wrapper: item.protocol_wrapper,
      cases: 0,
      successes: 0,
      wrong_scope_memory_use: 0,
      stale_memory_use: 0,
      forbidden_memory_use: 0,
      missing_critical_memory: 0,
    };
    current.cases += 1;
    current.successes += item.success ? 1 : 0;
    current.wrong_scope_memory_use += item.wrong_scope_memory_use;
    current.stale_memory_use += item.stale_memory_use;
    current.forbidden_memory_use += item.forbidden_memory_use;
    current.missing_critical_memory += item.missing_critical_memory;
    byWrapper.set(item.protocol_wrapper, current);
  }
  return [...byWrapper.values()].map((item) => ({
    ...item,
    success_rate: item.cases === 0 ? 0 : item.successes / item.cases,
  }));
}

export function runDropInProtocolReplacementBenchmark({
  instancesPerFamily = 3,
  protocol = "all",
  benchmark = "dropin-protocol-replacement-dev",
} = {}) {
  const protocols = parseList(protocol, Object.keys(WRAPPERS), "protocol wrapper");
  const scenarios = buildPhase4Scenarios({ instancesPerFamily });
  const cases = [];
  for (const scenario of scenarios) {
    for (const protocolWrapper of protocols) {
      const wrapper = WRAPPERS[protocolWrapper];
      const result = runPhase4Scenario({ scenario, condition: wrapper.condition });
      cases.push({
        ...result,
        protocol_wrapper: protocolWrapper,
        protocol_description: wrapper.description,
        same_agent_controls: SAME_AGENT_CONTROLS,
        protocol_only_change: {
          control_condition: wrapper.condition === "C4" ? "baseline" : "treatment",
          underlying_condition: wrapper.condition,
          changed_component: "inter-agent protocol wrapper",
          unchanged_components: Object.keys(SAME_AGENT_CONTROLS),
        },
      });
    }
  }
  return {
    benchmark,
    live: false,
    purpose: "Evaluate protocol-only replacement while holding agent app, task policy, tools, and memory backend fixed.",
    same_agent_controls: SAME_AGENT_CONTROLS,
    c4_c5_parity: assertC4C5OnlyDifferByBinding(),
    protocol_wrappers: Object.fromEntries(protocols.map((id) => [id, WRAPPERS[id]])),
    scenarios: scenarios.map((item) => ({ scenario_id: item.scenario_id, scenario_type: item.scenario_type })),
    cases,
    summary: summarize(cases),
  };
}

function printSummary(result) {
  console.log("protocol_wrapper\tcases\tsuccesses\tsuccess_rate\twrong_scope\tstale\tforbidden\tmissing");
  for (const row of result.summary) {
    console.log([
      row.protocol_wrapper,
      row.cases,
      row.successes,
      row.success_rate.toFixed(4),
      row.wrong_scope_memory_use,
      row.stale_memory_use,
      row.forbidden_memory_use,
      row.missing_critical_memory,
    ].join("\t"));
  }
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const parsed = parseArgs({
    options: {
      "instances-per-family": { type: "string", default: "3" },
      protocol: { type: "string", default: "all" },
      benchmark: { type: "string", default: "dropin-protocol-replacement-dev" },
      json: { type: "string" },
    },
  });
  const result = runDropInProtocolReplacementBenchmark({
    instancesPerFamily: Number.parseInt(parsed.values["instances-per-family"], 10),
    protocol: parsed.values.protocol,
    benchmark: parsed.values.benchmark,
  });
  printSummary(result);
  if (parsed.values.json) {
    mkdirSync(dirname(parsed.values.json), { recursive: true });
    writeFileSync(parsed.values.json, `${JSON.stringify(result, null, 2)}\n`, "utf8");
    console.log(`Wrote ${parsed.values.json}`);
  }
}
