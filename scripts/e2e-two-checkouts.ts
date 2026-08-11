/**
 * Two checkouts, two machines, one workspace — the actual user story.
 *
 * `e2e-cloud.ts` proved the pipe: one repo could log in, publish, sync and federate. It could
 * not prove the thing the feature exists for, because it published and read from the same
 * checkout, so the atom it published deduped against its own local copy and never had to travel.
 *
 * Here repo B has no local copy of anything repo A wrote, and a separate `KNOWL_HOME`, so it is
 * a different machine in every way that matters. If A's atom appears in B's query it can only
 * have arrived through the server.
 *
 * The final query runs the BUILT CLI rather than calling `queryFederated`, so the command a
 * person actually types is what gets exercised.
 *
 * Prerequisites: knowl-cloud running on :3000 with NODE_ENV=development, and `npm run build` here.
 * Usage: npx tsx scripts/e2e-two-checkouts.ts
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { createCloudApi } from '../src/cloud/api-client.js';
import { runLogin } from '../src/cloud/login.js';
import { runConnect } from '../src/cloud/connect.js';
import { stagePublish, pushStaged } from '../src/cloud/publish.js';
import { runPull } from '../src/cloud/pull.js';
import { readCredential } from '../src/cloud/credentials.js';
import { closeDb, getClient, initDb } from '../src/store/database.js';
import { storeKnowledgeItemDeduped } from '../src/store/knowledge-writer.js';
import * as repo from '../src/store/repository.js';
import { loadConfig } from '../src/core/config.js';

const API = 'http://localhost:3000';
const OWNER_USER_ID = '00000000-0000-0000-0000-0000000000e1';

const container = execFileSync('docker', ['ps', '--filter', 'publish=54329', '--format', '{{.Names}}'])
  .toString().trim();

function psql(sql: string): string {
  const result = spawnSync('docker', [
    'exec', '-e', 'PGPASSWORD=postgres', container,
    'psql', '-U', 'postgres', '-d', 'knowl_cloud', '-t', '-A', '-c', sql,
  ], { encoding: 'utf8' });
  if (result.status !== 0) throw new Error(`psql failed: ${result.stderr}`);
  return result.stdout.trim();
}

// Identity carried on each invocation rather than written with `git config`. These fixtures sit
// inside this repository, and `git config` searches upward when the fixture has no `.git` yet --
// so a run interrupted at the wrong moment leaves a bogus `user.email` in knowl's own config, and
// the next commit made here goes out authored by it. See `tests/git-identity.ts`.
const IDENTITY = ['-c', 'user.name=Knowl-E2E', '-c', 'user.email=e2e@example.test'];
const git = (cwd: string, args: string[]) => spawnSync('git', [...IDENTITY, ...args], { cwd, encoding: 'utf8' });
const step = (n: string, what: string) => console.log(`\n── ${n}. ${what}`);

/** A clone with a real `origin/HEAD`, which is what the publish gate reads. */
async function makeCheckout(origin: string, clone: string, remoteUrl: string): Promise<void> {
  for (const dir of [origin, clone]) await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
  await fs.mkdir(origin, { recursive: true });
  git(origin, ['init', '-q', '-b', 'main']);
  await fs.writeFile(path.join(origin, 'a.txt'), 'one', 'utf8');
  git(origin, ['add', '.']);
  git(origin, ['commit', '-qm', 'one']);
  spawnSync('git', ['clone', '-q', origin, clone], { encoding: 'utf8' });
  git(clone, ['remote', 'set-url', 'origin', remoteUrl]);
  await fs.mkdir(path.join(clone, '.knowl'), { recursive: true });
  await fs.writeFile(path.join(clone, '.knowl', 'config.json'), JSON.stringify({ version: 1 }), 'utf8');
}

/** Sign in on one "machine". Approval is written as the browser would, not called. */
async function loginAs(home: string): Promise<string> {
  process.env.KNOWL_HOME = home;
  const api = createCloudApi({ apiHost: API });
  const result = await runLogin({
    apiHost: API,
    api,
    onPrompt: () => {
      psql(`update device_authorizations set approved_user_id = '${OWNER_USER_ID}', approved_at = now()
            where id = (select id from device_authorizations where approved_at is null
                        order by created_at desc limit 1)`);
    },
  });
  if (result.status !== 'authorized') throw new Error(`login ${result.status}`);
  const credential = await readCredential(API);
  return credential!.accessToken;
}

