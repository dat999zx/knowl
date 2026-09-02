import { inlineUntrusted } from '../core/untrusted.js';
import type { SurfaceHit } from './surfaces.js';

/**
 * Everything the cards know about one live session, flattened.
 *
 * `name` is what the host answers to -- the `to:` of a `SendMessage` -- and it is the only field
 * an agent can act on, which is why every card leads with it. `messageable` is false whenever
 * that call cannot reach the session: it runs on another host, under another config directory,
 * or the reader's own host has no messaging at all. The roster still sees it, because the fleet
 * store is shared by every host; a card that offered the call anyway would send the agent
 * chasing a refusal.
 */
export interface SessionView {
  name: string;
  sessionId: string;
  /** The agent host this session runs under: `claude`, `codex`, `cursor`, and so on. */
  host: string;
  repo: string;
  cwd: string;
  messageable: boolean;
  /** Minutes since the session started. */
  ageMinutes: number;
  /** Minutes since its last recorded turn ended; undefined when it has recorded none. */
  idleMinutes?: number;
  /** True while a turn is in flight as far as the store knows. */
  working: boolean;
  ask?: string;
  summary?: string;
  /** Repo-relative paths written in the turn in flight. */
  writes: string[];
  lastError?: string;
  /** Whether Knowl recorded any activity from it at all. */
  known: boolean;
  /** The store row's last change, for the per-turn delta; absent when unknown to Knowl. */
  updatedAt?: string;
}

const MAX_ROSTER_REPOS = 8;
const MAX_NAMES_PER_REPO = 12;
const MAX_FOCUS_CHARS = 110;
const MAX_DIGEST_SESSIONS = 6;

/** `duckprep-server-1e` -> `1e`, since the repo column already says `duckprep-server`. */
export function shortName(name: string, repo: string): string {
  const stem = repo.toLowerCase();
  const lowered = name.toLowerCase();
  if (lowered.startsWith(stem + '-') && name.length > stem.length + 1) return name.slice(stem.length + 1);
  return name;
}

/** One line of what a session is on: what it was asked, or failing that what it last said. */
export function focusOf(view: Pick<SessionView, 'ask' | 'summary'>): string | undefined {
  const text = view.ask ?? view.summary;
  return text ? inlineUntrusted(text).slice(0, MAX_FOCUS_CHARS) : undefined;
}

/**
 * The SessionStart section: who else is running, grouped by repo. Sixty-odd tokens for a
 * fleet of twenty, and no focus lines -- those are a pull (`knowl_fleet`) or a per-turn delta,
 * because a start card that carried every session's current task would be stale by the second
 * tool call and would cost the same again on every resume. Empty when the session is alone, so
 * a single-session user never sees a line about it.
 */
export function renderFleetRoster(self: { sessionId: string; repo: string }, sessions: SessionView[]): string {
  const others = sessions.filter(session => session.sessionId !== self.sessionId);
  if (others.length === 0) return '';
  const byRepo = new Map<string, SessionView[]>();
  for (const session of others) {
    const list = byRepo.get(session.repo) ?? [];
    list.push(session);
    byRepo.set(session.repo, list);
  }
  const repos = [...byRepo.entries()].sort((a, b) => {
    if (a[0] === self.repo) return -1;
    if (b[0] === self.repo) return 1;
    return b[1].length - a[1].length;
  });
  const lines = [`LIVE SESSIONS (${others.length} other agent session${others.length === 1 ? '' : 's'} on this machine)`];
  for (const [repo, list] of repos.slice(0, MAX_ROSTER_REPOS)) {
    const names = list.slice(0, MAX_NAMES_PER_REPO).map(session => {
      const short = inlineUntrusted(shortName(session.name, repo));
      return session.messageable ? short : `${short}†`;
    });
    const more = list.length > MAX_NAMES_PER_REPO ? ` +${list.length - MAX_NAMES_PER_REPO}` : '';
    const tag = repo === self.repo ? '  ← same repo as you' : '';
    lines.push(`${inlineUntrusted(repo).padEnd(14)} ${names.join(' · ')}${more}${tag}`);
  }
  // The hosts of the unreachable ones, named: "another host" is a fact the agent can act on
  // only if it knows which, and it is what tells a person their Codex tab is in the fleet too.
  const unreachable = [...new Set(others.filter(session => !session.messageable).map(session => session.host))].sort();
  if (unreachable.length > 0) lines.push(`† visible here, not reachable with SendMessage (${unreachable.join(', ')} — another host or config directory).`);
  lines.push(others.some(session => session.messageable)
    ? 'knowl_fleet tells you what each is doing. Message one with SendMessage(to:"<full name>").'
    : 'knowl_fleet tells you what each is doing. None can be messaged from here — raise anything that matters with the user.');
  return lines.join('\n');
}

