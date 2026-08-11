# Command Surface 5.0 — Plan D: Surface Cleanup

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A human can store a fact, park their own work and leave a baton from the terminal; five two-word commands become one word; and every place that names a renamed command is corrected — including the strings that ship to the model.

**Architecture:** Three thin CLI wrappers over internals the MCP handlers already call, five command relocations, and a rename sweep across four surfaces: MCP tool descriptions, generated guidance, `docs/reference.md`, and knowl-cloud's web copy.

**Tech Stack:** TypeScript (ESM, Node ≥22), Commander 14, Vitest. **No new runtime dependencies.**

**Spec:** `docs/superpowers/specs/2026-08-11-command-surface-redesign-design.md` §8, §9, §10, §12.1.

**Depends on:** Plan B (the renames this sweep propagates), Plan A (`excludeFromPublish`, for `store --local`).

## Global Constraints

- Node `>=22`. ESM only — relative imports end in `.js`. **No new runtime dependencies.**
- Verification is `npm.cmd run build` **then** `npm.cmd test`, plus `npm.cmd run docs:check`. Finish with `git diff --check`.
- **Rebuild before running any `knowl` command inside this repository.** `knowl init`, `knowl upgrade` and `doctor --fix` rewrite KNOWL.md and AGENTS.md from the **built** CLI, so running one against a stale `dist/` silently reverts guidance to the old build (`699986cdbcaf4565`). That has happened before and produced a commit nobody could explain.
- **`docs/superpowers/**` is excluded from the rename sweep.** Those plans and specs describe commands as they were when written; rewriting them falsifies the record this plan's own spec cites (§12.1).
- **MCP tool descriptions are instructions to a model, not documentation.** A stale command string there is a wrong instruction an agent will follow.

## File Structure

| File | Responsibility |
| --- | --- |
| `src/cli/program.ts` | Modify: add `store`, `park`, `handoff`; flatten five groups |
| `src/mcp/tool-definitions.ts` | Modify: correct every CLI command string |
| `src/core/knowl-guidance.ts` | Modify: the generated KNOWL.md / AGENTS.md section |
| `docs/reference.md` | Modify: the two-phase publishing section and the command tables |
| `scripts/generate-docs.ts` | Modify if the coverage check enumerates command names |
| knowl-cloud `web/` + 3 e2e specs | Modify: the six hardcoded command strings |

---

### Task 1: `knowl store`

**Files:**
- Modify: `src/cli/program.ts`
- Test: `tests/cli/store-command.test.ts`

**Interfaces:**
- Consumes: the same writer `knowl_store`'s MCP handler calls; `excludeFromPublish` (Plan A Task 2)
- Produces: `knowl store <content> --category <c> --title <t> [--tag <t...>] [--path <p...>] [--confidence <n>] [--provenance <p>] [--reasoning <r>] [--alternative <a...>] [--source <s>] [--source-commit <c>] [--supersedes <id>] [--local]`

Omitted deliberately, per spec §8: `conflictKey`, `conflictScope`, `conflictExclusive` (machine-oriented), `namespace` (project is the only sensible CLI target), `steps` (skill-only — `knowl skill create` owns it).

- [ ] **Step 1: Write the failing test**

Create `tests/cli/store-command.test.ts`:

```ts
  it('stores an atom with the fields it was given', async () => {
    await runCli(['store', 'SQLite WAL needs a checkpoint before backup',
      '--category', 'fact', '--title', 'WAL checkpoint', '--tag', 'sqlite', '--confidence', '0.9']);

    const items = await queryKnowledgeBase(projectId, { status: 'active' });
    expect(items).toHaveLength(1);
    expect(items[0].title).toBe('WAL checkpoint');
    expect(items[0].category).toBe('fact');
    expect(items[0].confidence).toBe(0.9);
  });

  it('--local excludes the atom from publication', async () => {
    await runCli(['store', 'D:/coding path only on this box',
      '--category', 'fact', '--title', 'Local path', '--local']);

    const items = await queryKnowledgeBase(projectId, { status: 'active' });
    const { isExcluded } = await import('../../src/cloud/exclusions.js');
    expect(await isExcluded(items[0].id)).toBe(true);
  });

  it('refuses a confidence outside 0..1, naming the item', async () => {
    await expect(runCli(['store', 'x', '--category', 'fact', '--title', 'T', '--confidence', '5']))
      .rejects.toThrow(/confidence/i);
  });

  it('requires category and title', async () => {
    await expect(runCli(['store', 'x'])).rejects.toThrow();
  });
```

