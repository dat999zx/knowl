import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { cloudPointer, hasCloudSettingsWithoutPointer } from '../../src/core/cloud-pointer.js';
import { cloudDoctorChecks } from '../../src/cloud/doctor-checks.js';
import { cloudStatus } from '../../src/cloud/status.js';
import type { ProjectConfig } from '../../src/core/types.js';

/**
 * A `cloud` block is not the same thing as a cloud connection.
 *
 * 5.0.1 made `cloud.autoStage` settable, which was the point of that release -- and in doing so
 * created a state nothing had ever seen: `knowl config set cloud.autoStage false` in a repository
 * that was never connected writes `cloud: { autoStage: false }`, a block with no pointer in it.
 *
 * Every caller tested the block's presence. `doctor` therefore called `readCredential(undefined)`
 * and reported `[FAIL] Cannot read properties of undefined (reading 'trim')` -- a JavaScript
 * error printed where the diagnosis goes, on a repository whose only sin was setting a documented
 * preference.
 */
/**
 * A path that is never opened.
 *
 * Every call below returns before it touches disk -- that is the behaviour under test -- but
 * passing `process.cwd()` would aim them at the real repository, and a suite that reaches the
 * developer's own store is one bad early-return away from racing whichever other file vitest
 * scheduled in the same worker. That is not hypothetical: it made `publish-stage.test.ts` fail
 * in the full run while passing alone.
 */
const NOWHERE = path.join(os.tmpdir(), 'knowl-pointer-test-never-created');

const settingsOnly = { version: 1, cloud: { autoStage: false } } as unknown as ProjectConfig;
const connected = {
  version: 1,
  cloud: {
    apiHost: 'https://api.knowl.cloud', workspaceId: 'ws-1', workspaceName: 'team',
    repo: 'github.com/o/r', autoStage: false,
  },
} as unknown as ProjectConfig;

describe('cloudPointer', () => {
  it('is null for a repository that has never been connected', () => {
    expect(cloudPointer({ version: 1 } as ProjectConfig)).toBeNull();
  });

  it('is null for a block holding only a preference', () => {
    expect(cloudPointer(settingsOnly)).toBeNull();
  });

  it('is null when either half of the pointer is missing', () => {
    // Both are required: one names the deployment credentials are keyed by, the other names
    // what to read and write. A block carrying one of them points nowhere usable.
    expect(cloudPointer({ version: 1, cloud: { apiHost: 'https://a' } } as unknown as ProjectConfig)).toBeNull();
    expect(cloudPointer({ version: 1, cloud: { workspaceId: 'ws-1' } } as unknown as ProjectConfig)).toBeNull();
  });

  it('returns the block, preferences included, when it points somewhere', () => {
    // `autoStage` rides along on the same object and callers read it from there, so narrowing
    // must not erase it.
    expect(cloudPointer(connected)?.workspaceId).toBe('ws-1');
    expect(cloudPointer(connected)?.autoStage).toBe(false);
  });

  it('distinguishes settings-without-pointer from no block at all', () => {
    expect(hasCloudSettingsWithoutPointer(settingsOnly)).toBe(true);
    expect(hasCloudSettingsWithoutPointer({ version: 1 } as ProjectConfig)).toBe(false);
    expect(hasCloudSettingsWithoutPointer(connected)).toBe(false);
  });
});

describe('callers that used to read the block itself', () => {
  it('doctor stays silent instead of crashing on a preference-only block', async () => {
    // The reported failure, end to end. `cloudDoctorChecks` returning [] is what a repository
    // with no cloud connection is supposed to produce -- Knowl is local-first and must not
    // advertise the cloud to someone who never opted in.
    await expect(cloudDoctorChecks(settingsOnly, NOWHERE)).resolves.toEqual([]);
  });

  it('status reports disconnected rather than throwing', async () => {
    const status = await cloudStatus(NOWHERE, settingsOnly);
    expect(status.connected).toBe(false);
  });

  it('workspace resolution treats it as unlinked instead of building a peer around nothing', async () => {
    // The second site, and the reason the first fix looked complete when it was not: with
    // `cloudDoctorChecks` guarded, `doctor` failed one line further down instead, on
    // `teamStorePath(undefined)` -> `The "path" argument must be of type string`.
    //
    // `resolveWorkspace` cannot import the predicate from `cloud/` -- `workspace` sits below it
    // in the enforced layering -- which is why the predicate lives in `core/`.
    const { resolveWorkspace } = await import('../../src/workspace/resolve.js');
    await expect(resolveWorkspace(NOWHERE, settingsOnly)).resolves.toBeNull();
  });
});
