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


class FakeCtx:
    """Enough of Hermes' PluginContext for register() to run."""

    def __init__(self, settings=None):
        self.hooks = {}
        self.sections = {}
        self._settings = settings or {}

    def get_config(self, key, default=None):
        return self._settings.get(key, default)

    def register_hook(self, name, fn):
        self.hooks[name] = fn

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

        self.plugin._Runner.run = lambda _self, event, payload, cwd, timeout=None: fake_run(event, payload, cwd, timeout)
        self.plugin._Runner.query = lambda _self, text, cwd, limit=8, timeout=20.0: fake_query(text, cwd, limit, timeout)
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

    def test_nothing_fires_outside_a_knowl_project(self):
        self.plugin._has_knowl_project = lambda cwd: False
        ctx = FakeCtx()
        self.plugin.register(ctx)
        before = len(self.calls)
        ctx.hooks["pre_llm_call"](session_id="s", user_message="hi")
        ctx.hooks["pre_tool_call"](tool_name="write_file", args={}, session_id="s")
        self.assertEqual(len(self.calls), before)
        self.assertEqual(ctx.sections["knowl.project-memory"][0]({}), "")


if __name__ == "__main__":
    unittest.main()
