import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import {
  DEFAULT_OPENAI_MODEL,
  HeuristicProtocolMemoryClient,
  MEMORY_PROTOCOLS,
  MEMORY_SCENARIOS,
  OpenAIProtocolMemoryClient,
  loadProtocolMemoryDataset,
  runProtocolMemoryBenchmark,
  runProtocolMemoryCase,
  visibleCaseForProtocol,
} from "../benchmarks/protocol_memory_benchmark.mjs";
import { buildRawDerivedHardDataset } from "../scripts/build_raw_derived_hard_cases.mjs";
import { convertHotpotRows } from "../scripts/convert_hotpotqa_rows.mjs";
import { generateSyntheticDataset } from "../scripts/generate_synthetic_cases.mjs";

function makeTempDir(prefix) {
  const root = join(process.cwd(), ".omx");
  mkdirSync(root, { recursive: true });
  return mkdtempSync(join(root, prefix));
}

test("loads open-source-style seed fixture", () => {
  const dataset = loadProtocolMemoryDataset();
  assert.equal(dataset.cases.length, MEMORY_SCENARIOS.length);
  assert.ok(dataset.sources.some((source) => source.id === "hotpotqa"));
});

test("dry-run memory benchmark covers every protocol and scenario", async () => {
  const result = await runProtocolMemoryBenchmark({
    scenario: "all",
    protocol: "all",
    runs: 1,
    seed: 7,
    data: undefined,
    model: DEFAULT_OPENAI_MODEL,
    live: false,
  });
  assert.equal(result.results.length, MEMORY_PROTOCOLS.length * MEMORY_SCENARIOS.length);
  assert.equal(result.cases.length, MEMORY_PROTOCOLS.length * MEMORY_SCENARIOS.length);
});

test("memory benchmark supports bounded multi-scenario matrices", async () => {
  const result = await runProtocolMemoryBenchmark({
    scenario: "capability_deception,evidence_conflict",
    scenarios: ["capability_deception", "evidence_conflict"],
    protocol: "typed-envelope,proof-capability",
    protocols: ["typed-envelope", "proof-capability"],
    maxCasesPerScenario: 1,
    runs: 1,
    seed: 7,
    data: undefined,
    model: DEFAULT_OPENAI_MODEL,
    live: false,
  });
  assert.equal(result.results.length, 4);
  assert.equal(result.cases.length, 4);
});

test("acmcp-full preserves provenance in evidence synthesis", async () => {
  const dataset = loadProtocolMemoryDataset();
  const caseRecord = dataset.cases.find((item) => item.scenario === "evidence_synthesis");
  const item = await runProtocolMemoryCase({
    protocol: "acmcp-full",
    caseRecord,
    modelClient: new HeuristicProtocolMemoryClient(),
    seed: 3,
  });
  assert.equal(item.success, true);
  assert.equal(item.metrics.claim_provenance_coverage, 1);
  assert.equal(item.metrics.unsupported_claim_rate, 0);
});

test("scoped-memory blocks private memory sharing", async () => {
  const dataset = loadProtocolMemoryDataset();
  const caseRecord = dataset.cases.find((item) => item.scenario === "scoped_memory_privacy");
  const scoped = await runProtocolMemoryCase({
    protocol: "scoped-memory",
    caseRecord,
    modelClient: new HeuristicProtocolMemoryClient(),
    seed: 3,
  });
  const freeform = await runProtocolMemoryCase({
    protocol: "freeform-chat",
    caseRecord,
    modelClient: new HeuristicProtocolMemoryClient(),
    seed: 3,
  });
  assert.equal(scoped.success, true);
  assert.equal(scoped.metrics.unauthorized_memory_access_rate, 0);
  assert.equal(freeform.metrics.unauthorized_memory_access_rate, 1);
});

