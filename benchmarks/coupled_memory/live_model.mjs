import { spawnSync } from "node:child_process";
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

import { buildConditionMatrix, assertC4C5OnlyDifferByBinding, getConditionSpec } from "./conditions.mjs";
import { PHASE4_MAIN_SCENARIOS, PHASE4_SCENARIOS, runPhase4Scenario } from "./scenarios.mjs";

const DEFAULT_LIVE_MODEL = "gpt-5-nano";
const CURL_REQUEST_PATH = resolve(".omx/coupled-memory-live-request.json");
const CURL_RESPONSE_PATH = resolve(".omx/coupled-memory-live-response.json");

function stableStringify(value) {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableStringify(item)).join(",")}]`;
  }
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(",")}}`;
}

function decisionSchema() {
  return {
    type: "object",
    additionalProperties: false,
    properties: {
      selected_memory_ids: { type: "array", items: { type: "string" } },
      answer: { type: "string" },
      confidence: { type: "number" },
      needs_review: { type: "boolean" },
      selected_evidence: { type: "string" },
    },
    required: ["selected_memory_ids", "answer", "confidence", "needs_review", "selected_evidence"],
  };
}

function extractOutputText(response) {
  if (typeof response.output_text === "string") {
    return response.output_text;
  }
  const chunks = [];
  for (const item of response.output ?? []) {
    for (const content of item.content ?? []) {
      if (typeof content.text === "string") {
        chunks.push(content.text);
      } else if (typeof content.output_text === "string") {
        chunks.push(content.output_text);
      }
    }
  }
  if (chunks.length === 0) {
    throw new Error("OpenAI response did not contain output text");
  }
  return chunks.join("");
}

function extractGeminiText(response) {
  const chunks = [];
  for (const candidate of response.candidates ?? []) {
    for (const part of candidate.content?.parts ?? []) {
      if (typeof part.text === "string") {
        chunks.push(part.text);
      }
    }
  }
  if (chunks.length === 0) {
    const blocked = response.promptFeedback?.blockReason;
    throw new Error(`Gemini response did not contain output text${blocked ? ` (blockReason=${blocked})` : ""}`);
  }
  return chunks.join("");
}

export function promptPayload({ scenario, deterministic }) {
  // Prompt parity (review M6): every condition gets an IDENTICAL model-visible prompt -- the same
  // active_message context and the same instruction. We do NOT tell the model which condition it is
  // (no condition spec / feature flags), so the model cannot behave differently by label. The ONLY
  // controlled difference between C4 and C5 is which candidate_memories the deterministic gate has
  // already removed; that isolates the gate's filtering effect from any prompt-context difference.
  const cm = deterministic.current_message || {};
  return {
    scenario_id: scenario.scenario_id,
    scenario_type: scenario.scenario_type,
    query: scenario.query,
    candidate_memories: deterministic.injected_memory_ids.map((id, index) => ({
      memory_id: id,
      content: deterministic.injected_memory_contents[index],
    })),
    active_message: {
      message_id: cm.message_id,
      run_id: cm.run_id,
      task_id: cm.task_id,
      trace_id: cm.trace_id,
      receiver: cm.receiver,
      policy_context: cm.policy_context,
    },
    protocol_rule: "Select only the memory records that are valid for the active message (matching run/task/trace, an allowed receiver, and the current policy/status). Some candidates may be invalid for this message; do not select those.",
  };
}

export function evaluateLiveDecision({ deterministic, decision }) {
  const selected = decision.selected_memory_ids ?? [];
  const expected = new Set(deterministic.expected_memory_ids);
  const forbidden = new Set(deterministic.forbidden_memory_ids);
  const selectedExpected = selected.filter((id) => expected.has(id)).length;
  const selectedForbidden = selected.filter((id) => forbidden.has(id)).length;
  const success = selectedExpected === expected.size && selectedForbidden === 0;
  return {
    model_success: success,
    selected_expected_memory: selectedExpected,
    selected_forbidden_memory: selectedForbidden,
    model_selected_memory_ids: selected,
    model_answer: decision.answer,
    model_confidence: decision.confidence,
    model_needs_review: decision.needs_review,
  };
}

