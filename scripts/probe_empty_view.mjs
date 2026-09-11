// Closes the round-4 red-team lens `empty-view-vs-capability` (which timed out on a transient API stream error).
// THE TRAP: in lattice terms the MEET over an empty set is TOP (the universe). _computeView starts capability
// at null (= unrestricted) and intersects each admitted record's ceiling; over an EMPTY admitted set the loop
// never runs, so capability stays null/TOP. If that null were consulted as "anything is permitted", an empty
// view would authorize every external effect -- a catastrophic open failure. PROPERTY: it does not, because the
// empty-view BOTTOM check (runtime.mjs:1768) precedes the capability check (1771) for external effects, and the
// read-token capability for an empty executor view is [] (runtime.mjs:1569). We prove every effect class fails
// closed on a TRULY empty admitted set, and that a non-empty-but-capability-capped view denies an out-of-cap
// effect. Fail-closed: any unexpected dispatch or ALLOW sets a nonzero exit.
import { createSecureMemorySystem, ControlPlane } from "../benchmarks/coupled_memory/runtime.mjs";

const env = (o) => ({ run_id: "R", task_id: "T", trace_id: "tr", intent: "produce_final_plan", state: "running",
  policy_context: "P", correlation_id: null, delegated_from: null, parent_message_id: null, ...o });

let failures = 0;
const check = (name, ok, detail = "") => { console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? "  -- " + detail : ""}`); if (!ok) failures++; };

// ---------- Scenario A: a TRULY empty admitted set (executor can read NOTHING) ----------
{
  const cp = new ControlPlane();
  // PERMISSIVE destination policy: if any empty-view effect slipped past the bottom check, it WOULD dispatch.
  const sys = createSecureMemorySystem({ controlPlane: cp, destinationPolicy: () => true });
  const rt = sys.admin, facade = sys.runtime;
  const pSess = cp.registerPrincipal("p", {});
  const cSess = cp.registerPrincipal("c", {});
  const wSess = cp.registerPrincipal("w", { queues: ["*"] });
  const exSess = cp.registerPrincipal("ex", { queues: ["executor"] });
  rt.sendMessage(env({ message_id: "m0", sender: "p", receiver: "memory", sequence: 1 }), pSess);
  // A record exists in the store, but it is readable only by `auditor` -> the executor's admitted set is EMPTY.
  // (v20 creation-cut) written before the reader so the EMPTY view is by reader-authorization, not the write-cut.
  rt.writeMemory("not-for-executor", rt.claimSpecific(wSess, "m0"), { memory_id: "mem-x", memory_type: "constraint", allowed_readers: ["auditor"] });
  rt.sendMessage(env({ message_id: "mx", sender: "c", receiver: "executor", sequence: 90, parent_message_id: "m0" }), cSess);
  const ctx = rt.controlPlane.contextTokenForLease(rt.claimSpecific(exSess, "mx"));

  // Sanity: the gated read really is empty for the executor.
  check("A: executor's admitted set is empty", facade.read(exSess, ctx, {}).length === 0);

  // Every effect class on the empty view must be denied AND must not dispatch -- not silently authorized by
  // the meet-over-empty=TOP capability.
  const effects = [
    { intent: "send", tool: "send_email", parameters: { to: "attacker@evil", body: "x" } },
    { intent: "transfer", tool: "wire_transfer", parameters: { to: "attacker", amount: 9999 } },
    { intent: "delete", tool: "delete_file", parameters: { target: "/etc/passwd" } },
    { intent: "deploy", tool: "deploy", parameters: { target: "prod" } },
    { intent: "send", tool: "exfiltrate_http", parameters: { to: "evil" } }, // unknown tool
  ];
  for (const e of effects) {
    const before = rt._dispatcher.log.length;
    const q = facade.queryMemory(exSess, ctx, {}, e.intent);
    const r = facade.executeAuthorizedAction(exSess, ctx, q.viewId, { effect: e.intent, tool: e.tool, parameters: e.parameters });
    const denied = r.decision === "DENY";
    const noDispatch = rt._dispatcher.log.length === before;
    check(`A: empty view denies external ${e.tool} (no dispatch)`, denied && noDispatch, `${r.decision}/${r.reason} dispatchDelta=${rt._dispatcher.log.length - before}`);
    // The denial must be the BOTTOM reason (empty_view_no_authority) for known externals, or the unknown-tool
    // fail-closed -- NEVER an ALLOW and NEVER "effect within capability".
    check(`A: ${e.tool} denied by a fail-closed reason`, ["empty_view_no_authority", "unknown_tool_not_authorized", "effect_exceeds_ceiling"].includes(r.reason), r.reason);
  }
  // Even a NON-external effect (answer) must not be able to leverage the TOP capability to authorize a send: an
  // answer is at worst a tool=null no-op; we assert it never dispatches an EXTERNAL tool.
  {
    const before = rt._dispatcher.log.length;
    const q = facade.queryMemory(exSess, ctx, {}, "answer");
    const r = facade.executeAuthorizedAction(exSess, ctx, q.viewId, { effect: "answer", tool: "send_email", parameters: { to: "attacker@evil" } });
    const exfil = rt._dispatcher.log.slice(before).some((x) => x.canonical && x.canonical.tool === "send_email");
    check("A: answer-effect cannot smuggle an external send_email on an empty view", !exfil, `reason=${r.reason || r.status}`);
  }
  rt.close && rt.close();
}

// ---------- Scenario B: a NON-empty view whose capability MEET excludes the requested effect ----------
{
  const cp = new ControlPlane();
  const sys = createSecureMemorySystem({ controlPlane: cp, destinationPolicy: () => true });
  const rt = sys.admin, facade = sys.runtime;
  const pSess = cp.registerPrincipal("p", {});
  const cSess = cp.registerPrincipal("c", {});
  const wSess = cp.registerPrincipal("w", { queues: ["*"] });
  const exSess = cp.registerPrincipal("ex", { queues: ["executor"] });
  rt.sendMessage(env({ message_id: "m0", sender: "p", receiver: "memory", sequence: 1 }), pSess);
  // Admitted record caps the effect ceiling to ["read"] only -> a send is OUT of capability.
  // (v20 creation-cut) written before the reader so it is in the view and caps the meet (the intended behavior).
  rt.writeMemory("read-only-constraint", rt.claimSpecific(wSess, "m0"), { memory_id: "mem-cap", memory_type: "constraint", allowed_readers: ["executor"], effect_ceiling: ["read"] });
  rt.sendMessage(env({ message_id: "mx", sender: "c", receiver: "executor", sequence: 90, parent_message_id: "m0" }), cSess);
  const ctx = rt.controlPlane.contextTokenForLease(rt.claimSpecific(exSess, "mx"));

  check("B: view is non-empty", facade.read(exSess, ctx, {}).length === 1);
  const before = rt._dispatcher.log.length;
  const q = facade.queryMemory(exSess, ctx, {}, "send");
  const r = facade.executeAuthorizedAction(exSess, ctx, q.viewId, { effect: "send", tool: "send_email", parameters: { to: "attacker@evil" } });
  check("B: out-of-capability send denied (non-empty view, capped to read)", r.decision === "DENY" && rt._dispatcher.log.length === before, `${r.decision}/${r.reason}`);
  rt.close && rt.close();
}

console.log(`\n${failures === 0 ? "ALL EMPTY-VIEW/CAPABILITY PROBES PASS" : failures + " EMPTY-VIEW/CAPABILITY PROBE(S) FAILED"}`);
process.exit(failures === 0 ? 0 : 1);