Build `runCli` on whatever harness `tests/cli/` already uses for end-to-end command invocation; do not spawn a process if the existing suites call the program object directly.

- [ ] **Step 2: Run it and watch it fail**

Run: `npm.cmd test -- tests/cli/store-command.test.ts`
Expected: FAIL — unknown command `store`.

- [ ] **Step 3: Implement**

Add to `src/cli/program.ts`, beside `decide`:

```ts
program
  .command('store')
  .argument('<content>', 'The knowledge itself')
  .requiredOption('--category <category>', 'fact, decision, goal, constraint, architecture, state or skill')
  .requiredOption('--title <title>', 'Concise title')
  .option('--tag <tag...>', 'Tags')
  .option('--path <path...>', 'Repository-relative paths this knowledge depends on')
  .option('--confidence <number>', 'Confidence from 0.0 to 1.0', Number)
  .option('--provenance <provenance>', 'observed, user_stated or inferred')
  .option('--reasoning <text>', 'Why this is believed')
  .option('--alternative <text...>', 'Alternatives considered')
  .option('--source <label>', 'Source label')
  .option('--source-commit <sha>', 'Commit where this was last reviewed')
  .option('--supersedes <id>', 'Id of an active item this replaces')
  .option('--local', 'Never publish this atom to a cloud workspace')
  .description('Record one verified fact, decision or constraint')
  .action(async (content, options) => {
    try {
      const root = await findProjectRoot(process.cwd());
      await initDb(root);
      try {
        const stored = await storeKnowledgeAtom(root, {
          category: options.category,
          title: options.title,
          content,
          tags: options.tag,
          affectedPaths: options.path,
          confidence: options.confidence,
          provenance: options.provenance,
          reasoning: options.reasoning,
          alternatives: options.alternative,
          source: options.source,
          sourceCommit: options.sourceCommit,
          supersedes: options.supersedes,
        });
        // Before anything can auto-stage it. `--local` is a statement about the atom, and an atom
        // that reached the queue first would need unstaging as well as excluding.
        if (options.local) await excludeFromPublish(stored.id, 'knowl store --local');
        console.log(`Stored ${stored.category}: ${stored.title}`);
        if (options.local) console.log('Marked local. It will not be published.');
      } finally {
        await closeDb();
      }
    } catch (error: any) {
      console.error(`Error storing knowledge: ${error.message}`);
      process.exit(1);
    }
  });
```

`storeKnowledgeAtom` is the name used here for whatever function `knowl_store`'s handler in `src/mcp/tools.ts` calls. **Read that handler and use its actual function and argument shape** — this task is a wrapper, and inventing a parallel writer is the one thing it must not do.

Ordering note for the `--local` line: exclusion must be written before the auto-stage seam can fire, which means before the write returns if the seam is inside the repository call. If Plan C wired the seam such that this ordering cannot hold, pass a `local` flag through to the writer instead of excluding afterwards.

- [ ] **Step 4: Run it and watch it pass**

Run: `npm.cmd test -- tests/cli/store-command.test.ts`
Expected: PASS, all four cases.

- [ ] **Step 5: Commit**

```bash
git add src/cli/program.ts tests/cli/store-command.test.ts
git commit -m "feat(cli): a human can store one fact without going through an agent"
```

---

### Task 2: `knowl park` and `knowl handoff`

**Files:**
- Modify: `src/cli/program.ts`
- Test: `tests/cli/park-handoff.test.ts`

**Interfaces:**
- Consumes: `createResumePoint(projectDir, brief)` and `formatResumeBrief(point)` (`src/session/resume-points.ts:33,124`); `recordDeliberateHandoff(...)` (`src/session/session-handoff.ts:459`)
- Produces:
  - `knowl park --goal <g> [--completed <c...>] [--next-action <n>] [--blocker <b>] [--artifact <a...>] [--verified|--unverified]`
  - `knowl handoff --goal <g> --next-action <n> [same optional set]`

`--goal` is required on both and `--next-action` additionally on `handoff`, matching the tools' own `required` arrays (`src/mcp/tool-definitions.ts:780,797`). `sessionId` is omitted from both: it exists because an MCP client has no session of its own to report, which is not a problem a CLI invocation has.

- [ ] **Step 1: Write the failing test**

