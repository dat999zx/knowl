# Guidance Repair Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make Knowl project guidance and Claude/Gemini native imports repairable and verifiable when duplicate managed sections or Markdown code examples are present.

**Architecture:** Normalize every canonical guidance file by stripping all managed markers and appending one canonical block, then compare the normalized result for idempotency/currentness. Keep native import parsing dependency-free and conservative by excluding indented Markdown code lines before checking for an active import.

**Tech Stack:** TypeScript, Node.js filesystem APIs, Vitest

---

### Task 1: Normalize every managed guidance section

**Files:**
- Modify: `tests/core/agents-guidance.test.ts`
- Modify: `tests/cli/agent-instruction-files.test.ts`
- Modify: `src/core/agents-guidance.ts`

- [ ] **Step 1: Add failing duplicate-section tests**

Add this test to `tests/core/agents-guidance.test.ts`:

```ts
it('collapses duplicate managed sections and rejects them as current', async () => {
  await fs.mkdir(ROOT, { recursive: true });
  const managed = renderManagedKnowlGuidanceSection();
  const stale = '<!-- KNOWL_PROJECT_MEMORY -->\nstale duplicate\n<!-- /KNOWL_PROJECT_MEMORY -->\n';
  await fs.writeFile(path.join(ROOT, 'KNOWL.md'), `${managed}\n${stale}\nKnowl tail\n`);
  await fs.writeFile(path.join(ROOT, 'AGENTS.md'), `Agent rules\n\n${stale}\n${managed}`);

  expect(await isKnowlProjectGuidanceCurrent(ROOT)).toBe(false);
  expect(await installKnowlProjectGuidance(ROOT)).toEqual({ knowl: 'updated', agents: 'updated' });

  for (const filename of ['KNOWL.md', 'AGENTS.md']) {
    const saved = await fs.readFile(path.join(ROOT, filename), 'utf8');
    expect(saved.match(/<!-- KNOWL_PROJECT_MEMORY -->/g)).toHaveLength(1);
    expect(saved.match(/<!-- \/KNOWL_PROJECT_MEMORY -->/g)).toHaveLength(1);
    expect(saved).not.toContain('stale duplicate');
  }
  expect(await fs.readFile(path.join(ROOT, 'KNOWL.md'), 'utf8')).toContain('Knowl tail');
  expect(await fs.readFile(path.join(ROOT, 'AGENTS.md'), 'utf8')).toContain('Agent rules');
  expect(await isKnowlProjectGuidanceCurrent(ROOT)).toBe(true);
  expect(await installKnowlProjectGuidance(ROOT)).toEqual({ knowl: 'unchanged', agents: 'unchanged' });
});
```

Add this host-migration test inside the existing `describe.each` in `tests/cli/agent-instruction-files.test.ts`:

```ts
it('removes every duplicate legacy managed section in one run', async () => {
  await fs.mkdir(ROOT, { recursive: true });
  const managed = renderManagedKnowlGuidanceSection();
  await fs.writeFile(pathname, `${preferredImport}\n\n${managed}\nHost rules stay.\n\n${managed}`);

  expect(await installKnowlHostInstructions(ROOT, host)).toBe('updated');
  const saved = await fs.readFile(pathname, 'utf8');
  expect(saved).not.toContain('KNOWL_PROJECT_MEMORY');
  expect(saved).toContain('Host rules stay.');
  expect(await verifyKnowlHostInstructions(ROOT, host)).toBe(true);
  expect(await installKnowlHostInstructions(ROOT, host)).toBe('unchanged');
});
```

- [ ] **Step 2: Run the tests and verify RED**

Run:

```powershell
npm test -- tests/core/agents-guidance.test.ts tests/cli/agent-instruction-files.test.ts --maxWorkers=1
```

Expected: the new project-guidance test fails because duplicate canonical blocks are reported current/unchanged, and the host-migration test fails because one legacy marker remains.

- [ ] **Step 3: Implement complete normalization**

Replace `stripManagedKnowlGuidance` and the existing-file branch of `installManagedFile` in `src/core/agents-guidance.ts` with:

```ts
export function stripManagedKnowlGuidance(source: string): string {
  let current = source;
  while (true) {
    const start = current.indexOf(KNOWL_GUIDANCE_START_MARKER);
    if (start < 0) break;
    const end = current.indexOf(KNOWL_GUIDANCE_END_MARKER, start);
    const replacementEnd = end < 0 ? current.length : end + KNOWL_GUIDANCE_END_MARKER.length;
    const before = current.slice(0, start).trimEnd();
    const after = current.slice(replacementEnd).trimStart();
    current = [before, after].filter(Boolean).join('\n\n') + (before || after ? '\n' : '');
  }
  return current.replaceAll(KNOWL_GUIDANCE_END_MARKER, '');
}

function normalizeManagedFile(source: string, managed: string): string {
  const unmanaged = stripManagedKnowlGuidance(source).trimEnd();
  return unmanaged.length > 0 ? `${unmanaged}\n\n${managed}` : managed;
}
```