/**
 * The per-turn delta: only sessions whose focus changed since this session last saw it. Empty
 * output means "say nothing", and the caller must treat it that way -- a card that repeats the
 * same six lines every turn is exactly the interruption tax the whole design is built to avoid.
 */
export function renderFleetDigest(changed: SessionView[]): string {
  if (changed.length === 0) return '';
  const lines = [`SESSIONS MOVED (${changed.length}):`];
  for (const session of changed.slice(0, MAX_DIGEST_SESSIONS)) {
    const writes = session.writes.length > 0
      ? ` — editing ${session.writes.slice(0, 3).map(inlineUntrusted).join(', ')}${session.writes.length > 3 ? ` +${session.writes.length - 3}` : ''}`
      : '';
    const state = session.working ? 'working' : 'idle';
    lines.push(`- ${inlineUntrusted(session.name)} [${inlineUntrusted(session.repo)}, ${state}]: ${focusOf(session) ?? '(no focus recorded)'}${writes}`);
  }
  if (changed.length > MAX_DIGEST_SESSIONS) lines.push(`+${changed.length - MAX_DIGEST_SESSIONS} more — knowl_fleet for the full list.`);
  return lines.join('\n');
}

export interface ClaimView {
  session: SessionView;
  head: string;
  minutesAgo: number;
  files: string[];
}

/**
 * The same-problem card. Everything in it is what SWE-Touch found the bare announcement
 * lacks: the exact files the other session is editing, what it is trying to do, and the two
 * concrete calls that resolve it. The instruction is "do not fix in parallel", not "stop" --
 * the agent may still be the right one to fix it, but only after the other has been asked.
 */
export function renderSameProblemCard(claim: ClaimView): string {
  const { session } = claim;
  const when = claim.minutesAgo < 1 ? 'just now' : `${claim.minutesAgo} min ago`;
  const lines = [
    'ANOTHER SESSION IS ALREADY ON THIS PROBLEM',
    `${inlineUntrusted(session.name)} hit the same error ${when} and is working on it right now:`,
    `  error: ${inlineUntrusted(claim.head)}`,
  ];
  if (claim.files.length > 0) lines.push(`  editing: ${claim.files.slice(0, 4).map(inlineUntrusted).join(', ')}${claim.files.length > 4 ? ` +${claim.files.length - 4}` : ''}`);
  const focus = focusOf(session);
  if (focus) lines.push(`  its focus: ${focus}`);
  lines.push('Do not fix this in parallel. Either:');
  if (session.messageable) {
    lines.push(`  · SendMessage(to:"${inlineUntrusted(session.name)}", message:"…") to split the work, or`);
    lines.push(`  · SendMessage(to:"${inlineUntrusted(session.name)}", notify_when_idle:true) and pick it up after, or`);
  } else {
    lines.push(`  · that session (${inlineUntrusted(session.host)}) cannot be messaged from here, so`);
  }
  lines.push('  · tell the user both sessions hit it and let them decide.');
  return lines.join('\n');
}

export interface SurfaceView {
  hit: SurfaceHit;
  /** Live sessions that would feel the change, most recently active first. */
  affected: SessionView[];
  /** Sessions that read the exact file and have not re-read it since. */
  readers: SessionView[];
  /** One stored incident line, when the store has one for this kind of surface. */
  incident?: string;
  /** True when the change has already happened and the card can only ask for repair. */
  after?: boolean;
}

/**
 * The pre-flight card for a shared surface. Advisory by design: it names who is standing on
 * the thing about to move and the two polite ways to move it, then gets out of the way. It
 * never says "blocked" -- a card that claims to have stopped something it did not stop teaches
 * the agent to ignore the next one.
 */
