// E18 — long-running MULTI-AGENT, MULTI-TURN workflow benchmark.
// A workflow runs several LLM agent roles over many turns against a SHARED memory store that
// accumulates as the workflow proceeds. A communication-memory mismatch (a contaminating record from
// another run / a superseded constraint) is present in the store; a binding-blind workflow (C4) may
// ground on it at ANY turn and propagate the error to the final deliverable, while the message-bound
// gate (C5) filters it at every read. Scored END-TO-END: the final answer must be correct AND no turn
// may have acted on a forbidden (contaminating) record. This is a long-running workflow task, not a
// single memory-selection decision.
//
// Episode schema (data/longrun/*.json -> array of episodes):
// {
//   episode_id, domain, goal, final_question, gold_answer,
//   active_context: { run_id, task_id, trace_id, receiver, policy_context },
//   event_graph: [message_id, ...],                       // valid source message ids (provenance)
//   expected_memory_ids: [...], forbidden_memory_ids: [...],
//   seed_memory: [ { memory_id, content, run_id, task_id, status, source_message_id,
//                    allowed_readers, policy_context, memory_type } ],
//   turns: [ { turn, agent, instruction } ]               // >= 5 turns, multiple agent roles
// }
import { evaluateMemoryGateStandalone } from "../external/mbm_gate.mjs";

const API = "https://api.openai.com/v1/responses";

function extract(d) {
  return d.output_text ?? (d.output ?? []).flatMap((o) => (o.content ?? []).map((c) => c.text || "")).join("");
}

async function callJSON({ apiKey, model, instructions, user, schema, name }) {
  const body = {
    model, instructions,
    input: [{ role: "user", content: user }],
    text: { format: { type: "json_schema", name, strict: true, schema } },
  };
  const r = await fetch(API, { method: "POST", headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" }, body: JSON.stringify(body) });
  const d = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`OpenAI ${r.status}: ${JSON.stringify(d).slice(0, 160)}`);
  return JSON.parse(extract(d));
}

const TURN_SCHEMA = {
  type: "object", additionalProperties: false,
  properties: {
    used_memory_ids: { type: "array", items: { type: "string" } },
    output: { type: "string" },
    write_content: { type: "string" }, // "" if this turn writes nothing
  },
  required: ["used_memory_ids", "output", "write_content"],
};

function readable(store, active, eventGraph, condition) {
  if (condition !== "C5") return store;
  const eg = new Set(eventGraph);
  // Fail-closed (review M6): the gate result is used as-is. There is NO ground-truth fallback to
  // `_expected`; an empty admitted set is a real outcome (the agent simply gets no readable memory),
  // never silently backfilled with the answer key.
  return store.filter((m) => evaluateMemoryGateStandalone(m, active, { eventGraph: eg }).decision === "allow");
}

const fmtMem = (ms) => ms.length ? ms.map((m) => `- [${m.memory_id}] ${m.content}`).join("\n") : "(no readable memory)";
const fmtTranscript = (t) => t.length ? t.map((x) => `Turn ${x.turn} (${x.agent}): ${x.output}`).join("\n") : "(workflow just started)";

export async function runEpisode({ episode, condition, client, apiKey, model, judgeModel }) {
  const active = { ...episode.active_context };
  const store = episode.seed_memory.map((m) => ({
    ...m,
    _expected: (episode.expected_memory_ids || []).includes(m.memory_id),
    _forbidden: (episode.forbidden_memory_ids || []).includes(m.memory_id),
  }));
  const transcript = [];
  const contaminationTurns = [];
  let writeSeq = 0;

  for (const t of episode.turns) {
    const reads = readable(store, active, episode.event_graph || [], condition);
    let res = null, err = "";
    try {
      res = await callJSON({
        apiKey, model, name: "agent_turn",
        instructions: [
          `You are the ${t.agent} agent in a long-running multi-agent workflow.`,
          `Workflow goal: ${episode.goal}`,
          "Use ONLY the readable shared-memory records below; cite the memory ids you relied on in used_memory_ids.",
          "If your step should record a new shared fact, put it in write_content (else empty string).",
        ].join("\n"),
        user: `Active run/task: ${active.run_id}/${active.task_id} (receiver=${active.receiver}, policy=${active.policy_context})\n\nReadable shared memory:\n${fmtMem(reads)}\n\nWorkflow so far:\n${fmtTranscript(transcript)}\n\nYour instruction (${t.agent}): ${t.instruction}`,
        schema: TURN_SCHEMA,
      });
    } catch (e) { err = e.message; }
    if (err) return { episode_id: episode.episode_id, condition, model, api_error: err };
    const used = res.used_memory_ids || [];
    if (used.some((id) => (episode.forbidden_memory_ids || []).includes(id))) contaminationTurns.push(t.turn);
    transcript.push({ turn: t.turn, agent: t.agent, output: res.output, used });
    if (res.write_content && res.write_content.trim()) {
      writeSeq += 1;
      store.push({ // a new record stamped from the ACTIVE message (write-time binding)
        memory_id: `${episode.episode_id}-w${writeSeq}`, content: res.write_content,
        run_id: active.run_id, task_id: active.task_id, status: "active",
        source_message_id: (episode.event_graph || [])[0], allowed_readers: ["*"],
        policy_context: active.policy_context, memory_type: "note", _expected: false, _forbidden: false,
      });
    }
  }

  // end-to-end final answer = last turn output; judge vs gold (blind to condition / memory).
  const finalAns = transcript.length ? transcript[transcript.length - 1].output : "";
  const verdict = await callJSON({
    apiKey, model: judgeModel, name: "grade",
    instructions: "Decide if the predicted final answer is correct for the question, given the reference answer. Semantic match; ignore phrasing. Return JSON {correct}.",
    user: `Question: ${episode.final_question}\nReference: ${episode.gold_answer}\nPredicted final answer: ${finalAns}`,
    schema: { type: "object", additionalProperties: false, properties: { correct: { type: "boolean" } }, required: ["correct"] },
  });

  const contaminated = contaminationTurns.length > 0;
  const answer_correct = !!verdict.correct;
  return {
    episode_id: episode.episode_id, domain: episode.domain, condition, model,
    turns: episode.turns.length, store_final: store.length,
    answer_correct, contaminated, contamination_turns: contaminationTurns,
    end_to_end_success: answer_correct && !contaminated,
    final_answer: finalAns, api_error: "",
  };
}