```ts
  it('park mints a key and prints a line the user can paste back', async () => {
    const out = await runCli(['park', '--goal', 'Finish the 5.0 rename sweep']);
    expect(out).toMatch(/knowl resume /);
  });

  it('a parked key resumes from any directory', async () => {
    const out = await runCli(['park', '--goal', 'Finish the sweep']);
    const key = out.match(/knowl resume (\S+)/)![1];
    expect(await runCli(['resume', key])).toContain('Finish the sweep');
  });

  it('park requires a goal', async () => {
    await expect(runCli(['park'])).rejects.toThrow();
  });

  it('handoff requires both a goal and a next action', async () => {
    await expect(runCli(['handoff', '--goal', 'g'])).rejects.toThrow();
    await expect(runCli(['handoff', '--goal', 'g', '--next-action', 'n'])).resolves.toBeDefined();
  });
```

- [ ] **Step 2: Run it and watch it fail**

Run: `npm.cmd test -- tests/cli/park-handoff.test.ts`
Expected: FAIL — unknown commands.

- [ ] **Step 3: Implement**

```ts
program
  .command('park')
  .description('Park a workstream you mean to return to, and get a key back')
  .requiredOption('--goal <goal>', 'What this workstream is trying to achieve')
  .option('--completed <item...>', 'What is already done')
  .option('--next-action <action>', 'The next step as it stands now')
  .option('--blocker <blocker>', 'What is in the way, if anything')
  .option('--artifact <path...>', 'Files the returning session should look at')
  .option('--verified', 'The work so far was checked')
  .option('--unverified', 'The work so far was not checked')
  .action(async options => {
    try {
      const root = await findProjectRoot(process.cwd());
      const point = await createResumePoint(root, {
        goal: options.goal,
        completed: options.completed,
        nextAction: options.nextAction,
        blocker: options.blocker,
        artifactRefs: options.artifact,
        verificationStatus: options.verified ? 'verified' : options.unverified ? 'unverified' : undefined,
      });
      // Printed verbatim and unwrapped: a key reworded is a key lost, and this line is the whole
      // point of the command.
      console.log(`Parked. To pick this up later, from anywhere:\n\n    knowl resume ${point.key}\n`);
      await closeResumeDb();
    } catch (error: any) {
      console.error(`Error parking work: ${error.message}`);
      process.exit(1);
    }
  });

program
  .command('handoff')
  .description('Leave a baton for the next session in this project')
  .requiredOption('--goal <goal>', 'What this workstream is trying to achieve')
  .requiredOption('--next-action <action>', 'The single next thing to do')
  .option('--completed <item...>', 'What is already done')
  .option('--blocker <blocker>', 'What is in the way, if anything')
  .option('--artifact <path...>', 'Files the next session should look at')
  .option('--verified', 'The work so far was checked')
  .option('--unverified', 'The work so far was not checked')
  .action(async options => {
    try {
      const root = await findProjectRoot(process.cwd());
      await recordDeliberateHandoff(root, {
        goal: options.goal,
        nextAction: options.nextAction,
        completed: options.completed,
        blocker: options.blocker,
        artifactRefs: options.artifact,
        verificationStatus: options.verified ? 'verified' : options.unverified ? 'unverified' : undefined,
      });
      // One baton per project, and parking again replaces it -- say so, because the previous one
      // is gone and nothing else will mention it.
      console.log('Handed off. The next session in this project receives it once, then it is archived.');
    } catch (error: any) {
      console.error(`Error handing off: ${error.message}`);
      process.exit(1);
    }
  });
```

Match `createResumePoint`'s and `recordDeliberateHandoff`'s real signatures by reading them; the brief shapes above are taken from the MCP schemas and the argument order may differ.

- [ ] **Step 4: Run, pass, render**

Run: `npm.cmd test -- tests/cli/park-handoff.test.ts`, then `npm.cmd run build` and `node dist/index.js park --goal "test"` — read the printed key line, per the CLI-rendering constraint.

- [ ] **Step 5: Commit**

```bash
git add src/cli/program.ts tests/cli/park-handoff.test.ts
git commit -m "feat(cli): park and handoff stop being agent-only"
```

---

### Task 3: Flatten the one-leaf groups

**Files:**
- Modify: `src/cli/program.ts:1293-1295` (`code`), `1992-1994` (`eval`), `2127-2129` (`access`), `2858-2862` (`pr`), `2829-2833` (`evidence`)
- Test: `tests/cli/command-tree.test.ts`

**Interfaces:**
- Produces: `knowl index-code`, `knowl symbols <path>`, `knowl eval [--dataset]`, `knowl access`, `knowl pr`, `knowl evidence <item-id>`

`knowl snapshot create|restore` stays a group — those two are a genuine pair, not a group wrapping a single leaf.

- [ ] **Step 1: Write the failing test**

