"""Install the Knowl and agentmemory methods into a MemoryAgentBench checkout.

Run from anywhere:

    python benchmarks/memoryagentbench/mab/install.py /path/to/MemoryAgentBench

Why this exists rather than a .patch file: MemoryAgentBench moves. This clone has already taken a
renumbered results table and a new embedding baseline since the Knowl run, and a context-diff
patch fails on any of that. Anchored edits survive where a patch does not, and re-running this is
a no-op once they are in place.

Why it exists at all: the first time the Knowl adapter was built it lived only as untracked files
inside a local MAB clone, and it was lost. The published 90 then had no reproduction path.
Everything needed to re-run it is version-controlled here now.

After installing:

    npx tsup benchmarks/memoryagentbench/mab-bridge.ts --format esm --outDir .benchmark-dist --no-dts
    export KNOWL_BRIDGE=/abs/path/to/knowl/.benchmark-dist/mab-bridge.js
    cd /path/to/MemoryAgentBench
    python main.py --agent_config configs/agent_conf/RAG_Agents/gpt-4o-mini/Knowl_gpt-4o-mini.yaml ...

agentmemory additionally needs its own server running (it is a Node service, nothing lands in this
venv):  cd /path/to/agentmemory && node dist/cli.mjs      # REST on :3111
"""

import shutil
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent

METHODS = ("knowl.py", "agentmemory_bench.py", "graphiti_bench.py")

# Anchors are written as explicit line lists and joined, so no escape survives two layers of
# quoting. Each anchor must match exactly once; a replacement already present is skipped.
EDITS = [
    (
        "knowl: initialise dispatch",
        [
            '        elif self._is_agent_type("rag"):',
            "            self._initialize_rag_agent(agent_config, dataset_config)",
        ],
        [
            '        elif self._is_agent_type("knowl"):',
            "            from methods.knowl import initialize_knowl_agent",
            "            initialize_knowl_agent(self, agent_config)",
            '        elif self._is_agent_type("rag"):',
            "            self._initialize_rag_agent(agent_config, dataset_config)",
        ],
    ),
    (
        # One edit, not one per method: two edits against the same line collide on re-run, because
        # the second rewrites the line the first searches for and the run then reports the anchor
        # missing. Both methods install together, so go straight to the final list.
        "family routing (both methods)",
        ['for agent_type in ["letta", "cognee", "mem0", "zep"])'],
        ['for agent_type in ["letta", "cognee", "mem0", "zep", "knowl", "agentmemory", "graphiti"])'],
    ),
    (
        "knowl: memory-agent dispatch",
        [
            '        elif self._is_agent_type("zep"):',
            "            return self._handle_zep_agent(message, memorizing, query_id, context_id)",
        ],
        [
            '        elif self._is_agent_type("zep"):',
            "            return self._handle_zep_agent(message, memorizing, query_id, context_id)",
            '        elif self._is_agent_type("knowl"):',
            "            from methods.knowl import handle_knowl_agent",
            "            return handle_knowl_agent(self, message, memorizing, query_id, context_id)",
        ],
    ),
    (
        "agentmemory: initialise dispatch",
        [
            '        elif self._is_agent_type("knowl"):',
            "            from methods.knowl import initialize_knowl_agent",
        ],
        [
            '        elif self._is_agent_type("agentmemory"):',
            "            from methods.agentmemory_bench import initialize_agentmemory_agent",
            "            initialize_agentmemory_agent(self, agent_config)",
            '        elif self._is_agent_type("knowl"):',
            "            from methods.knowl import initialize_knowl_agent",
        ],
    ),
    (
        "graphiti: initialise dispatch",
        [
            '        elif self._is_agent_type("agentmemory"):',
            "            from methods.agentmemory_bench import initialize_agentmemory_agent",
        ],
        [
            '        elif self._is_agent_type("graphiti"):',
            "            from methods.graphiti_bench import initialize_graphiti_agent",
            "            initialize_graphiti_agent(self, agent_config)",
            '        elif self._is_agent_type("agentmemory"):',
            "            from methods.agentmemory_bench import initialize_agentmemory_agent",
        ],
    ),
    (
        "agentmemory: memory-agent dispatch",
        [
            "            return handle_knowl_agent(self, message, memorizing, query_id, context_id)",
        ],
        [
            "            return handle_knowl_agent(self, message, memorizing, query_id, context_id)",
            '        elif self._is_agent_type("agentmemory"):',
            "            from methods.agentmemory_bench import handle_agentmemory_agent",
            "            return handle_agentmemory_agent(self, message, memorizing, query_id, context_id)",
        ],
    ),
    (
        "graphiti: memory-agent dispatch",
        [
            "            return handle_agentmemory_agent(self, message, memorizing, query_id, context_id)",
        ],
        [
            "            return handle_agentmemory_agent(self, message, memorizing, query_id, context_id)",
            '        elif self._is_agent_type("graphiti"):',
            "            from methods.graphiti_bench import handle_graphiti_agent",
            "            return handle_graphiti_agent(self, message, memorizing, query_id, context_id)",
        ],
    ),
]


def main(root: Path) -> int:
    agent_py = root / "agent.py"
    if not agent_py.is_file():
        print(f"error: {agent_py} not found -- is that a MemoryAgentBench checkout?")
        return 1

    methods = root / "methods"
    configs = root / "configs" / "agent_conf" / "RAG_Agents" / "gpt-4o-mini"
    for target in (methods, configs):
        if not target.is_dir():
            print(f"error: expected directory missing: {target}")
            return 1

    for module in METHODS:
        shutil.copy2(HERE / module, methods / module)
        print(f"  copied methods/{module}")
    for cfg in sorted((HERE / "configs").glob("*.yaml")):
        shutil.copy2(cfg, configs / cfg.name)
        print(f"  copied configs/agent_conf/RAG_Agents/gpt-4o-mini/{cfg.name}")

    source = agent_py.read_text(encoding="utf-8")
    for label, anchor_lines, replacement_lines in EDITS:
        anchor = "\n".join(anchor_lines)
        replacement = "\n".join(replacement_lines)
        if replacement in source:
            print(f"  {label}: already applied")
            continue
        count = source.count(anchor)
        if count != 1:
            print(f"  error: {label}: anchor matched {count} times, expected 1.")
            print("         agent.py has moved; re-anchor this edit rather than forcing it.")
            return 1
        source = source.replace(anchor, replacement)
        print(f"  {label}: applied")
    agent_py.write_text(source, encoding="utf-8")

    print("\ndone.")
    return 0


if __name__ == "__main__":
    if len(sys.argv) != 2:
        print(__doc__)
        sys.exit(2)
    sys.exit(main(Path(sys.argv[1]).resolve()))
