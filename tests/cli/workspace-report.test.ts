import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { formatWorkspaceBlock, workspaceDoctorChecks } from '../../src/cli/workspace-report.js';
import { formatStatusReport } from '../../src/cli/status-report.js';
import { createManifest } from '../../src/workspace/manifest.js';
import type { ActiveWorkspace } from '../../src/workspace/resolve.js';
import { DEFAULT_CONFIG } from '../../src/core/config.js';
import type { ProjectConfig } from '../../src/core/types.js';

const active = (overrides: Partial<ActiveWorkspace> = {}): ActiveWorkspace => ({
  name: 'duckprep',
  repo: 'server',
  manifest: createManifest('duckprep', {
    provider: 'local', model: 'Xenova/all-MiniLM-L6-v2', dtype: 'q8', pooling: 'mean',
  }),
  peers: [
    { name: 'web', root: path.resolve('/repos/web'), databasePath: path.resolve('/repos/web/.knowl/knowl.db'), present: true },
    { name: 'protocol', root: path.resolve('/repos/protocol'), databasePath: path.resolve('/repos/protocol/.knowl/knowl.db'), present: false },
  ],
  ...overrides,
});

describe('workspace status block', () => {
  it('is empty when there is no workspace, so unlinked output is unchanged', () => {
    expect(formatWorkspaceBlock(null)).toEqual([]);
  });

  it('names the workspace, this repo, and each peer', () => {
    const text = formatWorkspaceBlock(active()).join('\n');
    expect(text).toContain('duckprep');
    expect(text).toContain('server');
    expect(text).toContain('web');
  });

  it('marks a peer that is missing from this machine', () => {
    expect(formatWorkspaceBlock(active()).join('\n')).toMatch(/protocol.*missing/i);
  });

  it('shows each peer recorded nature beside its presence', () => {
    const text = formatWorkspaceBlock(active({
      peers: [
        {
          name: 'duck', root: path.resolve('/repos/duck'), databasePath: path.resolve('/repos/duck/.knowl/knowl.db'),
          present: true, role: 'reading log', kin: 'forks', defaultVisibility: 'workspace',
        },
        { name: 'plain', root: path.resolve('/repos/plain'), databasePath: path.resolve('/repos/plain/.knowl/knowl.db'), present: true },
      ],
    })).join('\n');

    expect(text).toContain('reading log');
    expect(text).toContain('kin: forks');
    expect(text).toMatch(/duck[\s\S]*workspace-visible/);
    // A repo with nothing recorded reads exactly as it did before this feature.
    expect(text).toMatch(/plain\s+present\s*$/m);
  });

  it('shows names, not absolute paths, unless verbose', () => {
    expect(formatWorkspaceBlock(active()).join('\n')).not.toContain(path.resolve('/repos/web'));
    expect(formatWorkspaceBlock(active(), { verbose: true }).join('\n')).toContain(path.resolve('/repos/web'));
  });

  it('says so plainly when a workspace has no other repos yet', () => {
    expect(formatWorkspaceBlock(active({ peers: [] })).join('\n')).toMatch(/none yet/i);
  });
});

describe('formatStatusReport wiring', () => {
  const base = {
    project: { id: 'local', name: 'demo', rootPath: '/demo' } as never,
    config: DEFAULT_CONFIG,
    activeItems: [], supersededItems: [], deprecatedItems: [], commits: [],
  };

  it('renders the workspace block when one is passed', () => {
    // This assertion exists because the block was wired at the call site and in the type
    // but never actually rendered -- a scripted edit silently no-opped, and nothing caught
    // it until the CLI was run by hand against two real repos.
    const report = formatStatusReport({ ...base, workspace: active() });
    expect(report).toContain('WORKSPACE');
    expect(report).toContain('duckprep');
    expect(report).toContain('server');
  });

  it('renders nothing extra when there is no workspace', () => {
    expect(formatStatusReport({ ...base, workspace: null })).not.toContain('WORKSPACE');
    expect(formatStatusReport(base)).not.toContain('WORKSPACE');
  });
});

describe('workspace doctor checks', () => {
  it('returns nothing for an unlinked project', () => {
    expect(workspaceDoctorChecks(null, DEFAULT_CONFIG)).toEqual([]);
  });

  it('warns about an absent peer rather than reporting OK', () => {
    const checks = workspaceDoctorChecks(active(), DEFAULT_CONFIG);
    expect(checks.some(check => check.status === 'WARN' && /protocol/.test(check.message))).toBe(true);
  });

  it('warns when this repo embeds differently from the workspace', () => {
    const drifted = {
      ...DEFAULT_CONFIG,
      search: { vector: { enabled: true, provider: 'local', model: 'other', dtype: 'q8' } },
    } as ProjectConfig;
    // A mismatched embedding makes items mutually invisible, and a filtered-out embedding
    // looks exactly like no embedding -- nothing else would report this.
    expect(workspaceDoctorChecks(active(), drifted).some(check => check.status === 'WARN' && /embed/i.test(check.message))).toBe(true);
  });

  it('reports OK when every peer is present and the identity matches', () => {
    const healthy = active({
      peers: [{ name: 'web', root: '/repos/web', databasePath: '/repos/web/.knowl/knowl.db', present: true }],
    });
    expect(workspaceDoctorChecks(healthy, DEFAULT_CONFIG).every(check => check.status === 'OK')).toBe(true);
  });

  it('offers a fix for every warning it raises', () => {
    const checks = workspaceDoctorChecks(active(), DEFAULT_CONFIG);
    expect(checks.filter(check => check.status === 'WARN').every(check => Boolean(check.fix))).toBe(true);
  });
});
