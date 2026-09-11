#!/usr/bin/env node
// analyze_oss_shared_store.mjs
// -----------------------------------------------------------------------------
// STRUCTURAL-FREQUENCY analysis (NOT a vulnerability proof) for the MBM-Core
//  paper.
//
// Thesis under test: shared agent memory (a store / state / message pool that is
// shared across more than one run, thread, or agent/role) returns records by
// relevance / scope / key / recency, and NOT by whether a record is AUTHORIZED
// for the *active message* being served right now. We call the co-occurrence of
// (a) a shared store with (b) a retrieval API that carries no active-message /
// run / thread identity the STRUCTURAL PRECONDITION for the
// "communication-memory mismatch".
//
// This script measures how often that structural precondition appears in three
// real OSS multi-agent frameworks. It does NOT prove any read is exploitable:
// confirming exploitability needs the active-message context that the
// frameworks themselves do not track, so it cannot be decided statically here.
//
// Method (deterministic given the pinned SHAs):
//   * DENOMINATOR ("shared-store read sites"): code locations that READ from a
//     memory/store/state/message-pool that is shared across >1 run/thread/agent.
//   * NUMERATOR ("active-message-unbound"): the subset of those reads whose
//     retrieval key is namespace / similarity / key / recency / role / action,
//     with NO thread_id / run / active-message scoping argument. Reads that ARE
//     scoped (e.g. LangGraph checkpointer reads, which are keyed by thread_id)
//     are counted in the denominator but EXCLUDED from the numerator -- this is
//     the conservative, honest split.
//
// Patterns were derived by reading the actual framework source at the pinned
// SHAs (see per-pattern comments). They match production code; matches in
// tests / docs / examples are reported separately and are NOT counted in the
// headline numerator. We deliberately prefer a smaller, defensible number to an
// inflated one.
//
// Output: results/eval/oss-shared-store-analysis.json
// All file paths in the output are RELATIVE to each clone root. No absolute
// local paths ever appear in the analyzer output.
// -----------------------------------------------------------------------------

import { execFileSync } from "node:child_process";
import { writeFileSync, mkdirSync, existsSync, readdirSync, readFileSync } from "node:fs";
import { relative, sep, join } from "node:path";

// Clone roots. Overridable via env so the analysis is reproducible on any box
// that has cloned the pinned SHAs; defaults point at the scratch dir used to
// produce the committed result. NOTE: these are inputs only -- nothing derived
// from them (absolute paths) is ever written to the output JSON.
const CLONES = {
  autogen: process.env.AUTOGEN_DIR || "../_oss_clones/autogen",
  langgraph: process.env.LANGGRAPH_DIR || "../_oss_clones/langgraph",
  metagpt: process.env.METAGPT_DIR || "../_oss_clones/metagpt",
};

const REPO_META = {
  autogen: { url: "https://github.com/microsoft/autogen.git", subtree: "python/packages" },
  langgraph: { url: "https://github.com/langchain-ai/langgraph.git", subtree: "libs" },
  metagpt: { url: "https://github.com/FoundationAgents/MetaGPT.git", subtree: "metagpt" },
};

// A match is classified "test/doc" (excluded from headline counts) if its path
// contains any of these segments. Reported separately for transparency.
const NONPROD_RE = /(^|[\\/])(tests?|test_utils|examples?|docs?|samples?|benchmark|bench)([\\/]|$)|(^|[\\/])test_[^\\/]*\.py$|[^\\/]*_test\.py$/i;

