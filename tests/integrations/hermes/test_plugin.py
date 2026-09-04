"""Unit test for the shipped Hermes plugin.

Run: python -m unittest tests/integrations/hermes/test_plugin.py

Every case here is a contract with something outside this file -- Hermes' hook dispatcher, or
the `knowl` CLI's output shape -- so the assertions quote the real shapes rather than shapes
this test invented.
"""
import importlib.util
import json
import os
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
PLUGIN = os.path.join(HERE, "..", "..", "..", "integrations", "hermes", "knowl", "__init__.py")


def load_plugin():
    spec = importlib.util.spec_from_file_location("knowl_hermes_plugin", PLUGIN)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def load_plugin_as_memory_provider():
    """Import it the way Hermes' memory loader does, under its own namespace.

    `plugins/memory/__init__.py::_load_provider_from_dir` names a user-installed provider
    `_hermes_user_memory.<dir>`, and that name is the only thing telling this module which of
    its two importers ran.
    """
    spec = importlib.util.spec_from_file_location("_hermes_user_memory.knowl", PLUGIN)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


class FakeCollector:
    """Hermes' `_ProviderCollector`, including the part that makes double-registration possible.

    The real one is not a stub: its `__getattr__` forwards every `register_*` call to a live
    PluginContext. So `register_hook` here records into the same place the hook pass would,
    which is exactly the failure the module-name check exists to prevent.
    """

    def __init__(self):
        self.provider = None
        self.hooks = {}
        self.sections = {}
        self.tools = {}

    def get_config(self, key, default=None):
        return default

    def register_memory_provider(self, provider):
        self.provider = provider

    def register_hook(self, name, fn):
        self.hooks[name] = fn

    def register_tool(self, name, toolset, schema, handler, description="", emoji="", **_):
        self.tools[name] = (schema, handler)

    def register_system_prompt_section(self, id, content, *, position="after_memory", max_chars=4000):
        self.sections[id] = (content, position, max_chars)


class FakeCtx:
    """Enough of Hermes' PluginContext for register() to run."""

    def __init__(self, settings=None):
        self.hooks = {}
        self.sections = {}
        self.tools = {}
        self._settings = settings or {}

    def get_config(self, key, default=None):
        return self._settings.get(key, default)

    def register_hook(self, name, fn):
        self.hooks[name] = fn

    def register_tool(self, name, toolset, schema, handler, description="", emoji="", **_):
        self.tools[name] = (schema, handler)

    def register_system_prompt_section(self, id, content, *, position="after_memory", max_chars=4000):
        self.sections[id] = (content, position, max_chars)


