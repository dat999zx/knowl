import { describe, expect, it } from 'vitest';
import { cardFrameActive } from '../../src/mcp/card-frame.js';
import { hostProfile, isHookHost } from '../../src/session/hosts/index.js';

const HOSTS = [undefined, 'claude', 'codex', 'hermes', 'openclaw', 'cursor', 'copilot', 'claude-desktop', 'generic', 'bogus-host'];
const ROOT = '/some/project';

describe('cardFrameActive', () => {
  it.each(HOSTS)('follows the verified-hook rule for host %s', host => {
    const profile = host !== undefined && isHookHost(host) ? hostProfile(host) : undefined;
    const otherCarrier = Boolean(profile && (profile.midTurnDeliveryVerified || profile.pluginEvents?.length));
    expect(cardFrameActive(host, ROOT)).toBe(!otherCarrier);
  });

  it('gives the verified hook hosts neither wrap nor note, and everyone else both', () => {
    expect(cardFrameActive('claude', ROOT)).toBe(false);
    expect(cardFrameActive('codex', ROOT)).toBe(false);
    expect(cardFrameActive('hermes', ROOT)).toBe(false);
    expect(cardFrameActive('openclaw', ROOT)).toBe(false);
    expect(cardFrameActive(undefined, ROOT)).toBe(true);
    expect(cardFrameActive('cursor', ROOT)).toBe(true);
    expect(cardFrameActive('bogus-host', ROOT)).toBe(true);
  });

  it.each(HOSTS)('is off without a project root for host %s', host => {
    expect(cardFrameActive(host, null)).toBe(false);
  });
});
