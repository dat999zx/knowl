# Auto-approve skills you create at your own terminal

## Problem

A file-backed skill package can carry a runnable entrypoint (a `shell` command or a `script`).
`knowl_skill_run` and `knowl skill run` refuse to execute it until a human has run
`knowl skill approve <name>`, which pins the sha256 of every file in the package
(`src/skills/trust.ts`, `src/skills/registry.ts` `runNamed`).

That gate is right for a package Knowl did not watch a person write: one a cloned repository ships
under `.knowl/skills/`, or one an agent created through `knowl_skill_create`. It is friction for the
case where the person types `knowl skill create` themselves and then has to type a second command
to approve what they just wrote. Skills the user cannot run without a ceremony get written and
never used.

What approval does and does not cover today, so the change is not oversold:

- It gates execution only. Listing, reading and the "a saved skill matches this command" nudge work
  on an unapproved skill.
- It does not stop an agent that has a shell tool, because that agent can run `knowl skill approve`
  or `knowl skill create` itself. It stops the MCP-only path (`knowl_skill_create` then
  `knowl_skill_run`) and a cloned repository's skills.

## Decision

Settled with the user on 2026-10-19: do option 1 and put it behind a config toggle that defaults to
on.

`knowl skill create` (the CLI command) approves the package it has just written, with the same
record `knowl skill approve` writes, unless the toggle is off. Nothing else changes:

| Package comes from | Approved automatically? |
|---|---|
| `knowl skill create` typed at a terminal, toggle on | yes |
| `knowl skill create`, toggle off | no (`knowl skill approve` as today) |
| `knowl_skill_create` over MCP (an agent) | never |
| Shipped by a cloned repository, or imported | never |
| Any package that declares an external-effect capability (`write`, `network`, `publish`, `delete`) | never; the existing confirmation in `skill approve` still applies |

## Changes

1. **Config key `trust.autoApproveCreatedSkills`** (boolean).
   - Not under `skills.*`: that map is keyed by skill name (`skills.<name>` is a project binding),
     so a skill called `autoApprove` would collide.
   - Not in `DEFAULT_CONFIG` or `NEW_PROJECT_CONFIG`. The reader treats an unset key as `true`
     (`!== false`), the way `search.pathsChanged` does, so an upgrade does not write the key into
     every config on the machine. Four places, per the config rules: `ProjectConfig` in
     `src/core/types.ts`, `ConfigKey` plus a `CONFIG_FIELDS` entry in `src/cli/config/schema.ts`
     (category `Security`), the reader, and `docs/reference.md`.
   - The reader lives next to the skills code (`src/skills/trust.ts`), not in `src/core`.
2. **`src/cli/program.ts`, `skill create` action.** After `createSkillPackage` and
   `indexSkillPackage` succeed: if the toggle is on and `requiresStrongerApproval(manifest.requires?.capabilities ?? [])`
   is empty, call `approveSkill(root, name, { approvedBy: 'cli:create:<user>' })` and print
   `Approved for execution (turn off: knowl config set trust.autoApproveCreatedSkills false).`
   If the skill declares a stronger capability, print that it still needs `knowl skill approve`.
3. **`approvedBy` carries `cli:create:`** so `knowl skill list`/`read` and the run banner can tell an
   auto-approval from a deliberate one. The banner already prints `approved <date>`; no new field.
4. **No change** to `knowl_skill_create`, `runSkillPackage`, `assertSkillApproved`, the hash, the
   trust file location, or the planted-package check.

## Out of scope

- Approving agent-created or imported skills automatically.
- Any change to the trust-file format.
- The four `knowl_skill_*` hunks in #354 (separate: they are being reverted there).
- A `knowl skill approve --all`.

## Risks

- **Default-on changes posture for everyone who types `knowl skill create`.** The skill is theirs
  and they just wrote it; the cost of the default is that a mistake in a skill they just wrote
  runs without a second prompt. The CHANGELOG lists it as a default change with the off switch.
- **The toggle lives in the project config.** A cloned repository can ship `.knowl/config.json`
  with the key set either way. Setting it to `true` approves nothing: it only affects what the
  local `knowl skill create` command does when the person runs it. No path lets config approve an
  existing package.
- **An agent that can run shell commands can already do everything this enables** (`skill create`
  then `skill approve`), so this adds no capability to it.

## Verification

- Test: toggle unset and `true` approve after create, `false` does not, a skill declaring
  `network` does not, `knowl_skill_create` over MCP does not. Each against `approveSkill`'s record.
- Mutant: remove the capability check and the `network` case fails; flip the reader's `!== false`
  to `=== true` and the unset case fails; call the approval from the MCP create path and the MCP
  case fails.
- End to end on the built CLI in a scratch repo: `skill create`, then `skill run` runs with no
  `approve`; edit one byte of the package and `skill run` is refused again.
- `config-surface` test and `docs:check` pass with the new key.
