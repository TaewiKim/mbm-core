#!/usr/bin/env node

import { readFileSync, writeFileSync } from "node:fs";
import { parseArgs } from "node:util";

function stableId(value, fallback) {
  return String(value ?? fallback).replace(/[^a-zA-Z0-9_-]+/g, "-").replace(/^-+|-+$/g, "").toLowerCase();
}

function unwrapRows(input) {
  if (Array.isArray(input)) {
    return input;
  }
  if (Array.isArray(input.rows)) {
    return input.rows.map((item) => item.row ?? item);
  }
  if (Array.isArray(input.data)) {
    return input.data.map((item) => item.row ?? item);
  }
  if (Array.isArray(input.examples)) {
    return input.examples;
  }
  throw new Error("input must be an array, a Hugging Face /rows response, or an object with data/examples");
}

function normalizeContext(context) {
  if (!context) {
    return [];
  }
  if (Array.isArray(context.title) && Array.isArray(context.sentences)) {
    return context.title.map((title, index) => ({
      title,
      sentences: Array.isArray(context.sentences[index]) ? context.sentences[index] : [String(context.sentences[index] ?? "")],
    }));
  }
  if (Array.isArray(context)) {
    return context.map((item) => {
      if (Array.isArray(item)) {
        return {
          title: String(item[0] ?? ""),
          sentences: Array.isArray(item[1]) ? item[1] : [String(item[1] ?? "")],
        };
      }
      return {
        title: String(item.title ?? item[0] ?? ""),
        sentences: Array.isArray(item.sentences) ? item.sentences : [String(item.text ?? item[1] ?? "")],
      };
    });
  }
  return [];
}

function normalizeSupportingFacts(value) {
  if (!value) {
    return [];
  }
  if (Array.isArray(value.title) && Array.isArray(value.sent_id)) {
    return value.title.map((title, index) => ({
      title,
      sent_id: Number(value.sent_id[index] ?? 0),
    }));
  }
  if (Array.isArray(value)) {
    return value.map((item) => ({
      title: String(Array.isArray(item) ? item[0] : item.title ?? ""),
      sent_id: Number(Array.isArray(item) ? item[1] : item.sent_id ?? 0),
    }));
  }
  return [];
}

function fallbackFacts(contexts, maxFacts) {
  const facts = [];
  for (const context of contexts) {
    for (let index = 0; index < context.sentences.length; index += 1) {
      facts.push({ title: context.title, sent_id: index });
      if (facts.length >= maxFacts) {
        return facts;
      }
    }
  }
  return facts;
}

function sentenceFor(contexts, fact) {
  const context = contexts.find((item) => item.title === fact.title) ?? contexts[0];
  if (!context) {
    return "";
  }
  return String(context.sentences[fact.sent_id] ?? context.sentences[0] ?? "");
}

function evidenceFor(row, index, maxFacts = 2) {
  const contexts = normalizeContext(row.context);
  const facts = normalizeSupportingFacts(row.supporting_facts).slice(0, maxFacts);
  const selectedFacts = facts.length > 0 ? facts : fallbackFacts(contexts, maxFacts);
  return selectedFacts.map((fact, factIndex) => ({
    id: `hotpot-${index + 1}-fact-${factIndex + 1}`,
    text: sentenceFor(contexts, fact),
    supports_claims: [`hotpot-claim-${index + 1}-${factIndex + 1}`],
    source: fact.title || `hotpot-context-${factIndex + 1}`,
    sensitivity: "public",
    validity: "valid",
  })).filter((item) => item.text);
}

function candidateAnswers(row, index) {
  const answer = String(row.answer ?? "");
  const decoys = [
    "not enough information",
    "unknown",
    `decoy-${index + 1}`,
  ].filter((item) => item && item.toLowerCase() !== answer.toLowerCase());
  return [answer, ...decoys].slice(0, 4);
}

