/** Reads the synced replica, so "0 remote rows" can be told apart from "nothing was synced". */
import { createClient } from '@libsql/client';
import path from 'node:path';

const workspaceId = process.argv[2] ?? '5d522110-0e93-4a57-9414-6cb089d5b923';
const file = path.resolve('./.knowl-e2e-home/cloud', workspaceId, 'knowledge.db');
const client = createClient({ url: `file:${file}` });

const rows = await client.execute('select id, origin_repo, title, visibility, content_hash from knowledge_items');
console.log(`replica holds ${rows.rows.length} atom(s):`);
for (const row of rows.rows) {
  console.log(`  ${row.origin_repo} | ${row.visibility} | ${row.title}`);
}

const state = await client.execute('select since, role, last_synced_at from cloud_sync_state');
console.log('sync state:', JSON.stringify(state.rows[0]));

const evidence = await client.execute('select count(*) as n from evidence');
console.log('evidence rows:', evidence.rows[0].n);
