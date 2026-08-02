import { afterEach, describe, expect, it } from 'vitest';
import { formatWarmResult, warmEmbeddingModel } from '../../src/cli/warm-embeddings.js';
import { DEFAULT_CONFIG } from '../../src/core/config.js';
import type { ProjectConfig } from '../../src/core/types.js';

const ROOT = process.cwd();

describe('warmEmbeddingModel', () => {
  afterEach(() => {
    delete process.env.KNOWL_SKIP_MODEL_DOWNLOAD;
    // The suite sets this globally; restore it so later files keep their fast path.
    process.env.KNOWL_DISABLE_WRITE_EMBEDDING = '1';
  });

  it('skips on an explicit opt-out, without touching the model', async () => {
    process.env.KNOWL_SKIP_MODEL_DOWNLOAD = '1';
    const result = await warmEmbeddingModel(ROOT, DEFAULT_CONFIG);
    expect(result).toEqual({ status: 'skipped', reason: 'KNOWL_SKIP_MODEL_DOWNLOAD=1' });
  });

  it('skips when write-time embedding is off, since warming exists only to serve it', async () => {
    // Not a test accommodation: paying a model load here would slow every init and every
    // CI run for a capability that has been switched off.
    process.env.KNOWL_DISABLE_WRITE_EMBEDDING = '1';
    const result = await warmEmbeddingModel(ROOT, DEFAULT_CONFIG);
    expect(result).toEqual({ status: 'skipped', reason: 'KNOWL_DISABLE_WRITE_EMBEDDING=1' });
  });

  it('reports disabled when vector search is off in config', async () => {
    delete process.env.KNOWL_DISABLE_WRITE_EMBEDDING;
    const config = { ...DEFAULT_CONFIG, search: { vector: { enabled: false } } } as ProjectConfig;
    expect(await warmEmbeddingModel(ROOT, config)).toEqual({ status: 'disabled' });
  });

  it('never throws when the model cannot be prepared', async () => {
    delete process.env.KNOWL_DISABLE_WRITE_EMBEDDING;
    // A model name that cannot resolve stands in for offline, proxied and rate-limited
    // machines. Init runs in all of them and must still succeed.
    const config = {
      ...DEFAULT_CONFIG,
      search: { vector: { enabled: true, provider: 'local', model: 'knowl-test/does-not-exist', dtype: 'q8' } },
    } as ProjectConfig;
    const result = await warmEmbeddingModel(ROOT, config, { log: () => {} });
    expect(result.status).toBe('failed');
  }, 120_000);
});

describe('formatWarmResult', () => {
  it('says nothing when vector search is disabled', () => {
    expect(formatWarmResult({ status: 'disabled' })).toBeNull();
  });

  it('confirms readiness in terms of what it means for the user', () => {
    const message = formatWarmResult({ status: 'ready', model: 'local/m' })!;
    expect(message).toMatch(/semantic search/i);
  });

  it('names the recovery command when preparation failed', () => {
    const message = formatWarmResult({ status: 'failed', model: 'local/m', reason: 'offline' })!;
    expect(message).toContain('knowl reindex --vectors');
    // A failure must read as degraded, not broken: the project still works on keywords.
    expect(message).toMatch(/keyword search/i);
  });

  it('names the recovery command when the download was skipped', () => {
    const message = formatWarmResult({ status: 'skipped', reason: 'KNOWL_SKIP_MODEL_DOWNLOAD=1' })!;
    expect(message).toContain('knowl reindex --vectors');
  });

  it('points English-only defaults at the multilingual option', () => {
    const message = formatWarmResult({
      status: 'ready',
      model: 'onnx-community/granite-embedding-small-english-r2-ONNX',
    })!;
    expect(message).toContain('English');
    expect(message).toContain('knowl config');
  });

  it('says nothing about language when the model is already multilingual', () => {
    const message = formatWarmResult({
      status: 'ready',
      model: 'onnx-community/granite-embedding-97m-multilingual-r2-ONNX',
    })!;
    expect(message).not.toContain('knowl config');
  });
});
