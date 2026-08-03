/**
 * `transcript://<repo>/<session>#L<line>`, with `<repo>/` omitted for a local hit.
 *
 * A locator is handed to the agent and handed straight back. Session id plus line is not enough
 * to open a file -- the reader needs a path, which needs the owning repo, and in a workspace two
 * repos can hold sessions with the same id.
 */
export function formatLocator(hit: { repo?: string | null; sessionId: string; line: number }): string {
  const repo = hit.repo ? `${encodeURIComponent(hit.repo)}/` : '';
  return `transcript://${repo}${hit.sessionId}#L${hit.line}`;
}

const LOCATOR = /^transcript:\/\/(?:([^/]+)\/)?([^/#]+)#L(\d+)$/;

/** Null rather than a throw: a malformed locator is caller error, answered with a message. */
export function parseLocator(raw: string): { repo: string | null; sessionId: string; line: number } | null {
  if (typeof raw !== 'string') return null;
  const match = LOCATOR.exec(raw.trim());
  if (!match) return null;

  const line = Number(match[3]);
  // The regex already restricts this to digits, so the guard is about magnitude: a locator of
  // `#L99999999999999999999` parses to a float and would index nothing sensible.
  if (!Number.isSafeInteger(line) || line < 1) return null;

  let repo: string | null = null;
  if (match[1]) {
    try {
      repo = decodeURIComponent(match[1]);
    } catch {
      // `decodeURIComponent('%')` throws URIError on a lone or truncated escape. The contract
      // here is null-rather-than-throw, so a bad escape is just a malformed locator.
      return null;
    }
  }

  return { repo, sessionId: match[2], line };
}
