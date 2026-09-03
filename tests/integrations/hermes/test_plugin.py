"""Unit test for the shipped Hermes plugin. Run: python -m unittest tests/integrations/hermes/test_plugin.py"""
import importlib.util
import os
import sys
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
PLUGIN = os.path.join(HERE, "..", "..", "..", "integrations", "hermes", "knowl", "__init__.py")


def load_plugin():
    spec = importlib.util.spec_from_file_location("knowl_hermes_plugin", PLUGIN)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


class FakeCtx:
    def __init__(self):
        self.hooks = {}

    def register_hook(self, name, fn):
        self.hooks[name] = fn


class PluginTest(unittest.TestCase):
    def setUp(self):
        self.plugin = load_plugin()
        self.calls = []
        self.results = {}

        def fake_run(event, payload):
            self.calls.append((event, payload))
            return self.results.get(event)

        self.plugin.run_hook = fake_run
        self.ctx = FakeCtx()
        self.plugin.register(self.ctx)

    def test_registers_the_five_hooks(self):
        self.assertEqual(
            sorted(self.ctx.hooks),
            ["on_session_end", "on_session_start", "post_tool_call", "pre_llm_call", "pre_tool_call"],
        )

    def test_session_id_flows_from_session_start(self):
        self.ctx.hooks["on_session_start"]("sess-1", model="m", platform="cli")
        self.ctx.hooks["pre_llm_call"]("sess-1", "fix it", [], True, model="m", platform="cli")
        self.assertEqual(self.calls[0][0], "session-start")
        self.assertEqual(self.calls[1][0], "turn-start")
        for _event, payload in self.calls:
            self.assertEqual(payload["session_id"], "sess-1")
            self.assertTrue(payload["cwd"])

    def test_turn_card_and_held_bootstrap_are_returned_as_context(self):
        self.results["session-start"] = {"context": "BOOT"}
        self.results["turn-start"] = {"context": "TURN"}
        self.ctx.hooks["on_session_start"]("s")
        out = self.ctx.hooks["pre_llm_call"]("s", "hello there", [], True)
        self.assertEqual(out, {"context": "BOOT\n\nTURN"})
        # Bootstrap is delivered once.
        out2 = self.ctx.hooks["pre_llm_call"]("s", "again please", [], False)
        self.assertEqual(out2, {"context": "TURN"})

    def test_pre_tool_call_blocks_on_denied_and_holds_advice(self):
        self.results["tool-precheck"] = {"denied": "trap"}
        self.ctx.hooks["on_session_start"]("s")
        out = self.ctx.hooks["pre_tool_call"]("write_file", {"path": "a.py"}, "s")
        self.assertEqual(out, {"action": "block", "message": "trap"})
        self.assertEqual(self.calls[-1][1]["tool_name"], "write_file")
        self.assertEqual(self.calls[-1][1]["tool_input"], {"path": "a.py"})

        self.results["tool-precheck"] = {"context": "heads up"}
        self.assertIsNone(self.ctx.hooks["pre_tool_call"]("write_file", {"path": "a.py"}, "s"))
        out = self.ctx.hooks["pre_llm_call"]("s", "next turn text", [], False)
        self.assertEqual(out, {"context": "heads up"})

    def test_context_is_capped(self):
        self.results["turn-start"] = {"context": "x" * 20_000}
        self.ctx.hooks["on_session_start"]("s")
        out = self.ctx.hooks["pre_llm_call"]("s", "long", [], False)
        self.assertLessEqual(len(out["context"]), self.plugin.MAX_CONTEXT_CHARS)

    def test_a_failing_hook_allows(self):
        def boom(event, payload):
            raise RuntimeError("boom")

        self.plugin.run_hook = boom
        self.ctx.hooks["on_session_start"]("s")
        self.assertIsNone(self.ctx.hooks["pre_tool_call"]("write_file", {}, "s"))
        self.assertIsNone(self.ctx.hooks["pre_llm_call"]("s", "p", [], False))
        self.assertIsNone(self.ctx.hooks["post_tool_call"]("read_file", {}, "ok", "s", 3))
        self.assertIsNone(self.ctx.hooks["on_session_end"]("s", completed=True, interrupted=False))


if __name__ == "__main__":
    unittest.main()
