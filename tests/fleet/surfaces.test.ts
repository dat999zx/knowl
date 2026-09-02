import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { classifySharedSurfaceCommand, classifySharedSurfacePath } from '../../src/fleet/surfaces.js';

/**
 * Native paths wherever a repo root is involved, because the repo-relative display goes through
 * `path.relative`: a literal `C:\Code\...` is a single segment to POSIX, so the display falls
 * back to the whole string and the suite passes on Windows and fails on Ubuntu.
 *
 * The machine-wide cases below stay literal, in both spellings on purpose -- that branch splits
 * the path itself rather than asking `path`, so it must classify a Windows layout from Linux and
 * the other way round.
 */
const root = path.resolve('/Code/DuckPrep-server');
const inRepo = (...segments: string[]) => path.join(root, ...segments);

describe('classifySharedSurfacePath', () => {
  it('names the knowl config, host settings and hook scripts', () => {
    expect(classifySharedSurfacePath(inRepo('.knowl', 'config.json'), root)).toMatchObject({ kind: 'knowl-config', target: '.knowl/config.json', machineWide: false });
    expect(classifySharedSurfacePath(inRepo('.claude', 'settings.local.json'), root)).toMatchObject({ kind: 'host-settings', target: '.claude/settings.local.json', machineWide: false });
    expect(classifySharedSurfacePath(inRepo('.claude', 'hooks', 'lesson-gate.mjs'), root)).toMatchObject({ kind: 'host-hooks', target: '.claude/hooks/lesson-gate.mjs', machineWide: false });
  });

  it('marks the user-level Claude directory as machine-wide, for either account layout and either platform', () => {
    expect(classifySharedSurfacePath('C:\\Users\\Admin\\.claude\\settings.json')).toMatchObject({ kind: 'host-settings', machineWide: true });
    expect(classifySharedSurfacePath('C:\\Users\\Admin\\.claude-account-b\\settings.json')).toMatchObject({ kind: 'host-settings', machineWide: true });
    expect(classifySharedSurfacePath('/home/admin/.claude/hooks/x.sh')).toMatchObject({ kind: 'host-hooks', machineWide: true });
  });

  it('names migrations, manifests, env files and generated output', () => {
    expect(classifySharedSurfacePath(inRepo('server', 'migrations', '202609020001_peers.sql'), root)).toMatchObject({ kind: 'migrations' });
    expect(classifySharedSurfacePath(inRepo('package-lock.json'), root)).toMatchObject({ kind: 'manifest' });
    expect(classifySharedSurfacePath(inRepo('.env.local'), root)).toMatchObject({ kind: 'env' });
    expect(classifySharedSurfacePath(inRepo('src', 'api.generated.ts'), root)).toMatchObject({ kind: 'generated' });
  });

  it('leaves ordinary source files alone', () => {
    expect(classifySharedSurfacePath(inRepo('server', 'src', 'shared', 'question-source.ts'), root)).toBeUndefined();
    expect(classifySharedSurfacePath(inRepo('docs', 'migrations-guide.md'), root)).toBeUndefined();
  });
});

describe('classifySharedSurfaceCommand', () => {
  it('recognises the commands that replace the engine under every session', () => {
    expect(classifySharedSurfaceCommand('npm install -g @dat999zx/knowl@latest')).toMatchObject({ kind: 'knowl-engine', machineWide: true });
    expect(classifySharedSurfaceCommand('npm i -g knowl && knowl doctor')).toMatchObject({ kind: 'knowl-engine' });
    expect(classifySharedSurfaceCommand('knowl upgrade')).toMatchObject({ kind: 'knowl-engine' });
    expect(classifySharedSurfaceCommand('pwsh -c knowl-sync')).toMatchObject({ kind: 'knowl-engine' });
  });

  it('does not fire on ordinary knowl use or local installs', () => {
    expect(classifySharedSurfaceCommand('knowl query "peers roster"')).toBeUndefined();
    expect(classifySharedSurfaceCommand('npm install')).toBeUndefined();
    expect(classifySharedSurfaceCommand('npm install -g typescript')).toBeUndefined();
  });
});