```ts
  it('has no group that wraps a single leaf', () => {
    const top = buildProgram();
    for (const name of ['code', 'eval', 'access', 'pr', 'evidence']) {
      expect(top.commands.find((c: any) => c.name() === name)).toBeUndefined();
    }
    const names = top.commands.map((c: any) => c.name());
    for (const name of ['index-code', 'symbols', 'eval', 'access', 'pr', 'evidence']) {
      expect(names).toContain(name);
    }
  });

  it('keeps snapshot as a group, because create and restore are a pair', () => {
    const snapshot = buildProgram().commands.find((c: any) => c.name() === 'snapshot');
    expect(snapshot.commands.map((c: any) => c.name()).sort()).toEqual(['create', 'help', 'restore']);
  });
```

- [ ] **Step 2: Run, fail, implement**

Move each leaf's action to a top-level `.command()` with the new name, preserving its arguments, options and description verbatim. Delete the now-empty group definitions. The five actions are unchanged — this task moves code, it does not rewrite it.

- [ ] **Step 3: Run, pass, render**

Run the test, then `npm.cmd run build && node dist/index.js --help` and confirm the five groups are gone and the six commands are present with descriptions. Two of them (`knowl code index`, `knowl code symbols`) currently have **no** description at all (`src/cli/program.ts:1294-1295`) — give them one now rather than shipping a bare line into the top-level help where it is visible.

- [ ] **Step 4: Commit**

```bash
git add src/cli/program.ts tests/cli/command-tree.test.ts
git commit -m "feat(cli): flatten five groups that wrapped one leaf"
```

---

### Task 4: Correct every string that names a renamed command

**Files:**
- Modify: `src/mcp/tool-definitions.ts` — `:99` and any other CLI string
- Modify: `src/core/knowl-guidance.ts` — the generated guidance section
- Modify: `docs/reference.md` — §"Publishing tracks the default branch" (line ~724) and the command tables
- Modify: `scripts/generate-docs.ts` if its coverage check enumerates command names
- Test: `tests/mcp/tool-definitions.test.ts`, plus `npm.cmd run docs:check`

- [ ] **Step 1: Write the failing test**

```ts
  it('no tool description names a command that no longer exists', () => {
    const gone = ['knowl login', 'knowl logout', 'knowl publish', 'knowl code ',
                  'knowl eval retrieval', 'knowl access report', 'knowl pr check', 'knowl evidence list'];
    const all = [...CORE_TOOL_DEFINITIONS, ...TRANSCRIPT_TOOL_DEFINITIONS, ...CLOUD_TOOL_DEFINITIONS];

    for (const tool of all) {
      const text = JSON.stringify(tool);
      for (const name of gone) {
        expect(text, `${tool.name} names a removed command: ${name}`).not.toContain(name);
      }
    }
  });

  it('knowl_cloud names the commands it tells the agent to relay', () => {
    const cloud = CLOUD_TOOL_DEFINITIONS[0];
    expect(cloud.description).toContain('knowl cloud push');
    expect(cloud.description).toContain('knowl cloud login');
  });
```

The second case matters more than it looks: `knowl_cloud`'s description tells the agent to relay a command rather than route around the tool, so a wrong string there produces an agent confidently instructing a user to run something that fails.

- [ ] **Step 2: Run it and watch it fail**

Run: `npm.cmd test -- tests/mcp/tool-definitions.test.ts`
Expected: FAIL — `tool-definitions.ts:99` still says `knowl login`.

- [ ] **Step 3: Implement**

Fix the strings. In `docs/reference.md`, the two-phase publishing block currently reads:

```
knowl publish --category decision --apply   # stage: any time, any branch
knowl cloud push                            # send: only from an up-to-date default branch
```

Replace with `knowl cloud stage --category decision --apply`, and update the prose beneath it that says "`knowl publish` records an intent". While there, add the sentence §5.1 of the spec needs: two kinds of sharing exist, `workspace promote` reaches linked local repos and `cloud stage`/`push` reaches the team, and they are independent.

- [ ] **Step 4: Regenerate guidance, correctly**

```bash
npm.cmd run build          # FIRST. Running the next line against a stale dist reverts guidance.
npm.cmd run docs:generate
npm.cmd run docs:check
git diff KNOWL.md AGENTS.md
```

Read that diff. It is the file this repository's own agents load every session, and `699986cdbcaf4565` records a day when two stale-guidance commits landed through exactly this step.

- [ ] **Step 5: Sweep and prove**

