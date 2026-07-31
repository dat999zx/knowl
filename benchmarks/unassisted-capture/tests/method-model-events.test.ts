import { describe, expect, it } from 'vitest';
import { renderSessionEvents, runModelOnEvents } from '../src/method-model-events.js';
import type { CorpusSession } from '../src/types.js';

const session: CorpusSession = {
  sessionId: 's1',
  title: 'Agent turn',
  startedAt: '2026-07-30T10:00:00.000Z',
  finishedAt: '2026-07-30T10:30:00.000Z',
  events: [
    {
      id: 'e1',
      sessionId: 's1',
      type: 'error',
      payload: { message: 'SQLITE_BUSY: database is locked' },
      observedAt: '2026-07-30T10:01:00.000Z',
    },
    {
      id: 'e2',
      sessionId: 's1',
      type: 'checkpoint',
      payload: { changedPaths: ['src/store/database.ts'] },
      observedAt: '2026-07-30T10:02:00.000Z',
    },
    {
      id: 'e3',
      sessionId: 's1',
      type: 'command',
      payload: { command: 'npx vitest run', exitCode: 0 },
      observedAt: '2026-07-30T10:03:00.000Z',
    },
  ],
};

describe('renderSessionEvents', () => {
  it('includes error text, changed paths, and commands', () => {
    const rendered = renderSessionEvents(session);

    expect(rendered).toContain('SQLITE_BUSY');
    expect(rendered).toContain('src/store/database.ts');
    expect(rendered).toContain('npx vitest run');
  });

  it('keeps events in observation order so a failure reads as preceding its fix', () => {
    const rendered = renderSessionEvents(session);

    expect(rendered.indexOf('SQLITE_BUSY')).toBeLessThan(rendered.indexOf('src/store/database.ts'));
  });

  it('does not leak the session title into the event stream, which the rules cannot see', () => {
    expect(renderSessionEvents({ ...session, title: 'SECRET-TITLE' })).not.toContain('SECRET-TITLE');
  });
});

describe('runModelOnEvents', () => {
  it('tags every returned atom with its session', async () => {
    const generate = async () => [{ category: 'fact', title: 'Lock', content: 'SQLITE_BUSY fixed in database.ts' }];

    const atoms = await runModelOnEvents([session], generate);

    expect(atoms).toEqual([
      { sessionId: 's1', category: 'fact', title: 'Lock', content: 'SQLITE_BUSY fixed in database.ts' },
    ]);
  });

  it('treats an empty return as zero atoms rather than an error', async () => {
    expect(await runModelOnEvents([session], async () => [])).toEqual([]);
  });

  it('keeps going when one session throws, so a single failure cannot void the run', async () => {
    let call = 0;
    const generate = async () => {
      call++;
      if (call === 1) throw new Error('rate limited');
      return [{ category: 'fact', title: 'T', content: 'C' }];
    };

    const atoms = await runModelOnEvents([session, { ...session, sessionId: 's2' }], generate);

    expect(atoms).toHaveLength(1);
    expect(atoms[0].sessionId).toBe('s2');
  });
});