export class OpenAICoupledMemoryClient {
  constructor({ apiKey = process.env.OPENAI_API_KEY, model = DEFAULT_LIVE_MODEL, timeoutMs = 120000 } = {}) {
    this.apiKey = apiKey;
    this.model = model;
    this.timeoutMs = timeoutMs;
    if (!this.apiKey) {
      throw new Error("OPENAI_API_KEY is required for live coupled-memory runs");
    }
  }

  async decide({ scenario, condition, deterministic }) {
    return this.decidePayload(promptPayload({ scenario, condition, deterministic }));
  }

  // Decide from a pre-built prompt payload object (used by control/ablation runners).
  async decidePayload(payloadObject) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
    const body = {
      model: this.model,
      instructions: [
        "You are an executor in a multi-agent communication-memory benchmark.",
        "Choose the memory ids that should govern the final answer.",
        "Return exactly one compact JSON object matching the schema.",
        "Do not invent memory ids. Use needs_review=true if the condition lacks enough binding information.",
      ].join("\n"),
      input: [
        {
          role: "user",
          content: `Benchmark case JSON:\n${stableStringify(payloadObject)}`,
        },
      ],
      text: {
        format: {
          type: "json_schema",
          name: "coupled_memory_live_decision",
          strict: true,
          schema: decisionSchema(),
        },
      },
    };
    try {
      const data = await postOpenAIResponse({
        body,
        apiKey: this.apiKey,
        signal: controller.signal,
      });
      return JSON.parse(extractOutputText(data));
    } finally {
      clearTimeout(timeout);
    }
  }
}

const DEFAULT_GEMINI_MODEL = "gemini-2.5-flash";

// Non-OpenAI subject-model client (Google Gemini, generativelanguage API). Same decide() interface
// as OpenAICoupledMemoryClient so the suite runner is provider-agnostic. Used for the cross-model
// robustness check (reviewer P2: reduce OpenAI-family-specific risk).
export class GeminiCoupledMemoryClient {
  constructor({ apiKey = process.env.GEMINI_API_KEY, model = DEFAULT_GEMINI_MODEL, timeoutMs = 120000 } = {}) {
    this.apiKey = apiKey;
    this.model = model;
    this.timeoutMs = timeoutMs;
    if (!this.apiKey) {
      throw new Error("GEMINI_API_KEY is required for live Gemini coupled-memory runs");
    }
  }

  async decide({ scenario, condition, deterministic }) {
    return this.decidePayload(promptPayload({ scenario, condition, deterministic }));
  }

  async decidePayload(payloadObject) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
    const body = {
      system_instruction: {
        parts: [{
          text: [
            "You are an executor in a multi-agent communication-memory benchmark.",
            "Choose the memory ids that should govern the final answer.",
            "Return exactly one compact JSON object with keys: selected_memory_ids (array of strings),",
            "answer (string), confidence (number 0..1), needs_review (boolean), selected_evidence (string).",
            "No markdown, no code fences.",
            "Do not invent memory ids. Use needs_review=true if the condition lacks enough binding information.",
          ].join("\n"),
        }],
      },
      contents: [{
        role: "user",
        parts: [{ text: `Benchmark case JSON:\n${stableStringify(payloadObject)}` }],
      }],
      generationConfig: {
        temperature: 0,
        responseMimeType: "application/json",
      },
    };
    try {
      const data = await postGeminiResponse({
        body,
        apiKey: this.apiKey,
        model: this.model,
        signal: controller.signal,
      });
      return JSON.parse(extractGeminiText(data));
    } finally {
      clearTimeout(timeout);
    }
  }
}

async function postOpenAIResponse({ body, apiKey, signal }) {
  try {
    const response = await fetch("https://api.openai.com/v1/responses", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
      signal,
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      throw new Error(`OpenAI Responses API failed: ${response.status} ${stableStringify(data)}`);
    }
    return data;
  } catch (error) {
    if (error.message !== "fetch failed") {
      throw error;
    }
    return postOpenAIResponseWithCurl({ body, apiKey });
  }
}