Then use the normalizer in `installManagedFile`:

```ts
if (existing === undefined) {
  await fs.writeFile(filePath, `${createPrefix}${managed}`, 'utf8');
  return 'created';
}
const next = normalizeManagedFile(existing, managed);
if (next === existing) return 'unchanged';
await fs.writeFile(filePath, next, 'utf8');
return 'updated';
```

Update `isKnowlProjectGuidanceCurrent` to require exact normalized layouts:

```ts
return [knowl, agents].every(source =>
  source.split(KNOWL_GUIDANCE_START_MARKER).length - 1 === 1
  && source.split(KNOWL_GUIDANCE_END_MARKER).length - 1 === 1
  && normalizeManagedFile(source, managed) === source);
```

- [ ] **Step 4: Run the tests and verify GREEN**

Run:

```powershell
npm test -- tests/core/agents-guidance.test.ts tests/cli/agent-instruction-files.test.ts --maxWorkers=1
```

Expected: both files pass and reruns are unchanged.

- [ ] **Step 5: Commit the normalization fix**

```powershell
git add src/core/agents-guidance.ts tests/core/agents-guidance.test.ts tests/cli/agent-instruction-files.test.ts
git commit -m "fix: normalize duplicate Knowl guidance"
```

### Task 2: Ignore indented import examples

**Files:**
- Modify: `tests/cli/agent-instruction-files.test.ts`
- Modify: `src/cli/agents/instruction-files.ts`

- [ ] **Step 1: Add a failing indented-code import test**

Add this test inside the existing `describe.each` in `tests/cli/agent-instruction-files.test.ts`:

```ts
it.each([
  '    @./KNOWL.md',
  '\t@AGENTS.md',
])('does not mistake an indented-code %s example for an active import', async example => {
  await fs.mkdir(ROOT, { recursive: true });
  await fs.writeFile(pathname, `Example only:\n\n${example}\n`);

  expect(await installKnowlHostInstructions(ROOT, host)).toBe('updated');
  const saved = await fs.readFile(pathname, 'utf8');
  expect(saved.startsWith(`${preferredImport}\n`)).toBe(true);
  expect(await verifyKnowlHostInstructions(ROOT, host)).toBe(true);
});
```

- [ ] **Step 2: Run the test and verify RED**

Run:

```powershell
npm test -- tests/cli/agent-instruction-files.test.ts --maxWorkers=1
```

Expected: the new cases fail because the indented example is currently treated as the active import and init returns `unchanged`.

- [ ] **Step 3: Exclude conservative indented-code lines**

Update the line scanner in `hasActiveGuidanceImport` so indented lines are ignored before fence handling:

```ts
for (const line of withoutComments.split(/\r?\n/)) {
  if (/^(?: {4}|\t)/.test(line)) continue;
  if (/^\s{0,3}(?:```|~~~)/.test(line)) {
    fenced = !fenced;
    continue;
  }
  if (!fenced) visible.push(line.replace(/(`+).*?\1/g, ''));
}
```

- [ ] **Step 4: Run the test and verify GREEN**

Run:

```powershell
npm test -- tests/cli/agent-instruction-files.test.ts --maxWorkers=1
```

Expected: all host-instruction cases pass for Claude and Gemini.

- [ ] **Step 5: Commit the import-parser fix**

```powershell
git add src/cli/agents/instruction-files.ts tests/cli/agent-instruction-files.test.ts
git commit -m "fix: ignore indented host import examples"
```

### Task 3: Verify the repair

**Files:**
- Verify: `src/core/agents-guidance.ts`
- Verify: `src/cli/agents/instruction-files.ts`
- Verify: affected and full test suites

- [ ] **Step 1: Run affected tests**

```powershell
npm test -- tests/core/agents-guidance.test.ts tests/cli/agent-instruction-files.test.ts tests/cli/agent-adapters.test.ts tests/cli/init-flow.test.ts tests/cli/cli.test.ts --maxWorkers=1
```

Expected: all affected tests pass.

- [ ] **Step 2: Build production output**

```powershell
npm run build
```

Expected: TypeScript declarations and ESM bundle build successfully.

- [ ] **Step 3: Run the complete serial suite**

```powershell
npm test -- --maxWorkers=1
```

Expected: no new failures. If the known generic lifecycle assertion remains, verify by blame/diff that it still predates this repair and report it separately.

- [ ] **Step 4: Check patch hygiene**

```powershell
git diff --check HEAD~2..HEAD
git status --short
```

Expected: no whitespace errors and no uncommitted implementation changes.
