import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { loadUnavailableAdapters } from '../../benchmarks/accuracy/src/registry.js';

const roots: string[] = [];

async function writeLock(systems: unknown[]): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'knowl-benchmark-lock-'));
  roots.push(root);
  const lockPath = path.join(root, 'systems.lock.json');
  await fs.writeFile(lockPath, JSON.stringify({ schemaVersion: 1, verifiedOn: '2026-07-13', systems }), 'utf-8');
  return lockPath;
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => fs.rm(root, { recursive: true, force: true })));
});

describe('external system registry', () => {
  it('keeps pinned but uninstalled systems explicitly N/A', async () => {
    const lockPath = await writeLock([{
      id: 'example',
      name: 'Example Memory',
      version: 'v1.0.0',
      repository: 'https://example.com/memory',
      commit: 'a'.repeat(40),
      status: 'unavailable',
      reason: 'adapter is not installed',
    }]);

    const [adapter] = await loadUnavailableAdapters(lockPath);

    expect(adapter.metadata.commit).toBe('a'.repeat(40));
    expect(adapter.metadata.capabilities.normalized).toMatchObject({
      supported: false,
      reason: 'adapter is not installed',
    });
  });

  it('rejects duplicate system ids', async () => {
    const system = {
      id: 'duplicate',
      name: 'Duplicate',
      version: 'v1',
      repository: 'https://example.com/memory',
      commit: 'b'.repeat(40),
      status: 'unavailable',
      reason: 'not installed',
    };
    const lockPath = await writeLock([system, system]);

    await expect(loadUnavailableAdapters(lockPath)).rejects.toThrow('Duplicate system id');
  });
});
