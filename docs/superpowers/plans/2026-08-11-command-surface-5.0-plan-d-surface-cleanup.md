# Command Surface 5.0 — Plan D: Surface Cleanup

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A human can store a fact, park their own work and leave a baton from the terminal; five two-word commands become one word; and every place that names a renamed command is corrected — including the strings that ship to the model.

**Architecture:** Three thin CLI wrappers over internals the MCP handlers already call, five command relocations, and a rename sweep across four surfaces: MCP tool descriptions, generated guidance, `docs/reference.md`, and knowl-cloud's web copy.

**Tech Stack:** TypeScript (ESM, Node ≥22), Commander 14, Vitest. **No new runtime dependencies.**

**Spec:** `docs/superpowers/specs/2026-08-11-command-surface-redesign-design.md` §8, §9, §10, §12.1.

**Depends on:** Plan B (the renames this sweep propagates), Plan A (`excludeFromPublish`, for `store --local`), and **Plan C** — `store --local` has to beat the auto-stage seam, and the seam is Plan C's. Building this against A and B alone produces a `--local` flag that publishes the atom it was told to keep local.

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
| knowl-cloud `web/` | Modify: six `knowl workspace connect` sites and twelve `knowl login` sites |
| knowl-cloud `web/tests/e2e/` | Modify: the two Playwright assertions that pin the wrong command — note the path is `web/tests/e2e/`, not `web/e2e/` |

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
      const config = await loadConfig(root);
      await initDb(root);
      try {
        const project = await repo.getProjectByRootPath(root);
        if (!project) throw new Error('Project not found in database.');

        // The same ownership check the MCP handler makes at `src/mcp/tools.ts:554`. In a linked
        // workspace, `supersedes` can name an item another repository owns, and only that repo
        // may retire it -- so a CLI path without this check is a way to supersede a neighbour's
        // knowledge that the tool path refuses.
        await assertOwnedTargets([options.supersedes], root, config);

        const result = await storeKnowledgeItemDeduped(
          project.id,
          {
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
            // Read by the writer BEFORE the auto-stage seam fires. See the ordering note below.
            local: Boolean(options.local),
          },
          `Store ${options.category}: ${options.title}`,
          // Secret validation. The MCP handler passes this as the fourth argument; a CLI path
          // that omitted it would be a way to write a secret that the tool path rejects.
          config?.security,
        );

        if (result.action === 'duplicate') {
          console.log(`Not stored — already held verbatim as ${result.item.id}.`);
          return;
        }
        console.log(`Stored ${result.item.category}: ${result.item.title}`);
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

**Three things this wrapper must not drop, all of which an earlier draft did.** They are what makes it a wrapper rather than a parallel writer:

| Dropped | Where the MCP handler does it | Consequence of omitting |
| --- | --- | --- |
| `assertOwnedTargets([supersedes], projectRoot, config)` | `src/mcp/tools.ts:554` | In a linked workspace, the CLI could supersede an item owned by another repository |
| `config?.security` as the fourth argument | `src/mcp/tools.ts:578` | Secret validation off on this path only |
| `projectId`, not `root`, as the first argument | `src/mcp/tools.ts:558` | `storeKnowledgeItemDeduped(projectId, input, commitMessage, validationOptions)` — there is no `storeKnowledgeAtom`, and `root` is not a project id |

`getProjectByRootPath` is how every other CLI action resolves the id (`src/cli/program.ts:393, 436, 540, …`). Read the handler at `src/mcp/tools.ts:548-595` and mirror it; the snippet above is that mirror, not a replacement for reading it.

**The `--local` ordering, settled.** Excluding *after* the write returns does not work, and this is not a hypothetical: Plan C Task 2 fires `maybeAutoStage` inside `storeKnowledgeItemDeduped`, after its transaction commits but **before** it returns. So an atom stored with `--local` would be staged, and — with auto-push consent on — could be sent, before the exclusion was ever written. The atom would then need unstaging *and* excluding, and if it had already been pushed, retracting.

So `--local` travels **into** the writer as a field on the input, and the writer excludes before it calls the seam:

```ts
  // `local` is a statement about the atom, so it has to be true before anything can act on the
  // atom. Excluding after the write returns loses the race with the auto-stage seam a few lines
  // above -- and losing it once, with auto-push on, is unrecoverable without a retraction.
  if (input.local) await excludeFromPublish(item.id, 'knowl store --local');
  await maybeAutoStage({ projectRoot, config, itemId: item.id, namespace, alreadyPublished: false });
```

Both calls sit after the transaction commits, in that order. `maybeAutoStage` already consults `filterExcluded` (Plan C Task 1), so the exclusion is all it takes — no second flag threaded into the gate.

- [ ] **Step 3a: Pin the race, not just the outcome**

Add a case that would pass under the broken ordering and fail under nothing else:

```ts
  it('--local excludes before the auto-stage seam can queue it', async () => {
    await connectRepo(ROOT, WS);                       // auto-stage on by default
    await runCli(['store', 'D:/coding path only on this box',
      '--category', 'fact', '--title', 'Local path', '--local']);

    const items = await queryKnowledgeBase(projectId, { status: 'active' });
    const { isExcluded } = await import('../../src/cloud/exclusions.js');
    expect(await isExcluded(items[0].id)).toBe(true);
    // The assertion that matters: it was never queued, not merely excluded afterwards.
    expect(await listStaged(WS)).toEqual([]);
  });
```

The existing `--local excludes the atom from publication` case passes in a **disconnected** repo, where the seam never fires — so on its own it proves nothing about the ordering.

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
  .option('--host <host>', 'Which host\'s hooks should deliver this baton', 'claude')
  .action(async options => {
    try {
      const root = await findProjectRoot(process.cwd());
      // `recordDeliberateHandoff` writes through the knowledge store, so the database has to be
      // open. `createResumePoint` does not need this -- it opens the resume store itself
      // (`src/session/resume-points.ts:39`), which is why `park` above has no `initDb`.
      await initDb(root);
      try {
        const project = await repo.getProjectByRootPath(root);
        if (!project) throw new Error('Project not found in database.');

        const { replacedPrevious } = await recordDeliberateHandoff(project.id, {
          // Mirrors the MCP handler at `src/mcp/tools.ts:1401-1414`, including its reasoning: the
          // baton is filed under the host whose hooks deliver it on session start, and the caller
          // is not that host. `--host` exists for anyone running hooks under another one.
          host: options.host,
          projectRoot: root,
          // The MCP path sends 'unknown' because an MCP client has no session of its own. A CLI
          // invocation is not an unknown session, it is not a session -- so say that instead.
          externalSessionId: 'cli',
          taskState: {
            goal: options.goal,
            nextAction: options.nextAction,
            completed: options.completed,
            blocker: options.blocker,
            artifactRefs: options.artifact,
            verificationStatus: options.verified ? 'verified' : options.unverified ? 'unverified' : undefined,
          },
        });

        // One baton per project, and parking again replaces it -- say so, because the previous
        // one is gone and nothing else will mention it. The MCP handler says the same thing.
        if (replacedPrevious) {
          console.log('Replaced the previous unconsumed handoff — its goal, next action and blocker are gone.');
        }
        console.log('Handed off. The next session in this project receives it once, then it is archived.');
      } finally {
        await closeDb();
      }
    } catch (error: any) {
      console.error(`Error handing off: ${error.message}`);
      process.exit(1);
    }
  });
```

**`recordDeliberateHandoff` does not take a project root and does not take a flat brief.** Its real signature (`src/session/session-handoff.ts:459`) is

```ts
recordDeliberateHandoff(
  projectId: string,
  input: { host: string; projectRoot: string; externalSessionId: string; sessionTitle?: string; taskState: HandoffTaskState },
): Promise<{ itemId: string; handoff: PendingHandoff; replacedPrevious: boolean }>
```

so the six brief fields live **inside** `taskState` (`HandoffTaskState`, `:40-47`), and three arguments the CLI has to supply — `projectId`, `host`, `externalSessionId` — have no CLI source until this action provides one. `createResumePoint(projectDir, brief)` (`resume-points.ts:33`) genuinely does take the root as its first argument, so `park` above is correct as written and only `handoff` changes.

Read both signatures before implementing rather than trusting this block.

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
const subcommandsOf = (root: any, name: string): string[] | undefined => {
  const node = root.commands.find((c: any) => c.name() === name);
  return node && node.commands.map((c: any) => c.name()).filter((n: string) => n !== 'help');
};

  /**
   * Four of these five keep their names and lose their depth; only `code` disappears.
   *
   * `knowl eval retrieval` becomes `knowl eval` — so `eval` must still EXIST at the top level,
   * as a leaf. An earlier draft asserted it was `undefined` and then asserted it was present two
   * lines later, which no implementation could satisfy. `code` is the exception because it wrapped
   * *two* leaves, `index` and `symbols`, so it splits into two names rather than collapsing.
   */
  it.each(['eval', 'access', 'pr', 'evidence'])('%s is a leaf, not a group', name => {
    expect(subcommandsOf(buildProgram(), name)).toEqual([]);
  });

  it('code is gone, and its two leaves are top-level commands', () => {
    const top = buildProgram();
    expect(top.commands.find((c: any) => c.name() === 'code')).toBeUndefined();
    const names = top.commands.map((c: any) => c.name());
    expect(names).toContain('index-code');
    expect(names).toContain('symbols');
  });

  it('every flattened command has a description, because they are in top-level help now', () => {
    const top = buildProgram();
    for (const name of ['index-code', 'symbols', 'eval', 'access', 'pr', 'evidence']) {
      const node = top.commands.find((c: any) => c.name() === name);
      expect(node?.description(), `${name} has no description`).toBeTruthy();
    }
  });

  it('keeps snapshot as a group, because create and restore are a pair', () => {
    expect(subcommandsOf(buildProgram(), 'snapshot')?.sort()).toEqual(['create', 'restore']);
  });
```

`help` is filtered for the same reason as in Plan B's tree test: whether Commander materialises an implicit help subcommand inside `.commands` is a version detail, not something this plan decides.

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

**Files (in `d:/coding/knowl-cloud`), verified by grep on 2026-08-12:**

`knowl workspace connect` — the command that never existed:
- `web/app/(marketing)/(site)/docs/page.tsx:55`
- `web/app/(marketing)/(site)/page.tsx:120`
- `web/app/(app)/onboarding/page.tsx:58`
- `web/app/(app)/w/[ws]/repos/page.tsx:57` and `:98`
- `web/components/ui/copy.tsx:11` (a docblock, but it is the one that explains the component)

`knowl login` — **real today, gone after Plan B**, and an earlier draft of this task missed every one of them:
- `web/app/(marketing)/(site)/docs/page.tsx:68`
- `web/app/(marketing)/(site)/page.tsx:121`
- `web/app/(marketing)/(auth)/device/page.tsx:11` (docblock) and `:46`
- `web/app/(app)/onboarding/page.tsx:13` (docblock) and `:68`
- `web/app/(app)/w/[ws]/repos/page.tsx:55`
- `web/components/auth/device-approval.tsx:35` and `:51`
- `web/components/account/device-list.tsx:34` and `:84`
- `web/app/auth/callback/route.ts:71` (docblock)
- `web/tests/e2e/public-surfaces.spec.ts:38` (comment only — no assertion)

e2e assertions that pin the wrong string — **two, not three**, and under `web/tests/e2e/`, not `web/e2e/`:
- `web/tests/e2e/app-onboarding.spec.ts:30`
- `web/tests/e2e/app-instrument-screens.spec.ts:68`

**Two pre-existing bugs and one propagation, in one task.** Per knowl-cloud goal `a052496241be48a2` the web documents `knowl workspace connect <workspace-id>`, which has never been a command — and because `knowl workspace` *is* a real group for linking local repos, it fails with a confusing argument error rather than an unknown-command one. Separately, `knowl login` is real today and is removed by Plan B, so every site above becomes wrong the moment 5.0 ships. `knowl publish` does not appear in `web/` at all; there is nothing to propagate for that one.

- [ ] **Step 1: Confirm the line numbers before editing**

```bash
cd d:/coding/knowl-cloud
grep -rn "knowl workspace connect\|knowl publish\|knowl login" web/ | grep -v node_modules
```

The list above was taken this way and is current as of this plan's revision; re-run it anyway, because these are two repositories moving independently.

- [ ] **Step 2: Fix the two e2e assertions first**

They assert the wrong string, so they pass today and will fail the moment the copy is right. Update them to the real command, then run Playwright and watch them fail against the unfixed copy — that failure is the proof the assertions now test something.

```bash
npm run test:e2e --workspace @knowl-cloud/web
```

**`npm run test` is not this suite.** In `web/package.json`, `test` is `vitest run` and `test:e2e` is `cross-env … next build && playwright test`. An earlier draft ran `test` at every verification step, so the Playwright specs it was editing would never have executed once.

- [ ] **Step 3: Fix the copy sites**

- `knowl workspace connect <workspace-id>` → `knowl cloud connect --workspace <id>`
- `knowl login` → `knowl cloud login`

Docblocks and comments included. They are what the next reader trusts, and one of them (`copy.tsx:11`) is the explanation of the component that renders the wrong command everywhere else.

- [ ] **Step 4: Verify**

```bash
npm run typecheck --workspace @knowl-cloud/web
npm run test --workspace @knowl-cloud/web        # vitest
npm run test:e2e --workspace @knowl-cloud/web    # playwright — the suite this task edits
npm run test                                      # the engine suite, at the repo root
```

Expected: green. Per knowl-cloud constraint `8b4b2ec92d764ded`, the root Vitest run does **not** cover the web workspace — running only the engine suite is how a merge passed CI and still broke. All four commands, not a subset.

- [ ] **Step 5: Commit in knowl-cloud**

```bash
git add web/
git commit -m "fix(web): name the commands that exist

The onboarding copy documented \`knowl workspace connect <id>\`, which has
never been a command -- and because \`knowl workspace\` is a real group for
linking local repos, it failed with a confusing argument error rather than
an unknown-command one. Two Playwright specs asserted the wrong string, so
the suite pinned the error in place.

Also propagates knowl 5.0's rename: \`knowl login\` is now
\`knowl cloud login\`, across eleven copy sites and four docblocks."
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
npm run test                                      # engine
npm run typecheck --workspace @knowl-cloud/web
npm run test --workspace @knowl-cloud/web         # vitest
npm run test:e2e --workspace @knowl-cloud/web     # playwright
```

All four. `8b4b2ec92d764ded` records a merge that passed CI and still broke because only the first was run.

- [ ] **Step 4: Store the outcome**

Record what shipped, the migration level, and any deviation from these four plans, with `knowl store --category state`. A plan that ran with deviations and left no record is how the next reader gets a wrong map.

---

## What Plan D deliberately does not do

- **No `knowl ask` removal.** It is a deletion candidate (spec §11.2) but deleting a user-facing command deserves its own decision.
- **No retention consolidation.** `transcripts approve/discard`, `gc` and `forget-log` remain three surfaces (§11.3).
- **No aliases.** There are none today and 5.0 adds none (§11.6).