```bash
grep -rn "knowl login\|knowl logout\|knowl publish\|knowl code \|knowl eval retrieval\|knowl access report\|knowl pr check\|knowl evidence list" \
  src/ README.md docs/reference.md KNOWL.md AGENTS.md
```

Expected: no output. **Do not extend this grep to `docs/superpowers/`** — those plans and specs describe commands as they were when written, and rewriting them falsifies the record (§12.1).

- [ ] **Step 6: Commit**

```bash
git add src/mcp/tool-definitions.ts src/core/knowl-guidance.ts docs/reference.md KNOWL.md AGENTS.md tests/mcp/tool-definitions.test.ts
git commit -m "fix(mcp): stop telling agents to run commands that no longer exist"
```

---

### Task 5: knowl-cloud's web copy

**Files (in `d:/coding/knowl-cloud`):**
- Modify: `web/app/(marketing)/(site)/docs/page.tsx:55`, `web/app/(marketing)/(site)/page.tsx:120`, `web/app/(app)/onboarding/page.tsx:58`, `web/app/(app)/w/[ws]/repos/page.tsx:57` and `:98`, `web/components/ui/copy.tsx:11`
- Modify: `web/e2e/app-onboarding.spec.ts:30`, `web/e2e/app-instrument-screens.spec.ts:68`

**This repo's suite currently pins a command that has never existed.** Per knowl-cloud goal `a052496241be48a2`, the web documents `knowl workspace connect <workspace-id>`; the real command was `knowl cloud connect --workspace <id>` before this wave and is unchanged by it. So this task fixes a pre-existing bug and propagates the `publish` → `cloud stage` rename at the same time.

- [ ] **Step 1: Confirm the line numbers before editing**

```bash
cd d:/coding/knowl-cloud
grep -rn "knowl workspace connect\|knowl publish\|knowl login" web/ | grep -v node_modules
```

Line numbers from a goal written days ago may have moved. Use what the grep says.

- [ ] **Step 2: Fix the three e2e assertions first**

They currently assert the wrong string, so they pass today and will fail the moment the copy is right. Update them to the real command, run the suite, and watch them fail against the unfixed copy — that failure is the proof the assertions now test something.

```bash
npm run test --workspace @knowl-cloud/web
```

- [ ] **Step 3: Fix the six copy sites**

`knowl workspace connect <workspace-id>` → `knowl cloud connect --workspace <id>`, and any `knowl publish` → `knowl cloud stage`.

- [ ] **Step 4: Verify**

```bash
npm run test --workspace @knowl-cloud/web
npm run typecheck
```

Expected: green. Per knowl-cloud constraint `8b4b2ec92d764ded`, the root Vitest run does **not** cover the web workspace — running only the engine suite is how a merge passed CI and still broke. Run both.

- [ ] **Step 5: Commit in knowl-cloud**

```bash
git add web/
git commit -m "fix(web): name the command that exists

The onboarding copy documented `knowl workspace connect <id>`, which has
never been a command -- and because `knowl workspace` is a real group for
linking local repos, it failed with a confusing argument error rather than
an unknown-command one. Three e2e tests asserted the wrong string, so the
suite pinned the error in place.

Also propagates knowl 5.0's rename: publish is now `knowl cloud stage`."
```

---

### Task 6: Final verification across both repos

- [ ] **Step 1: knowl**

```bash
cd d:/coding/knowl
npm.cmd run build
npm.cmd run typecheck
npm.cmd run lint
npm.cmd test
npm.cmd run docs:check
git diff --check
```

- [ ] **Step 2: Render the whole surface and read it**

```bash
node dist/index.js --help
node dist/index.js cloud --help
node dist/index.js workspace --help
node dist/index.js publish
```

Expected: no cloud verb at top level; eleven under `cloud`; `workspace` unchanged with ten subcommands; `knowl publish` exits 1 naming `knowl cloud stage`.

- [ ] **Step 3: knowl-cloud**

```bash
cd d:/coding/knowl-cloud
npm run test
npm run test --workspace @knowl-cloud/web
```

- [ ] **Step 4: Store the outcome**

Record what shipped, the migration level, and any deviation from these four plans, with `knowl store --category state`. A plan that ran with deviations and left no record is how the next reader gets a wrong map.

---

## What Plan D deliberately does not do

- **No `knowl ask` removal.** It is a deletion candidate (spec §11.2) but deleting a user-facing command deserves its own decision.
- **No retention consolidation.** `transcripts approve/discard`, `gc` and `forget-log` remain three surfaces (§11.3).
- **No aliases.** There are none today and 5.0 adds none (§11.6).
</content>
