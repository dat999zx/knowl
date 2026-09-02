import fs from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { claudeConfigDirs, derivedSessionName, isPidAlive, readHostSessionRegistry, sameDir } from '../../src/fleet/roster.js';

const root = path.resolve('./.knowl-peers-roster-test');
const home = path.join(root, 'home');
const dirA = path.join(home, '.claude');
const dirB = path.join(home, '.claude-account-b');

/**
 * Native on both platforms, because the host writes native paths into the registry and the
 * name derivation is `path.basename`. A literal `C:\Code\...` is one path segment to POSIX,
 * so the fallback name would come back as the whole string -- a green Windows run and a red
 * Ubuntu one, which is the split CONTRIBUTING names.
 */
const CWD = path.resolve('/Code/DuckPrep-server');

const record = (pid: number, extra: Record<string, unknown> = {}) => JSON.stringify({
  pid,
  sessionId: `session-${pid}`,
  cwd: CWD,
  startedAt: 1_788_000_000_000 + pid,
  name: `duckprep-server-${pid}`,
  kind: 'interactive',
  version: '2.1.257',
  messagingSocketPath: `\\\\.\\pipe\\LOCAL\\cc-msg-${pid}`,
  ...extra,
});

beforeAll(() => {
  fs.mkdirSync(path.join(dirA, 'sessions'), { recursive: true });
  fs.mkdirSync(path.join(dirB, 'sessions'), { recursive: true });
  // A sibling that is not a config dir: no sessions folder.
  fs.mkdirSync(path.join(home, '.claude-launchers'), { recursive: true });
  fs.writeFileSync(path.join(dirA, 'sessions', '100.json'), record(100));
  fs.writeFileSync(path.join(dirA, 'sessions', '200.json'), record(200));
  fs.writeFileSync(path.join(dirA, 'sessions', '200.abcdef.key'), 'not a record');
  fs.writeFileSync(path.join(dirA, 'sessions', 'broken.json'), '{not json');
  fs.writeFileSync(path.join(dirA, 'sessions', 'nopid.json'), JSON.stringify({ sessionId: 'x', cwd: 'y' }));
  fs.writeFileSync(path.join(dirB, 'sessions', '300.json'), record(300, { name: '' }));
});

afterAll(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

describe('claudeConfigDirs', () => {
  it('lists CLAUDE_CONFIG_DIR first, then ~/.claude, then every ~/.claude-* sibling with a sessions folder', () => {
    const dirs = claudeConfigDirs({ CLAUDE_CONFIG_DIR: dirB }, home);
    expect(dirs).toEqual([path.resolve(dirB), path.resolve(dirA)]);
  });

  it('does not repeat a directory named twice and skips siblings without sessions/', () => {
    const dirs = claudeConfigDirs({ CLAUDE_CONFIG_DIR: dirA }, home);
    expect(dirs).toEqual([path.resolve(dirA), path.resolve(dirB)]);
    expect(dirs.some(dir => dir.endsWith('.claude-launchers'))).toBe(false);
  });

  it('takes an explicit list over discovery', () => {
    const dirs = claudeConfigDirs({ KNOWL_CLAUDE_CONFIG_DIRS: [dirB, path.join(home, '.claude-launchers')].join(path.delimiter), CLAUDE_CONFIG_DIR: dirA }, home);
    expect(dirs).toEqual([path.resolve(dirB)]);
  });
});

describe('readHostSessionRegistry', () => {
  it('returns only records whose process is alive, oldest first, tagged with their config dir', () => {
    const alive = (pid: number) => pid === 200 || pid === 300;
    const records = readHostSessionRegistry([dirA, dirB], alive);
    expect(records.map(r => r.pid)).toEqual([200, 300]);
    expect(records[0]).toMatchObject({
      sessionId: 'session-200',
      name: 'duckprep-server-200',
      cwd: CWD,
      configDir: dirA,
      kind: 'interactive',
      version: '2.1.257',
    });
    expect(records[1].configDir).toBe(dirB);
  });

  it('skips malformed and incomplete records without throwing', () => {
    const records = readHostSessionRegistry([dirA], () => true);
    expect(records.map(r => r.pid)).toEqual([100, 200]);
  });

  it('derives a display name when the record carries none', () => {
    const [record] = readHostSessionRegistry([dirB], () => true);
    expect(record.name).toBe('duckprep-server-se');
  });

  it('tolerates a config dir with no sessions folder', () => {
    expect(readHostSessionRegistry([path.join(home, '.claude-launchers')], () => true)).toEqual([]);
  });
});

describe('isPidAlive', () => {
  it('is true for this process and false for an impossible pid', () => {
    expect(isPidAlive(process.pid)).toBe(true);
    expect(isPidAlive(0)).toBe(false);
    expect(isPidAlive(-1)).toBe(false);
    expect(isPidAlive(2_147_483_000)).toBe(false);
  });
});

describe('directory comparisons', () => {
  it('treats a trailing separator as the same directory', () => {
    expect(sameDir(root, root + path.sep)).toBe(true);
    expect(sameDir(root, path.join(root, 'home'))).toBe(false);
  });

  it.runIf(process.platform === 'win32')('ignores drive-letter and path casing on Windows', () => {
    expect(sameDir('C:\\Code\\X', 'c:\\code\\x')).toBe(true);
  });
});

describe('derivedSessionName', () => {
  it('is the folder and two characters of the id, so a host with no registry names alike', () => {
    expect(derivedSessionName(CWD, 'session-300')).toBe('duckprep-server-se');
  });
});