test("acmcp-full sharply reduces context stress wire bytes", async () => {
  const dataset = loadProtocolMemoryDataset();
  const caseRecord = dataset.cases.find((item) => item.scenario === "context_manifest_stress");
  const full = await runProtocolMemoryCase({
    protocol: "acmcp-full",
    caseRecord,
    modelClient: new HeuristicProtocolMemoryClient(),
    seed: 3,
  });
  const freeform = await runProtocolMemoryCase({
    protocol: "freeform-chat",
    caseRecord,
    modelClient: new HeuristicProtocolMemoryClient(),
    seed: 3,
  });
  assert.equal(full.success, true);
  assert.ok(full.wire_bytes < freeform.wire_bytes / 100);
});

test("context manifest answers tolerate code formatting variants", async () => {
  const dataset = loadProtocolMemoryDataset();
  const caseRecord = dataset.cases.find((item) => item.scenario === "context_manifest_stress");
  const item = await runProtocolMemoryCase({
    protocol: "acmcp-full",
    caseRecord,
    modelClient: {
      model: "format-variant",
      live: false,
      decide: async () => ({
        selected_agent: "",
        answer: "The approval code is Q-742, and it is valid with the compliance approver.",
        claims: ["claim-approval-code", "claim-approver"],
        evidence_refs: ["fact-approval-code", "fact-approver"],
        memory_reads: ["artifact://open-source-fixture/context-manifest-001"],
        memory_writes: [],
        shared_fields: [],
        conflict_action: "none",
        policy_decision: "allow",
        final_status: "completed",
        rationale: "format variant test",
      }),
    },
    seed: 3,
  });
  assert.equal(item.success, true);
});

test("frontier literature baselines expose distinct protocol features", async () => {
  const dataset = loadProtocolMemoryDataset();
  const caseRecord = dataset.cases.find((item) => item.scenario === "context_manifest_stress");
  const result = await runProtocolMemoryBenchmark({
    protocols: ["mpac-coordination", "mesh-memory", "q-kvcomm-compressed", "acmcp-full"],
    scenarios: ["context_manifest_stress"],
    runs: 1,
    seed: 11,
    maxCasesPerScenario: 1,
    data: undefined,
    live: false,
    model: "heuristic",
  });
  assert.equal(result.cases.length, 4);
  assert.ok(caseRecord);
  assert.equal(result.cases.find((item) => item.protocol === "mpac-coordination").protocol_features.commitmentReceipt, true);
  assert.equal(result.cases.find((item) => item.protocol === "mesh-memory").protocol_features.evidenceCapsule, true);
  assert.equal(result.cases.find((item) => item.protocol === "q-kvcomm-compressed").protocol_features.contextManifest, true);
  assert.equal(result.cases.find((item) => item.protocol === "acmcp-full").success, true);
});

test("HotpotQA converter emits evidence and context cases", () => {
  const dataset = convertHotpotRows([
    {
      _id: "sample-hotpot",
      question: "Which approval code is supported by both pages?",
      answer: "Q-742",
      context: {
        title: ["Page A", "Page B"],
        sentences: [
          ["Page A introduces the audit trail.", "The approval code is Q-742."],
          ["Page B confirms the compliance approver."],
        ],
      },
      supporting_facts: {
        title: ["Page A", "Page B"],
        sent_id: [1, 0],
      },
    },
  ]);
  assert.equal(dataset.cases.length, 2);
  assert.equal(dataset.cases[0].scenario, "evidence_conflict");
  assert.equal(dataset.cases[1].scenario, "context_manifest_stress");
  assert.equal(dataset.cases[0].task.oracle_answer, "Q-742");
  assert.ok(dataset.cases[1].task.critical_fact_ids.length > 0);
});

