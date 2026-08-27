import { describe, expect, it } from 'vitest';
import { formatRecentContextToMarkdown } from '../../src/core/format.js';
import type { KnowledgeItem } from '../../src/core/types.js';

const item = (title: string, category: 'fact' | 'skill' = 'fact'): KnowledgeItem => ({
  id: title, title, content: 'body', category, status: 'active',
  createdAt: '2026-08-27T00:00:00.000Z', updatedAt: '2026-08-27T00:00:00.000Z',
} as KnowledgeItem);

// `toSurfacedSkills` keeps only active items of category 'skill'; a 'fact' renders no row at
// all, which is what made the first draft of these tests pass an empty section as a pass.
const skill = (title: string): KnowledgeItem => item(title, 'skill');

// A four-repo workspace with prose roles, which is what the defect was measured on: the repo
// list alone rendered 1,034 characters against a subagent's 853-character budget.
// Roles are the length real manifests carry -- the measured four-repo list was 1,034 characters,
// about 258 per repo. A fixture with short roles does not reproduce the defect, and the guard
// test below fails rather than passing quietly if this drifts back under the cap.
const role = (what: string) => `${what}, and a further clause of the kind manifests actually carry describing what stays private, what is shared, and which conventions a reader should not assume transfer`;
const WIDE_WORKSPACE = {
  name: 'duck', repo: 'knowl-cloud',
  selfRole: role('the hosted team-memory service, Node engine in src/ plus the Next.js client in web/'),
  peers: [
    { name: 'duckprep', role: role('the consumer SAT app, React 19 and Postgres'), defaultVisibility: 'workspace' as const },
    { name: 'ducksat', role: role('the private tutoring tool, vanilla TS and SQLite'), defaultVisibility: 'workspace' as const },
    { name: 'students', role: role('per-student tutoring records, roster and pedagogy'), defaultVisibility: 'workspace' as const },
  ],
};

const AGENT_CAP = 853;

describe('the card composed for a subagent', () => {
  it('uses a fixture whose repo list alone exceeds a subagent budget, as the real one does', () => {
    // The precondition every other test here depends on. Stated as an assertion because a
    // shortened fixture would make the regression tests pass for the wrong reason.
    const md = formatRecentContextToMarkdown({ items: [], commits: [] }, {
      maxChars: Number.MAX_SAFE_INTEGER, workspace: WIDE_WORKSPACE,
    });
    expect(md.length).toBeGreaterThan(AGENT_CAP);
  });

  it('reaches the skills section on a workspace whose repo list alone exceeds the budget', () => {
    // The regression this exists for. Slicing the parent's card at 853 stopped inside the repo
    // list, so a subagent got no skills at all -- and skills are the part it cannot query for,
    // because getRecentContext returns three items of any category and a peer's shared skill is
    // findable only by an agent who already knows it exists.
    const md = formatRecentContextToMarkdown(
      { items: [item('a')], commits: [], skills: [skill('a skill worth surfacing')] },
      { maxChars: AGENT_CAP, workspace: WIDE_WORKSPACE, compactWorkspace: true, knowledgeAsPointer: true },
    );
    expect(md).toContain('a skill worth surfacing');
    expect(md).not.toContain('[Context truncated]');
    expect(md.length).toBeLessThanOrEqual(AGENT_CAP);
  });

  it('loses the skills section under the old render-wide-then-slice path', () => {
    // Pins the CAUSE, and the cause is the two-step: bootstrapAgentSession rendered at
    // MAX_SAFE_INTEGER and the caller sliced the finished string to 853. Rendering AT 853
    // instead is not the same operation and does not reproduce the loss -- the formatter's own
    // skillBudget clamp and section ordering only apply when it knows the real cap, which under
    // the old path it never did. Written the wrong way round first, and this comment is why.
    const wide = formatRecentContextToMarkdown(
      { items: [item('a')], commits: [], skills: [skill('a skill worth surfacing')] },
      { maxChars: Number.MAX_SAFE_INTEGER, workspace: WIDE_WORKSPACE },
    );
    expect(wide).toContain('a skill worth surfacing');
    expect(wide.slice(0, AGENT_CAP)).not.toContain('a skill worth surfacing');
  });

  it('drops role prose but keeps repo names and write visibility', () => {
    const md = formatRecentContextToMarkdown({ items: [], commits: [] }, {
      maxChars: AGENT_CAP, workspace: WIDE_WORKSPACE, compactWorkspace: true,
    });
    expect(md).toContain('- duckprep — new writes are workspace-visible');
    expect(md).not.toContain('the consumer SAT app');
  });

  it('replaces recent knowledge with a pointer carrying no answerable content', () => {
    // Measured: 5 titles -> 6/6 subagents queried, 13 titles -> 1/6, a bare pointer -> 6/6 at a
    // seventh of the size. Content long enough to look sufficient is answered FROM.
    const md = formatRecentContextToMarkdown(
      { items: [item('a title an agent could answer from')], commits: [{ createdAt: 'x', message: 'a commit message', changes: [] } as never] },
      { maxChars: AGENT_CAP, knowledgeAsPointer: true },
    );
    expect(md).toContain('Call knowl_query');
    expect(md).not.toContain('a title an agent could answer from');
    expect(md).not.toContain('a commit message');
    expect(md).not.toMatch(/## Recent Active Knowledge/);
  });

  it('prints no item count beside the pointer', () => {
    // getRecentContext returns at most three items whatever the store holds, so any count in
    // scope understates it and reads as a reason not to bother looking.
    const md = formatRecentContextToMarkdown(
      { items: [item('one'), item('two'), item('three')], commits: [] },
      { maxChars: AGENT_CAP, knowledgeAsPointer: true },
    );
    expect(md).not.toMatch(/\b3\b/);
  });

  it('keeps recent knowledge for a parent squeezed by a worst-case warning block', () => {
    // The parent path prices its warnings first and composes the card into what is left. Its
    // three producers cap at 283 + 777 + 246 = 1,310 joined; under the old render-wide-then-slice
    // that cut the knowledge section off entirely on a four-repo workspace. Composing at the same
    // budget keeps it, because the formatter can drop item BODIES to fit rather than losing a
    // whole trailing section to a blind cut.
    const parentBudget = 3000 - 1310 - 2;
    const md = formatRecentContextToMarkdown(
      { items: [item('a knowledge item the parent must still see')], commits: [], skills: [skill('a skill')] },
      { maxChars: parentBudget, workspace: WIDE_WORKSPACE },
    );
    expect(md).toContain('## Recent Active Knowledge');
    expect(md).toContain('a knowledge item the parent must still see');
    expect(md).toContain('a skill');
    expect(md.length).toBeLessThanOrEqual(parentBudget);
  });

  it('leaves the parent card unchanged when neither option is set', () => {
    const md = formatRecentContextToMarkdown({ items: [item('kept')], commits: [] }, { workspace: WIDE_WORKSPACE });
    expect(md).toContain('kept');
    expect(md).toContain('the consumer SAT app');
    expect(md).toContain('## Recent Active Knowledge');
  });
});
