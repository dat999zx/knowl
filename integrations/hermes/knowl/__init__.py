"""Knowl lifecycle plugin for Hermes Agent.

Hermes plugins are Python modules under ``~/.hermes/plugins/<name>/`` that register hook callbacks
in ``register(ctx)``. Every callback here forwards one normalized event to
``knowl agent-hook hermes <event> --json`` -- the same entry point every other host's hooks use --
and maps the result into the return value Hermes documents for that hook.

Install: ``knowl init hermes`` copies this directory into place, adds the ``mcp_servers.knowl`` entry
to ``~/.hermes/config.yaml``, and runs ``hermes plugins enable knowl``.

What reaches the model, and where:

* ``pre_llm_call`` returns ``{"context": ...}``, which Hermes appends to the user message (capped at
  10,000 characters). The bootstrap card from ``on_session_start`` -- whose own return value Hermes
  ignores -- and any impact card held from ``pre_tool_call`` ride the next one of these.
* ``pre_tool_call`` returns ``{"action": "block", "message": ...}`` when the write gate refused.
* There is no turn-stop hook in Hermes, so the capture nudge is not delivered here; it rides the
  MCP tool results instead.

Failure: this runs inside Hermes' process, so nothing here raises. A miss, a timeout or a crash
returns ``None``, which allows the action. ``run_hook`` is a module global so tests can replace it.
"""

from __future__ import annotations

import json
import os
import subprocess
import sys
import time
import random

HOOK_TIMEOUT_S = 10
# Hermes caps injected context at 10,000 characters; overflow is spilled to a file with a preview,
# which is worse than a shorter card. Stay under the cap so the card itself arrives.
MAX_CONTEXT_CHARS = 9_000

_FALLBACK_SESSION_ID = f"hermes-{int(time.time()):x}-{random.randrange(1 << 20):x}"
_state = {"session_id": None, "held": []}


def run_hook(event: str, payload: dict):
    """Run one ``knowl agent-hook`` process; return its parsed stdout, or ``None``. Never raises."""
    try:
        command = "knowl.cmd" if sys.platform == "win32" else "knowl"
        completed = subprocess.run(
            [command, "agent-hook", "hermes", event, "--json"],
            input=json.dumps(payload),
            capture_output=True,
            text=True,
            timeout=HOOK_TIMEOUT_S,
        )
        out = completed.stdout.strip()
        return json.loads(out) if out else None
    except Exception:  # noqa: BLE001 -- a hook failure must allow the action
        return None


def _call(event: str, **extra):
    payload = {
        "session_id": _state["session_id"] or _FALLBACK_SESSION_ID,
        "cwd": os.getcwd(),
        **extra,
    }
    try:
        return run_hook(event, payload)
    except Exception:  # noqa: BLE001
        return None


def _text(value):
    return value if isinstance(value, str) and value else None


def _hold(text):
    if text:
        _state["held"].append(text)


def _on_session_start(session_id, *args, **kwargs):
    _state["session_id"] = session_id or _state["session_id"]
    result = _call("session-start", title="Agent session")
    _hold(_text((result or {}).get("context")))


def _pre_llm_call(session_id, user_message, conversation_history=None, is_first_turn=False, *args, **kwargs):
    if session_id:
        _state["session_id"] = session_id
    result = _call("turn-start", title="Agent turn", prompt=user_message if isinstance(user_message, str) else None)
    parts = list(_state["held"])
    _state["held"] = []
    card = _text((result or {}).get("context"))
    if card:
        parts.append(card)
    if not parts:
        return None
    text = "\n\n".join(parts)
    if len(text) > MAX_CONTEXT_CHARS:
        # Trim the held (older) part first; the current turn's card is the one that matters now.
        text = text[-MAX_CONTEXT_CHARS:]
    return {"context": text}


def _pre_tool_call(tool_name, args, task_id=None, *rest, **kwargs):
    result = _call("tool-precheck", tool_name=tool_name, tool_input=args if isinstance(args, dict) else {}) or {}
    denied = _text(result.get("denied"))
    if denied:
        return {"action": "block", "message": denied}
    _hold(_text(result.get("context")))
    return None


def _post_tool_call(tool_name, args, result=None, task_id=None, duration_ms=None, *rest, **kwargs):
    _call("session-event", tool_name=tool_name, tool_input=args if isinstance(args, dict) else {})
    return None


def _on_session_end(session_id, completed=True, interrupted=False, *args, **kwargs):
    _call("session-stop", title="Agent session", status="failed" if interrupted else "finished")
    return None


def register(ctx):
    ctx.register_hook("on_session_start", _on_session_start)
    ctx.register_hook("pre_llm_call", _pre_llm_call)
    ctx.register_hook("pre_tool_call", _pre_tool_call)
    ctx.register_hook("post_tool_call", _post_tool_call)
    ctx.register_hook("on_session_end", _on_session_end)
