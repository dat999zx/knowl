"""Install the Knowl method into a MemoryAgentBench checkout.

Run from anywhere:

    python benchmarks/memoryagentbench/mab/install.py /path/to/MemoryAgentBench

Why this exists rather than a .patch file: MemoryAgentBench moves. This clone has already taken a
renumbered results table and a new embedding baseline since the Knowl run, and a context-diff
patch fails on any of that. Three anchored edits survive where a patch does not, and re-running
this is a no-op once they are in place.

Why it exists at all: the first time the adapter was built it lived only as untracked files inside
a local MAB clone, and it was lost. The published 90 then had no reproduction path. Everything
needed to re-run it is version-controlled here now.

After installing:

    npx tsup benchmarks/memoryagentbench/mab-bridge.ts --format esm --outDir .benchmark-dist --no-dts
    export KNOWL_BRIDGE=/abs/path/to/knowl/.benchmark-dist/mab-bridge.js
    cd /path/to/MemoryAgentBench
    python main.py --agent_config configs/agent_conf/RAG_Agents/gpt-4o-mini/Knowl_gpt-4o-mini.yaml ...
"""

import shutil
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent

# (anchor, replacement). Each anchor is matched exactly once; if the replacement is already
# present the edit is skipped. Anchors are two lines wherever one line would be ambiguous --
# `_is_agent_type("zep")` appears in both the initialise and the handle dispatch.
EDITS = [
    (
        "initialise dispatch",
        '        elif self._is_agent_type("rag"):\n'
        "            self._initialize_rag_agent(agent_config, dataset_config)",
        '        elif self._is_agent_type("knowl"):\n'
        "            from methods.knowl import initialize_knowl_agent\n"
        "            initialize_knowl_agent(self, agent_config)\n"
        '        elif self._is_agent_type("rag"):\n'
        "            self._initialize_rag_agent(agent_config, dataset_config)",
    ),
    (
        "family routing",
        'for agent_type in ["letta", "cognee", "mem0", "zep"])',
        'for agent_type in ["letta", "cognee", "mem0", "zep", "knowl"])',
    ),
    (
        "memory-agent dispatch",
        '        elif self._is_agent_type("zep"):\n'
        "            return self._handle_zep_agent(message, memorizing, query_id, context_id)",
        '        elif self._is_agent_type("zep"):\n'
        "            return self._handle_zep_agent(message, memorizing, query_id, context_id)\n"
        '        elif self._is_agent_type("knowl"):\n'
        "            from methods.knowl import handle_knowl_agent\n"
        "            return handle_knowl_agent(self, message, memorizing, query_id, context_id)",
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

    shutil.copy2(HERE / "knowl.py", methods / "knowl.py")
    print(f"  copied methods/knowl.py")
    for cfg in sorted((HERE / "configs").glob("*.yaml")):
        shutil.copy2(cfg, configs / cfg.name)
        print(f"  copied configs/agent_conf/RAG_Agents/gpt-4o-mini/{cfg.name}")

    source = agent_py.read_text(encoding="utf-8")
    for label, anchor, replacement in EDITS:
        if replacement in source:
            print(f"  {label}: already applied")
            continue
        count = source.count(anchor)
        if count != 1:
            print(f"  error: {label}: anchor matched {count} times, expected 1. agent.py has moved;")
            print(f"         re-anchor this edit rather than forcing it.")
            return 1
        source = source.replace(anchor, replacement)
        print(f"  {label}: applied")
    agent_py.write_text(source, encoding="utf-8")

    print("\ndone. Build the bridge and set KNOWL_BRIDGE, then run main.py with either config.")
    return 0


if __name__ == "__main__":
    if len(sys.argv) != 2:
        print(__doc__)
        sys.exit(2)
    sys.exit(main(Path(sys.argv[1]).resolve()))
