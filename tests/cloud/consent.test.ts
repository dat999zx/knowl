import fs from 'node:fs/promises';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { consentPath, readAutoPushConsent, writeAutoPushConsent } from '../../src/cloud/consent.js';
import { knowlHome } from '../../src/core/paths.js';

const HOME = path.resolve('./.knowl-consent-home');
const REPO = path.resolve('./.knowl-consent-repo');

describe('auto-push consent', () => {
  beforeEach(async () => {
    process.env.KNOWL_HOME = HOME;
    await fs.rm(HOME, { recursive: true, force: true }).catch(() => {});
    await fs.mkdir(HOME, { recursive: true });
    await fs.rm(REPO, { recursive: true, force: true }).catch(() => {});
    await fs.mkdir(path.join(REPO, '.knowl'), { recursive: true });
  });

  afterEach(async () => {
    delete process.env.KNOWL_HOME;
    await fs.rm(HOME, { recursive: true, force: true }).catch(() => {});
    await fs.rm(REPO, { recursive: true, force: true }).catch(() => {});
  });

  it('defaults to off', async () => {
    // The safe direction for a permission to do something irreversible.
    expect(await readAutoPushConsent('ws-1')).toBe(false);
  });

  it('round-trips per workspace', async () => {
    await writeAutoPushConsent('ws-1', true);
    expect(await readAutoPushConsent('ws-1')).toBe(true);
    expect(await readAutoPushConsent('ws-2')).toBe(false);
  });

  it('can be withdrawn', async () => {
    await writeAutoPushConsent('ws-1', true);
    await writeAutoPushConsent('ws-1', false);
    expect(await readAutoPushConsent('ws-1')).toBe(false);
  });

  it('lives in knowlHome, never in the repository', async () => {
    expect(consentPath().startsWith(knowlHome())).toBe(true);
  });

  it('a corrupt file reads as off rather than throwing', async () => {
    await fs.writeFile(consentPath(), 'not json', 'utf8');
    expect(await readAutoPushConsent('ws-1')).toBe(false);
  });

  it('enabling consent changes nothing in the repository', async () => {
    // This is the failure mode the design exists to prevent: a committed `true` would enable
    // irreversible publishing for every teammate who clones and for CI. A test is the only
    // thing that stops this regressing back into project config.
    const configPath = path.join(REPO, '.knowl', 'config.json');
    await fs.writeFile(configPath, JSON.stringify({ version: 1, cloud: { workspaceId: 'ws-1' } }), 'utf8');
    const before = await fs.readFile(configPath, 'utf8');

    await writeAutoPushConsent('ws-1', true);

    expect(await fs.readFile(configPath, 'utf8')).toBe(before);
    expect(before).not.toContain('autoPush');
  });
});