function postOpenAIResponseWithCurl({ body, apiKey }) {
  mkdirSync(dirname(CURL_REQUEST_PATH), { recursive: true });
  writeFileSync(CURL_REQUEST_PATH, JSON.stringify(body), "utf8");
  const run = spawnSync("curl.exe", [
    "--ssl-no-revoke",
    "-sS",
    "-X",
    "POST",
    "https://api.openai.com/v1/responses",
    "-H",
    `Authorization: Bearer ${apiKey}`,
    "-H",
    "Content-Type: application/json",
    "--data-binary",
    `@${CURL_REQUEST_PATH}`,
    "-o",
    CURL_RESPONSE_PATH,
    "-w",
    "%{http_code}",
  ], {
    encoding: "utf8",
  });
  if (run.status !== 0) {
    throw new Error(`curl fallback failed: ${run.stderr || run.stdout}`);
  }
  const status = Number.parseInt(run.stdout.trim().replaceAll("\"", ""), 10);
  const data = JSON.parse(readFileSync(CURL_RESPONSE_PATH, "utf8"));
  if (status < 200 || status >= 300) {
    throw new Error(`OpenAI Responses API failed: ${status} ${stableStringify(data)}`);
  }
  return data;
}

function geminiUrl(model) {
  return `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`;
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Pull the server-suggested retry delay (RetryInfo.retryDelay, e.g. "6s") out of a 429/503 body.
function parseRetryDelayMs(data) {
  for (const detail of data?.error?.details ?? []) {
    if (typeof detail.retryDelay === "string") {
      const match = detail.retryDelay.match(/([\d.]+)s/);
      if (match) {
        return Math.ceil(Number.parseFloat(match[1]) * 1000);
      }
    }
  }
  return null;
}

// Free-tier Gemini enforces a low requests-per-minute quota, so a burst of calls returns 429.
// Retry on 429/503, honoring the server's retryDelay when present, else exponential backoff.
async function postGeminiResponse({ body, apiKey, model, signal, maxRetries = 6 }) {
  for (let attempt = 0; ; attempt += 1) {
    try {
      const response = await fetch(geminiUrl(model), {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-goog-api-key": apiKey,
        },
        body: JSON.stringify(body),
        signal,
      });
      const data = await response.json().catch(() => ({}));
      if ((response.status === 429 || response.status === 503) && attempt < maxRetries) {
        await sleep(parseRetryDelayMs(data) ?? Math.min(60000, 3000 * 2 ** attempt));
        continue;
      }
      if (!response.ok) {
        throw new Error(`Gemini API failed: ${response.status} ${stableStringify(data)}`);
      }
      return data;
    } catch (error) {
      if (error.message?.startsWith("Gemini API failed")) {
        throw error;
      }
      if (error.message !== "fetch failed") {
        throw error;
      }
      return postGeminiResponseWithCurl({ body, apiKey, model });
    }
  }
}

function postGeminiResponseWithCurl({ body, apiKey, model }) {
  mkdirSync(dirname(CURL_REQUEST_PATH), { recursive: true });
  writeFileSync(CURL_REQUEST_PATH, JSON.stringify(body), "utf8");
  const args = [
    "-sS", "-X", "POST", geminiUrl(model),
    "-H", `x-goog-api-key: ${apiKey}`,
    "-H", "Content-Type: application/json",
    "--data-binary", `@${CURL_REQUEST_PATH}`,
    "-o", CURL_RESPONSE_PATH, "-w", "%{http_code}",
  ];
  // POSIX curl first; fall back to curl.exe (Windows) to match postOpenAIResponseWithCurl's reach.
  let run = spawnSync("curl", args, { encoding: "utf8" });
  if (run.error) {
    run = spawnSync("curl.exe", ["--ssl-no-revoke", ...args], { encoding: "utf8" });
  }
  if (run.status !== 0) {
    throw new Error(`curl fallback failed: ${run.stderr || run.stdout}`);
  }
  const status = Number.parseInt(run.stdout.trim().replaceAll("\"", ""), 10);
  const data = JSON.parse(readFileSync(CURL_RESPONSE_PATH, "utf8"));
  if (status < 200 || status >= 300) {
    throw new Error(`Gemini API failed: ${status} ${stableStringify(data)}`);
  }
  return data;
}

function makeLiveClient({ provider, model, timeoutMs }) {
  if (provider === "gemini") {
    return new GeminiCoupledMemoryClient({ model, timeoutMs });
  }
  if (provider && provider !== "openai") {
    throw new Error(`unknown provider '${provider}' (expected 'openai' or 'gemini')`);
  }
  return new OpenAICoupledMemoryClient({ model, timeoutMs });
}

