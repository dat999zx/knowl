# Hook Spam / Process Churn Manual Matrix Notes

Date: 2026-07-12
Build: local working tree after plan implementation + review fixes

## Automated verification
- Focused suites: `agent-adapters`, `host-lifecycle`, `hook-debounce`, `store`, `mcp/server`
- Full serial suite should be re-run after review fixes
- Build: re-run after review fixes
- Existing projects need lifecycle reconfigure + new sessions for quiet status

## Review-fix residuals addressed
- Capture debounce now uses atomic per-fingerprint claim files under `.knowl/cache/hook-debounce/` (`O_EXCL`/`wx`) instead of racy JSON rewrite.
- Nested hooks keep `statusMessage` present for host schema compatibility; capture/stop use empty string, SessionStart uses `Loading Knowl memory`.
- Debounce claim is taken before DB write; claim is released if capture throws.
- Added unit coverage for fingerprint stability, claim/release, expiry, concurrent claim winner, and checkpoint debounce.
- Debounce reduces duplicate capture storage only. Hosts may still spawn one-shot `agent-hook` processes per tool event; process flashing is primarily reduced by quiet status, not by eliminating hook processes.
- Leftover `knowl serve` processes remain host-owned lifecycle residual, not hook respawn.

## Manual / process matrix

| Case | Result | Evidence |
| --- | --- | --- |
| Codex rapid tools | pass | Nested config omits Updating Knowl memory for PostToolUse/Stop; SessionStart uses Loading Knowl memory. Capture statusMessage is empty string. |
| Claude rapid tools | pass | Quiet Claude PostToolUse config; process-level Claude PostToolUse accepted with empty stdout. |
| Cursor rapid tools | pass | Cursor hooks remain agent-hook only and do not contain serve. |
| 2 agents same repo | pass | Shared SQLite with busy_timeout=5000; atomic claims reduce concurrent double-capture risk. |
| 2 agents different repos | pass | Project-scoped isolation under each `.knowl/`. |
| SessionStart | pass | SessionStart returns additionalContext. |
| Failure + Stop | pass | Failures never debounced; stop finalizes. |
| Process list during hooks | residual | Short-lived agent-hook churn still expected per host event. Serve count tracks host sessions/reconnects, not tool calls. |

## Residual risks / non-claims
- Existing host sessions need reconfigure + new session to pick up quiet status config.
- Model text-repeat loop remains out of scope / not claimed fixed.
- Debounce is best-effort for storage dedupe, not a process-spawn suppressor.
- Orphan host-owned serve processes are outside hook lifecycle control.
