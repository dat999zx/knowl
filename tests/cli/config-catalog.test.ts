import fs from 'node:fs/promises';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { buildConfigCatalog, formatFeatureSummary, isSwitch, renderConfigCatalog, renderConfigReference } from '../../src/cli/config/catalog.js';
import { CONFIG_FIELDS, type ConfigField } from '../../src/cli/config/schema.js';
import { DEFAULT_CONFIG } from '../../src/core/config.js';

const ROOT = path.resolve('.knowl-config-catalog-test');

afterEach(async () => {
  await fs.rm(ROOT, { recursive: true, force: true });
});

async function writeConfig(value: unknown = DEFAULT_CONFIG) {
  await fs.mkdir(path.join(ROOT, '.knowl'), { recursive: true });
  await fs.writeFile(path.join(ROOT, '.knowl', 'config.json'), JSON.stringify(value, null, 2), 'utf8');
}

/**
 * The catalog is the answer to "what can this thing do, and what is on" -- a question no
 * surface answered before it. `knowl status` reports counts and workspace, `knowl doctor`
 * reports health; neither enumerates features, and `knowl config` renders these same
 * descriptions only from inside an interactive TTY.
 *
 * Rendering is tested against fixtures rather than `CONFIG_FIELDS` so a wording change to a
 * real setting cannot fail these; the registry itself is asserted separately below.
 */
const field = (over: Partial<ConfigField> & Pick<ConfigField, 'key'>): ConfigField => ({
  category: 'Search',
  type: 'boolean',
  label: 'A setting',
  description: 'What it does.',
  applies: 'immediately',
  parse: (raw: string) => raw === 'true',
  ...over,
} as ConfigField);

describe('renderConfigCatalog', () => {
  it('marks a setting that is on and names the key that sets it', () => {
    const lines = renderConfigCatalog([
      { field: field({ key: 'search.vector.enabled', label: 'Semantic search' }), value: true },
    ]);

    const text = lines.join('\n');
    expect(text).toContain('Semantic search');
    expect(text).toContain('search.vector.enabled');
    expect(text).toMatch(/●.*Semantic search/);
  });

  it('gives the exact command that turns an off setting on', () => {
    const lines = renderConfigCatalog([
      { field: field({ key: 'search.transcripts.share' }), value: false },
    ]);

    expect(lines.join('\n')).toContain('knowl config set search.transcripts.share true');
  });

  it('does not print a command for a setting that is already on', () => {
    const lines = renderConfigCatalog([
      { field: field({ key: 'search.vector.enabled' }), value: true },
    ]);

    expect(lines.join('\n')).not.toContain('knowl config set');
  });

  it('groups settings under their category heading', () => {
    const lines = renderConfigCatalog([
      { field: field({ key: 'search.vector.enabled', category: 'Search' }), value: true },
      { field: field({ key: 'security.rejectSecrets', category: 'Security' }), value: true },
    ]);

    const text = lines.join('\n');
    expect(text).toContain('SEARCH');
    expect(text).toContain('SECURITY');
    expect(text.indexOf('SEARCH')).toBeLessThan(text.indexOf('SECURITY'));
  });

  /**
   * Caught by running it rather than by asserting it: several real descriptions are 200-plus
   * characters, and a terminal breaks them at the window edge with no indent, so the wrap lands
   * in column one and reads as a new setting.
   */
  it('wraps a long description instead of leaving the terminal to break it', () => {
    const lines = renderConfigCatalog([
      {
        field: field({
          key: 'reminders.driftBackoff',
          description: 'Double the gap after each reminder -- 12, 24, 48, 96 -- instead of repeating at the same cadence forever. The message is identical every time, so the fortieth is worth nothing; this keeps the long-session safety net without the nagging.',
        }),
        value: true,
      },
    ]);

    expect(lines.every(line => line.length <= 96)).toBe(true);
    const wrapped = lines.filter(line => line.includes('cadence') || line.includes('fortieth'));
    expect(wrapped.length).toBeGreaterThan(0);
    expect(wrapped.every(line => line.startsWith('      '))).toBe(true);
  });

  it('never prints the value of a secret field', () => {
    const lines = renderConfigCatalog([
      { field: field({ key: 'ai.apiKey', type: 'string', secret: true }), value: 'sk-live-not-a-real-key' },
    ]);

    const text = lines.join('\n');
    expect(text).not.toContain('sk-live-not-a-real-key');
    expect(text).toContain('(set)');
  });

  it('names the allowed values of an enum so the set command can be written', () => {
    const lines = renderConfigCatalog([
      { field: field({ key: 'impact.gate', type: 'enum', values: ['off', 'shadow', 'enforce'] }), value: 'shadow' },
    ]);

    const text = lines.join('\n');
    expect(text).toContain('off');
    expect(text).toContain('enforce');
  });

  it('reports a preset-owned field as owned rather than offering an edit that does nothing', () => {
    const lines = renderConfigCatalog([
      {
        field: field({ key: 'search.vector.model', type: 'string', derivedFrom: 'search.vector.preset' }),
        value: 'onnx-community/granite-embedding-small-english-r2-ONNX',
        shadowed: true,
      },
    ]);

    const text = lines.join('\n');
    expect(text).toContain('search.vector.preset');
    expect(text).not.toContain('knowl config set search.vector.model');
  });
});

