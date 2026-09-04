# Global skills: reusable playbooks with project bindings

Date: 2026-09-04
Status: draft for review
Governed by: decision `d7bfb0ef36fe41d2` — global skills are *reusable playbooks/templates, while
project bindings provide repo-specific commands and paths*, and executable ones require
applicability checks, explicit capabilities, fail-closed preconditions, visible resolved commands,
versioning/pinning, provenance, and stronger approval for external effects.
Depends on: `2026-09-04-global-memory-layer-design.md` (the global store and its resolution).

## Why

A skill that is worth writing once is rarely worth writing per repository. "Cut a release",
"regenerate the API client", "bisect a flaky test" are the same procedure everywhere; what differs
is the command, the path and the branch name. Today a skill lives in one repository's
`.knowl/skills/`, so the reusable half is copied and the copies drift.

The governing decision names the shape: keep the **playbook** global and let each project supply
its **bindings**. That is also what keeps it safe — a global skill never carries a hardcoded
command to run somewhere it has never seen.

## What is already built

The per-project skill system is not a starting point to improve on; it is the security model this
spec extends unchanged.

| Piece | Where |
| --- | --- |
| `SkillManifest`: name, purpose, triggers, entrypoints, version | `src/skills/registry.ts` |
| Entrypoints, normalised, with `.bat`/`.cmd` refused on Windows (CVE-2024-24576) | `normalizeEntrypoints` |
| Trust record: approved hash, allowed entrypoints | `src/skills/trust.ts` |
| Approval gate: must be approved, entrypoint must be allowed, **content hash must still match** | `assertSkillApproved` |
| Auto-init refuses a repo shipping `.knowl/skill-trust.json` | `src/mcp/auto-init.ts` |

That last one matters here: a planted trust file must never make a planted skill runnable. The
same rule has to survive the move to a machine-wide location, where a single mistake would apply
to every project rather than one.

## Where they live

```
~/.knowl/skills/<name>/        # the playbook: manifest, markdown, scripts
~/.knowl/skill-trust.json      # machine-wide approvals, mirroring the per-project file
```

Resolution is layered the same way memory is: a project skill shadows a global skill of the same
name, so a repository can always override the shared playbook. `knowl skill list` labels each
entry with the layer it came from, because "which one will run" must never be a guess.

## The binding model

A global skill declares what it needs; a project supplies it. Neither half is runnable alone,
which is the property that makes a shared playbook safe.

**The playbook declares inputs, and its entrypoints reference them by name only:**

```yaml
# ~/.knowl/skills/release/skill.yaml
name: release
purpose: Cut a release: verify, tag, push.
requires:
  capabilities: [process, network]     # what it will do, declared up front
  inputs:
    test_command:  { description: "Command that must pass before tagging" }
    release_branch: { description: "Branch releases are cut from", default: "main" }
  preconditions:
    - clean_worktree                   # fail-closed: refuse unless satisfied
entrypoints:
  default: { type: script, path: release.sh, args: ["${inputs.test_command}", "${inputs.release_branch}"] }
```

**The project binds it, in its own config, under its own review:**

```jsonc
// .knowl/config.json
"skills": { "release": { "inputs": { "test_command": "npm test" } } }
```

**Interpolation is inputs only.** `${inputs.*}` and nothing else — no environment, no arbitrary
expressions, no shell. A reference to an input the binding does not supply and that has no default
is a refusal before anything runs, not an empty string spliced into a command line.

An unbound global skill is **listed and readable but not runnable**, and says what it is missing.
That is deliberate: discovery is the point of a shared playbook, and running it in a repository
nobody bound it to is exactly the blast radius the decision warns about.

## Capabilities

The manifest declares what the skill will do. Nothing else is granted.

| Capability | Covers |
| --- | --- |
| `process` | running the entrypoint at all |
| `network` | outbound requests |
| `write` | modifying files outside `.knowl/` |
| `publish` | pushing, releasing, posting — anything others can see |
| `delete` | destructive filesystem or remote operations |

Approval is **per capability**: approving a `process`-only skill does not later approve the same
skill once it declares `publish`, because a capability change changes the hash, which invalidates
the approval — `assertSkillApproved` already enforces exactly that for content. The decision's
"stronger approval rules for writes, network, publishing, deletion" is implemented as: those four
require an explicit second confirmation naming the capability, where `process` alone does not.