class PluginTest(unittest.TestCase):
    def setUp(self):
        self.plugin = load_plugin()
        self.calls = []
        self.results = {}
        self.timeouts = {}

        def fake_run(event, payload, cwd, timeout=None):
            self.calls.append((event, payload, cwd))
            self.timeouts[event] = timeout
            return self.results.get(event, (None, 0, ""))

        def fake_query(text, cwd, limit=8, timeout=20.0):
            return self.results.get("__query__", [])

        def fake_cli(args, cwd, timeout=30.0):
            self.cli_calls.append((args, cwd))
            return self.results.get("__cli__", (0, "[]", ""))

        self.cli_calls = []
        self.plugin._Runner.run = lambda _self, event, payload, cwd, timeout=None: fake_run(event, payload, cwd, timeout)
        self.plugin._Runner.query = lambda _self, text, cwd, limit=8, timeout=20.0: fake_query(text, cwd, limit, timeout)
        self.plugin._Runner.cli = lambda _self, args, cwd, timeout=30.0: fake_cli(args, cwd, timeout)
        # A real project directory, so the cheap `.knowl` pre-check passes.
        self.plugin._has_knowl_project = lambda cwd: True
        self.plugin._is_hermes_source_clone = lambda cwd: False
        self.plugin._resolve_cwd = lambda: os.getcwd()

        self.ctx = FakeCtx()
        self.plugin.register(self.ctx)

    # -- registration ---------------------------------------------------------

    def test_registers_every_hook_the_profile_expects(self):
        self.assertEqual(
            sorted(self.ctx.hooks),
            [
                "on_session_end",
                "on_session_finalize",
                "post_tool_call",
                "pre_llm_call",
                "pre_tool_call",
                "pre_verify",
                "transform_tool_result",
            ],
        )
        # on_session_start is deliberately absent: it would spend the bootstrap card on an
        # event Hermes discards, leaving the first real turn with nothing.
        self.assertNotIn("on_session_start", self.ctx.hooks)

    def test_registers_the_rules_section(self):
        self.assertIn("knowl.project-memory", self.ctx.sections)
        render = self.ctx.sections["knowl.project-memory"][0]
        self.assertIn("knowl_query", render({}))

    def test_a_session_with_no_project_still_gets_rules(self):
        """Gating the rules on a project is why a Home session called nothing: the card arrived
        and the model was never told the tools existed."""
        self.plugin._has_knowl_project = lambda cwd: False
        self.plugin._has_global_store = lambda: True
        ctx = FakeCtx()
        self.plugin.register(ctx)
        rendered = ctx.sections["knowl.project-memory"][0]({})
        self.assertIn("knowl_query", rendered)
        self.assertIn("no project open", rendered.lower())

    def test_no_rules_when_there_is_no_memory_at_all(self):
        self.plugin._has_knowl_project = lambda cwd: False
        self.plugin._has_global_store = lambda: False
        ctx = FakeCtx()
        self.plugin.register(ctx)
        self.assertEqual(ctx.sections["knowl.project-memory"][0]({}), "")

    # -- the memory tools -----------------------------------------------------

    def test_registers_the_memory_tools(self):
        self.assertEqual(sorted(self.ctx.tools), ["knowl_query", "knowl_store"])

    def test_query_tool_returns_items_from_either_output_shape(self):
        keyed = json.dumps({"knowl": [{"id": "1"}], "other": [{"id": "2"}]})
        for label, out, expected in (("bare", json.dumps([{"id": "1"}]), 1), ("keyed", keyed, 2)):
            with self.subTest(label):
                self.results["__cli__"] = (0, out, "")
                _schema, handler = self.ctx.tools["knowl_query"]
                self.assertEqual(len(json.loads(handler({"query": "x"}))["items"]), expected)

    def test_query_tool_runs_in_the_session_directory_with_bounded_limit(self):
        self.results["__cli__"] = (0, "[]", "")
        _schema, handler = self.ctx.tools["knowl_query"]
        handler({"query": "hermes hooks", "limit": 999, "category": "decision"})
        args, cwd = self.cli_calls[-1]
        self.assertEqual(args[:2], ["query", "hermes hooks"])
        self.assertEqual(args[args.index("--limit") + 1], "25")  # clamped, not passed through
        self.assertEqual(args[args.index("--category") + 1], "decision")
        self.assertEqual(cwd, os.getcwd())

    def test_store_tool_passes_every_field_through(self):
        self.results["__cli__"] = (0, "Stored fact abc123: A title", "")
        _schema, handler = self.ctx.tools["knowl_store"]
        out = json.loads(handler({
            "content": "body", "title": "A title", "category": "fact",
            "paths": ["src/a.ts", "src/b.ts"], "tags": ["hermes"], "provenance": "observed",
        }))
        self.assertTrue(out["ok"])
        args, _cwd = self.cli_calls[-1]
        self.assertEqual(args[:2], ["store", "body"])
        self.assertEqual(args[args.index("--title") + 1], "A title")
        self.assertEqual([args[i + 1] for i, a in enumerate(args) if a == "--path"], ["src/a.ts", "src/b.ts"])
        self.assertEqual(args[args.index("--provenance") + 1], "observed")

    def test_store_tool_hands_back_a_refusal_verbatim(self):
        # Secret detection refuses the write; the caller has to see why.
        self.results["__cli__"] = (1, "", "Knowledge write rejected: secret material was detected.")
        _schema, handler = self.ctx.tools["knowl_store"]
        self.assertIn("secret material", json.loads(handler({"content": "c", "title": "t", "category": "fact"}))["error"])

    def test_tools_require_their_arguments(self):
        _q_schema, query = self.ctx.tools["knowl_query"]
        self.assertIn("error", json.loads(query({"query": "  "})))
        _s_schema, store = self.ctx.tools["knowl_store"]
        self.assertIn("error", json.loads(store({"content": "c", "title": "t"})))

    def test_tools_answer_from_the_machine_store_when_there_is_no_project(self):
        """A folderless session still has the personal-defaults layer to read and write."""
        self.plugin._has_knowl_project = lambda cwd: False
        self.plugin._has_global_store = lambda: True
        ctx = FakeCtx()
        self.plugin.register(ctx)

        self.results["__cli__"] = (0, json.dumps([{"id": "1", "title": "I prefer pnpm"}]), "")
        _q, query = ctx.tools["knowl_query"]
        self.assertEqual(len(json.loads(query({"query": "package manager"}))["items"]), 1)

        # A write with no repository to own it belongs to the machine, and says so outright
        # rather than landing wherever a default happens to point.
        self.results["__cli__"] = (0, "Stored fact abc: t", "")
        _s, store = ctx.tools["knowl_store"]
        self.assertTrue(json.loads(store({"content": "c", "title": "t", "category": "fact"}))["ok"])
        args, _cwd = self.cli_calls[-1]
        self.assertEqual(args[args.index("--namespace") + 1], "global")

    def test_tools_say_so_with_no_project_and_no_machine_store(self):
        self.plugin._has_knowl_project = lambda cwd: False
        self.plugin._has_global_store = lambda: False
        ctx = FakeCtx()
        self.plugin.register(ctx)
        for name in ("knowl_query", "knowl_store"):
            _schema, handler = ctx.tools[name]
            error = json.loads(handler({"query": "x", "content": "c", "title": "t", "category": "fact"}))["error"]
            self.assertIn("No Knowl memory", error)

    def test_the_machine_home_is_not_mistaken_for_a_project(self):
        """`~/.knowl` exists on every machine that has run Knowl, and is not a project.

        Accepting any `.knowl` directory reported every path under the user's home as a project,
        so the plugin fired hooks the engine could only refuse.
        """
        home = os.path.join(os.sep, "fake-home")
        knowl_home = os.path.join(home, ".knowl")
        project = os.path.join(home, "repo")
        plugin = load_plugin()
        plugin._knowl_home = lambda: knowl_home
        # Only these two directories exist, so the walk cannot wander into the real home --
        # a temp directory would, because %TEMP% lives under it on Windows.
        present = {os.path.normcase(knowl_home), os.path.normcase(os.path.join(project, ".knowl"))}
        plugin.os.path.isdir = lambda p: os.path.normcase(p) in present

        try:
            # The machine home is not a project, so nothing under it becomes one by inheritance.
            self.assertFalse(plugin._has_knowl_project(home))
            self.assertFalse(plugin._has_knowl_project(os.path.join(home, "Documents")))
            # A real project below it is still found.
            self.assertTrue(plugin._has_knowl_project(project))
        finally:
            plugin.os.path.isdir = os.path.isdir

    # -- payload shape --------------------------------------------------------

    def test_payload_matches_the_hermes_shell_hook_shape(self):
        self.ctx.hooks["pre_tool_call"](tool_name="write_file", args={"path": "a.py"}, session_id="s1")
        event, payload, _cwd = self.calls[-1]
        self.assertEqual(event, "pre_tool_call")
        self.assertEqual(payload["hook_event_name"], "pre_tool_call")
        self.assertEqual(payload["session_id"], "s1")
        self.assertEqual(payload["tool_name"], "write_file")
        self.assertEqual(payload["tool_input"], {"path": "a.py"})
        self.assertIn("cwd", payload)
        json.dumps(payload)  # must survive the pipe to the CLI

    # -- the write gate -------------------------------------------------------

    def test_gate_blocks_on_a_decision_and_on_exit_two(self):
        self.results["pre_tool_call"] = ({"decision": "block", "reason": "trap"}, 0, "")
        self.assertEqual(
            self.ctx.hooks["pre_tool_call"](tool_name="write_file", args={}, session_id="s"),
            {"action": "block", "message": "trap"},
        )
        self.results["pre_tool_call"] = (None, 2, "refused by the gate")
        out = self.ctx.hooks["pre_tool_call"](tool_name="patch", args={}, session_id="s")
        self.assertEqual(out["action"], "block")

    # -- the project root every MCP call carries --------------------------------

    def test_mcp_calls_carry_the_session_project_root(self):
        out = self.ctx.hooks["pre_tool_call"](
            tool_name="mcp__knowl__knowl_query", args={"query": "x"}, session_id="s"
        )
        self.assertEqual(out["action"], "modify")
        self.assertEqual(out["args"]["query"], "x")
        self.assertEqual(out["args"][self.plugin.PROJECT_ROOT_ARG], os.getcwd())
        # Injection is local: it must not spend a subprocess on the tool-call path.
        self.assertEqual(self.calls, [])

    def test_mcp_calls_are_left_alone_outside_a_knowl_project(self):
        # Better the server's own honest "no project here" than a root we invented.
        self.plugin._has_knowl_project = lambda cwd: False
        ctx = FakeCtx()
        self.plugin.register(ctx)
        self.assertIsNone(ctx.hooks["pre_tool_call"](tool_name="mcp__knowl__knowl_query", args={}, session_id="s"))

    def test_other_servers_tools_are_untouched(self):
        self.assertIsNone(self.ctx.hooks["pre_tool_call"](tool_name="mcp__github__create_issue", args={}, session_id="s"))

    def test_gate_ignores_tools_that_do_not_write(self):
        self.assertIsNone(self.ctx.hooks["pre_tool_call"](tool_name="read_file", args={}, session_id="s"))
        self.assertIsNone(self.ctx.hooks["pre_tool_call"](tool_name="terminal", args={}, session_id="s"))

    def test_gate_answers_before_hermes_fails_it_closed(self):
        """pre_tool_call is the one hook Hermes fails CLOSED on timeout, so we must answer first."""
        self.ctx.hooks["pre_tool_call"](tool_name="write_file", args={}, session_id="s")
        used = self.timeouts["pre_tool_call"]
        self.assertIsNotNone(used)
        self.assertLess(used, self.plugin.DEFAULT_HOOK_CALLBACK_TIMEOUT)
        self.assertGreaterEqual(used, self.plugin.MIN_GATE_TIMEOUT_SECONDS)

    # -- recall card ----------------------------------------------------------

    def test_turn_card_is_returned_and_bounded_under_the_spill_threshold(self):
        self.results["pre_llm_call"] = ({"context": "REMEMBER"}, 0, "")
        self.assertEqual(self.ctx.hooks["pre_llm_call"](session_id="s", user_message="hi"), {"context": "REMEMBER"})

        self.results["pre_llm_call"] = ({"context": "x" * 40_000}, 0, "")
        out = self.ctx.hooks["pre_llm_call"](session_id="s", user_message="hi")
        self.assertLessEqual(len(out["context"]), self.plugin.CONTEXT_CHAR_BUDGET)

    def test_no_card_means_no_return(self):
        self.results["pre_llm_call"] = ({"context": "   "}, 0, "")
        self.assertIsNone(self.ctx.hooks["pre_llm_call"](session_id="s", user_message="hi"))

    # -- capture nudge --------------------------------------------------------

    def test_pre_verify_continues_the_turn_with_the_reason(self):
        self.results["pre_verify"] = ({"decision": "block", "reason": "store what you learned"}, 0, "")
        self.assertEqual(
            self.ctx.hooks["pre_verify"](session_id="s", coding=True, changed_paths=["a.py"]),
            {"action": "continue", "message": "store what you learned"},
        )
        self.results["pre_verify"] = (None, 0, "")
        self.assertIsNone(self.ctx.hooks["pre_verify"](session_id="s", coding=True))

    def test_pre_verify_forwards_the_paths_hermes_supplies(self):
        self.results["pre_verify"] = (None, 0, "")
        self.ctx.hooks["pre_verify"](session_id="s", coding=True, changed_paths=["src/a.py"], attempt=1)
        _event, payload, _cwd = self.calls[-1]
        self.assertEqual(payload["extra"]["changed_paths"], ["src/a.py"])

    # -- impact card ----------------------------------------------------------

    def _atom(self, paths):
        return {"id": "abc", "title": "A trap", "category": "fact", "affectedPaths": paths}

    def test_impact_card_appends_dependent_atoms_once_per_file(self):
        self.results["__query__"] = [self._atom(["README.md"])]
        first = self.ctx.hooks["transform_tool_result"](
            tool_name="write_file", args={"path": "README.md"}, result="ok", session_id="s"
        )
        self.assertIn("[Knowl]", first)
        self.assertTrue(first.startswith("ok"))
        # Once per (session, file): a second write to the same file says nothing new.
        self.assertIsNone(
            self.ctx.hooks["transform_tool_result"](
                tool_name="write_file", args={"path": "README.md"}, result="ok", session_id="s"
            )
        )

    def test_impact_card_is_silent_when_nothing_depends_on_the_file(self):
        self.results["__query__"] = [self._atom(["src/other.ts"])]
        self.assertIsNone(
            self.ctx.hooks["transform_tool_result"](
                tool_name="write_file", args={"path": "README.md"}, result="ok", session_id="s"
            )
        )

    # -- the CLI's two output shapes -----------------------------------------

    def test_query_reads_both_the_bare_and_the_workspace_keyed_shape(self):
        """`knowl query` answers with an array in a lone repo and an object keyed by repo name
        in a linked workspace. Reading only the first is how the impact card went silent in
        every repository that has neighbours."""
        plugin = load_plugin()
        runner = plugin._Runner.__new__(plugin._Runner)
        runner._command = ["knowl"]
        runner._lock = __import__("threading").Lock()
        runner.timeout = 30.0

        bare = json.dumps([{"id": "1", "title": "a"}])
        keyed = json.dumps({"knowl": [{"id": "1", "title": "a"}], "other-repo": [{"id": "2", "title": "b"}]})

        for label, out, expected in (("bare array", bare, 1), ("workspace-keyed", keyed, 2)):
            with self.subTest(label):
                plugin.subprocess.run = lambda *a, **k: type("P", (), {"stdout": out, "stderr": "", "returncode": 0})()
                self.assertEqual(len(runner.query("x", os.getcwd())), expected)

        # A failed call is empty, never an exception.
        plugin.subprocess.run = lambda *a, **k: type("P", (), {"stdout": "boom", "stderr": "", "returncode": 1})()
        self.assertEqual(runner.query("x", os.getcwd()), [])

    # -- path handling --------------------------------------------------------

    def test_dot_directories_do_not_collapse_onto_their_undotted_twin(self):
        self.assertTrue(self.plugin._covers([".github/ci.yml"], ".github/ci.yml"))
        self.assertFalse(self.plugin._covers(["github/ci.yml"], ".github/ci.yml"))
        self.assertTrue(self.plugin._covers(["src"], "src/a.ts"))

    # -- failure is always allow ---------------------------------------------

    def test_a_failing_hook_never_breaks_the_turn(self):
        def boom(*_a, **_k):
            raise RuntimeError("boom")

        self.plugin._Runner.run = boom
        self.plugin._Runner.query = boom
        ctx = FakeCtx()
        self.plugin.register(ctx)
        self.assertIsNone(ctx.hooks["pre_tool_call"](tool_name="write_file", args={}, session_id="s"))
        self.assertIsNone(ctx.hooks["pre_llm_call"](session_id="s", user_message="p"))
        self.assertIsNone(ctx.hooks["pre_verify"](session_id="s"))
        self.assertIsNone(
            ctx.hooks["transform_tool_result"](tool_name="write_file", args={"path": "a"}, result="ok", session_id="s")
        )
        self.assertIsNone(ctx.hooks["on_session_end"](session_id="s"))

    def test_the_lifecycle_stays_project_only(self):
        """Capture, the write gate, impact and drift all resolve against a checkout, so none of
        them fire without one -- even though reads now reach the machine store."""
        self.plugin._has_knowl_project = lambda cwd: False
        self.plugin._has_global_store = lambda: True
        ctx = FakeCtx()
        self.plugin.register(ctx)
        before = len(self.calls)
        ctx.hooks["pre_tool_call"](tool_name="write_file", args={}, session_id="s")
        ctx.hooks["post_tool_call"](tool_name="write_file", args={}, session_id="s")
        self.assertEqual(len(self.calls), before, "no lifecycle event should reach the engine")

    def test_a_folderless_session_still_gets_a_recall_card(self):
        # The lifecycle path answers nothing without a project, so the card is read directly --
        # otherwise a Home session has memory it is never shown.
        self.plugin._has_knowl_project = lambda cwd: False
        self.plugin._has_global_store = lambda: True
        self.results["__query__"] = [{"title": "I prefer pnpm", "category": "constraint", "content": "everywhere"}]
        ctx = FakeCtx()
        self.plugin.register(ctx)
        card = ctx.hooks["pre_llm_call"](session_id="s", user_message="which package manager?")
        self.assertIn("I prefer pnpm", card["context"])
        self.assertIn("no project open", card["context"].lower())


