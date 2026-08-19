/**
 * A deep link into the running viewer, pointed at one atom.
 *
 * The token rides in the query because that is how `browseUrl` already authenticates a pasted
 * link -- the page swaps it for an `HttpOnly` cookie on first load. The atom id goes in the
 * fragment instead, so it is never sent to the server: routing to a row is the page's business,
 * and a fragment keeps the id out of any access log or proxy trace.
 */
export type IdMatch =
  | { kind: 'one'; id: string }
  | { kind: 'none' }
  | { kind: 'many'; ids: string[] };

/**
 * `knowl list` prints eight characters of the id, because sixteen does not fit beside a title.
 * So the id a person has in front of them to copy is a prefix, and requiring the full one makes
 * the two commands disagree about what an id is — you paste exactly what was shown and are told
 * it does not exist.
 *
 * An exact match wins outright, even when it is also a prefix of longer ids, so a complete id
 * can never be ambiguous.
 */
export function resolveAtomId(ids: string[], given: string): IdMatch {
  if (ids.includes(given)) return { kind: 'one', id: given };
  const matches = ids.filter(id => id.startsWith(given));
  if (matches.length === 1) return { kind: 'one', id: matches[0] };
  if (matches.length === 0) return { kind: 'none' };
  return { kind: 'many', ids: matches };
}

export function atomEditUrl(viewer: { url: string; token: string }, atomId: string): string {
  const origin = viewer.url.replace(/\/+$/, '');
  return `${origin}/?token=${encodeURIComponent(viewer.token)}#/atom/${encodeURIComponent(atomId)}`;
}
