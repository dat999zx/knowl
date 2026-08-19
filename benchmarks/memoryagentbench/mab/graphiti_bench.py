"""Graphiti as a memory method for MemoryAgentBench.

Graphiti (getzep/graphiti) is Zep's open-source temporal knowledge-graph engine. Zep's hosted
product has a published FC-SH row (7.0 in arXiv 2507.05257v4 Table 3); Graphiti itself does not,
so this is a new measurement.

BACKEND: FalkorDB, one fresh graph per run, via

    docker run -d --name mab-falkordb -p 6379:6379 falkordb/falkordb:latest

Kuzu was tried first because it is embedded and needs no container, and it does not work: both
0.29.2 and 0.29.3 fail on the first write with "Table RelatesToNode_ doesn't have an index with
name edge_name_and_fact" against kuzu 0.11.3, the version graphiti's own extra requires. FalkorDB
is also the fairer choice -- it is a backend Graphiti ships, tests and documents, so a number
measured on it reflects the system rather than an unfinished driver.

LLM AND EMBEDDER go through the same OpenAI-compatible endpoint the harness uses for every other
method (`OPENAI_BASE_URL` / `OPENAI_API_KEY`) on the same `gpt-4o-mini` backbone the paper
specifies for all RAG and commercial memory agents.

COST WARNING, and it is the reason this method is run at 6k before 262k: unlike every other
method here, Graphiti's ingest is LLM-driven. `add_episode` extracts entities and edges, dedupes
both, and resolves temporal invalidation -- several model calls per episode. 455 facts is a few
hundred calls; the 262k instance is 18,332 facts and would be roughly forty times that. Measure
here, extrapolate, then decide.

NORMALIZED INPUT: the identical parsed fact list every other method gets, one episode per fact in
context order, via the shared `parse_fact_lines` port of `facts.ts:parseFactLines`. `reference_time`
carries the context position so the graph has the same recency signal the task provides -- nothing
marks a fact as an update, which is the point of FactConsolidation.
"""

import asyncio
import os
import time
from datetime import datetime, timedelta, timezone

from methods.agentmemory_bench import parse_fact_lines


class GraphitiClient:
    def __init__(self, model, group_id):
        from graphiti_core import Graphiti
        from graphiti_core.driver.falkordb_driver import FalkorDriver
        from graphiti_core.embedder.openai import OpenAIEmbedder, OpenAIEmbedderConfig
        from graphiti_core.llm_client.config import LLMConfig
        from graphiti_core.llm_client.openai_client import OpenAIClient

        self.group_id = group_id
        self.chunks = []
        self.flushed = False
        self.episodes = 0

        # A per-run graph name inside one FalkorDB server is the isolation boundary: the server
        # is shared, the graph is not, and `close` drops it.
        self.graph_name = group_id

        base_url = os.environ.get("OPENAI_BASE_URL")
        api_key = os.environ.get("OPENAI_API_KEY")
        llm_config = LLMConfig(api_key=api_key, base_url=base_url, model=model, small_model=model)

        self.graphiti = Graphiti(
            graph_driver=FalkorDriver(
                host=os.environ.get("FALKORDB_HOST", "127.0.0.1"),
                port=int(os.environ.get("FALKORDB_PORT", "6379")),
                database=self.graph_name,
            ),
            llm_client=OpenAIClient(config=llm_config),
            embedder=OpenAIEmbedder(
                config=OpenAIEmbedderConfig(
                    api_key=api_key,
                    base_url=base_url,
                    embedding_model="text-embedding-3-small",
                )
            ),
        )
        self.loop = asyncio.new_event_loop()
        self.loop.run_until_complete(self.graphiti.build_indices_and_constraints())

    def add(self, text):
        self.chunks.append(text)

    def flush(self):
        """One episode per fact, awaited in order. Idempotent, like every other method's flush.

        Awaited rather than fired concurrently on purpose: `add_episode` resolves each new fact
        against what the graph already holds, so overlapping calls would race on exactly the
        conflict resolution the task measures.
        """
        if self.flushed:
            return {"episodes": self.episodes}

        facts = parse_fact_lines("".join(self.chunks))
        base = datetime(2020, 1, 1, tzinfo=timezone.utc)

        async def ingest():
            for position, fact in enumerate(facts):
                await self.graphiti.add_episode(
                    name=f"fact-{position}",
                    episode_body=fact,
                    source_description="MemoryAgentBench FactConsolidation",
                    reference_time=base + timedelta(seconds=position),
                )

        self.loop.run_until_complete(ingest())
        self.episodes = len(facts)
        self.flushed = True
        print(f"\ngraphiti flush: {self.episodes} episodes ingested\n")
        return {"episodes": self.episodes}

    def query(self, text, k):
        edges = self.loop.run_until_complete(
            self.graphiti.search(query=text, num_results=k)
        )
        return [edge.fact for edge in edges if getattr(edge, "fact", None)]

    def close(self):
        try:
            self.loop.run_until_complete(self.graphiti.close())
        except Exception:
            pass
        try:
            self.loop.close()
        except Exception:
            pass



def initialize_graphiti_agent(agent, agent_config=None):
    config = agent_config or {}
    agent.retrieve_num = config["retrieve_num"]
    agent.context = ""
    agent.agent_start_time = time.time()
    group_id = f"mab_{agent.sub_dataset}_{os.getpid()}_{int(time.time())}"
    agent.graphiti_client = GraphitiClient(agent.model, group_id)
    print(f"\n\ngraphiti up on kuzu, group_id={group_id}\n\n")


def handle_graphiti_agent(agent, message, memorizing, query_id, context_id):
    """Mirror `_handle_bm25_rag`: same query extraction, same reader assembly."""
    from methods.knowl import build_reader_messages, format_retrieval_memory_string
    from utils.templates import get_template

    if memorizing:
        agent.graphiti_client.add(message)
        return "Memorized"

    start_time = time.time()
    stats = agent.graphiti_client.flush()
    memory_construction_time = time.time() - start_time

    retrieval_query = agent._extract_retrieval_query(message)
    contents = agent.graphiti_client.query(retrieval_query, agent.retrieve_num)
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
    print(f"\ngraphiti stats: {stats}\n")

    return agent._create_standard_response(
        response.choices[0].message.content,
        response.usage.prompt_tokens,
        response.usage.completion_tokens,
        memory_construction_time,
        query_time_len,
    )
