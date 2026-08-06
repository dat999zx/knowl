import fs from 'node:fs/promises';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { closeDb, initDb } from '../../src/store/database.js';
import * as repo from '../../src/store/repository.js';
import { storeKnowledgeItemDeduped, storeKnowledgeAtomsDeduped } from '../../src/store/knowledge-writer.js';

const ROOT = path.resolve('./.knowl-supersede-write-test');

describe('supersede on write', () => {
  let projectId = '';
  beforeAll(async () => {
    await fs.rm(ROOT, { recursive: true, force: true });
    await fs.mkdir(path.join(ROOT, '.knowl'), { recursive: true });
    await initDb(ROOT);
    projectId = (await repo.createProject(ROOT, 'supersede')).id;
  });
  afterAll(async () => { await closeDb(); await fs.rm(ROOT, { recursive: true, force: true }).catch(() => {}); });

  it('a changed state atom supersedes its near-duplicate predecessor', async () => {
    const first = await storeKnowledgeItemDeduped(projectId, {
      category: 'state', title: 'Migration progress', content: 'Postgres migration is 40 percent complete, users table done.',
    });
    expect(first.action).toBe('inserted');

    const second = await storeKnowledgeItemDeduped(projectId, {
      category: 'state', title: 'Migration progress', content: 'Postgres migration is 90 percent complete, users and orders tables done.',
    });
    expect(second.action).toBe('inserted');

    const old = await repo.getKnowledgeItem(first.item.id);
    expect(old!.status).toBe('superseded');
    expect(old!.supersededById).toBe(second.item.id);
    expect((await repo.getKnowledgeItem(second.item.id))!.status).toBe('active');
  });

  it('an identical state re-store is still deduped, not churned', async () => {
    const content = 'Deploy pipeline is green on main.';
    const first = await storeKnowledgeItemDeduped(projectId, { category: 'state', title: 'Deploy status', content });
    const again = await storeKnowledgeItemDeduped(projectId, { category: 'state', title: 'Deploy status', content });
    expect(again.action).toBe('duplicate');
    expect(again.item.id).toBe(first.item.id);
    expect((await repo.getKnowledgeItem(first.item.id))!.status).toBe('active');
  });

  it('a corrected fact supersedes its same-titled predecessor instead of being dropped', async () => {
    const first = await storeKnowledgeItemDeduped(projectId, {
      category: 'fact', title: 'Cache TTL', content: 'The product cache expires after 5 minutes.',
    });
    const second = await storeKnowledgeItemDeduped(projectId, {
      category: 'fact', title: 'Cache TTL', content: 'The product cache expires after 30 minutes now.',
    });
    // Dropping the new write leaves the STALE value active and loses the correction with
    // no durable trace. Superseding keeps both: the correction becomes the active answer
    // and the predecessor stays queryable with status 'superseded'.
    expect(second.action).toBe('inserted');
    const old = await repo.getKnowledgeItem(first.item.id);
    expect(old!.status).toBe('superseded');
    expect(old!.supersededById).toBe(second.item.id);
  });

  it('an identical fact re-store is still deduped, not churned', async () => {
    const first = await storeKnowledgeItemDeduped(projectId, {
      category: 'fact', title: 'Queue driver', content: 'Background jobs run on Redis.',
    });
    const repeat = await storeKnowledgeItemDeduped(projectId, {
      category: 'fact', title: 'Queue driver', content: 'Background jobs run on Redis.',
    });
    expect(repeat.action).toBe('duplicate');
    expect(repeat.item.id).toBe(first.item.id);
    expect((await repo.getKnowledgeItem(first.item.id))!.status).toBe('active');
  });

  it('a subset-titled restatement supersedes rather than being dropped', async () => {
    const original = await storeKnowledgeItemDeduped(projectId, {
      category: 'fact', title: 'Deploy target', content: 'The web app deploys to Fly.io in the iad region.',
    });
    const restated = await storeKnowledgeItemDeduped(projectId, {
      category: 'fact', title: 'Deploy target for web', content: 'The web app deploys to Fly.io in the iad region, pinned to iad only.',
    });
    // "Deploy target" is a token subset of "Deploy target for web", so this is the same
    // subject and the newer write becomes the single active answer.
    expect(restated.action).toBe('inserted');
    expect(restated.superseded?.id).toBe(original.item.id);
    expect((await repo.getKnowledgeItem(original.item.id))!.status).toBe('superseded');
  });

  it('an unrelated-title overlap keeps both active and reports the near-duplicate', async () => {
    const original = await storeKnowledgeItemDeduped(projectId, {
      category: 'fact', title: 'Rate limiter buckets', content: 'The API throttles clients with a token bucket of 100 requests per minute.',
    });
    const other = await storeKnowledgeItemDeduped(projectId, {
      category: 'fact', title: 'Throttling headers returned to clients', content: 'The API throttles clients and returns Retry-After on a token bucket rejection.',
    });
    // The engine cannot tell a correction from a genuinely distinct record here, so it
    // writes the content and names the overlap instead of discarding either one.
    expect(other.action).toBe('inserted');
    expect(other.superseded).toBeUndefined();
    expect(other.nearDuplicate?.id).toBe(original.item.id);
    expect((await repo.getKnowledgeItem(original.item.id))!.status).toBe('active');
  });

  it('never drops a write: a reworded correction is always persisted', async () => {
    await storeKnowledgeItemDeduped(projectId, {
      category: 'constraint', title: 'Upload size limit', content: 'Uploads are capped at 10 MB by the edge proxy.',
    });
    const corrected = await storeKnowledgeItemDeduped(projectId, {
      category: 'constraint', title: 'Maximum upload size enforced at the edge', content: 'Uploads are capped at 50 MB by the edge proxy since the tier upgrade.',
    });
    // Whatever the title similarity, the new content exists in the database afterwards.
    expect(corrected.action).toBe('inserted');
    const stored = await repo.getKnowledgeItem(corrected.item.id);
    expect(stored!.content).toContain('50 MB');
    expect(stored!.status).toBe('active');
  });

  it('an explicit supersedes id retires the named item for any category', async () => {
    const original = await storeKnowledgeItemDeduped(projectId, {
      category: 'fact', title: 'Node runtime', content: 'Services run on Node.js 18.',
    });
    const replacement = await storeKnowledgeItemDeduped(projectId, {
      category: 'fact', title: 'Node runtime upgraded', content: 'Services now run on Node.js 22 LTS.',
      supersedes: original.item.id,
    });
    expect(replacement.action).toBe('inserted');
    const old = await repo.getKnowledgeItem(original.item.id);
    expect(old!.status).toBe('superseded');
    expect(old!.supersededById).toBe(replacement.item.id);
  });

  it('never supersedes a differently-titled state record (work loop trail is safe)', async () => {
    const start = await storeKnowledgeItemDeduped(projectId, {
      category: 'state', title: 'Work Loop: Implement search UI', content: 'Started work loop for the search UI task.',
    });
    // A different title on the same topic must not retire the earlier record,
    // even though the text overlaps heavily.
    await storeKnowledgeItemDeduped(projectId, {
      category: 'state', title: 'Work Loop finish', content: 'Started work loop for the search UI task, verified implementation.',
    });

    expect((await repo.getKnowledgeItem(start.item.id))!.status).toBe('active');
  });

  it('batch promotion supersedes stale state too', async () => {
    const seed = await storeKnowledgeItemDeduped(projectId, {
      category: 'state', title: 'Session outcome', content: 'Finished the retrieval refactor, tests passing.',
    });
    const result = await storeKnowledgeAtomsDeduped(projectId, [{
      category: 'state', title: 'Session outcome', content: 'Finished the retrieval refactor and the viewer rewrite, tests passing.',
    }], 'Finalize memory session');
    expect(result.insertedCount).toBe(1);
    expect(result.supersededIds).toEqual([seed.item.id]);
    expect(result.outcomes[0].supersededId).toBe(seed.item.id);
    expect((await repo.getKnowledgeItem(seed.item.id))!.status).toBe('superseded');
  });

  it('batch outcomes separate a verbatim no-op from a real insert', async () => {
    const seed = await storeKnowledgeItemDeduped(projectId, {
      category: 'fact', title: 'Search backend', content: 'Full-text search runs on SQLite FTS5.',
    });
    const result = await storeKnowledgeAtomsDeduped(projectId, [
      { category: 'fact', title: 'Search backend', content: 'Full-text search runs on SQLite FTS5.' },
      { category: 'fact', title: 'Ranking function', content: 'Result ordering uses the BM25 scorer.' },
    ], 'Mixed batch');

    // The old reply counted both as "stored", so a caller could not tell that the first
    // atom wrote nothing.
    expect(result.insertedCount).toBe(1);
    expect(result.duplicateCount).toBe(1);
    expect(result.outcomes[0]).toMatchObject({ action: 'duplicate', itemId: seed.item.id });
    expect(result.outcomes[1].action).toBe('inserted');
  });

  it('a restatement that adds affectedPaths is not a verbatim no-op', async () => {
    // The no-op test compared title and content and nothing else, so a second write of the
    // same sentence carrying the paths it applies to was answered "already held verbatim,
    // nothing was lost" and silently dropped. `affectedPaths` is what the whole drift system
    // keys on, so the dropped write is the difference between an item that gets re-checked
    // when its file changes and one that never does.
    const first = await storeKnowledgeItemDeduped(projectId, {
      category: 'fact', title: 'Retry budget', content: 'The HTTP client retries three times.',
    });
    const withPaths = await storeKnowledgeItemDeduped(projectId, {
      category: 'fact', title: 'Retry budget', content: 'The HTTP client retries three times.',
      affectedPaths: ['src/http/client.ts'],
    });

    expect(withPaths.action).toBe('inserted');
    expect((await repo.getKnowledgeItem(withPaths.item.id))!.affectedPaths).toEqual(['src/http/client.ts']);
    expect((await repo.getKnowledgeItem(first.item.id))!.status).toBe('superseded');
  });

  it('a restatement that adds tags, a source commit or a confidence is not a no-op either', async () => {
    const base = {
      category: 'fact' as const,
      title: 'Session cookie lifetime',
      content: 'Session cookies expire after fourteen days.',
    };
    await storeKnowledgeItemDeduped(projectId, base);

    const tagged = await storeKnowledgeItemDeduped(projectId, { ...base, tags: ['auth', 'cookies'] });
    expect(tagged.action).toBe('inserted');
    expect((await repo.getKnowledgeItem(tagged.item.id))!.tags).toEqual(['auth', 'cookies']);

    const committed = await storeKnowledgeItemDeduped(projectId, {
      ...base, tags: ['auth', 'cookies'], sourceCommit: 'abc1234',
    });
    expect(committed.action).toBe('inserted');
    expect((await repo.getKnowledgeItem(committed.item.id))!.sourceCommit).toBe('abc1234');

    const downgraded = await storeKnowledgeItemDeduped(projectId, {
      ...base, tags: ['auth', 'cookies'], sourceCommit: 'abc1234', confidence: 0.4,
    });
    expect(downgraded.action).toBe('inserted');
    expect((await repo.getKnowledgeItem(downgraded.item.id))!.confidence).toBeCloseTo(0.4);
  });

  it('a barer restatement of a richer record is still a no-op, and leaves the richer one active', async () => {
    // The other half of the same rule. "Carries something new" is not "differs": a write that
    // simply omits what the store already holds adds nothing, so writing it would retire the
    // richer record in favour of a barer one -- the same field-blindness pointed the other way.
    const rich = await storeKnowledgeItemDeduped(projectId, {
      category: 'fact', title: 'Password hashing', content: 'Passwords are hashed with argon2id.',
      reasoning: 'Chosen for memory hardness.', tags: ['auth', 'crypto'], affectedPaths: ['src/auth/hash.ts'],
    });

    const bare = await storeKnowledgeItemDeduped(projectId, {
      category: 'fact', title: 'Password hashing', content: 'Passwords are hashed with argon2id.',
    });

    expect(bare.action).toBe('duplicate');
    expect(bare.item.id).toBe(rich.item.id);
    const stored = await repo.getKnowledgeItem(rich.item.id);
    expect(stored!.status).toBe('active');
    expect(stored!.tags).toEqual(['auth', 'crypto']);
    expect(stored!.affectedPaths).toEqual(['src/auth/hash.ts']);
  });

  it('a batch atom that adds a field is not counted as already held', async () => {
    await storeKnowledgeItemDeduped(projectId, {
      category: 'fact', title: 'Log shipping', content: 'Application logs ship to Loki.',
    });
    const result = await storeKnowledgeAtomsDeduped(projectId, [{
      category: 'fact', title: 'Log shipping', content: 'Application logs ship to Loki.',
      affectedPaths: ['src/logging/ship.ts'],
    }], 'Log shipping paths');

    expect(result.duplicateCount).toBe(0);
    expect(result.insertedCount).toBe(1);
    expect((await repo.getKnowledgeItem(result.itemIds[0]))!.affectedPaths).toEqual(['src/logging/ship.ts']);
  });

  // Four decisions this module documents in prose and did not check. Each is a mutation that
  // survived every test file able to observe this module -- confirmed one at a time in a fresh
  // process -- so each names a way to break the documented rule that the suite agreed with.
  it('retires the item the caller NAMED, not the unrelated neighbour the search turned up', async () => {
    // `input.supersedes === duplicate.id` -> `!==` survived. Read it through
    // `resolveSupersedeTarget`, which prefers the detected duplicate over the explicit id
    // whenever the resolution qualifies: under the mutant, a write naming X reports
    // 'supersede' against the *neighbour* Y the similarity search found, so Y is retired and X
    // is left active -- the caller's instruction landing on someone else's record. Every
    // existing case names an id whose title the duplicate search would have matched anyway,
    // which is the one shape where the two cannot be told apart.
    //
    // Written on unmutated code this failed first for a different reason, and that is worth
    // recording: when the detected duplicate IS a same-subject match, it outranks the explicit
    // id today, so `supersedes: X` retires the duplicate and leaves X active. Not changed here
    // -- this test pins the unrelated-neighbour case, where the explicit id does win.
    const named = await storeKnowledgeItemDeduped(projectId, {
      category: 'architecture', title: 'Ingest runs on a cron',
      content: 'The nightly cron entry triggers the ingest job at 02:00.',
    });
    const neighbour = await storeKnowledgeItemDeduped(projectId, {
      category: 'architecture', title: 'Search index build cadence',
      content: 'The search index is rebuilt after every import run and takes four minutes.',
    });
    const replacement = await storeKnowledgeItemDeduped(projectId, {
      category: 'architecture', title: 'Importer timing note',
      content: 'The search index is rebuilt after every import run and takes nine minutes.',
      supersedes: named.item.id,
    });

    // Unrelated titles, so this is a coexisting neighbour and not a correction of it.
    expect(replacement.nearDuplicate?.id).toBe(neighbour.item.id);
    expect((await repo.getKnowledgeItem(neighbour.item.id))!.status).toBe('active');
    // ...and the named item is the one that was retired.
    expect(replacement.superseded?.id).toBe(named.item.id);
    expect((await repo.getKnowledgeItem(named.item.id))!.status).toBe('superseded');
  });

  it('a one-word title is too coarse to make two items the same subject', async () => {
    // `if (smaller.size < 2) return false` -> disabled, survived. The rule is stated in the
    // comment above sameSubjectTitle -- "A one-token title ('Auth') is too coarse to carry this
    // and is excluded" -- and nothing tested it. Without it, the single token of a bare title is
    // trivially contained in any richer title that mentions it, so a note called "Auth" retires
    // the specific note it was filed beside.
    const specific = await storeKnowledgeItemDeduped(projectId, {
      category: 'fact', title: 'Auth token rotation', content: 'Auth tokens rotate every twelve hours in production.',
    });
    const bare = await storeKnowledgeItemDeduped(projectId, {
      category: 'fact', title: 'Auth', content: 'Auth tokens rotate every twelve hours in production, per environment.',
    });

    expect(bare.action).toBe('inserted');
    expect(bare.superseded).toBeUndefined();
    expect((await repo.getKnowledgeItem(specific.item.id))!.status).toBe('active');
  });

  it('a write that newly declares an exclusive conflict key is not "already held"', async () => {
    // `incoming.conflictExclusive !== true || held.conflictExclusive === true` -> `true`
    // survived. Exclusivity is enforced inside createKnowledgeItem, so an incoming atom that is
    // dropped as a verbatim no-op is an atom whose exclusivity was never registered -- the guard
    // silently not applied, which is how it was already found to be off for the batch path.
    // The key is held constant on both writes on purpose. Vary it too and `conflictKey` decides
    // the no-op on its own, the exclusivity clause is never reached, and the mutant lives
    // through a test that looks like it covers this -- which is what the first draft did.
    const base = {
      category: 'decision' as const,
      title: 'Cache eviction policy',
      content: 'The product cache evicts least-recently-used entries.',
      conflictKey: 'cache.eviction.policy',
    };
    await storeKnowledgeItemDeduped(projectId, base);

    const exclusive = await storeKnowledgeItemDeduped(projectId, { ...base, conflictExclusive: true });
    expect(exclusive.action).toBe('inserted');
    expect((await repo.getKnowledgeItem(exclusive.item.id))!.conflictExclusive).toBe(true);
  });

  it('compares a skill by its steps, and treats a reflowed restatement as the same text', async () => {
    // Three survivors meet here:
    //
    //   the whole steps clause of `carriesNothingNew`            -> `true`
    //   `duplicate.category === 'skill' ? getSkillSteps(...)`    -> `!==`
    //   `normalizedIdentity`'s `.replace(/\s+/g, ' ').trim()`    -> removed
    //
    // The first drops a genuine revision of a procedure. The second never fetches a skill's held
    // steps, so `held.steps` is always empty and an unchanged skill churns a new version on
    // every re-store. The third makes "already held verbatim" byte-exact, so a restatement that
    // differs only in whitespace supersedes rather than deduping. All three are the same
    // question -- what counts as the same skill -- asked from different sides.
    const steps = ['Read the ledger', 'Run the gauntlet', 'Deploy'];
    const skill = {
      category: 'skill' as const,
      title: 'Release checklist',
      content: 'File-backed learned skill package.\nPurpose: ship a release safely.',
    };
    const first = await storeKnowledgeItemDeduped(projectId, { ...skill, steps });

    // Same steps, and content that differs only in how it is wrapped: nothing new.
    const reflowed = await storeKnowledgeItemDeduped(projectId, {
      ...skill, content: '  File-backed learned skill package.\n  Purpose: ship a release safely.  ', steps,
    });
    expect(reflowed.action).toBe('duplicate');
    expect(reflowed.item.id).toBe(first.item.id);

    // A changed procedure is a different skill, however identical the prose around it.
    const revised = await storeKnowledgeItemDeduped(projectId, {
      ...skill, steps: ['Read the ledger', 'Run the gauntlet', 'Tag', 'Deploy'],
    });
    expect(revised.action).toBe('inserted');
    expect((await repo.getSkillSteps(revised.item.id)).map(step => step.instruction))
      .toEqual(['Read the ledger', 'Run the gauntlet', 'Tag', 'Deploy']);
  });

  it('an explicit supersedes id works in the batch path too', async () => {
    const original = await storeKnowledgeItemDeduped(projectId, {
      category: 'architecture', title: 'Transport layer', content: 'Clients talk to the server over REST.',
    });
    const result = await storeKnowledgeAtomsDeduped(projectId, [{
      category: 'architecture', title: 'Clients now speak gRPC to the server', content: 'Clients talk to the server over gRPC with protobuf schemas.',
      supersedes: original.item.id,
    }], 'Transport migration');

    expect(result.insertedCount).toBe(1);
    expect(result.supersededIds).toEqual([original.item.id]);
    expect((await repo.getKnowledgeItem(original.item.id))!.status).toBe('superseded');
  });
});
