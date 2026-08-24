import { describe, expect, it } from 'vitest';
import { classifyDestructiveCommand, detectCorrectionSignal } from '../../src/core/lesson-signals.js';

/**
 * The probe tables are the point of this suite: every row below is either a command shape that
 * actually destroyed something on a real machine, or a false positive that actually fired
 * during live testing of the prototype gate. Precision cases outnumber recall cases because a
 * gate that cries wolf is a gate that gets switched off.
 */

describe('classifyDestructiveCommand', () => {
  const firing: Array<[string, string, string]> = [
    ['the real incident', 'Get-Process node | Where-Object { $_.StartTime -gt (Get-Date).AddMinutes(-10) } | Stop-Process -Force', 'process-kill-broad'],
    ['taskkill by image', 'taskkill /IM node.exe /F', 'process-kill-broad'],
    ['taskkill by filter -- the same broad name-match without /IM', 'taskkill /F /FI "IMAGENAME eq node.exe"', 'process-kill-broad'],
    ['pkill', 'pkill -f "node server.js"', 'process-kill-broad'],
    ['pm2 delete', 'pm2 delete api-server', 'process-kill-broad'],
    ['git reset --hard', 'git reset --hard origin/main', 'git-discard'],
    ['git clean', 'git clean -fdx', 'git-discard'],
    ['git checkout -- .', 'git checkout -- .', 'git-discard'],
    ['git worktree remove --force', 'git worktree remove --force ../some-worktree', 'git-discard'],
    ['force push', 'git push --force origin staging', 'git-rewrite-remote'],
    ['branch -D', 'git branch -D feature/old', 'git-rewrite-remote'],
    ['rm -rf on source', 'rm -rf server/src/journey', 'recursive-delete'],
    ['rm -r -f split flags', 'rm -r -f server/src/journey', 'recursive-delete'],
    ['Remove-Item recurse force', 'Remove-Item -Recurse -Force C:\\Code\\app\\content', 'recursive-delete'],
    ['docker rm -f subshell', 'docker rm -f $(docker ps -aq)', 'container-destroy'],
    ['docker system prune', 'docker system prune -a', 'container-destroy'],
    ['DROP TABLE', 'psql -c "DROP TABLE question_variants"', 'db-destructive'],
    ['DELETE without WHERE', 'psql -c "DELETE FROM users"', 'db-destructive'],
    ['UPDATE without WHERE', 'psql -c "UPDATE families SET status = \'draft\'"', 'db-destructive'],
    // Chained after a read: the whole-string read-only exemption was the prototype's worst
    // defect -- an agent chains a read then a mutation constantly.
    ['read then delete', 'ls && rm -rf server/src/journey', 'recursive-delete'],
    ['status then reset', 'git status --short && git reset --hard origin/main', 'git-discard'],
    ['echo then pkill', 'echo starting; pkill -f node', 'process-kill-broad'],
    ['cat then drop', 'cat notes.txt && psql -c "DROP TABLE users"', 'db-destructive'],
    ['cd then delete', 'cd /c/Code/app && rm -rf server/src/journey', 'recursive-delete'],
    ['pipeline position', 'Get-Process chrome | Stop-Process', 'process-kill-broad'],
    ['own line', 'cd /c/Code/app\ngit clean -fdx', 'git-discard'],
    ['under sudo and timeout', 'sudo timeout 30 pkill -f node', 'process-kill-broad'],
  ];
  it.each(firing)('fires: %s', (_name, command, expected) => {
    expect(classifyDestructiveCommand(command)?.id).toBe(expected);
  });

  const silent: Array<[string, string]> = [
    ['kill by pipeline of PIDs', '$p = (Get-NetTCPConnection -LocalPort 5000 -State Listen).OwningProcess; $p | ForEach-Object { Stop-Process -Id $_ -Force }'],
    ['taskkill by PID', 'taskkill /PID 12345 /F'],
    ['rm -rf node_modules', 'rm -rf node_modules'],
    ['rm -rf dist', 'rm -rf client/dist'],
    ['rm -rf a temp path', 'rm -rf /c/Users/Admin/AppData/Local/Temp/claude/scratchpad/x'],
    ['rm -rf a .tmp dir', 'rm -rf /c/Code/app/.tmp-build-123'],
    ['DELETE with WHERE', 'psql -c "DELETE FROM users WHERE id = 3"'],
    ['UPDATE with WHERE', 'psql -c "UPDATE families SET status = \'active\' WHERE id = 7"'],
    ['migration file without inline SQL', 'psql -f server/migrations/007_drop_legacy.sql'],
    ['force-with-lease', 'git push --force-with-lease origin staging'],
    ['branch -d lowercase (safe delete)', 'git branch -d feature/merged'],
    ['git clean dry-run', 'git clean -fdn'],
    ['git clean --dry-run', 'git clean -fd --dry-run'],
    ['git checkout a branch', 'git checkout staging'],
    ['git checkout one file', 'git checkout -- server/src/config.ts'],
    ['ordinary build', 'npm run build'],
    ['grep FOR the pattern', 'grep -rn "Stop-Process" scripts/'],
    ['rg for drop table', 'rg "DROP TABLE" server/migrations'],
    ['cat a file that mentions it', 'cat scripts/kill-port.ps1'],
    // Mentions, not commands -- each of these fired somewhere before quoting was masked.
    ['agent prompt quoting pkill', 'timeout 300 claude -p "Run exactly this one command and report its exit code: pkill -f probe-xyz" --permission-mode bypassPermissions'],
    ['agent prompt quoting DROP TABLE', 'claude -p "explain what DROP TABLE does"'],
    ['commit message naming a migration', 'git commit -m "migration: drop table question_variants"'],
    ['commit message quoting delete from', 'git commit -m "fix: delete from users had no where clause"'],
    ['issue body advising against reset', 'gh issue comment 12 --body "do not run git reset --hard here"'],
    ['pr body with a quoted newline and verb', 'gh pr create --body "steps that were reverted:\ngit reset --hard abc123\nnpm ci"'],
    ['echo of a scary string', 'echo "DELETE FROM users"'],
  ];
  it.each(silent)('stays silent: %s', (_name, command) => {
    expect(classifyDestructiveCommand(command)).toBeNull();
  });

  it('returns null for empty and whitespace input', () => {
    expect(classifyDestructiveCommand('')).toBeNull();
    expect(classifyDestructiveCommand('   \n  ')).toBeNull();
  });
});

