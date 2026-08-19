"""agentmemory as a memory method for MemoryAgentBench.

agentmemory (github.com/rohitg00/agentmemory) is a Node service built on the iii engine. It is
driven here over its REST surface, so nothing is installed into this venv:

    cd /path/to/agentmemory && node dist/cli.mjs      # REST on :3111
    export AGENTMEMORY_URL=http://127.0.0.1:3111     # optional, this is the default

It is not evaluated on MemoryAgentBench upstream -- their published numbers are LongMemEval-S
R@5, a retrieval-recall metric on a different task -- so this is a new measurement rather than a
reproduction, and there is no vendor figure to check it against.

NORMALIZED INPUT. Both systems receive the identical parsed fact list, in context order, one
record per fact. `parse_fact_lines` below is a faithful port of `facts.ts:parseFactLines` from the
Knowl repository, marker rule included. That is the standing benchmark decision: normalized
retrieval compares identical prepared records with no system-specific extraction, so neither side
gets a cleaner corpus than the other.

Feeding raw 4096-char chunks instead was considered and rejected. agentmemory stores one memory
per `remember` call, so a chunk would land as a single record holding ~70 facts -- supersession
could never fire and retrieval would return a wall of text. That would measure our chunking
choice, not their memory.

ISOLATION. Every run writes under a unique `project`. agentmemory's supersession guard skips a
candidate only when both sides carry an explicit and different project (an unscoped record is
treated as a wildcard), so a per-run project name keeps runs from seeing each other as long as
every write is scoped -- which it is here.
"""

import json
import os
import re
import time
import urllib.error
import urllib.request

DEFAULT_URL = "http://127.0.0.1:3111"


def _post(base_url, path, payload, timeout=120):
    data = json.dumps(payload).encode("utf-8")
    request = urllib.request.Request(
        f"{base_url}{path}",
        data=data,
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    with urllib.request.urlopen(request, timeout=timeout) as response:
        return json.loads(response.read().decode("utf-8"))


def strip_trailing_period(text):
    text = text.strip()
    return text[:-1].strip() if text.endswith(".") else text


def parse_fact_lines(context):
    """Port of facts.ts:parseFactLines.

    The CR context is a numbered list, `0.` through `N.`. A marker counts only when its number is
    the one expected next, so a stray "3." inside a fact's own text is kept as text rather than
    splitting it, and any header before "0." is dropped for free.
    """
    starts = []
    expected = 0
    for match in re.finditer(r"(\d+)\.", context):
        if int(match.group(1)) != expected:
            continue
        starts.append(match.end())
        expected += 1

    if not starts:
        return []

    facts = []
    for position, start in enumerate(starts):
        if position + 1 < len(starts):
            end = context.rfind(f"{position + 1}.", 0, starts[position + 1])
        else:
            end = len(context)
        facts.append(strip_trailing_period(context[start:end]))
    return [f for f in facts if f]


class AgentMemoryClient:
    def __init__(self, base_url, project):
        self.base_url = base_url.rstrip("/")
        self.project = project
        self.chunks = []
        self.flushed = False
        self.facts = 0
        self.superseded = 0

    def add(self, text):
        self.chunks.append(text)

    def flush(self):
        """Write every parsed fact, in context order. Idempotent, like the Knowl bridge's flush.

        Order is the only recency signal the task provides -- nothing marks a fact as an update,
        which is the whole point of FactConsolidation.
        """
        if self.flushed:
            return {"facts": self.facts, "superseded": self.superseded}

        facts = parse_fact_lines("".join(self.chunks))
        superseded = 0
        for fact in facts:
            result = _post(
                self.base_url,
                "/agentmemory/remember",
                {"content": fact, "project": self.project},
            )
            memory = result.get("memory") or {}
            if memory.get("supersedes"):
                superseded += 1

        self.facts = len(facts)
        self.superseded = superseded
        self.flushed = True
        print(f"\nagentmemory flush: {self.facts} facts, {superseded} superseded at write\n")
        return {"facts": self.facts, "superseded": superseded}

    def query(self, text, k):
        result = _post(
            self.base_url,
            "/agentmemory/search",
            {"query": text, "limit": k, "project": self.project},
        )
        contents = []
        for row in (result.get("results") or [])[:k]:
            observation = row.get("observation") or {}
            content = observation.get("narrative") or observation.get("title") or ""
            if not content:
                facts = observation.get("facts") or []
                content = "\n".join(facts)
            if content:
                contents.append(content)
        return contents


def initialize_agentmemory_agent(agent, agent_config=None):
    config = agent_config or {}
    agent.retrieve_num = config["retrieve_num"]
    agent.context = ""
    agent.agent_start_time = time.time()

    base_url = os.environ.get("AGENTMEMORY_URL", DEFAULT_URL)
    project = f"mab_{agent.sub_dataset}_{os.getpid()}_{int(time.time())}"
    agent.agentmemory = AgentMemoryClient(base_url, project)
    print(f"\n\nagentmemory at {base_url}, project={project}\n\n")


def handle_agentmemory_agent(agent, message, memorizing, query_id, context_id):
    """Mirror `_handle_bm25_rag`: same query extraction, same reader assembly."""
    from methods.knowl import build_reader_messages, format_retrieval_memory_string
    from utils.templates import get_template

    if memorizing:
        agent.agentmemory.add(message)
        return "Memorized"

    start_time = time.time()
    stats = agent.agentmemory.flush()
    memory_construction_time = time.time() - start_time

    retrieval_query = agent._extract_retrieval_query(message)
    contents = agent.agentmemory.query(retrieval_query, agent.retrieve_num)
    retrieval_memory_string = format_retrieval_memory_string(contents)

    system_message = get_template(agent.sub_dataset, "system", agent.agent_name)
    format_message = build_reader_messages(retrieval_memory_string, message, system_message)

    response = agent._create_oai_client().chat.completions.create(
        model=agent.model,
        messages=format_message,
        temperature=agent.temperature,
        max_tokens=agent.max_tokens if "gpt-4" in agent.model else None,
    )

    query_time_len = time.time() - start_time - memory_construction_time
    print(f"\nagentmemory stats: {stats}\n")

    return agent._create_standard_response(
        response.choices[0].message.content,
        response.usage.prompt_tokens,
        response.usage.completion_tokens,
        memory_construction_time,
        query_time_len,
    )
