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