async function main(): Promise<void> {
  const ORIGIN_A = path.resolve('./.knowl-e2e2-origin-a');
  const REPO_A = path.resolve('./.knowl-e2e2-repo-a');
  const ORIGIN_B = path.resolve('./.knowl-e2e2-origin-b');
  const REPO_B = path.resolve('./.knowl-e2e2-repo-b');
  const HOME_A = path.resolve('./.knowl-e2e2-home-a');
  const HOME_B = path.resolve('./.knowl-e2e2-home-b');
  for (const dir of [HOME_A, HOME_B]) await fs.rm(dir, { recursive: true, force: true }).catch(() => {});

  step('1', 'two separate repos, each a real clone');
  await makeCheckout(ORIGIN_A, REPO_A, 'git@github.com:acme/service-a.git');
  await makeCheckout(ORIGIN_B, REPO_B, 'git@github.com:acme/service-b.git');
  console.log('   service-a and service-b ready');

  step('2', 'machine A signs in and creates a workspace');
  const tokenA = await loginAs(HOME_A);
  const created = await fetch(`${API}/v1/workspaces`, {
    method: 'POST',
    headers: { authorization: `Bearer ${tokenA}`, 'content-type': 'application/json' },
    body: JSON.stringify({ name: 'Two Checkouts', orgName: 'Acme E2E' }),
  });
  if (!created.ok) throw new Error(`create workspace ${created.status}: ${await created.text()}`);
  // `workspaceId`, not `id` -- `CreateWorkspaceResponse` names both ids it returns, since it can
  // create an org alongside. Reading `id` gave `undefined`, which then reached `runConnect` as an
  // absent workspace and came back as `ambiguous` -- a refusal about the wrong thing entirely.
  const { workspaceId, orgId } = await created.json() as { workspaceId: string; orgId: string };
  if (!workspaceId) throw new Error('create workspace returned no workspaceId');
  console.log(`   created workspace ${workspaceId} in org ${orgId}`);

  step('3', 'machine A connects, writes an atom, and publishes it');
  process.env.KNOWL_HOME = HOME_A;
  const apiA = createCloudApi({ apiHost: API });
  const connectedA = await runConnect({ projectRoot: REPO_A, apiHost: API, workspaceId, api: apiA });
  if (connectedA.status !== 'connected') throw new Error(`connect A ${connectedA.status}`);
  console.log(`   ${connectedA.pointer.repo} as ${connectedA.role}`);

  await initDb(REPO_A);
  const projectA = (await repo.createProject(REPO_A, 'a')).id;
  const atom = await storeKnowledgeItemDeduped(projectA, {
    category: 'decision',
    title: 'Rollbacks target the previous tag',
    content: 'A failed deploy rolls back to the previous tag, never to a branch head.',
  });
  await getClient().execute(
    `update knowledge_items set origin_repo = '${connectedA.pointer.repo}' where id = '${atom.item.id}'`,
  );
  await closeDb();

  await stagePublish({ projectRoot: REPO_A, config: await loadConfig(REPO_A), ids: [atom.item.id], apply: true });
  const pushed = await pushStaged({ projectRoot: REPO_A, config: await loadConfig(REPO_A), api: apiA });
  if (pushed.status !== 'pushed' || pushed.created + pushed.updated === 0) {
    throw new Error(`push failed: ${JSON.stringify(pushed)}`);
  }
  console.log(`   published: created ${pushed.created}`);

  step('4', 'machine B — a different repo, a different KNOWL_HOME — signs in and connects');
  await loginAs(HOME_B);
  const apiB = createCloudApi({ apiHost: API });
  const connectedB = await runConnect({ projectRoot: REPO_B, apiHost: API, workspaceId, api: apiB });
  if (connectedB.status !== 'connected') throw new Error(`connect B ${connectedB.status}`);
  console.log(`   ${connectedB.pointer.repo} as ${connectedB.role}`);

  step('5', 'machine B pulls');
  const pulled = await runPull({ projectRoot: REPO_B, config: await loadConfig(REPO_B), api: apiB });
  if (pulled.status !== 'pulled') throw new Error(`pull ${pulled.status}`);
  console.log(`   ${pulled.sync.status}: +${pulled.sync.upserted}, watermark ${pulled.sync.since}`);

  step('6', 'machine B runs the built CLI — the command a person types');
  const cli = spawnSync(process.execPath, [
    path.resolve('dist/index.js'), 'query', 'rollback previous tag',
  ], {
    cwd: REPO_B,
    encoding: 'utf8',
    env: { ...process.env, KNOWL_HOME: HOME_B },
  });
  console.log(cli.stdout.trim() || cli.stderr.trim());

  const payload = cli.stdout.slice(cli.stdout.indexOf('{') >= 0 ? cli.stdout.indexOf('{') : 0);
  const sawAtom = cli.stdout.includes('Rollbacks target the previous tag');
  const sawOwner = cli.stdout.includes('service-a');
  void payload;

  console.log('');
  if (!sawAtom) throw new Error("machine B did not receive machine A's atom");
  if (!sawOwner) throw new Error('the atom arrived but is not attributed to service-a');
  console.log('✓ machine B received an atom it never wrote, attributed to the repo that did');
}

await main().catch(error => {
  console.error(`\n✗ ${error.message}`);
  process.exitCode = 1;
});