class MemoryProviderTest(unittest.TestCase):
    """The second surface: `memory.provider: knowl` in Settings > Memory & Context.

    Every case here is a contract with Hermes' memory-provider loader
    (`plugins/memory/__init__.py`) or its `MemoryProvider` ABC (`agent/memory_provider.py`).
    """

    def setUp(self):
        self.plugin = load_plugin_as_memory_provider()
        self.queries = []

        def fake_query(_self, text, cwd, limit=8, timeout=20.0):
            self.queries.append((text, cwd, limit))
            return self.items

        self.items = []
        self.runs = []
        self.plugin._Runner.query = fake_query
        self.plugin._Runner.run = lambda _self, event, payload, cwd, timeout=None: (
            self.runs.append((event, payload, cwd)) or (None, 0, "")
        )
        self.plugin._has_knowl_project = lambda cwd: True
        self.plugin._is_hermes_source_clone = lambda cwd: False
        self.plugin._resolve_cwd = lambda: os.getcwd()

        self.ctx = FakeCollector()
        self.plugin.register(self.ctx)

    # -- the discriminator ----------------------------------------------------

    def test_the_memory_load_registers_a_provider_and_not_one_hook(self):
        """The whole point of the module-name check.

        The collector forwards `register_hook` to a real PluginContext, so registering hooks
        on this path would put a second copy of all seven behind the ones the PluginManager
        pass already registered -- every event firing twice, with nothing to see it.
        """
        self.assertIsNotNone(self.ctx.provider)
        self.assertEqual(self.ctx.provider.name, "knowl")
        self.assertEqual(self.ctx.hooks, {})
        self.assertEqual(self.ctx.tools, {})

    def test_the_plugin_load_registers_hooks_and_no_provider(self):
        """The mirror: the ordinary import must not hand over a provider.

        `PluginContext.register_memory_provider` is deliberately inert, so a provider
        registered there is silently dropped -- and if this path ALSO skipped the hooks, the
        integration would have no channel at all.
        """
        plugin = load_plugin()
        plugin._has_knowl_project = lambda cwd: True
        plugin._is_hermes_source_clone = lambda cwd: False
        plugin._resolve_cwd = lambda: os.getcwd()
        ctx = FakeCollector()
        plugin.register(ctx)
        self.assertIsNone(ctx.provider)
        self.assertIn("pre_llm_call", ctx.hooks)
        self.assertIn("pre_tool_call", ctx.hooks)

    # -- invariants the packaging depends on ----------------------------------

    def test_the_provider_is_discoverable_within_the_first_8kb(self):
        """`_is_memory_provider_dir` reads only `__init__.py[:8192]`.

        The class itself sits far past that, so the mention in the module docstring is what
        puts Knowl in the memory-provider dropdown at all. Deleting it delists us silently.
        """
        with open(os.path.join(HERE, "..", "..", "..", "integrations", "hermes", "knowl", "__init__.py"),
                  encoding="utf-8") as handle:
            head = handle.read(8192)
        self.assertIn("MemoryProvider", head)

    def test_plugin_yaml_still_declares_kind_standalone(self):
        """Without an explicit `kind`, `_detect_kind_from_source` sniffs "MemoryProvider" out
        of the source, auto-coerces the plugin to `kind: exclusive`, and the PluginManager
        then skips it -- taking every hook with it and leaving no error behind."""
        with open(os.path.join(HERE, "..", "..", "..", "integrations", "hermes", "knowl", "plugin.yaml"),
                  encoding="utf-8") as handle:
            manifest = handle.read()
        self.assertIn("kind: standalone", manifest)

    # -- recall ---------------------------------------------------------------

    def test_prefetch_builds_a_card_from_the_store(self):
        self.items = [{"title": "WAL mode is required", "category": "constraint", "content": "sqlite"}]
        card = self.ctx.provider.prefetch("which journal mode?")
        self.assertIn("WAL mode is required", card)
        self.assertIn("project memory", card)
        self.assertEqual(self.queries[0][0], "which journal mode?")

    def test_prefetch_says_so_when_there_is_no_project(self):
        self.plugin._has_knowl_project = lambda cwd: False
        self.plugin._has_global_store = lambda: True
        self.items = [{"title": "I prefer pnpm", "category": "constraint", "content": "everywhere"}]
        card = self.ctx.provider.prefetch("package manager?")
        self.assertIn("I prefer pnpm", card)
        self.assertIn("no project open", card.lower())

    def test_prefetch_is_empty_on_a_miss_and_reports_no_recall(self):
        self.items = []
        self.assertEqual(self.ctx.provider.prefetch("nothing about this"), "")
        self.assertIsNone(self.ctx.provider.recall_status())

    def test_recall_status_counts_only_the_last_prefetch(self):
        """The ABC is explicit that a stale count must never be reported."""
        self.plugin._RecallStatus = lambda provider_label, count, glyph: (provider_label, count, glyph)
        self.items = [{"title": "a", "category": "fact", "content": "x"},
                      {"title": "b", "category": "fact", "content": "y"}]
        self.ctx.provider.prefetch("something")
        self.assertEqual(self.ctx.provider.recall_status()[1], 2)
        self.items = []
        self.ctx.provider.prefetch("something else")
        self.assertIsNone(self.ctx.provider.recall_status())

    def test_the_rules_ride_in_the_system_prompt(self):
        self.assertIn("knowl_query", self.ctx.provider.system_prompt_block())

    def test_no_tool_schemas_because_the_hook_pass_already_registers_them(self):
        """Both halves load on a session where Knowl is the selected provider, so returning
        the tools here too would put two `knowl_query` in front of the model."""
        self.assertEqual(self.ctx.provider.get_tool_schemas(), [])

    # -- compaction -----------------------------------------------------------

    def test_pre_compress_checkpoints_the_session(self):
        """Hermes fires no hook before compressing, so this is the only channel there is."""
        self.ctx.provider.initialize("s1")
        self.ctx.provider.on_pre_compress([{"role": "user", "content": "hi"}])
        self.assertEqual([event for event, _payload, _cwd in self.runs], ["on_pre_compress"])

    def test_pre_compress_writes_nothing_for_a_subagent(self):
        """The ABC asks providers to skip writes outside the primary context, or a cron run's
        system prompt is recorded as the user's own work."""
        self.ctx.provider.initialize("s1", agent_context="subagent")
        self.ctx.provider.on_pre_compress([])
        self.assertEqual(self.runs, [])


