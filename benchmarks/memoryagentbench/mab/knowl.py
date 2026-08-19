"""Knowl as an agentic-memory method for MemoryAgentBench.

Knowl is a local-first project-memory engine (TypeScript + SQLite). It is driven here through a
small newline-delimited JSON bridge over stdio, built from the Knowl repository:

    npx tsup benchmarks/memoryagentbench/mab-bridge.ts --format esm --outDir .benchmark-dist --no-dts

Point KNOWL_BRIDGE at the resulting mab-bridge.js.

What makes Knowl interesting on FactConsolidation is that it resolves conflicts at WRITE time: a
fact whose subject+relation matches one already stored retires the earlier record, so the stale
value is never a retrieval candidate. Set KNOWL_SUPERSEDE=0 for the ablation that switches this
off and leaves both values active -- same corpus, same retrieval, governance toggled.

Every response line from the bridge is prefixed with a sentinel. The embedding runtime and the
SQLite bindings both write to stdout at will, and an unframed protocol would eventually swallow a
stray log line and desynchronise mid-run -- a failure that surfaces as a plausible score rather
than an error.
"""

import json
import os
import subprocess

SENTINEL = "@@KNOWL@@"


class KnowlBridge:
    """Owns the Node subprocess and speaks the line protocol to it."""

    def __init__(self, supersede=True, vector=True):
        bridge_path = os.environ.get("KNOWL_BRIDGE")
        if not bridge_path:
            raise RuntimeError(
                "Set KNOWL_BRIDGE to the built mab-bridge.js (npx tsup "
                "benchmarks/memoryagentbench/mab-bridge.ts --format esm --outDir .benchmark-dist --no-dts)"
            )
        # The bridge resolves its embedding profile from the Knowl project it belongs to, via
        # findProjectRoot(process.cwd()). Inheriting MemoryAgentBench's cwd makes it look for a
        # .knowl next to agent.py and fail. The measured store is a fresh temp dir either way --
        # this only decides which config the embedding preset is read from, and that must be the
        # Knowl repo's, so the run is reproducible from a checkout rather than from a local dir.
        project_root = os.environ.get("KNOWL_PROJECT") or os.path.dirname(
            os.path.dirname(os.path.abspath(bridge_path))
        )
        self.proc = subprocess.Popen(
            ["node", bridge_path],
            cwd=project_root,
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=None,
            text=True,
            encoding="utf-8",
            bufsize=1,
        )
        self._call({"op": "init", "supersede": supersede, "vector": vector})

    def _call(self, payload):
        self.proc.stdin.write(json.dumps(payload, ensure_ascii=False) + "\n")
        self.proc.stdin.flush()
        # Skip anything the runtime printed that is not ours. Only sentinel lines are protocol.
        while True:
            line = self.proc.stdout.readline()
            if not line:
                code = self.proc.poll()
                if code is not None:
                    raise RuntimeError(f"Knowl bridge exited with code {code}")
                raise RuntimeError("Knowl bridge closed stdout unexpectedly")
            line = line.strip()
            if not line.startswith(SENTINEL):
                continue
            result = json.loads(line[len(SENTINEL):].strip())
            if not result.get("ok"):
                raise RuntimeError(f"Knowl bridge error: {result.get('error')}")
            return result

    def add(self, text):
        self._call({"op": "add", "text": text})

    def flush(self):
        """Parse the buffered stream and write every fact.

        Idempotent: the construction-time stamp and the first query both reach for it.

        Ingestion is deferred until the whole stream is in hand: the titling rule derives each
        fact's subject+relation by shared-prefix discovery across the WHOLE fact list, so it
        cannot run chunk by chunk. Calling this explicitly at the end of memorisation is what
        keeps MemoryAgentBench's `memory_construction_time` honest -- without it the harness
        reports ~0.01s and buries the real ingest cost inside the latency of question 1.
        """
        return self._call({"op": "flush"})

    def query(self, text, k):
        return self._call({"op": "query", "text": text, "k": k})["contents"]

    def close(self):
        try:
            self._call({"op": "close"})
        except Exception:
            pass
        try:
            self.proc.stdin.close()
            self.proc.wait(timeout=30)
        except Exception:
            self.proc.kill()