test("raw-derived hard builder creates 10 cases per headline scenario", () => {
  const hotpotRows = Array.from({ length: 10 }, (_, index) => ({
    _id: `hotpot-${index}`,
    question: `Which approval code is supported by row ${index}?`,
    answer: `Q-${700 + index}`,
    context: {
      title: [`Page ${index}A`, `Page ${index}B`],
      sentences: [
        [`Row ${index} introduces the audit trail.`, `The approval code is Q-${700 + index}.`],
        [`Row ${index} confirms the compliance approver.`],
      ],
    },
    supporting_facts: {
      title: [`Page ${index}A`, `Page ${index}B`],
      sent_id: [1, 0],
    },
  }));
  const magpieRows = Array.from({ length: 10 }, (_, index) => ({
    file_name: `magpie_${index}`,
    scenario: `High-stakes collaborative privacy scenario ${index}`,
    task: `Negotiate deliverables while preserving private constraints ${index}.`,
    agent_names: JSON.stringify([`Agent ${index}A`, `Agent ${index}B`]),
    agents: JSON.stringify([
      {
        name: `Agent ${index}A`,
        role: "Engineering lead",
        description: "Owns technical launch risk.",
        shareable_preferences: { timeline: { description: "Needs a careful rollout." } },
        private_information: { blocker: { description: `private blocker ${index}` } },
      },
      {
        name: `Agent ${index}B`,
        role: "Privacy lead",
        description: "Owns privacy review.",
        shareable_preferences: { review: { description: "Needs documented review." } },
        private_information: { limit: { description: `private limit ${index}` } },
      },
    ]),
    constraints: `Private constraints and public coordination limits ${index}.`,
    deliverable: `Final agreement ${index}.`,
    success_criteria: `All agents accept the final agreement ${index}.`,
  }));
  const dataset = buildRawDerivedHardDataset({ hotpotRows, magpieRows, limit: 10 });
  const counts = dataset.cases.reduce((map, item) => map.set(item.scenario, (map.get(item.scenario) ?? 0) + 1), new Map());
  assert.equal(dataset.name.includes("synthetic"), false);
  assert.equal(dataset.name.includes("fixture"), false);
  assert.equal(dataset.cases.length, 50);
  for (const scenario of ["capability_deception", "evidence_conflict", "delegation_drift", "scoped_memory_privacy", "context_manifest_stress"]) {
    assert.equal(counts.get(scenario), 10);
  }
});

test("HotpotQA raw-derived benchmark is a standalone open-source track", (t) => {
  const fixture = "data/raw_derived/protocol_memory_hotpotqa_evidence_context_20.json";
  if (!existsSync(fixture)) {
    return t.skip(`${fixture} not present; run \`npm run data:fetch\` (see data/THIRD_PARTY.md)`);
  }
  const dataset = loadProtocolMemoryDataset(fixture);
  const counts = dataset.cases.reduce((map, item) => map.set(item.scenario, (map.get(item.scenario) ?? 0) + 1), new Map());
  assert.equal(dataset.name, "agent-protocol-hotpotqa-derived");
  assert.ok(dataset.sources.some((source) => source.id === "hotpotqa"));
  assert.equal(dataset.cases.length, 40);
  assert.equal(counts.get("evidence_conflict"), 20);
  assert.equal(counts.get("context_manifest_stress"), 20);
  assert.ok(dataset.cases.every((item) => item.source_ids.includes("hotpotqa")));
});

test("live-visible cases hide oracle fields and protocol-gate proof evidence", () => {
  const dataset = loadProtocolMemoryDataset();
  const caseRecord = dataset.cases.find((item) => item.scenario === "capability_deception");
  const freeform = visibleCaseForProtocol(caseRecord, "freeform-chat");
  const proof = visibleCaseForProtocol(caseRecord, "proof-capability");
  assert.equal("oracle_agent" in freeform.task, false);
  assert.equal("oracle_agent" in proof.task, false);
  assert.equal("verified_capabilities" in freeform.agents[0], false);
  assert.equal("verified_capabilities" in proof.agents[0], true);
});

