/**
 * Drives the real client against a real knowl-cloud server, over real HTTP.
 *
 * Not a unit test and not a replacement for one. Every suite on both sides runs against fakes or
 * fixtures; this exists to answer the one question neither can: do the two halves agree? The
 * first run of it found five auth contract mismatches that 293 green tests could not see.
 *
 * Approval is written straight into `device_authorizations` rather than called. That is faithful
 * rather than lazy: the CLI never approves its own device code -- a person does, in a browser --
 * so simulating the browser's effect is exactly the client's real experience of the flow.
 *
 * Prerequisites: `npm run db:up` and `npm start` in knowl-cloud, and NODE_ENV=development.
 * Usage: npx tsx scripts/e2e-cloud.ts
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
import { queryFederated } from '../src/workspace/federated-query.js';
import { resolveWorkspace } from '../src/workspace/resolve.js';
import { closeDb, getClient, initDb } from '../src/store/database.js';
import { storeKnowledgeItemDeduped } from '../src/store/knowledge-writer.js';
import * as repo from '../src/store/repository.js';
import { loadConfig, saveConfig } from '../src/core/config.js';

const API = 'http://localhost:3000';
const OWNER_USER_ID = '00000000-0000-0000-0000-0000000000e1';
const ROOT = path.resolve('./.knowl-e2e-repo');
const HOME = path.resolve('./.knowl-e2e-home');

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

const step = (n: number, what: string) => console.log(`\n── ${n}. ${what}`);

async function main(): Promise<void> {
  process.env.KNOWL_HOME = HOME;
  for (const dir of [ROOT, HOME]) await fs.rm(dir, { recursive: true, force: true }).catch(() => {});

  step(1, 'a scratch clone with a real origin, so the publish gate can see a default branch');
  // Cloned from a local origin rather than `git init` plus `git remote add`. The gate resolves
  // the default branch from `origin/HEAD`, which only a clone or a fetch creates -- and it was
  // right to refuse the hand-made repo that had a remote URL and no remote-tracking ref at all.
  const ORIGIN = path.resolve('./.knowl-e2e-origin');
  await fs.rm(ORIGIN, { recursive: true, force: true }).catch(() => {});
  await fs.mkdir(ORIGIN, { recursive: true });
  const inOrigin = (args: string[]) => spawnSync('git', args, { cwd: ORIGIN, encoding: 'utf8' });
  inOrigin(['init', '-q', '-b', 'main']);
  inOrigin(['config', 'user.email', 'e2e@example.com']);
  inOrigin(['config', 'user.name', 'E2E']);
  await fs.writeFile(path.join(ORIGIN, 'a.txt'), 'one', 'utf8');
  inOrigin(['add', '.']);
  inOrigin(['commit', '-qm', 'one']);
  spawnSync('git', ['clone', '-q', ORIGIN, ROOT], { encoding: 'utf8' });

  const git = (args: string[]) => spawnSync('git', args, { cwd: ROOT, encoding: 'utf8' });
  git(['config', 'user.email', 'e2e@example.com']);
  git(['config', 'user.name', 'E2E']);
  // The refs are what the gate reads; the URL is only what identity is derived from. Rewriting it
  // after cloning gives a realistic `github.com/acme/e2e` without losing `origin/main`.
  git(['remote', 'set-url', 'origin', 'git@github.com:acme/e2e.git']);
  await fs.mkdir(path.join(ROOT, '.knowl'), { recursive: true });
  await fs.writeFile(path.join(ROOT, '.knowl', 'config.json'), JSON.stringify({ version: 1 }), 'utf8');
  console.log('   repo ready');

  const workspaceId = psql('select id from workspaces limit 1');
  console.log(`   workspace ${workspaceId}`);

  step(2, 'knowl login — real device flow, approval written as the browser would');
  const api = createCloudApi({ apiHost: API });
  const login = await runLogin({
    apiHost: API,
    api,
    onPrompt: authorization => {
      console.log(`   server said: code ${authorization.userCode}, expires ${authorization.expiresAt}`);
      // The browser's effect, not the browser's call. Approving the newest pending row is
      // unambiguous here because this script created it moments ago.
      psql(`update device_authorizations set approved_user_id = '${OWNER_USER_ID}', approved_at = now()
            where approved_at is null and consumed_at is null
            and id = (select id from device_authorizations where approved_at is null
                      order by created_at desc limit 1)`);
      console.log('   approved out of band');
    },
  });
  if (login.status !== 'authorized') throw new Error(`login ${login.status}`);
  const stored = await readCredential(API);
  console.log(`   session ${login.sessionId}, token expires ${stored?.expiresAt}`);
  if (!stored?.expiresAt || Number.isNaN(Date.parse(stored.expiresAt))) {
    throw new Error('stored credential has no usable expiry — the refresh storm bug');
  }

  step(3, 'knowl cloud connect');
  const connected = await runConnect({ projectRoot: ROOT, apiHost: API, workspaceId, api });
  if (connected.status !== 'connected') throw new Error(`connect ${connected.status}`);
  console.log(`   ${connected.pointer.repo} → ${connected.pointer.workspaceName} as ${connected.role}`);

  step(4, 'write a local atom and stage it');
  await initDb(ROOT);
  const projectId = (await repo.createProject(ROOT, 'e2e')).id;
  const written = await storeKnowledgeItemDeduped(projectId, {
    category: 'decision',
    title: 'E2E: deploys roll back by tag',
    content: 'A failed deploy rolls back to the previous tag, never to a branch.',
  });
  await getClient().execute(
    `update knowledge_items set origin_repo = '${connected.pointer.repo}' where id = '${written.item.id}'`,
  );
  await closeDb();
  const staged = await stagePublish({
    projectRoot: ROOT, config: await loadConfig(ROOT), ids: [written.item.id], apply: true,
  });
  console.log(`   staged: ${staged.status === 'staged' ? staged.items.length : staged.status}`);

  step(5, 'knowl cloud push — real publish over HTTP');
  const pushed = await pushStaged({ projectRoot: ROOT, config: await loadConfig(ROOT), api });
  if (pushed.status !== 'pushed') throw new Error(`push ${pushed.status}: ${JSON.stringify(pushed)}`);
  console.log(`   created ${pushed.created}, updated ${pushed.updated}, ` +
    `conflicts ${pushed.conflicts.length}, rejected ${pushed.rejected.length}`);
  if (pushed.created + pushed.updated === 0) throw new Error('nothing was published');

  step(6, 'knowl cloud pull — real sync back down');
  const pulled = await runPull({ projectRoot: ROOT, config: await loadConfig(ROOT), api });
  if (pulled.status !== 'pulled') throw new Error(`pull ${pulled.status}`);
  console.log(`   ${pulled.sync.status}: +${pulled.sync.upserted} -${pulled.sync.deleted} ` +
    `over ${pulled.sync.pages} page(s), watermark ${pulled.sync.since}`);

  step(7, 'federated query — does team knowledge come back?');
  const config = await loadConfig(ROOT);
  const workspace = await resolveWorkspace(ROOT, config);
  if (!workspace) throw new Error('workspace did not resolve from the cloud pointer');
  await initDb(ROOT);
  try {
    const result = await queryFederated({ workspace, query: 'deploy rollback tag', limit: 5 });
    for (const group of result.groups) {
      console.log(`   [${group.repo || '(local)'}] ${group.items.length} item(s)` +
        group.items.map(item => `\n       ${item.remote ? 'remote' : 'local '}  ${item.title}`).join(''));
    }
    if (result.skipped.length) console.log(`   skipped: ${JSON.stringify(result.skipped)}`);
    const remote = result.groups.flatMap(g => g.items).filter(item => item.remote);
    console.log(`   ${remote.length} remote row(s) — expected 0: this atom exists locally too, ` +
      'and `byContent` prefers the local copy by design');

    // The query that can only be answered by the replica. Its atom was written by another repo
    // and this machine has no copy, so a hit here is proof the whole path carries knowledge a
    // teammate published -- which is the entire point of the feature.
    step(8, 'a query only the replica can answer');
    const teamOnly = await queryFederated({ workspace, query: 'Atom a', limit: 5 });
    for (const group of teamOnly.groups) {
      for (const item of group.items) {
        console.log(`   [${group.repo}] ${item.remote ? 'remote' : 'local '}  ${item.title}`);
      }
    }
    const fromTeam = teamOnly.groups.flatMap(g => g.items).filter(item => item.remote);
    if (fromTeam.length === 0) throw new Error('no team row reached the page — federation is not reading the replica');
    console.log(`\n   ${fromTeam.length} row(s) came from a repo this machine has never checked out`);
  } finally {
    await closeDb();
  }

  console.log('\n✓ end to end complete');
}

await main().catch(error => {
  console.error(`\n✗ ${error.message}`);
  process.exitCode = 1;
});
