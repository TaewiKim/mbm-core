# References

This file keeps the paper-oriented references separate from run notes. It is
organized by how each reference informs the benchmark and proposed protocol.

## Agent Interoperability and Protocols

### KQML

- Title: KQML as an Agent Communication Language
- URL: https://research.cs.umbc.edu/kqml/papers/kqml-acl-html/root2.html
- Relevance: Early agent communication language based on explicit
  performatives and message-handling semantics.

### Model Context Protocol

- Title: Model Context Protocol specification
- URL: https://modelcontextprotocol.io/specification/2025-03-26/basic/index
- Relevance: Tool/resource context protocol baseline. Useful as a contrast:
  MCP standardizes application-context access, while this project studies
  agent-to-agent communication-memory semantics.

### Agent2Agent

- Title: Agent2Agent protocol specification
- URL: https://github.com/a2aproject/A2A/blob/main/docs/specification.md
- Relevance: Agent-to-agent task exchange and interoperability baseline.
  Useful for comparing agent card, task lifecycle, and delegation concepts.

### A Survey of Agent Interoperability Protocols

- Title: A survey of agent interoperability protocols: Model Context Protocol
  (MCP), Agent Communication Protocol (ACP), Agent-to-Agent Protocol (A2A), and
  Agent Network Protocol (ANP)
- URL: https://arxiv.org/abs/2505.02279
- Relevance: Survey framing for positioning the proposed communication-memory
  control plane as an overlay rather than a replacement for existing protocols.

### ProtocolBench

- Title: Which LLM Multi-Agent Protocol to Choose?
- URL: https://arxiv.org/abs/2510.17149
- Relevance: Direct motivation for protocol-level benchmarks that measure
  success, overhead, latency, and robustness.

## Multi-Agent Benchmarks and Frameworks

### AutoGen

- Title: AutoGen: Enabling Next-Gen LLM Applications via Multi-Agent
  Conversation
- URL: https://arxiv.org/abs/2308.08155
- Relevance: Multi-agent conversation framework; useful as a framework-level
  contrast with protocol-level semantics.

### CAMEL

- Title: CAMEL: Communicative Agents for "Mind" Exploration of Large Scale
  Language Model Society
- URL: https://arxiv.org/abs/2303.17760
- Relevance: Role-playing communicative agents and task collaboration through
  dialogue.

### AgentBench

- Title: AgentBench: Evaluating LLMs as Agents
- URL: https://arxiv.org/abs/2308.03688
- Relevance: General interactive agent evaluation benchmark.

### MultiAgentBench

- Title: MultiAgentBench: Evaluating the Collaboration and Competition of LLM
  agents
- URL: https://arxiv.org/abs/2503.01935
- Relevance: Multi-agent collaboration/competition benchmark framing.

### SOTOPIA

- Title: SOTOPIA: Interactive Evaluation for Social Intelligence in Language
  Agents
- URL: https://github.com/sotopia-lab/sotopia
- Relevance: Open-ended social interaction environment. Useful source family
  for multi-agent privacy and capability-routing cases.

## Privacy and Safety

### AgentLeak

- Title: AgentLeak: A Full-Stack Benchmark for Privacy Leakage in Multi-Agent
  LLM Systems
- URL: https://arxiv.org/abs/2602.11510
- Relevance: Key motivation for measuring intermediate inter-agent messages,
  shared memory, and tool arguments rather than final outputs only.

### Security Threat Modeling for Emerging AI-Agent Protocols

- Title: Security Threat Modeling for Emerging AI-Agent Protocols
- URL: https://arxiv.org/abs/2602.11327
- Relevance: Threat model background for identity, capability, delegation, and
  policy-boundary checks.

## Memory and Context Management

### Generative Agents

- Title: Generative Agents: Interactive Simulacra of Human Behavior
- URL: https://arxiv.org/abs/2304.03442
- Relevance: Early influential memory/reflection architecture for agents.

### MemGPT

- Title: MemGPT: Towards LLMs as Operating Systems
- URL: https://arxiv.org/abs/2310.08560
- Relevance: Treats context and memory management as an operating-system-like
  problem.

### LoCoMo

- Title: Evaluating Very Long-Term Conversational Memory of LLM Agents
- URL: https://snap-research.github.io/locomo/
- Relevance: Long-term conversational memory dataset and benchmark. Useful for
  cross-session rehydration and forgetting experiments.

### Multi-Agent Memory from a Computer Architecture Perspective

- Title: Multi-Agent Memory from a Computer Architecture Perspective: Visions
  and Challenges Ahead
- URL: https://arxiv.org/abs/2603.10062
- Relevance: Conceptual support for treating memory hierarchy, coherence,
  consistency, and access control as multi-agent systems concerns.

### MPAC

- Title: MPAC: A Multi-Principal Agent Coordination Protocol for Interoperable
  Multi-Agent Collaboration
- URL: https://arxiv.org/abs/2604.09744
- Relevance: Directly related multi-principal coordination protocol with
  session, intent, operation, conflict, and governance semantics. Useful as a
  strong coordination baseline rather than a memory-specific baseline.

### Mesh Memory Protocol

- Title: Mesh Memory Protocol: Semantic Infrastructure for Multi-Agent LLM
  Systems
- URL: https://arxiv.org/abs/2604.19540
- Relevance: Closest protocol-memory comparison point. It specifies field-level
  memory acceptance, inter-agent lineage, and receiver-evaluated memory blocks.

### Intrinsic Memory Agents

- Title: Intrinsic Memory Agents: Heterogeneous Multi-Agent LLM Systems through
  Structured Contextual Memory
- URL: https://arxiv.org/abs/2508.08997
- Relevance: Strong multi-agent memory framework reference. Useful for
  positioning ACM-CP as a protocol-layer control plane rather than an
  agent-internal memory architecture.

### Q-KVComm

- Title: Q-KVComm: Efficient Multi-Agent Communication Via Adaptive KV Cache
  Compression
- URL: https://arxiv.org/abs/2512.17914
- Relevance: Communication-efficiency baseline for large-context transfer. It
  is not a policy/provenance protocol, but it is a strong comparator for
  wire-byte and context-transfer claims.

### GroupMemBench

- Title: GroupMemBench: Benchmarking LLM Agent Memory in Multi-Party
  Conversations
- URL: https://arxiv.org/abs/2605.14498
- Relevance: Multi-party memory benchmark; useful source family for group
  memory and shared-memory consistency cases.

## Evidence and Open-Source Dataset Families

### HotpotQA

- Title: HotpotQA
- URL: https://huggingface.co/datasets/hotpotqa/hotpot_qa
- Relevance: Multi-hop QA with questions, answers, context, and supporting
  facts. Useful for evidence capsule and context-manifest stress tests.
- License note: Dataset card lists `cc-by-sa-4.0`; check upstream terms before
  redistributing raw converted rows.

### FEVER

- Title: FEVER: a Large-scale Dataset for Fact Extraction and VERification
- URL: https://fever.ai/
- Relevance: Candidate future source for claim/evidence verification cases.

## OpenAI API

### GPT-5.4 mini

- Title: OpenAI GPT-5.4 mini model documentation
- URL: https://developers.openai.com/api/docs/models/gpt-5.4-mini
- Relevance: Target live model requested for the simulator.

### Responses API

- Title: OpenAI Responses API reference
- URL: https://platform.openai.com/docs/api-reference/responses
- Relevance: Live simulator transport for structured JSON outputs.

### Structured Outputs

- Title: OpenAI Structured Outputs guide
- URL: https://platform.openai.com/docs/guides/structured-outputs
- Relevance: Used by live simulator clients to request schema-constrained JSON.