// -----------------------------------------------------------------------------
// Pattern definitions. Each entry:
//   id        : stable identifier
//   role      : "denominator" (shared-store read) or
//               "numerator"   (active-message-unbound subset; also counted in
//                              the denominator)
//   bound     : true  => shared read that IS run/thread/active-message scoped
//                        (denominator only, never numerator)
//   regex     : ripgrep pattern (PCRE2)
//   why       : justification, citing the real API observed at the pinned SHA
// -----------------------------------------------------------------------------
const PATTERNS = {
  // ---------------------------------------------------------------- LangGraph
  // BaseStore is documented as "shared across threads" and its read APIs
  // (.get(namespace, key) / .search(namespace_prefix, query=...)) take only a
  // namespace / key / natural-language query -- NO thread_id or active-message
  // identity. This is the canonical unbound shared-store read.
  langgraph: [
    {
      id: "lg_store_search",
      role: "numerator",
      bound: false,
      // store.search( / .asearch(  -- similarity/namespace retrieval, unbound.
      regex: String.raw`\b(\w*store\w*|self)\.a?search\(`,
      why: "BaseStore.search/asearch(namespace_prefix, *, query=...) retrieves by namespace+similarity; store is shared across threads (BaseStore docstring); no thread_id/active-message arg => active-message-UNBOUND.",
    },
    {
      id: "lg_store_get",
      role: "numerator",
      bound: false,
      // store.get( / .aget(  -- key retrieval within a (shared) namespace.
      regex: String.raw`\b(\w*store\w*)\.a?get\(`,
      why: "BaseStore.get/aget(namespace, key) retrieves by key within a cross-thread shared namespace; no thread_id/active-message scoping => active-message-UNBOUND.",
    },
    {
      id: "lg_checkpoint_get_tuple",
      role: "denominator",
      bound: true,
      // checkpointer get_tuple/aget_tuple(config) -- shared persistence layer,
      // but config["configurable"]["thread_id"] IS the primary key, so these
      // reads ARE thread-scoped. Counted as a shared read but NOT unbound.
      regex: String.raw`\.a?get_tuple\(`,
      why: "Checkpointer get_tuple/aget_tuple(config) reads shared persisted state but is keyed by config thread_id (BaseCheckpointSaver docstring: 'thread_id is the primary key'); thread-bound => denominator only.",
    },
  ],

  // ----------------------------------------------------------------- AutoGen
  autogen: [
    {
      id: "ag_memory_query",
      role: "numerator",
      bound: false,
      // Memory.query(query, ...) -- the abstract memory read; returns entries
      // "with relevance scores". A single Memory instance is passed to one or
      // more AssistantAgents (memory= param) and queried per-turn via
      // update_context; retrieval is by relevance, with no active-message id.
      // Restricted to memory-like receivers (self / mem / *memory) so unrelated
      // .query( calls (e.g. SQL/DB clients) are not counted. self.query inside a
      // Memory subclass IS a Memory.query call.
      regex: String.raw`\b(self|mem|\w*memory)\.query\(`,
      why: "Memory.query(query, ...) returns entries by relevance score (Memory ABC docstring); shared memory instance can be attached to multiple agents; retrieval carries no run/active-message identity => active-message-UNBOUND. Restricted to self/mem/*memory receivers (Memory subclasses) to exclude unrelated .query() calls.",
    },
    {
      id: "ag_update_context",
      role: "numerator",
      bound: false,
      // update_context(model_context) -- each agent enriches its context from
      // memory before inference (AssistantAgent._update_model_context). Reads
      // memory keyed only on the current model_context similarity, not on which
      // active message is authorized.
      regex: String.raw`\.update_context\(`,
      why: "Memory.update_context(model_context) injects memory into an agent's context by similarity to model_context; no authorization scoping to the active message => active-message-UNBOUND.",
    },
    {
      id: "ag_group_message_thread_read",
      role: "numerator",
      bound: false,
      // Group-chat manager keeps a single self._message_thread shared by all
      // participating agents and READS it (select_speaker, iteration, slicing,
      // serialization). Every agent reads the same pooled history regardless of
      // which message is being served. We count READ uses only: we EXCLUDE
      // writes (assignment `self._message_thread =`, the `: List[...]` init, and
      // mutators .clear()/.extend()/.append()). A read is a use of the value
      // (passed as an arg, iterated `for .. in`, comprehension `in self._message_thread`,
      // reversed(...), or sliced).
      regex: String.raw`self\._message_thread\b(?!\s*[:=](?!=))(?!\.(clear|extend|append)\()`,
      why: "Group-chat manager's self._message_thread is one shared history READ by all agents (select_speaker, iteration, serialization); reads are not scoped to an authorized active message => active-message-UNBOUND. Writes (assignment, type-annot init, .clear/.extend/.append) are excluded.",
    },
  ],

  // ----------------------------------------------------------------- MetaGPT
  metagpt: [
    {
      id: "mg_memory_get",
      role: "numerator",
      bound: false,
      // Role memory read by recency: Memory.get(k) returns the most-recent k
      // messages. A Role's rc.memory is populated (via _observe -> add_batch)
      // with messages PUBLISHED BY OTHER ROLES through the Environment, so it is
      // effectively a cross-role shared store; get(k) selects by recency only.
      regex: String.raw`\bmemory\.get\(`,
      why: "Memory.get(k) returns most-recent k messages; a Role's rc.memory is filled with other roles' messages via Environment.publish_message -> _observe.add_batch, so it is a cross-role shared store read by recency => active-message-UNBOUND.",
    },
    {
      id: "mg_memory_get_by",
      role: "numerator",
      bound: false,
      // Retrieval by role / action / content / keyword -- get_by_role,
      // get_by_action(s), get_by_content, try_remember. All scope by attribute,
      // never by the active-message/run identity.
      regex: String.raw`\bmemory\.(get_by_role|get_by_action|get_by_actions|get_by_content|try_remember)\(`,
      why: "Memory.get_by_role/get_by_action(s)/get_by_content/try_remember scope retrieval by role/action/content keyword over the (cross-role-populated) store; no active-message/run scoping => active-message-UNBOUND.",
    },
    {
      id: "mg_search_retrieve",
      role: "numerator",
      bound: false,
      // Long-term / RAG retrieval: MemoryStorage.search_similar and RAG
      // engine.retrieve(query) -- pure similarity retrieval over a shared
      // index, no active-message identity.
      regex: String.raw`\.(search_similar|retrieve)\(`,
      why: "MemoryStorage.search_similar / RAG engine.retrieve(query) retrieve by embedding similarity over a shared index; no run/active-message scoping => active-message-UNBOUND.",
    },
  ],
};