Capabilities are declarations, not a sandbox. They exist so a person approving a skill is told
what it intends before it runs, and so a skill that quietly grows a new intent has to be approved
again. That limit is stated in the docs rather than implied away.

## Preconditions, fail-closed

Named checks that must pass before an entrypoint runs. Unknown name, failed check, or a check that
errors — all three refuse.

- `clean_worktree` — no uncommitted changes
- `on_branch:<name>` — the current branch matches, after binding interpolation
- `command_exists:<bin>` — the tool is on PATH

Fail-closed is the whole point: a precondition that cannot be evaluated is a precondition that did
not pass. The failure names the check, so the fix is obvious.

## Approval

Two keys, because a global skill has two independent risks.

1. **The playbook, once per machine.** `knowl skill approve <name> --global` records the content
   hash and the allowed entrypoints in `~/.knowl/skill-trust.json`, reusing `approveSkill` against
   the global root. Editing the skill invalidates it, exactly as today.
2. **The binding, per project.** Writing `skills.<name>` into a project's config is the second
   key: it is a reviewed change in that repository, by the person who knows what `npm test` means
   there.

Neither alone runs anything. A machine-wide approval with no binding is inert; a binding for an
unapproved playbook refuses at the gate.

**The planted-package rule carries over.** A repository that ships a `skills` binding for a global
skill it also ships is refused, for the same reason `scaffoldTarget` refuses a repo carrying
`.knowl/skill-trust.json`: a checkout must never be able to approve itself.

## Visible resolved commands

Before an entrypoint runs, the fully-resolved command is shown — every `${inputs.*}` substituted,
the working directory, and the capabilities being exercised:

```
knowl skill run release
  skill:        release (global, v3, approved 2026-09-01)
  command:      bash ~/.knowl/skills/release/release.sh "npm test" "main"
  cwd:          D:/coding/knowl
  capabilities: process, network, publish
  preconditions: clean_worktree ✓
```

Shown on every run, not only the first. The reason a shared playbook needs this and a local script
does not is that the person running it did not write it.

## Versioning, pinning and provenance

- `SkillManifest.version` already exists and increments on change.
- A binding may pin: `"release": { "version": 3, "inputs": {...} }`. A newer global skill then
  refuses rather than running silently, naming both versions.
- Every skill record carries where it came from — authored locally, or imported, with the source
  — and `knowl skill read` shows it. A playbook whose origin is unknown is not one to approve.

## Applicability

Same treatment as the memory layer: a global skill surfaces where it plausibly applies, and the
mechanisms are the ones already there — `triggers` on the manifest, plus the binding itself. A
skill nobody bound in this project does not run here, which is a stronger applicability check than
any predicate, because it is a human decision rather than a match.

## What this does not cover

- **Sandboxing.** Capabilities describe intent; they do not confine the process. Stated, not
  implied.
- **Sharing skills between people** — publishing, registries, signatures. Machine-local only.
- **Global skills that write memory** — they run in the project's context and use the ordinary
  write path, with no special access to the global store.

## Testing

- Resolution: a project skill shadows a global one of the same name; `list` labels both layers.
- Binding: an unbound global skill lists and reads but refuses to run, naming what is missing; a
  missing input with no default refuses before execution; `${inputs.*}` is the only interpolation
  accepted.
- Trust: approval is per hash and per entrypoint at the global root; editing the playbook
  invalidates it; a capability added to the manifest invalidates it.
- Capabilities: `publish`, `write`, `network` and `delete` each demand the second confirmation;
  `process` alone does not.
- Preconditions: each check refuses on failure and on being unevaluable; an unknown check refuses.
- Planted package: a repository shipping both a global skill and its binding is refused.
- Pinning: a version bump refuses a pinned binding and names both versions.
- Windows: `.bat` and `.cmd` entrypoints stay refused at the global layer too.

## Risks

**One approval, every project.** A machine-wide skill approved once can run in every repository
that binds it. That is the feature, and the mitigation is the second key: the binding is a
reviewed change in each repository.

**Capabilities can be believed.** They are declarations, and a reader may take them for
enforcement. The run banner lists them next to the actual command for exactly that reason, and the
documentation says plainly that they are not a sandbox.

**Interpolation is the injection surface.** Restricting it to `${inputs.*}`, with no shell and no
environment, is what keeps it small — and it is the first thing to re-examine if the syntax ever
grows.