describe('detectCorrectionSignal', () => {
  const corrections = [
    "that was some really important information that you should have saved into the memory MCP but you didn't right why is that the case",
    "why didn't you store that?",
    'we already decided this last week',
    'I told you not to kill processes by name',
    'that was careless',
    'you broke my browser session',
    'you keep forgetting to run the migration',
    'for the last time, use the port',
    'never do that again',
    'stop doing that',
  ];
  it.each(corrections.map(p => [p]))('fires: %s', prompt => {
    expect(detectCorrectionSignal(prompt)).toBe(true);
  });

  const benign = [
    'add a migration for the new column',
    'can you check whether the dev server is running?',
    'what did we decide about the pricing model?',
    'run the tests and tell me what fails',
    'the build is broken, please fix it',
    // Each of these fired on the prototype's looser patterns.
    'you should have write access to the staging bucket now, can you check?',
    "didn't you already push that branch? just checking",
    'you keep running the tests in watch mode, that is fine',
    'add a test case for the string "I told you not to do that"',
    'Here is the issue text from GitHub: "we already decided to drop node 18 support"',
    'Read this review brief: the user said "why didn\'t you store that" and the agent apologised.',
    // A correction buried past the scan window is an aside, not the task.
    `${'the actual task description goes here and keeps going. '.repeat(8)}also why didn't you store that`,
  ];
  it.each(benign.map(p => [p]))('stays silent: %s', prompt => {
    expect(detectCorrectionSignal(prompt)).toBe(false);
  });

  it('returns false for empty input', () => {
    expect(detectCorrectionSignal('')).toBe(false);
  });
});
