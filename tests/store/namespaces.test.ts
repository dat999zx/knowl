import { describe, expect, it } from 'vitest';
import { namespacePrecedence, projectNamespace, sessionNamespace } from '../../src/store/namespaces.js';
describe('namespaces', () => { it('keeps session/project stores separate with project precedence', () => { expect(projectNamespace('x').databasePath).not.toBe(sessionNamespace('x').databasePath); expect(namespacePrecedence([{ namespace: 'global' }, { namespace: 'project' }, { namespace: 'session' }]).map(item => item.namespace)).toEqual(['session', 'project', 'global']); }); });
