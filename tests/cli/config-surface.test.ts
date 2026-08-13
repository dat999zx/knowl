import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { CONFIG_FIELDS } from '../../src/cli/config/schema.js';

/**
 * Every setting in `ProjectConfig` is either editable or deliberately not.
 *
 * `ProjectConfig` (`src/core/types.ts`) is what the code reads; `CONFIG_FIELDS` is a separate
 * hand-maintained list that decides what `knowl config` shows and what `config set` accepts.
 * Nothing connected the two, and nothing failed when they diverged — `cloud.autoStage` shipped in
 * 5.0.0 with `docs/reference.md` telling people to run `knowl config set cloud.autoStage false`,
 * a command that answered `Unknown config key`. `updateCheck.enabled` had been unreachable for
 * longer than that.
 *
 * A source assertion rather than a runtime one, because TypeScript types do not exist at runtime
 * and the alternative — deriving the list from a value like `DEFAULT_CONFIG` — cannot see the
 * three keys deliberately kept out of it (`impact.enabled`, `impact.gate`, `capture.nudge`, whose
 * comments explain that merging them in would arm a write gate in every repository on the
 * machine). `tests/cli/cloud-exit-codes.test.ts` reads source for the same class of reason.
 *
 * This does not decide anything. It forces a decision: a new field must be given a UI or an entry
 * below saying why it has none.
 */
const SOURCE = readFileSync(new URL('../../src/core/types.ts', import.meta.url), 'utf8');

/**
 * Settings a person must not edit by hand, and the reason for each.
 *
 * Not a suppression list. Everything here is written by a command that also does something else —
 * authenticating, joining, migrating — so a hand-edited value would describe a state the rest of
 * the system never entered.
 */
const NOT_EDITABLE: Record<string, string> = {
  'version': 'schema version of the file itself, owned by the config loader',
  'cloud.apiHost': 'pointer written by `knowl cloud connect`, after authenticating against it',
  'cloud.workspaceId': 'pointer written by `knowl cloud connect`',
  'cloud.workspaceName': 'label that travels with the pointer `connect` wrote',
  'cloud.repo': 'publication identity, derived from the git remote or `--repo` at connect time',
  'cloud.remote': 'records which remote the identity came from, for inspection',
  'workspace.workspace': 'membership, written by `knowl workspace add` / `join`',
  'workspace.repo': 'this repo\'s name within that workspace, written by the same commands',
};

/** Leaf paths of `ProjectConfig`, as the interface declares them. */
function projectConfigLeaves(): string[] {
  const start = SOURCE.indexOf('export interface ProjectConfig {');
  expect(start, 'ProjectConfig not found — this suite would otherwise pass by describing nothing')
    .toBeGreaterThan(-1);

  const lines = SOURCE.slice(start).split('\n');
  const leaves: string[] = [];
  const path: string[] = [];
  let depth = 0;

  for (const raw of lines.slice(1)) {
    const line = raw.trim();
    if (line.startsWith('//') || line.startsWith('*') || line.startsWith('/*')) continue;

    if (line === '}' || line === '};') {
      if (depth === 0) break;      // end of the interface
      depth -= 1;
      path.pop();
      continue;
    }

    // A whole object on one line — `organization?: { enabled?: boolean; path?: string };` — is
    // as nested as the multi-line form and has to expand the same way. Reading it as a leaf
    // named `memory.organization` was this parser's own first bug.
    const inline = /^([a-zA-Z]+)\??:\s*\{(.+)\};$/.exec(line);
    if (inline) {
      for (const part of inline[2].split(';')) {
        const inner = /^\s*([a-zA-Z]+)\??:/.exec(part);
        if (inner) leaves.push([...path, inline[1], inner[1]].join('.'));
      }
      continue;
    }

    // `name?: {` opens a nested block; `name?: string;` is a leaf.
    const opens = /^([a-zA-Z]+)\??:\s*\{$/.exec(line);
    if (opens) {
      path.push(opens[1]);
      depth += 1;
      continue;
    }

    const leaf = /^([a-zA-Z]+)\??:\s*[^{].*;$/.exec(line);
    if (leaf) leaves.push([...path, leaf[1]].join('.'));
  }

  return leaves;
}

describe('the config surface', () => {
  const leaves = projectConfigLeaves();
  const editable = new Set(CONFIG_FIELDS.map(field => field.key as string));

  it('reads the interface at all, so a rename cannot make this vacuous', () => {
    expect(leaves.length).toBeGreaterThan(15);
    // Spot-check one from each shape: top level, nested twice, nested three deep.
    expect(leaves).toContain('version');
    expect(leaves).toContain('security.rejectSecrets');
    expect(leaves).toContain('search.vector.preset');
  });

  it('gives every setting a UI or a stated reason for having none', () => {
    const orphans = leaves.filter(key => !editable.has(key) && !(key in NOT_EDITABLE));
    expect(
      orphans,
      `These exist in ProjectConfig but are neither editable nor listed in NOT_EDITABLE. `
      + `Add a CONFIG_FIELDS entry, or an entry saying why a person must not set it: ${orphans.join(', ')}`,
    ).toEqual([]);
  });

  it('does not claim a setting is uneditable while also offering it', () => {
    // Both lists are hand-maintained, so they can contradict each other as easily as they can
    // fall out of date.
    const both = Object.keys(NOT_EDITABLE).filter(key => editable.has(key));
    expect(both, `listed as not editable while CONFIG_FIELDS offers it: ${both.join(', ')}`).toEqual([]);
  });

  it('offers no key that ProjectConfig does not declare', () => {
    const declared = new Set(leaves);
    const phantom = [...editable].filter(key => !declared.has(key));
    expect(phantom, `CONFIG_FIELDS offers keys no longer in ProjectConfig: ${phantom.join(', ')}`).toEqual([]);
  });

  it('reaches the two that shipped unreachable', () => {
    expect(editable.has('cloud.autoStage')).toBe(true);
    expect(editable.has('updateCheck.enabled')).toBe(true);
  });
});
