import { describe, expect, it } from 'vitest';
import { shellReadPaths } from '../../src/session/shell-reads.js';

/**
 * The shell-read parser, tested mostly on what it REFUSES.
 *
 * A read-set row asserts "this session saw this text", and the certain tier spends that
 * assertion by interrupting the agent and refusing its write. So a missed read costs recall on
 * a tier allowed to be incomplete, and a fabricated one costs precision on the only tier
 * allowed to interrupt. Every refusal below is therefore a property, not an omission.
 */
describe('shellReadPaths', () => {
  describe('reads it recognises', () => {
    it('takes the paths a content reader names', () => {
      expect(shellReadPaths('cat src/auth.ts')).toEqual(['src/auth.ts']);
      expect(shellReadPaths('head -20 src/a.ts')).toEqual(['src/a.ts']);
      expect(shellReadPaths('tail -n 5 src/b.ts')).toEqual(['src/b.ts']);
    });

    it('reads a printing sed, and drops its script rather than filing it as a path', () => {
      expect(shellReadPaths('sed -n 1,50p src/c.ts')).toEqual(['src/c.ts']);
      expect(shellReadPaths('sed -n 100,130p src/host-lifecycle.ts')).toEqual(['src/host-lifecycle.ts']);
      // Only the FIRST non-option is the script: `sed -n 1p a b` really does read both files.
      expect(shellReadPaths('sed -n 1p src/a.ts src/b.ts')).toEqual(['src/a.ts', 'src/b.ts']);
    });

    it('refuses an in-place sed, which is a write wearing a reader\'s name', () => {
      // The one verb here that reads and writes under the same name. Filing an in-place edit
      // as an observation would leave the write gate and the read set holding opposite
      // beliefs about one event.
      expect(shellReadPaths("sed -i 's/a/b/' src/c.ts")).toEqual([]);
      expect(shellReadPaths("sed -i.bak 's/a/b/' src/c.ts")).toEqual([]);
      expect(shellReadPaths("sed --in-place 's/a/b/' src/c.ts")).toEqual([]);
      // `-n` present and `-i` present is still an in-place edit that suppresses output.
      expect(shellReadPaths("sed -n -i 's/a/b/' src/c.ts")).toEqual([]);
      // A sed that is not printing at all is a filter, not a read of the named file.
      expect(shellReadPaths("sed 's/a/b/' src/c.ts")).toEqual([]);
    });

    it('takes every file a single reader names, in the command\'s own order', () => {
      expect(shellReadPaths('cat src/z.ts src/a.ts')).toEqual(['src/z.ts', 'src/a.ts']);
    });

    it('classifies on the verb\'s last path component', () => {
      expect(shellReadPaths('/usr/bin/cat src/auth.ts')).toEqual(['src/auth.ts']);
    });

    it('reads a quoted path with a space in it', () => {
      expect(shellReadPaths('cat "src/my file.ts"')).toEqual(['src/my file.ts']);
    });

    it('collapses a path named twice', () => {
      expect(shellReadPaths('cat src/a.ts && cat src/a.ts')).toEqual(['src/a.ts']);
    });
  });

  describe('every segment is classified, not just the first', () => {
    it('finds a read after a chain operator', () => {
      // The defect this exists to avoid has a receipt: a sibling hook exempted the whole
      // command string on its first token, so `ls && rm -rf ...` passed its guard unseen.
      expect(shellReadPaths('ls -la && cat src/auth.ts')).toEqual(['src/auth.ts']);
      expect(shellReadPaths('npm test; cat src/auth.ts')).toEqual(['src/auth.ts']);
      expect(shellReadPaths('true || cat src/auth.ts')).toEqual(['src/auth.ts']);
    });

    it('finds reads in several segments at once', () => {
      expect(shellReadPaths('cat src/a.ts && head -3 src/b.ts')).toEqual(['src/a.ts', 'src/b.ts']);
    });
  });

  describe('refusals', () => {
    it('refuses git show, whose text is a ref\'s and not the working tree\'s', () => {
      // The sharpest refusal here. The agent saw the file as of that ref; the hash the caller
      // would record is the working tree's, so the row asserts a belief about text nobody
      // read -- and the very next comparison falsifies it, on the tier held to >=95%.
      expect(shellReadPaths('git show upstream/main:src/auth.ts')).toEqual([]);
      expect(shellReadPaths('git show HEAD:src/auth.ts | head -20')).toEqual([]);
    });

    it('refuses tools that return matches or names rather than contents', () => {
      // Same reasoning that excludes Grep and Glob upstream: the agent never received the
      // file's text, so a row for it claims signatures it never saw.
      expect(shellReadPaths('grep -n foo src/auth.ts')).toEqual([]);
      expect(shellReadPaths('rg pattern src/auth.ts')).toEqual([]);
      expect(shellReadPaths('ls src/auth.ts')).toEqual([]);
      expect(shellReadPaths('find src -name auth.ts')).toEqual([]);
      expect(shellReadPaths('wc -l src/auth.ts')).toEqual([]);
    });

    it('refuses a read the pipe would otherwise launder past a refused verb', () => {
      // `grep x f` is refused two tests up because the agent receives matching lines and not
      // the file. `cat f | grep x` puts the agent in the identical state, so recording it
      // would let the pipe smuggle in an observation written the other way round -- a
      // fabricated read on the one tier allowed to interrupt and refuse a write.
      expect(shellReadPaths('cat src/auth.ts | grep createSession')).toEqual([]);
      expect(shellReadPaths('cat src/auth.ts | wc -l')).toEqual([]);
      expect(shellReadPaths('cat package.json | jq .name')).toEqual([]);
      // Every stage, not only the one next to the pipe.
      expect(shellReadPaths('cat src/a.ts | tail -20 | grep x')).toEqual([]);
    });

    it('keeps a read whose downstream stages do pass the contents through', () => {
      // `cat f | head -20` shows the agent the file's first 20 lines, which is what
      // `head -20 f` shows -- and that is recorded. The rule is about what reaches the agent,
      // not about the presence of a pipe.
      expect(shellReadPaths('cat src/auth.ts | head -20')).toEqual(['src/auth.ts']);
      expect(shellReadPaths('cat src/auth.ts | sed -n 1,5p')).toEqual(['src/auth.ts']);
    });

    it('refuses any segment carrying a redirect, whatever its verb reads', () => {
      expect(shellReadPaths('cat > src/auth.ts')).toEqual([]);
      expect(shellReadPaths('cat >> src/auth.ts')).toEqual([]);
      expect(shellReadPaths('cat src/auth.ts > out.txt')).toEqual([]);
      expect(shellReadPaths("cat <<'EOF'")).toEqual([]);
    });

    it('refuses a token the shell would have expanded', () => {
      // A glob, a variable, a subshell or a brace names a file only after the shell has run,
      // and this parser is not a shell.
      expect(shellReadPaths('cat src/*.ts')).toEqual([]);
      expect(shellReadPaths('cat $FILE')).toEqual([]);
      expect(shellReadPaths('cat "$(ls src)"')).toEqual([]);
      expect(shellReadPaths('cat src/{a,b}.ts')).toEqual([]);
      expect(shellReadPaths('cat ~/notes.md')).toEqual([]);
      expect(shellReadPaths('cat src/a.ts?')).toEqual([]);
    });

    it('drops options rather than reading them as paths', () => {
      expect(shellReadPaths('head -20 src/a.ts')).not.toContain('-20');
      expect(shellReadPaths('tail -n 5 src/a.ts')).toEqual(['src/a.ts']);
      expect(shellReadPaths('cat -- src/a.ts')).toEqual(['src/a.ts']);
    });

    it('says nothing about a verb with no target, or no verb at all', () => {
      expect(shellReadPaths('cat')).toEqual([]);
      expect(shellReadPaths('')).toEqual([]);
      expect(shellReadPaths('   ')).toEqual([]);
    });

    it('refuses a command long enough to be a script rather than a call', () => {
      expect(shellReadPaths(`cat src/a.ts ${'x'.repeat(4_000)}`)).toEqual([]);
    });
  });
});