function gitHead(dir) {
  return execFileSync("git", ["-C", dir, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
}

// Pure-Node .py file walker (no external ripgrep dependency, so the analyzer is
// self-contained and reproducible on any machine with only Node + the pinned
// clones). Caches file lists per (cloneDir, subtree) so repeated pattern passes
// do not re-walk the tree. Directories irrelevant to source are pruned for speed.
const SKIP_DIRS = new Set([".git", "__pycache__", ".venv", "node_modules", ".mypy_cache", ".pytest_cache", "dist", "build", ".tox"]);
const _pyFileCache = new Map();

function listPyFiles(cloneDir, subtree) {
  const cacheKey = `${cloneDir}::${subtree}`;
  if (_pyFileCache.has(cacheKey)) return _pyFileCache.get(cacheKey);
  const root = join(cloneDir, subtree);
  const files = [];
  const stack = [root];
  while (stack.length) {
    const cur = stack.pop();
    let entries;
    try { entries = readdirSync(cur, { withFileTypes: true }); } catch { continue; }
    for (const ent of entries) {
      if (ent.isDirectory()) {
        if (SKIP_DIRS.has(ent.name)) continue;
        stack.push(join(cur, ent.name));
      } else if (ent.isFile() && ent.name.endsWith(".py")) {
        files.push(join(cur, ent.name));
      }
    }
  }
  files.sort(); // deterministic ordering independent of filesystem
  _pyFileCache.set(cacheKey, files);
  return files;
}

// Compute, per line, whether that line is "code context" (not a comment and not
// inside a triple-quoted docstring / fenced example block). Python docstrings
// and ```python fenced examples are the dominant source of false positives in
// these repos (e.g. LangGraph store.get/.search appear ~10x more often in
// docstring usage examples than in executed library code), so excluding them is
// essential for an honest count. This is a lexical scanner: it tracks triple-
// quote (''' / \"\"\") open/close state and skips '#' comment lines. It does not
// fully parse Python strings, but is conservative -- when in doubt it marks a
// line as NON-code so it is excluded from counting.
function codeContextMask(lines) {
  const mask = new Array(lines.length).fill(true);
  let inTriple = null; // null | '"""' | "'''"
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (inTriple) {
      mask[i] = false; // line is inside a docstring body
      if (line.includes(inTriple)) inTriple = null;
      continue;
    }
    const stripped = line.trim();
    // Full-line comment.
    if (stripped.startsWith("#")) { mask[i] = false; continue; }
    // Detect a triple-quote that opens (and possibly closes) on this line.
    for (const q of ['"""', "'''"]) {
      const first = line.indexOf(q);
      if (first === -1) continue;
      const rest = line.slice(first + 3);
      const closes = rest.includes(q);
      if (!closes) {
        // Opens a multi-line docstring; this line is treated as non-code.
        inTriple = q;
        mask[i] = false;
      } else {
        // One-line docstring/string literal: if the whole line is essentially
        // a string (common for module/func docstrings), treat as non-code.
        if (/^\s*[rbuf]*("""|''')/.test(line)) mask[i] = false;
      }
      break;
    }
  }
  return mask;
}

// Apply a single regex over every .py file under the subtree, counting only
// matches that fall on code-context lines (not comments/docstrings/examples).
// The PATTERNS use only portable RegExp syntax (\b, \w, character classes,
// capture groups) so a JS RegExp is faithful to the intended PCRE2 semantics.
// Returns array of {file(relative, POSIX), line, text}.
function rgMatches(cloneDir, subtree, regex) {
  const re = new RegExp(regex);
  const results = [];
  for (const absPath of listPyFiles(cloneDir, subtree)) {
    let content;
    try { content = readFileSync(absPath, "utf8"); } catch { continue; }
    const lines = content.split(/\r?\n/);
    const mask = codeContextMask(lines);
    for (let i = 0; i < lines.length; i++) {
      if (!mask[i]) continue; // skip comments / docstring / example bodies
      // Exclude matches that occur inside a string literal or backtick span on
      // an otherwise-code line (e.g. error messages like
      //   "...replace `store.get(...)` with ...").
      if (matchInsideStringOrBacktick(lines[i], re)) continue;
      if (re.test(lines[i])) {
        const rel = relative(cloneDir, absPath).split(sep).join("/");
        results.push({ file: rel, line: i + 1, text: lines[i].trim() });
      }
    }
  }
  return results;
}

// True if the regex's match position on this line lies inside a single/double
// quoted string or a backtick span (common in error-message text that mentions
// an API name). Conservative: if the match is inside quotes, we drop it.
function matchInsideStringOrBacktick(line, re) {
  const reG = new RegExp(re.source, "g");
  const m = reG.exec(line);
  if (!m) return false;
  const idx = m.index;
  const before = line.slice(0, idx);
  const dq = (before.match(/"/g) || []).length;
  const sq = (before.match(/'/g) || []).length;
  const bt = (before.match(/`/g) || []).length;
  // Odd count of an unescaped quote/backtick before the match => inside it.
  return dq % 2 === 1 || sq % 2 === 1 || bt % 2 === 1;
}

// A handful of matches are docstring/example lines even inside production files
// (e.g. LangGraph store base/__init__.py docstrings show `store.search(...)`).
// We additionally flag obvious docstring/example lines (assignment to a demo
// var inside a fenced example) so the headline count is conservative. This is a
// best-effort lexical heuristic, reported under `docexample_inline`.
function looksLikeInlineDocExample(text) {
  // `results = store.search(` / `item = store.get(` patterns used in docstrings
  // and `>>> ` doctest prompts.
  return /^>>>/.test(text) || /^\#/.test(text) || /^results?\s*=\s*(await\s+)?store\.(a?search|a?get)\(/.test(text) || /^item\s*=\s*(await\s+)?store\.a?get\(/.test(text);
}

function analyzeFramework(name) {
  const dir = CLONES[name];
  if (!existsSync(dir)) {
    throw new Error(`clone not found for ${name} (set ${name.toUpperCase()}_DIR)`);
  }
  const { url, subtree } = REPO_META[name];
  const sha = gitHead(dir);
  const patternResults = [];
  // Dedup read sites by file:line across patterns so a line matched by two
  // patterns is not double-counted in the totals.
  const denomKeys = new Set();
  const numerKeys = new Set();
  const denomProdKeys = new Set();
  const numerProdKeys = new Set();
  let docExampleInline = 0;

  for (const pat of PATTERNS[name]) {
    const matches = rgMatches(dir, subtree, pat.regex);
    let prodCount = 0, nonprodCount = 0, docInline = 0;
    const exampleSites = [];
    for (const m of matches) {
      const key = `${m.file}:${m.line}`;
      const isNonProd = NONPROD_RE.test(m.file);
      const isDocInline = !isNonProd && looksLikeInlineDocExample(m.text);
      if (isNonProd) nonprodCount += 1;
      else if (isDocInline) { docInline += 1; docExampleInline += 1; }
      else prodCount += 1;

      // Totals (production, non-doc-example lines only).
      const countable = !isNonProd && !isDocInline;
      denomKeys.add(key);
      if (pat.role === "numerator") numerKeys.add(key);
      if (countable) {
        denomProdKeys.add(key);
        if (pat.role === "numerator") numerProdKeys.add(key);
      }
      if (countable && exampleSites.length < 6) exampleSites.push(m);
    }
    patternResults.push({
      id: pat.id,
      role: pat.role,
      bound: pat.bound,
      pattern: pat.regex,
      why: pat.why,
      matches_total: matches.length,
      matches_production: prodCount,
      matches_test_or_doc: nonprodCount,
      matches_inline_docexample: docInline,
      examples: exampleSites.slice(0, 5).map((m) => ({ file: m.file, line: m.line, text: m.text })),
    });
  }

  return {
    repo_url: url,
    pinned_sha: sha,
    source_subtree: subtree,
    // Headline counts: production lines only, deduped by file:line.
    shared_store_read_sites: denomProdKeys.size,
    active_message_unbound: numerProdKeys.size,
    pct_unbound: denomProdKeys.size
      ? Number(((100 * numerProdKeys.size) / denomProdKeys.size).toFixed(1))
      : null,
    // Transparency: also report including test/doc matches.
    shared_store_read_sites_incl_test_doc: denomKeys.size,
    active_message_unbound_incl_test_doc: numerKeys.size,
    inline_docexample_lines_excluded: docExampleInline,
    patterns: patternResults,
    representative_examples: patternResults
      .flatMap((p) => p.examples.map((e) => ({ pattern_id: p.id, ...e })))
      .slice(0, 5),
  };
}

const frameworks = {};
for (const name of Object.keys(CLONES)) {
  frameworks[name] = analyzeFramework(name);
}

const totalShared = Object.values(frameworks).reduce((a, f) => a + f.shared_store_read_sites, 0);
const totalUnbound = Object.values(frameworks).reduce((a, f) => a + f.active_message_unbound, 0);

const out = {
  analysis: "oss-shared-store-structural-frequency",
  generated_for: "MBM-Core  paper -- structural precondition frequency, NOT a vulnerability proof",
  honest_finding:
    "This analysis counts STRUCTURAL PRECONDITIONS, not confirmed exploits. A 'shared-store read site' is a code location that reads from a memory/store/state/message-pool shared across more than one run, thread, or agent/role. It is 'active-message-unbound' when retrieval is by namespace / similarity / key / recency / role / action with NO scoping to the current run/thread/active-message identity. The co-occurrence of a shared store and an unbound read is the precondition for the communication-memory mismatch the paper studies: memory returns records by relevance/scope, not by whether a record is authorized for the message being served now. These counts do NOT establish that any read is exploitable; confirming exploitability requires the active-message authorization context that none of these frameworks track at the read API, and therefore cannot be decided by static analysis here. Counts are production code only (deduped by file:line); test/doc/example matches and inline docstring examples are reported separately and excluded from the headline numbers. Thread/run-bound shared reads (e.g. LangGraph checkpointer reads keyed by thread_id) are counted as shared-store reads but EXCLUDED from the unbound numerator.",
  method: {
    denominator: "shared-store read sites = code locations reading a store/state/message-pool shared across >1 run/thread/agent/role (production code, deduped by file:line).",
    numerator: "active-message-unbound = subset whose retrieval key is namespace/similarity/key/recency/role/action with no thread_id/run/active-message scoping. Thread-bound reads (checkpointer get_tuple) are excluded.",
    determinism: "Deterministic given the pinned SHAs; patterns are hardcoded regexes applied by a self-contained pure-Node scanner (no external ripgrep dependency) over .py files in each framework's source subtree, with a lexical pass that excludes Python comments and triple-quoted docstring / fenced-example bodies.",
    nonprod_excluded: "Paths matching tests/examples/docs/samples/benchmark and test_*.py/*_test.py are excluded from headline counts and reported under *_incl_test_doc.",
  },
  totals: {
    shared_store_read_sites: totalShared,
    active_message_unbound: totalUnbound,
    pct_unbound: totalShared ? Number(((100 * totalUnbound) / totalShared).toFixed(1)) : null,
  },
  frameworks,
};

mkdirSync("results/eval", { recursive: true });
writeFileSync("results/eval/oss-shared-store-analysis.json", JSON.stringify(out, null, 2) + "\n");

for (const [name, f] of Object.entries(frameworks)) {
  console.log(
    `[${name}] sha=${f.pinned_sha.slice(0, 12)} shared=${f.shared_store_read_sites} unbound=${f.active_message_unbound} (${f.pct_unbound}%)`,
  );
}
console.log(
  `[TOTAL] shared=${totalShared} unbound=${totalUnbound} (${out.totals.pct_unbound}%) -> results/eval/oss-shared-store-analysis.json`,
);