export function renderSharedSurfaceCard(view: SurfaceView): string {
  const { hit } = view;
  const scope = hit.machineWide ? 'every live session on this machine' : 'every live session in this repo';
  const lines = [
    `SHARED SURFACE · ${hit.kind} · ${inlineUntrusted(hit.target)}`,
    `${hit.reason.charAt(0).toUpperCase()}${hit.reason.slice(1)} — reaches ${scope}.`,
  ];
  if (view.incident) lines.push(`Known incident: ${inlineUntrusted(view.incident)}`);
  const editing = view.affected.filter(session => session.working || session.writes.length > 0);
  const idle = view.affected.filter(session => !editing.includes(session));
  if (view.affected.length > 0) {
    const describe = (session: SessionView) => {
      const state = editing.includes(session) ? 'working' : session.idleMinutes !== undefined ? `idle ${session.idleMinutes} min` : 'no activity recorded';
      return `${inlineUntrusted(session.name)} (${state})`;
    };
    lines.push(`Sessions that would feel it: ${[...editing, ...idle].slice(0, 6).map(describe).join(', ')}${view.affected.length > 6 ? ` +${view.affected.length - 6}` : ''}.`);
  }
  if (view.readers.length > 0) {
    lines.push(`Read this exact file and not since: ${view.readers.slice(0, 4).map(session => inlineUntrusted(session.name)).join(', ')}.`);
  }
  // Only the sessions this one can actually reach may be offered as something to message; the
  // rest fall back to the user, who can reach every terminal on the machine.
  const busy = editing.filter(session => session.messageable);
  if (view.after) {
    lines.push(busy.length > 0
      ? 'This already ran. Verify the sessions above still work, and message the working ones so they know.'
      : 'This already ran. Verify the sessions above still work, and tell the user which ones may need a restart.');
    return lines.join('\n');
  }
  lines.push('Options:');
  if (busy.length > 0) {
    lines.push(`  (a) wait — SendMessage(to:"${inlineUntrusted(busy[0].name)}", notify_when_idle:true)${busy.length > 1 ? ` (and the other ${busy.length - 1})` : ''}, then proceed;`);
    lines.push('  (b) proceed now, and message the working sessions first so they re-read;');
  } else {
    lines.push('  (a) proceed, and tell the user which sessions will need to re-read;');
    lines.push('  (b) hold until they are idle;');
  }
  lines.push('  (c) ask the user which.');
  return lines.join('\n');
}

export interface StaleReadView {
  session: SessionView;
  /** Repo-relative paths this session wrote that the other read and has not re-read. */
  paths: string[];
}

/**
 * The stop-time push. This one costs a turn -- it rides the only channel that reaches a model
 * at stop, which withholds the stop -- so it asks for one specific thing and accepts a reason
 * instead. The specificity is the point: file, symbol, what changed. CooperBench's agents spent
 * a fifth of their budget on messages that said nothing; this card exists to make the one
 * message that matters, once.
 */
export function renderStaleReadNudge(views: StaleReadView[]): string {
  if (views.length === 0) return '';
  const lines = ['ANOTHER SESSION READ WHAT YOU JUST CHANGED'];
  for (const view of views.slice(0, 3)) {
    const state = view.session.working || (view.session.idleMinutes !== undefined && view.session.idleMinutes <= 30) ? 'still working' : 'idle';
    const focus = focusOf(view.session);
    const paths = view.paths.slice(0, 3).map(inlineUntrusted).join(', ') + (view.paths.length > 3 ? ` +${view.paths.length - 3}` : '');
    lines.push(`- ${inlineUntrusted(view.session.name)} (${state}${focus ? `, on: ${focus}` : ''}) read ${paths} before your edit.`);
  }
  const first = views[0].session;
  if (first.messageable) {
    lines.push(`Send one SendMessage(to:"${inlineUntrusted(first.name)}") naming the file, the symbol, and what changed — or say in one line why it does not affect them. Then stop.`);
  } else {
    lines.push(`That session cannot be messaged from here (${inlineUntrusted(first.host)}). Tell the user in one line, then stop.`);
  }
  return lines.join('\n');
}
