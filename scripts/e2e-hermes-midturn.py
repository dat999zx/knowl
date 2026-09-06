"""Does a mid-turn card actually reach the model on Hermes?

Run:  python scripts/e2e-hermes-midturn.py        (after `npm run build`)

This is the evidence behind `midTurnDeliveryVerified: true` in src/session/hosts/hermes.ts.
That flag may only be set from an observation, so if the delivery path changes, re-run this
rather than reasoning about whether it still holds. Expect a card on tool call 11 of 14 --
DEFAULT_DRIFT_REMINDER_EVERY is 12 and the counter is 0-indexed.

Drives the REAL plugin hooks against the REAL knowl CLI in a REAL project. Nothing about the
engine is mocked, because whether the engine ever fills the slot is the thing in doubt.

Two traps, both of which produced a confident false negative on the first attempt:

  * `_resolve_cwd` reads Hermes' live per-session ContextVar. Run this from inside a Hermes
    session and it returns the SESSION's directory, not the probe's -- so every hook fires
    against the wrong project and reports zero cards. Pinned below.
  * the engine's event command is `agent-hook hermes <event> --json` over stdin, not
    `agent session-event`.

The turn-start card is the control. It uses a channel that already worked, so if it reads
zero the harness is broken and the mid-turn result means nothing.
"""
import os, sys, time, subprocess, tempfile, shutil, json

# The repo this script lives in, so it works from any checkout and any cwd.
WT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
CLI = os.path.join(WT, "dist", "index.js")
NODE = sys.argv[1] if len(sys.argv) > 1 else shutil.which("node") or "node"

if not os.path.isfile(CLI):
    sys.exit(f"no build at {CLI} -- run `npm run build` first")

root = tempfile.mkdtemp(prefix="knowl-midturn-")
home = os.path.join(root, "home"); proj = os.path.join(root, "proj")
os.makedirs(home); os.makedirs(proj)
os.environ["KNOWL_HOME"] = home

subprocess.run([NODE, CLI, "init", "--yes"], cwd=proj, capture_output=True)
for i in range(4):
    subprocess.run([NODE, CLI, "store", f"how module {i} behaves under load",
                    "--category", "fact", "--title", f"module {i} behaviour",
                    "--path", f"src/mod{i}.ts"], cwd=proj, capture_output=True)

shim = os.path.join(root, "knowl.cmd")
with open(shim, "w") as fh:
    fh.write(f'@echo off\r\n"{NODE}" "{CLI}" %*\r\n')
os.environ["KNOWL_BIN"] = shim

sys.path.insert(0, f"{WT}/integrations/hermes")
os.chdir(proj)
import knowl as plugin

# THE FIX: pin the session cwd to the probe's project.
plugin._resolve_cwd = lambda: proj
assert plugin._project_cwd() == proj, f"project_cwd still {plugin._project_cwd()!r}"
print(f"project_cwd pinned: {plugin._project_cwd()!r}")

# Sanity: does the engine answer a hook at all here?
probe = subprocess.run([shim, "agent-hook", "hermes", "pre_llm_call", "--json"],
                       input=json.dumps({"hook_event_name": "pre_llm_call",
                                         "session_id": "warmup", "cwd": proj,
                                         "userMessage": "what changed in module 2"}),
                       cwd=proj, capture_output=True, text=True)
print(f"engine hook exit={probe.returncode}, stdout={len(probe.stdout)} chars")
if probe.returncode != 0:
    print(f"  stderr: {probe.stderr[:300]}")

hooks = {}
class Ctx:
    def register_hook(self, name, fn): hooks[name] = fn
    def register_memory_provider(self, provider): pass
    def get_config(self, key, default=None): return default
    def __getattr__(self, name):
        return lambda *a, **k: None

plugin.register(Ctx())
SESSION = "midturn-probe"

start = hooks["pre_llm_call"](messages=[{"role": "user", "content": "what changed in module 2"}],
                              session_id=SESSION)
card = start.get("context", "") if isinstance(start, dict) else ""
print(f"turn-start card: {len(card)} chars   <-- control: nonzero means the pipe works\n")
# Fail loudly rather than reporting a clean zero. The turn-start channel already worked before
# any of this; if it is silent, the harness is wrong and the mid-turn count below is noise.
assert card, "CONTROL FAILED: turn-start card is empty, so this run proves nothing about mid-turn delivery"

delivered = []
for i in range(14):
    hooks["post_tool_call"](tool_name="read_file", args={"path": f"src/mod{i%4}.ts"},
                            session_id=SESSION, status="ok")
    time.sleep(1.4)
    body = f"file contents {i}"
    out = hooks["transform_tool_result"](tool_name="read_file",
                                         args={"path": f"src/mod{i%4}.ts"},
                                         result=body, session_id=SESSION)
    if out and out.strip() != body:
        extra = out.replace(body, "").strip()
        delivered.append(i)
        print(f">>> CARD on tool call {i} ({len(extra)} chars):")
        print("    " + extra[:300].replace("\n", "\n    ") + "\n")

print(f"=== {len(delivered)}/14 tool calls carried a mid-turn card: {delivered} ===")
shutil.rmtree(root, ignore_errors=True)