export async function runCoupledMemoryLiveSuite({
  conditions = ["C4", "C5"],
  scenarios,
  split = "dev",
  scenarioLimit = 4,
  instancesPerFamily = 0,
  runs = 1,
  provider = "openai",
  model = provider === "gemini" ? DEFAULT_GEMINI_MODEL : DEFAULT_LIVE_MODEL,
  timeoutMs = 120000,
  // Proactive inter-request throttle. Free-tier Gemini has a low requests-per-minute quota, so we
  // pace calls (the client also retries 429s with backoff). 0 = no pacing (OpenAI default).
  requestDelayMs = provider === "gemini" ? 4500 : 0,
  jsonl,
} = {}) {
  const selectedScenarios = selectScenarios({ scenarios, split, scenarioLimit, instancesPerFamily });
  const client = makeLiveClient({ provider, model, timeoutMs });
  const cases = [];
  if (jsonl) {
    mkdirSync(dirname(jsonl), { recursive: true });
    writeFileSync(jsonl, "", "utf8");
  }
  let callIndex = 0;
  for (const scenario of selectedScenarios) {
    for (const condition of conditions) {
      for (let runIndex = 0; runIndex < runs; runIndex += 1) {
        const deterministic = runPhase4Scenario({ scenario, condition });
        let decision = null;
        let apiError = "";
        if (requestDelayMs > 0 && callIndex > 0) {
          await sleep(requestDelayMs);
        }
        callIndex += 1;
        try {
          decision = await client.decide({ scenario, condition, deterministic });
        } catch (error) {
          apiError = error.message;
        }
        const evaluated = decision ? evaluateLiveDecision({ deterministic, decision }) : {};
        const row = {
          benchmark: "coupled-memory-phase6-live-model",
          live: true,
          provider,
          model,
          scenario_id: scenario.scenario_id,
          scenario_type: scenario.scenario_type,
          condition,
          run_index: runIndex,
          deterministic_success: deterministic.success,
          injected_memory_ids: deterministic.injected_memory_ids,
          expected_memory_ids: deterministic.expected_memory_ids,
          forbidden_memory_ids: deterministic.forbidden_memory_ids,
          // MEASURED reconstructability of the gate's decision (audit replay; review M2). 1 only if
          // a gate ran AND its decision log replays to exactly the admitted set; 0 for ungated reads.
          // Not synthesized from the condition label downstream.
          event_graph_reconstructability: deterministic.event_graph_reconstructability ?? 0,
          api_error: apiError,
          ...evaluated,
        };
        cases.push(row);
        if (jsonl) {
          appendFileSync(jsonl, `${JSON.stringify(row)}\n`, "utf8");
        }
      }
    }
  }
  return {
    benchmark: "coupled-memory-phase6-live-model",
    live: true,
    provider,
    model,
    runs_per_case: runs,
    split,
    scenario_limit: scenarioLimit,
    instances_per_family: instancesPerFamily,
    condition_matrix: buildConditionMatrix(conditions),
    c4_c5_parity: assertC4C5OnlyDifferByBinding(),
    cases,
    summary: summarize(cases),
  };
}

function selectScenarios({ scenarios, split, scenarioLimit, instancesPerFamily }) {
  if (scenarios) {
    return scenarios;
  }
  if (split === "main") {
    if (instancesPerFamily > 0) {
      const counts = new Map();
      return PHASE4_MAIN_SCENARIOS.filter((scenario) => {
        const count = counts.get(scenario.scenario_type) ?? 0;
        if (count >= instancesPerFamily) {
          return false;
        }
        counts.set(scenario.scenario_type, count + 1);
        return true;
      });
    }
    return PHASE4_MAIN_SCENARIOS.slice(0, scenarioLimit);
  }
  return PHASE4_SCENARIOS.slice(0, scenarioLimit);
}

function summarize(cases) {
  const groups = new Map();
  for (const item of cases) {
    const key = item.condition;
    if (!groups.has(key)) {
      groups.set(key, []);
    }
    groups.get(key).push(item);
  }
  return [...groups.entries()].map(([condition, items]) => ({
    condition,
    cases: items.length,
    api_errors: items.filter((item) => item.api_error).length,
    deterministic_success_rate: rate(items, "deterministic_success"),
    model_success_rate: rate(items, "model_success"),
    selected_forbidden_memory: items.reduce((total, item) => total + Number(item.selected_forbidden_memory ?? 0), 0),
  }));
}

function rate(items, field) {
  return Number((items.filter((item) => item[field]).length / Math.max(1, items.length)).toFixed(4));
}