def build_reader_messages(retrieval_memory_string, message, system_message):
    """Assemble the reader prompt.

    Default layout is byte-identical to MemoryAgentBench's own RAG handler
    (`ask_llm_message = retrieval_memory_string + "\\n" + message`), so a Knowl number sits
    beside the published baselines on equal terms. The task instruction therefore TRAILS the
    retrieved facts, and the system message is only the generic "you are a helpful assistant".

    KNOWL_MAB_READER_LAYOUT=system-first is a diagnostic, not a competing result: it moves the
    same instruction text into a system message ahead of the facts. It is our construction, not
    a standard, and any number produced under it must be labelled as such.
    """
    if os.environ.get("KNOWL_MAB_READER_LAYOUT") == "system-first":
        return [
            {"role": "system", "content": message},
            {"role": "user", "content": retrieval_memory_string},
        ]
    ask_llm_message = retrieval_memory_string + "\n" + message
    return [
        {"role": "system", "content": system_message},
        {"role": "user", "content": ask_llm_message},
    ]


def format_retrieval_memory_string(contents):
    """Match `_handle_bm25_rag` exactly: each item gets a trailing newline, then 'Memory i:' labels."""
    retrieval_context = [f"{text}\n" for text in contents]
    return "\n".join(f"Memory {i + 1}:\n{text}" for i, text in enumerate(retrieval_context))


# ── the two entry points agent.py delegates to ─────────────────────────────────
#
# The logic lives here rather than in agent.py so the patch applied to MemoryAgentBench stays
# three lines. Upstream moves -- this clone already took a renumbered table and a new baseline --
# and a small patch survives a rebase where a large one does not.

def initialize_knowl_agent(agent, agent_config=None):
    """Start the bridge.

    The arm is chosen by `knowl_supersede` in the agent config -- that is what distinguishes the
    two checked-in YAMLs, so a run is reproducible from the config alone. KNOWL_SUPERSEDE=0 still
    overrides, for a one-off ablation without editing a file.
    """
    config = agent_config or {}
    # Set the same fields every other memory agent's initialiser sets (see _initialize_mem0_agent):
    # the memory-agent path does not run _initialize_rag_agent, so nothing else assigns these.
    agent.retrieve_num = config["retrieve_num"]
    agent.context = ""
    agent.agent_start_time = __import__("time").time()

    supersede = bool(config.get("knowl_supersede", True))
    vector = bool(config.get("knowl_vector", True))
    if os.environ.get("KNOWL_SUPERSEDE") == "0":
        supersede = False
    agent.knowl = KnowlBridge(supersede=supersede, vector=vector)
    print("Knowl bridge up, supersede=%s vector=%s" % (supersede, vector))


def handle_knowl_agent(agent, message, memorizing, query_id, context_id):
    """Mirror `_handle_bm25_rag`: same retrieval-query extraction, same reader assembly.

    The only deliberate difference from the RAG handlers is that ingestion is buffered and
    flushed once, which is a property of the system under test rather than of the harness.
    """
    import time

    if memorizing:
        agent.knowl.add(message)
        return "Memorized"

    start_time = time.time()

    # Flush here, not lazily inside the first query, so the cost lands in
    # memory_construction_time where the harness reports it.
    stats = agent.knowl.flush()
    memory_construction_time = time.time() - start_time

    # Identical to every RAG baseline: MAB wraps each question in ~200 tokens of task
    # boilerplate that is byte-identical across questions, so retrieving on the raw message is
    # retrieving on noise. See agent.py `_extract_retrieval_query`.
    retrieval_query = agent._extract_retrieval_query(message)

    contents = agent.knowl.query(retrieval_query, agent.retrieve_num)
    retrieval_memory_string = format_retrieval_memory_string(contents)

    from utils.templates import get_template
    system_message = get_template(agent.sub_dataset, "system", agent.agent_name)
    format_message = build_reader_messages(retrieval_memory_string, message, system_message)

    response = agent._create_oai_client().chat.completions.create(
        model=agent.model,
        messages=format_message,
        temperature=agent.temperature,
        max_tokens=agent.max_tokens if "gpt-4" in agent.model else None,
    )

    query_time_len = time.time() - start_time - memory_construction_time
    print(f"\nknowl stats: {stats}\n")

    return agent._create_standard_response(
        response.choices[0].message.content,
        response.usage.prompt_tokens,
        response.usage.completion_tokens,
        memory_construction_time,
        query_time_len,
    )