describe('isSwitch', () => {
  it('counts a boolean as a switch', () => {
    expect(isSwitch(field({ key: 'search.vector.enabled', type: 'boolean' }))).toBe(true);
  });

  it('counts an enum as a switch', () => {
    expect(isSwitch(field({ key: 'impact.gate', type: 'enum', values: ['off', 'shadow'] }))).toBe(true);
  });

  it('does not count a free-text value as a switch', () => {
    expect(isSwitch(field({ key: 'search.vector.cacheDir', type: 'string' }))).toBe(false);
  });

  it('does not count a field a preset owns as a switch', () => {
    expect(isSwitch(field({ key: 'search.vector.dtype', type: 'enum', derivedFrom: 'search.vector.preset' }))).toBe(false);
  });
});

/**
 * When a change takes effect is the first thing anyone asks after flipping a switch, and the
 * answer is not uniform: three gates re-read from disk per call and everything else is the
 * config the MCP server captured at spawn. Stated once, as a rule, rather than per field --
 * a per-field label would have to be hand-maintained for 32 settings whose consumer chains
 * were not all traced, and a wrong "immediate" is worse than a rule the reader applies.
 */
describe('the effect notice', () => {
  it('names the three settings a running session obeys immediately', () => {
    const text = renderConfigCatalog([
      { field: field({ key: 'search.vector.enabled' }), value: true },
    ]).join('\n');

    expect(text.toLowerCase()).toContain('transcript');
    expect(text.toLowerCase()).toContain('cloud');
    expect(text.toLowerCase()).toContain('workspace');
  });

  it('appears once however many settings are listed', () => {
    const text = renderConfigCatalog([
      { field: field({ key: 'search.vector.enabled' }), value: true },
      { field: field({ key: 'security.rejectSecrets', category: 'Security' }), value: true },
    ]).join('\n');

    expect(text.match(/obeyed immediately/g)).toHaveLength(1);
  });
});

