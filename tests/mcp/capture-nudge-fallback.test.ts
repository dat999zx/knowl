import { afterEach, describe, expect, it, vi } from 'vitest';
import { consumeCaptureNudge, resetChangeNotice } from '../../src/mcp/change-notice.js';
import type { ProjectConfig } from '../../src/core/types.js';

/**
 * The capture nudge for clients with no stop hook.
 *
 * The first attempt at this could never fire, and nothing caught it: it reused
 * `capture_outcomes`, whose rows are keyed on a host session id this path does not have and
 * whose `turns` counter is incremented only from the hook path. On a genuinely hookless host
 * the row never existed, so the threshold was never met and the feature was silently dark.
 * Every test here asserts the nudge actually arrives, or actually does not, for a stated reason.
 */
vi.mock('../../src/session/host-session-bindings.js', () => ({
  listLiveHostBindings: vi.fn(async () => [] as string[]),
}));

const { listLiveHostBindings } = await import('../../src/session/host-session-bindings.js');
const ROOT = '/tmp/knowl-capture-nudge';
const enforce = { capture: { nudge: 'enforce' } } as unknown as ProjectConfig;

const read = (config: ProjectConfig | null = enforce) => consumeCaptureNudge(ROOT, 'knowl_query', config);

afterEach(() => {
  resetChangeNotice();
  vi.mocked(listLiveHostBindings).mockResolvedValue([]);
});

describe('MCP capture nudge', () => {
  it('stays silent until the session has consulted memory several times', async () => {
    for (let call = 0; call < 4; call += 1) expect(await read(), `call ${call + 1}`).toBeUndefined();
    expect(await read()).toContain('stored');
  });

  it('is spent once per process, because the agent may rightly decline to clear it', async () => {
    for (let call = 0; call < 5; call += 1) await read();
    expect(await read()).toBeUndefined();
    expect(await read()).toBeUndefined();
  });

  it('never fires for a session that actually stored something', async () => {
    await consumeCaptureNudge(ROOT, 'knowl_store', enforce);
    for (let call = 0; call < 10; call += 1) expect(await read()).toBeUndefined();
  });

  it('stands down when a hooked host owns the stop channel', async () => {
    // Claude gets this at stop time, where it can withhold something. A second copy here would
    // spend the message twice and read as memory nagging.
    vi.mocked(listLiveHostBindings).mockResolvedValue(['claude']);
    for (let call = 0; call < 8; call += 1) expect(await read()).toBeUndefined();
  });

  it('still fires for a hooked host whose hooks cannot carry it', async () => {
    // Windsurf has twelve hook events and none at stop time, so a live binding does not mean
    // the nudge is being delivered elsewhere.
    vi.mocked(listLiveHostBindings).mockResolvedValue(['windsurf']);
    for (let call = 0; call < 4; call += 1) await read();
    expect(await read()).toContain('stored');
  });

  it('does nothing at all unless the repository asked for it', async () => {
    for (let call = 0; call < 10; call += 1) {
      expect(await read(null)).toBeUndefined();
      expect(await read({ capture: { nudge: 'shadow' } } as unknown as ProjectConfig)).toBeUndefined();
    }
  });
});

describe('the installed host is better evidence than a live binding', () => {
  it('stands down for a host whose hooks carry the nudge, before any binding exists', async () => {
    // A binding only appears once that host's SessionStart has landed. A Claude session that
    // reached five Knowl calls first would otherwise take both nudges -- one here and one at
    // stop time -- which reads, to the agent, as memory nagging it.
    vi.mocked(listLiveHostBindings).mockResolvedValue([]);
    for (let call = 0; call < 8; call += 1) {
      expect(await consumeCaptureNudge(ROOT, 'knowl_query', enforce, 'claude')).toBeUndefined();
    }
  });

  it('still fires for an installed host whose hooks cannot carry it', async () => {
    // Windsurf has twelve hook events and none at stop time, so knowing the host does not mean
    // the nudge is being delivered elsewhere.
    for (let call = 0; call < 4; call += 1) {
      await consumeCaptureNudge(ROOT, 'knowl_query', enforce, 'windsurf');
    }
    expect(await consumeCaptureNudge(ROOT, 'knowl_query', enforce, 'windsurf')).toContain('stored');
  });

  it('ignores a host string it does not recognise rather than trusting it', async () => {
    for (let call = 0; call < 4; call += 1) {
      await consumeCaptureNudge(ROOT, 'knowl_query', enforce, 'not-a-host');
    }
    expect(await consumeCaptureNudge(ROOT, 'knowl_query', enforce, 'not-a-host')).toContain('stored');
  });
});