function evidenceConflictCase(row, index) {
  const evidence = evidenceFor(row, index, 2);
  const requiredClaims = evidence.flatMap((item) => item.supports_claims);
  const id = stableId(row.id ?? row._id, `hotpot-${index + 1}`);
  return {
    id: `hotpot-evidence-${id}`,
    scenario: "evidence_conflict",
    source_ids: ["hotpotqa"],
    task: {
      description: row.question ?? "Answer the HotpotQA question using cited supporting facts.",
      oracle_answer: String(row.answer ?? ""),
      candidate_answers: candidateAnswers(row, index),
      required_claims: requiredClaims,
      requires_evidence_capsule: true,
    },
    evidence: [
      ...evidence,
      {
        id: `hotpot-${index + 1}-stale-decoy`,
        text: `A stale note suggests a conflicting answer for: ${row.question ?? "unknown question"}`,
        supports_claims: requiredClaims.slice(0, 1),
        source: "synthetic-conflict-decoy",
        sensitivity: "public",
        validity: "outdated",
      },
    ],
  };
}

function contextManifestCase(row, index) {
  const evidence = evidenceFor(row, index, 2);
  const id = stableId(row.id ?? row._id, `hotpot-${index + 1}`);
  const contexts = normalizeContext(row.context);
  const contextText = contexts.flatMap((item) => item.sentences).join("\n");
  const estimatedBytes = Math.max(100000, Buffer.byteLength(contextText, "utf8") * 25);
  return {
    id: `hotpot-context-${id}`,
    scenario: "context_manifest_stress",
    source_ids: ["hotpotqa"],
    task: {
      description: row.question ?? "Answer from a large HotpotQA evidence bundle.",
      oracle_answer: String(row.answer ?? ""),
      candidate_answers: candidateAnswers(row, index),
      evidence_bundle_bytes: estimatedBytes,
      critical_fact_ids: evidence.map((item) => item.id),
      artifact_ref: `artifact://hotpotqa/${id}`,
    },
    evidence,
    noise: {
      irrelevant_document_count: Math.max(0, contexts.length - evidence.length),
      estimated_noise_bytes: Math.max(0, estimatedBytes - Buffer.byteLength(JSON.stringify(evidence), "utf8")),
    },
  };
}

export function convertHotpotRows(rows, { limit = rows.length, mode = "both" } = {}) {
  const selected = rows.slice(0, limit);
  const cases = [];
  selected.forEach((row, index) => {
    if (mode === "evidence" || mode === "both") {
      cases.push(evidenceConflictCase(row, index));
    }
    if (mode === "context" || mode === "both") {
      cases.push(contextManifestCase(row, index));
    }
  });
  return {
    name: "agent-protocol-hotpotqa-derived",
    version: "0.1.0",
    fixture_policy: "Derived from user-provided HotpotQA rows. Keep original dataset licensing and attribution with any redistribution.",
    sources: [
      {
        id: "hotpotqa",
        name: "HotpotQA",
        url: "https://huggingface.co/datasets/hotpotqa/hotpot_qa",
        dataset_family: "multi-hop question answering with supporting facts",
        recommended_scenarios: ["evidence_conflict", "context_manifest_stress"],
        license_note: "Check upstream dataset card before redistributing raw converted rows.",
      },
    ],
    cases,
    generation: {
      generator: "scripts/convert_hotpotqa_rows.mjs",
      input_rows: selected.length,
      mode,
      total_cases: cases.length,
    },
  };
}

if (process.argv[1]?.endsWith("convert_hotpotqa_rows.mjs")) {
  const parsed = parseArgs({
    options: {
      input: { type: "string" },
      output: { type: "string" },
      limit: { type: "string", default: "50" },
      mode: { type: "string", default: "both" },
      compact: { type: "boolean", default: false },
    },
  });
  if (!parsed.values.input || !parsed.values.output) {
    throw new Error("--input and --output are required");
  }
  if (!["evidence", "context", "both"].includes(parsed.values.mode)) {
    throw new Error("--mode must be one of: evidence, context, both");
  }
  const input = JSON.parse(readFileSync(parsed.values.input, "utf8"));
  const rows = unwrapRows(input);
  const dataset = convertHotpotRows(rows, {
    limit: Number.parseInt(parsed.values.limit, 10),
    mode: parsed.values.mode,
  });
  const spacing = parsed.values.compact ? 0 : 2;
  writeFileSync(parsed.values.output, `${JSON.stringify(dataset, null, spacing)}\n`, "utf8");
}