describe('buildConfigCatalog', () => {
  it('reads the value each setting is actually running on', async () => {
    await writeConfig({ ...DEFAULT_CONFIG, search: { ...DEFAULT_CONFIG.search, vector: { ...DEFAULT_CONFIG.search?.vector, enabled: false } } });

    const rows = await buildConfigCatalog(ROOT);
    const vector = rows.find(row => row.field.key === 'search.vector.enabled');

    expect(vector?.value).toBe(false);
  });

  it('shows only switches by default and every field under all', async () => {
    await writeConfig();

    const switches = await buildConfigCatalog(ROOT);
    const everything = await buildConfigCatalog(ROOT, { all: true });

    expect(switches.length).toBeLessThan(everything.length);
    expect(switches.every(row => isSwitch(row.field))).toBe(true);
    expect(everything.length).toBe(CONFIG_FIELDS.length);
  });

  /**
   * The bug this guards is `1453b1f2`: switching preset never rewrites the flat keys, so the
   * stored `search.vector.model` names a model that has not been used since the switch. A
   * catalog that printed the stored value would report the wrong model with total confidence.
   */
  it('reports a preset-owned model as the preset supplies it, not as the stale key holds it', async () => {
    await writeConfig({
      ...DEFAULT_CONFIG,
      search: {
        ...DEFAULT_CONFIG.search,
        vector: { ...DEFAULT_CONFIG.search?.vector, preset: 'granite-small-en-r2', model: 'Xenova/all-MiniLM-L6-v2' },
      },
    });

    const rows = await buildConfigCatalog(ROOT, { all: true });
    const model = rows.find(row => row.field.key === 'search.vector.model');

    expect(model?.shadowed).toBe(true);
    expect(model?.value).not.toBe('Xenova/all-MiniLM-L6-v2');
  });

  it('does not call a field shadowed when the preset is custom', async () => {
    await writeConfig({
      ...DEFAULT_CONFIG,
      search: {
        ...DEFAULT_CONFIG.search,
        vector: { ...DEFAULT_CONFIG.search?.vector, preset: 'custom', model: 'Xenova/all-MiniLM-L6-v2' },
      },
    });

    const rows = await buildConfigCatalog(ROOT, { all: true });
    const model = rows.find(row => row.field.key === 'search.vector.model');

    expect(model?.shadowed).toBeFalsy();
    expect(model?.value).toBe('Xenova/all-MiniLM-L6-v2');
  });
});

/**
 * `knowl init` ends by pointing at `knowl status` and at nothing else, and status reported item
 * counts, capture health and workspace -- never a feature. One line there is the whole reason
 * the catalog is reachable at all; a command nobody is told about is the failure mode this was
 * meant to avoid.
 */
describe('formatFeatureSummary', () => {
  it('counts how many features are on out of how many exist', () => {
    const summary = formatFeatureSummary([
      { field: field({ key: 'a' }), value: true },
      { field: field({ key: 'b' }), value: true },
      { field: field({ key: 'c' }), value: false },
    ]);

    expect(summary).toContain('2 of 3');
  });

  it('names the command that shows them', () => {
    const summary = formatFeatureSummary([{ field: field({ key: 'a' }), value: true }]);

    expect(summary).toContain('knowl config list');
  });
});

/**
 * `gh config --help` prints every setting it respects with a one-line description, its allowed
 * values and its default, and that help text is the reference people actually read. Ours is
 * generated from the same registry so it cannot fall behind the settings it documents.
 *
 * No current values here: help is printed without a repository, and a reference that guessed at
 * state would be wrong wherever it mattered. State is what `knowl config list` is for.
 */
describe('renderConfigReference', () => {
  it('names each switch and what it does', () => {
    const text = renderConfigReference().join('\n');

    expect(text).toContain('search.vector.enabled');
    expect(text).toContain('Rank by meaning');
  });

  it('leaves out the internals a preset owns', () => {
    const text = renderConfigReference().join('\n');

    expect(text).not.toContain('search.vector.dtype');
  });

  it('gives the allowed values of an enum', () => {
    const lines = renderConfigReference();
    const start = lines.findIndex(line => line.includes('impact.gate'));
    // The entry is its first line plus every continuation under it, since a long description
    // pushes the allowed values onto one.
    const entry = [lines[start], ...lines.slice(start + 1).filter(line => /^\s+\S/.test(line) && !/^\s{2}\S+\s{2}/.test(line))];

    expect(entry.join(' ')).toContain('{off | shadow | enforce}');
  });

  it('wraps rather than emitting the 300-character lines the real descriptions produce', () => {
    expect(renderConfigReference().every(line => line.length <= 96)).toBe(true);
  });
});

describe('CONFIG_FIELDS', () => {
  /**
   * The catalog renders `description` for every field it shows, so a field without one renders
   * a blank line under its name. Nothing else forced this: the interactive editor shows the
   * description only for the field being edited, so a missing one was invisible until now.
   */
  it('gives every field a description to render', () => {
    const undescribed = CONFIG_FIELDS.filter(candidate => !candidate.description?.trim()).map(candidate => candidate.key);
    expect(undescribed).toEqual([]);
  });
});
