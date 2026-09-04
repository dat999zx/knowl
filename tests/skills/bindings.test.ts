import { describe, expect, it } from 'vitest';
import { interpolate, resolveBinding } from '../../src/skills/bindings.js';

const manifest = {
  name: 'release', purpose: 'cut a release', version: 1, entrypoints: {},
  createdAt: '', updatedAt: '',
  requires: {
    inputs: { test_command: { description: 'must pass' }, release_branch: { default: 'main' } },
  },
} as any;

describe('bindings fill a playbook in', () => {
  it('takes bound values and falls back to declared defaults', () => {
    const resolved = resolveBinding(manifest, { inputs: { test_command: 'npm test' } });
    expect('values' in resolved && resolved.values).toEqual({ test_command: 'npm test', release_branch: 'main' });
  });

  it('reports what is missing instead of running with a hole in the command', () => {
    const resolved = resolveBinding(manifest, {});
    expect('missing' in resolved && resolved.missing).toEqual(['test_command']);
  });

  it('substitutes only ${inputs.*}', () => {
    expect(interpolate(['--run', '${inputs.test_command}'], { test_command: 'npm test' }))
      .toEqual(['--run', 'npm test']);
  });

  it('refuses any other interpolation, rather than resolving it to nothing', () => {
    // The injection surface is exactly this. No environment, no expressions, no shell.
    for (const bad of ['${env.PATH}', '${process.cwd()}', '$(whoami)', '${inputs.nope}']) {
      expect(() => interpolate([bad], { test_command: 'npm test' }), bad).toThrow();
    }
  });
});
