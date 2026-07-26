import fs from 'node:fs/promises';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import * as namespaces from '../../src/store/namespaces.js';
import { closeDb } from '../../src/store/database.js';
import { createKnowledgeItem } from '../../src/store/repository.js';

const ROOT = path.resolve('.knowl-namespaces-test');

describe('namespaces', () => {
  afterAll(async () => { await closeDb(); await fs.rm(ROOT, { recursive: true, force: true }).catch(() => {}); });

  it('keeps session/project stores separate with project precedence', () => {
    expect(namespaces.projectNamespace('x').databasePath).not.toBe(namespaces.sessionNamespace('x').databasePath);
    expect(namespaces.namespacePrecedence([{ namespace: 'global' }, { namespace: 'project' }, { namespace: 'session' }]).map(item => item.namespace)).toEqual(['session', 'project', 'global']);
  });

  it('uses isolated physical stores and returns namespace-labelled layered reads', async () => {
    await fs.mkdir(path.join(ROOT, '.knowl'), { recursive: true });
    const descriptors = namespaces.defaultNamespaces(ROOT);
    const project = descriptors.find(item => item.namespace === 'project')!;
    const session = descriptors.find(item => item.namespace === 'session')!;
    await namespaces.withNamespaceDatabase(project, () => createKnowledgeItem('local', { category: 'fact', title: 'Project auth', content: 'Project uses JWT.', tags: ['auth'] }));
    await namespaces.withNamespaceDatabase(session, () => createKnowledgeItem('local', { category: 'state', title: 'Session auth', content: 'Current auth migration.', tags: ['auth'] }));

    await expect(fs.access(project.databasePath)).resolves.toBeUndefined();
    await expect(fs.access(session.databasePath)).resolves.toBeUndefined();
    expect((await namespaces.queryLayeredKnowledge(ROOT, 'auth', descriptors)).map(item => [item.namespace, item.title])).toEqual([
      ['session', 'Session auth'], ['project', 'Project auth'],
    ]);
  });

  // Parity means the layered path behaves like the direct path, which is not the same as
  // "every filter is a hard filter". queryKnowledgeForAgent deliberately passes category as
  // undefined and applies it only as a ranking boost, because agents guess categories badly.
  // status and tags are genuine filters. The layered path forwarded none of the three.
  it('honours status and tag filters, which the direct path treats as hard filters', async () => {
    const root = path.resolve('.knowl-namespace-parity-test');
    await fs.rm(root, { recursive: true, force: true });
    await fs.mkdir(path.join(root, '.knowl'), { recursive: true });
    const descriptors = namespaces.defaultNamespaces(root);
    const project = descriptors.find(item => item.namespace === 'project')!;

    await namespaces.withNamespaceDatabase(project, () => createKnowledgeItem('local', {
      category: 'decision', title: 'Ranking uses reciprocal rank fusion',
      content: 'Fuse candidate lists by reciprocal rank rather than raw score.', tags: ['ranking'],
    }));
    await namespaces.withNamespaceDatabase(project, () => createKnowledgeItem('local', {
      category: 'fact', title: 'Ranking benchmark fixture count',
      content: 'The ranking benchmark fixture holds forty two labelled queries.', tags: ['retired'],
    }));

    const unfiltered = await namespaces.queryLayeredKnowledge(root, 'ranking', descriptors, 5, 'test');
    expect(unfiltered.length).toBe(2);

    const tagged = await namespaces.queryLayeredKnowledge(root, 'ranking', descriptors, 5, 'test', { tags: ['ranking'] });
    expect(tagged.length).toBe(1);
    expect(tagged[0].title).toBe('Ranking uses reciprocal rank fusion');

    const archived = await namespaces.queryLayeredKnowledge(root, 'ranking', descriptors, 5, 'test', { status: 'archived' });
    expect(archived.length).toBe(0);

    await closeDb();
    await fs.rm(root, { recursive: true, force: true }).catch(() => {});
  });

  it('applies category as a ranking boost, matching the direct path rather than filtering', async () => {
    const root = path.resolve('.knowl-namespace-boost-test');
    await fs.rm(root, { recursive: true, force: true });
    await fs.mkdir(path.join(root, '.knowl'), { recursive: true });
    const descriptors = namespaces.defaultNamespaces(root);
    const project = descriptors.find(item => item.namespace === 'project')!;

    await namespaces.withNamespaceDatabase(project, () => createKnowledgeItem('local', {
      category: 'fact', title: 'Caching fact', content: 'The cache holds compiled templates.', tags: ['cache'],
    }));
    await namespaces.withNamespaceDatabase(project, () => createKnowledgeItem('local', {
      category: 'decision', title: 'Caching decision', content: 'The cache holds compiled templates for reuse.', tags: ['cache'],
    }));

    // A wrong category guess must not empty the result set -- that is the documented
    // contract for agent retrieval, and the layered path has to honour it too.
    const guessed = await namespaces.queryLayeredKnowledge(root, 'caching', descriptors, 5, 'test', { category: 'skill' });
    expect(guessed.length).toBe(2);

    const boosted = await namespaces.queryLayeredKnowledge(root, 'caching', descriptors, 5, 'test', { category: 'decision' });
    expect(boosted[0].category).toBe('decision');

    await closeDb();
    await fs.rm(root, { recursive: true, force: true }).catch(() => {});
  });

  it('adds only configured organization/global paths outside the project', () => {
    const configured = (namespaces as any).configuredNamespaces;
    expect(configured).toBeTypeOf('function');
    const entries = configured(ROOT, {
      memory: {
        organization: { enabled: true, path: path.resolve(ROOT, '..', 'org.db') },
        global: { enabled: true, path: path.resolve(ROOT, '..', 'global.db') },
      },
    });
    expect(entries.map((entry: any) => entry.namespace)).toEqual(['session', 'project', 'organization', 'global']);
  });
});
