# End-to-end check against a Hermes `serve` backend

Proves the plugin fires on the Desktop code path (the one shell hooks never reach), without touching the running Desktop app.

```powershell
# 1. a repo with a Knowl store and one memorable atom
knowl init -y; knowl store "The demo service listens on port 4321 and must never be exposed publicly" --category constraint --title "Demo port 4321 is internal only"

# 2. a private backend with Desktop's exact launch command (needs HERMES_DESKTOP=1 + a token for the loopback auth exemption)
$env:HERMES_DESKTOP="1"; $env:HERMES_DASHBOARD_SESSION_TOKEN="test-" + (Get-Random)
Set-Content serve.token $env:HERMES_DASHBOARD_SESSION_TOKEN
& "$env:LOCALAPPDATA\hermes\hermes-agent\venv\Scripts\python.exe" -m hermes_cli.main serve --host 127.0.0.1 --port 0   # prints HERMES_BACKEND_READY port=NNNNN

# 3. one session, one memory-only question (Node 24+, global WebSocket)
node integrations/hermes/verify/drive.mjs NNNNN serve.token C:\path\to\repo "What port does the demo service listen on, and may it be public? Say where you learned it." anthropic/claude-haiku-4.5
```

Then read `<HERMES_HOME>/logs/agent.log` for `knowl plugin registered`, `Session plugin prompt section: id=knowl.project-memory`, and `knowl pre_llm_call: N chars of memory context`, and the assistant row for the session in `<HERMES_HOME>/state.db` (`messages` table). Observed 2026-09-04: "Port 4321, internal only—never expose publicly. From Knowl project memory (recent constraint, updated Sept 3)."

The driver's `session.create` accepts an optional model (sent with `provider: "openrouter"`); Opus at Hermes' default 128k max_tokens needs more OpenRouter credit than a test should spend.
