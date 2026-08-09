import fs from 'node:fs/promises';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  clearCredential,
  credentialsPath,
  readCredential,
  writeCredential,
} from '../../src/cloud/credentials.js';

const HOME = path.resolve('./.knowl-credentials-home');
const HOST = 'https://api.knowl.dev';
const OTHER = 'https://staging.knowl.dev';

const credential = (token: string) => ({
  accessToken: token,
  refreshToken: `${token}-refresh`,
  expiresAt: '2099-01-01T00:00:00.000Z',
  userId: 'user-1',
});

describe('cloud credential store', () => {
  beforeEach(async () => {
    process.env.KNOWL_HOME = HOME;
    await fs.rm(HOME, { recursive: true, force: true }).catch(() => {});
  });

  afterEach(async () => {
    delete process.env.KNOWL_HOME;
    await fs.rm(HOME, { recursive: true, force: true }).catch(() => {});
  });

  it('returns null for a host that has never been logged in to', async () => {
    expect(await readCredential(HOST)).toBeNull();
  });

  it('round-trips a credential', async () => {
    await writeCredential(HOST, credential('a'));
    expect(await readCredential(HOST)).toEqual(credential('a'));
  });

  it('keeps hosts apart, so staging cannot answer for production', async () => {
    await writeCredential(HOST, credential('prod'));
    await writeCredential(OTHER, credential('staging'));

    expect((await readCredential(HOST))?.accessToken).toBe('prod');
    expect((await readCredential(OTHER))?.accessToken).toBe('staging');
  });

  it('treats trailing slashes and case as the same host', async () => {
    await writeCredential('https://API.knowl.dev/', credential('a'));
    expect(await readCredential(HOST)).toEqual(credential('a'));
  });

  it('clears one host without disturbing the other', async () => {
    await writeCredential(HOST, credential('prod'));
    await writeCredential(OTHER, credential('staging'));

    await clearCredential(HOST);

    expect(await readCredential(HOST)).toBeNull();
    expect(await readCredential(OTHER)).not.toBeNull();
  });

  it('survives a corrupt file rather than blocking every cloud command', async () => {
    // Machine-local convenience state. A truncated file must cost a re-login, not a crash
    // on every invocation -- the same rule the repo registry follows.
    await fs.mkdir(path.dirname(credentialsPath()), { recursive: true });
    await fs.writeFile(credentialsPath(), '{ not json', 'utf8');

    expect(await readCredential(HOST)).toBeNull();
    await writeCredential(HOST, credential('a'));
    expect(await readCredential(HOST)).toEqual(credential('a'));
  });

  it('writes atomically, leaving no partial file behind', async () => {
    await writeCredential(HOST, credential('a'));
    const entries = await fs.readdir(path.dirname(credentialsPath()));
    expect(entries.filter(name => name.includes('.tmp'))).toEqual([]);
  });

  it.skipIf(process.platform === 'win32')('restricts the file to the owner on POSIX', async () => {
    await writeCredential(HOST, credential('a'));
    const mode = (await fs.stat(credentialsPath())).mode & 0o777;
    expect(mode).toBe(0o600);
  });
});
