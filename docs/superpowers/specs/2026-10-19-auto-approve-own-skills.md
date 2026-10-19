# Run skills without `knowl skill approve`

## Problem

A file-backed skill package can carry a runnable entrypoint (a `shell` command or a `script`).
`knowl_skill_run` and `knowl skill run` refuse to execute it until a human has run
`knowl skill approve <name>`, which pins the sha256 of every file in the package
(`src/skills/trust.ts`, `runNamed` in `src/skills/registry.ts`).

The agent host already asks the person before it runs a command or calls a tool, and a skill run
prints its resolved command, working directory and capabilities before it starts. So the approval
was a second prompt that showed nothing the first did not, and skills the user could not run
without a ceremony got written and never used.

What approval did and did not cover, so the change is not oversold:

- It gated execution only. Listing, reading and the "a saved skill matches this command" nudge
  worked on an unapproved skill.
- It did not stop an agent that has a shell tool: that agent can run `knowl skill approve` itself.
  It stopped the MCP-only path (`knowl_skill_create` then `knowl_skill_run`) and a skill shipped by
  a cloned repository.

## Decision

Settled with the user on 2026-10-19, after first proposing a narrower version (approve only what
`knowl skill create` writes, never agent-created or repository-shipped skills, never a skill
declaring an external effect). The user's ruling: auto-approve applies to everything, because the
skills are local and made by their own AI. Behind a config toggle that defaults to on.

`runSkillPackage` skips `assertSkillApproved` unless `trust.autoApproveSkills` is the literal
`false`. Everything else in the run path is unchanged.

| Situation | Default (key unset or true) | `trust.autoApproveSkills = false` |
|---|---|---|
| Skill never approved | runs | refused, names `knowl skill approve` |
| Skill edited after approval | runs | refused, "changed since it was approved" |
| Agent-created, repository-shipped or imported skill | runs | refused until approved |
| Skill declaring write, network, publish or delete | runs | approval asks for confirmation as before |

## Changes

1. **Config key `trust.autoApproveSkills`** (boolean).
   - Not under `skills.*`: that map is keyed by skill name (`skills.<name>` is a project binding),
     so a skill called `autoApproveSkills` would collide.
   - Not in `DEFAULT_CONFIG` or `NEW_PROJECT_CONFIG`; the reader treats unset as `true`
     (`!== false`), as `search.pathsChanged` does, so an upgrade does not stamp it into every
     config. Four places: `ProjectConfig` in `src/core/types.ts`, `ConfigKey` plus a
     `CONFIG_FIELDS` entry in `src/cli/config/schema.ts` (category Security), the reader
     `isAutoApproveSkills` in `src/skills/trust.ts`, and `docs/reference.md`.
2. **`src/skills/registry.ts`, `runNamed`:** `if (!isAutoApproveSkills(config)) await assertSkillApproved(...)`.
   `config` is the project config `runSkillPackage` already loads.
3. **Unchanged:** `knowl skill approve` and `revoke` (they are how the gate is satisfied once the
   key is `false`), the hash, the trust file locations, `assertBindingNotSelfApproved` (a repository
   still cannot bind a global playbook it ships), shell interpolation refusal, preconditions, and
   the run banner.

## Out of scope

- Removing `knowl skill approve` or the trust file.
- Auto-binding global playbooks: a global skill still has to be bound in project config before it runs.

## Risks

- **Default-on changes posture for everyone.** A skill a cloned repository ships can now run when
  the agent calls `knowl_skill_run`. The mitigations are the host's own prompt and the printed
  command; `trust.autoApproveSkills false` is the answer for a repository whose skills you did not
  write. The CHANGELOG says so.
- **The toggle lives in the project config.** A repository can ship `.knowl/config.json` setting it
  either way. Setting it `true` only matches the default, and setting it `false` only makes the gate
  stricter, so a repository cannot use it to gain anything.

## Verification

- Tests (`tests/skills/auto-approve.test.ts`): reader semantics; a never-approved skill runs by
  default, including one declaring `network`; a skill keeps running after its files change; the key
  `false` refuses again; end to end on the built CLI, create then run with no approve, then
  `config set trust.autoApproveSkills false` refuses.
- The gate tests (`tests/skills/trust.test.ts`, the global-playbook lifecycle in
  `tests/cli/skill-cli.test.ts`) set the key to `false`, since they test the gate itself.
- Mutants, each failing a different subset: reader `=== true`; the bypass removed so the gate always
  runs; the gate never running (the existing refusal tests fail).