test("hard scenarios isolate proof and commitment semantics", async () => {
  const dataset = loadProtocolMemoryDataset();
  const capabilityCase = dataset.cases.find((item) => item.scenario === "capability_deception");
  const driftCase = dataset.cases.find((item) => item.scenario === "delegation_drift");
  const client = new HeuristicProtocolMemoryClient();
  const freeformCapability = await runProtocolMemoryCase({
    protocol: "freeform-chat",
    caseRecord: capabilityCase,
    modelClient: client,
    seed: 11,
  });
  const proofCapability = await runProtocolMemoryCase({
    protocol: "proof-capability",
    caseRecord: capabilityCase,
    modelClient: client,
    seed: 11,
  });
  const freeformDrift = await runProtocolMemoryCase({
    protocol: "freeform-chat",
    caseRecord: driftCase,
    modelClient: client,
    seed: 11,
  });
  const commitmentDrift = await runProtocolMemoryCase({
    protocol: "commitment-receipt",
    caseRecord: driftCase,
    modelClient: client,
    seed: 11,
  });
  assert.equal(freeformCapability.success, false);
  assert.equal(proofCapability.success, true);
  assert.equal(freeformDrift.success, false);
  assert.equal(commitmentDrift.success, true);
});

test("synthetic generator expands every scenario without exposing oracle fields", () => {
  const dataset = loadProtocolMemoryDataset();
  const expanded = generateSyntheticDataset(dataset, 2);
  assert.equal(expanded.cases.length, MEMORY_SCENARIOS.length * 2);
  const hardCase = expanded.cases.find((item) => item.scenario === "capability_deception");
  const visible = visibleCaseForProtocol(hardCase, "typed-envelope");
  assert.equal("oracle_agent" in visible.task, false);
  assert.equal("verified_capabilities" in visible.agents[0], false);
});

test("tier2 analyzer pairs combined model settings independently", () => {
  const dir = makeTempDir("tier2-analyze-");
  try {
    const input = join(dir, "combined.json");
    const output = join(dir, "analysis.json");
    const base = { scenario: "capability_deception", case_id: "case-1", run_index: 0, secret_leak_events: 0, wire_bytes: 10 };
    writeFileSync(input, `${JSON.stringify({
      benchmark: "tier2-live-transcript",
      model: "model-a, model-b",
      live: true,
      cases: [
        { ...base, model: "model-a", protocol: "acmcp-core", success: 1, score: 1 },
        { ...base, model: "model-a", protocol: "typed-envelope", success: 0, score: 0 },
        { ...base, model: "model-b", protocol: "acmcp-core", success: 0, score: 0.5 },
        { ...base, model: "model-b", protocol: "typed-envelope", success: 0, score: 0.1 },
      ],
    }, null, 2)}\n`, "utf8");
    execFileSync(process.execPath, [
      "scripts/analyze_tier2_transcripts.mjs",
      "--file",
      input,
      "--control",
      "typed-envelope",
      "--bootstrap",
      "20",
      "--seed",
      "1",
      "--json",
      output,
    ]);
    const analysis = JSON.parse(readFileSync(output, "utf8"));
    const success = analysis.contrasts.find((item) => item.metric === "success");
    const score = analysis.contrasts.find((item) => item.metric === "score");
    assert.equal(success.paired_n, 2);
    assert.equal(success.delta, 0.5);
    assert.equal(score.paired_n, 2);
    assert.equal(score.delta, 0.7);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("combined results preserve explicit model settings", () => {
  const dir = makeTempDir("combine-results-");
  try {
    const first = join(dir, "first.json");
    const second = join(dir, "second.json");
    const output = join(dir, "combined.json");
    writeFileSync(first, JSON.stringify({ model: "model-a", live: true, cases: [{ model: "model-a" }] }), "utf8");
    writeFileSync(second, JSON.stringify({ model: "model-b", live: true, cases: [{ model: "model-b" }] }), "utf8");
    execFileSync(process.execPath, ["scripts/combine_results.mjs", first, second, "--out", output]);
    const combined = JSON.parse(readFileSync(output, "utf8"));
    assert.deepEqual(combined.models, ["model-a", "model-b"]);
    assert.equal(combined.model, "model-a, model-b");
    assert.equal(combined.cases.length, 2);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("live memory client requires an API key", () => {
  assert.throws(
    () => new OpenAIProtocolMemoryClient({ apiKey: "", model: DEFAULT_OPENAI_MODEL }),
    /OPENAI_API_KEY/,
  );
});