class ProviderHandoffTest(unittest.TestCase):
    """`pre_llm_call` when the provider owns recall. Both halves are loaded together, so the
    card has to come from exactly one of them."""

    def setUp(self):
        self.plugin = load_plugin()
        self.calls = []
        self.plugin._Runner.run = lambda _self, event, payload, cwd, timeout=None: (
            self.calls.append(event) or (None, 0, "")
        )
        self.plugin._Runner.query = lambda _self, text, cwd, limit=8, timeout=20.0: []
        self.plugin._has_knowl_project = lambda cwd: True
        self.plugin._is_hermes_source_clone = lambda cwd: False
        self.plugin._resolve_cwd = lambda: os.getcwd()

    def _hook(self, active_provider):
        self.plugin._active_memory_provider = lambda: active_provider
        ctx = FakeCtx()
        self.plugin.register(ctx)
        return ctx.hooks["pre_llm_call"]

    def test_the_hook_stops_injecting_when_the_provider_is_selected(self):
        self.plugin._Runner.run = lambda _self, event, payload, cwd, timeout=None: (
            self.calls.append(event) or ({"context": "a card"}, 0, "")
        )
        self.assertIsNone(self._hook("knowl")(session_id="s", user_message="hello"))

    def test_but_the_event_still_fires_so_the_session_still_binds(self):
        """Suppressing the whole hook would take session binding and capture with it -- the
        card is the only part the provider duplicates."""
        self._hook("knowl")(session_id="s", user_message="hello")
        self.assertEqual(self.calls, ["pre_llm_call"])

    def test_the_hook_keeps_the_card_when_another_provider_is_selected(self):
        self.plugin._Runner.run = lambda _self, event, payload, cwd, timeout=None: (
            self.calls.append(event) or ({"context": "a card"}, 0, "")
        )
        self.assertEqual(self._hook("mem0")(session_id="s", user_message="hello"),
                         {"context": "a card"})


if __name__ == "__main__":
    unittest.main()
