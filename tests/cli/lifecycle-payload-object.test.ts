import { describe, expect, it } from 'vitest';
import {
  MAX_RETAINED_ARRAY_ITEMS,
  MAX_RETAINED_STRING,
  ROOT_FIELDS,
  readLifecyclePayloadObject,
} from '../../src/cli/agents/lifecycle.js';

describe('readLifecyclePayloadObject', () => {
  it('truncates strings to MAX_RETAINED_STRING and arrays to MAX_RETAINED_ARRAY_ITEMS and drops non-ROOT_FIELDS', () => {
    const raw = {
      prompt: 'a'.repeat(5_000),
      changedPaths: Array.from({ length: 200 }, (_, i) => `path/to/file-${i}.ts`),
      unrecognized_field: 'should be dropped',
      another_ignored: { nested: true },
    };

    const result = readLifecyclePayloadObject(raw);

    // Root fields allowlist
    expect(ROOT_FIELDS.has('prompt')).toBe(true);
    expect(ROOT_FIELDS.has('unrecognized_field')).toBe(false);
    expect(result).toHaveProperty('prompt');
    expect(result).toHaveProperty('changedPaths');
    expect(result).not.toHaveProperty('unrecognized_field');
    expect(result).not.toHaveProperty('another_ignored');

    // String truncation
    expect(result.prompt).toBe('a'.repeat(MAX_RETAINED_STRING));
    expect((result.prompt as string).length).toBe(MAX_RETAINED_STRING);

    // Array truncation
    expect(Array.isArray(result.changedPaths)).toBe(true);
    expect((result.changedPaths as unknown[]).length).toBe(MAX_RETAINED_ARRAY_ITEMS);
    expect((result.changedPaths as unknown[])[0]).toBe('path/to/file-0.ts');
    expect((result.changedPaths as unknown[])[MAX_RETAINED_ARRAY_ITEMS - 1]).toBe(`path/to/file-${MAX_RETAINED_ARRAY_ITEMS - 1}.ts`);
  });

  it('tail-truncates fields in TAIL_FIELDS like stdout', () => {
    const raw = {
      session_id: 'test-session',
      tool_response: {
        stdout: `prefix-discarded-${'x'.repeat(3000)}tail-kept`,
        exit_code: 0,
      },
    };

    const result = readLifecyclePayloadObject(raw);
    const response = result.tool_response as Record<string, unknown>;
    expect(response.exit_code).toBe(0);
    expect(typeof response.stdout).toBe('string');
    expect((response.stdout as string).length).toBe(MAX_RETAINED_STRING);
    expect((response.stdout as string).endsWith('tail-kept')).toBe(true);
    expect(response.stdout as string).not.toContain('prefix-discarded');
  });

  it('filters nested objects and arrays correctly', () => {
    const raw = {
      session_id: 's1',
      tool_input: {
        command: 'npm test',
        disallowed: 'drop-me',
        atoms: [
          { title: 'Atom 1', body: 'drop body' },
          { title: 'Atom 2', notes: 'drop notes' },
        ],
      },
      toolCall: {
        name: 'testTool',
        args: {
          CommandLine: 'git status',
          ForbiddenContent: 'drop this large file content',
        },
      },
    };

    const result = readLifecyclePayloadObject(raw);
    expect(result.tool_input).toEqual({
      command: 'npm test',
      atoms: [
        { title: 'Atom 1' },
        { title: 'Atom 2' },
      ],
    });
    expect(result.toolCall).toEqual({
      name: 'testTool',
      args: {
        CommandLine: 'git status',
      },
    });
  });

  it('returns empty object for non-object inputs', () => {
    expect(readLifecyclePayloadObject(null)).toEqual({});
    expect(readLifecyclePayloadObject(undefined)).toEqual({});
    expect(readLifecyclePayloadObject('string')).toEqual({});
    expect(readLifecyclePayloadObject(123)).toEqual({});
    expect(readLifecyclePayloadObject([])).toEqual({});
  });
});
