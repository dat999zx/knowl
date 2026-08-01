import { describe, expect, it } from 'vitest';
import { qualifiesForSkillCapture, renderSkillCaptureNudge, SKILL_CAPTURE_MIN_REPEATS } from '../../src/store/skill-capture.js';

describe('qualifiesForSkillCapture', () => {
  it('rejects a bare command however often it repeats', () => {
    // The capture experiment fired on `npm test` twice in one session. Running the
    // suite is not a workflow worth remembering.
    expect(qualifiesForSkillCapture('npm test', 9)).toBe(false);
  });

  it('accepts a repeated command carrying a filter', () => {
    expect(qualifiesForSkillCapture('npm run typecheck:bench 2>&1 | grep "benchmarks/unassisted-capture"', 3)).toBe(true);
  });

  it('rejects a non-obvious command that has not repeated enough', () => {
    expect(qualifiesForSkillCapture('npm test 2>&1 | tail -20', SKILL_CAPTURE_MIN_REPEATS - 1)).toBe(false);
  });

  it('accepts a redirect as non-obvious', () => {
    expect(qualifiesForSkillCapture('node build.js > out.log', 3)).toBe(true);
  });

  it('does not treat a .cmd suffix as encoded knowledge', () => {
    // This project runs on Windows, where `npm.cmd test` is plain `npm test` with the
    // shell's own suffix attached. Calling it a "platform-specific binary" made the very
    // command the bare-command rule excludes qualify anyway.
    expect(qualifiesForSkillCapture('npm.cmd test', 3)).toBe(false);
    expect(qualifiesForSkillCapture('npx.cmd vitest run', 3)).toBe(false);
  });

  it('fires on the run that reaches the threshold and not on later ones', () => {
    // The nudge asks the agent to save the command once. Re-asking on runs 4, 5 and 20
    // is noise whether or not it complied.
    const command = 'npm test | tail -20';

    expect(qualifiesForSkillCapture(command, SKILL_CAPTURE_MIN_REPEATS)).toBe(true);
    expect(qualifiesForSkillCapture(command, SKILL_CAPTURE_MIN_REPEATS + 1)).toBe(false);
    expect(qualifiesForSkillCapture(command, SKILL_CAPTURE_MIN_REPEATS + 17)).toBe(false);
  });

  it('rejects an empty or trivially short command', () => {
    expect(qualifiesForSkillCapture('', 9)).toBe(false);
    expect(qualifiesForSkillCapture('ls', 9)).toBe(false);
  });

  it('does not treat a bare hyphen flag as non-obvious', () => {
    // Flags alone are ordinary. Only pipes, redirects, filters and platform
    // binaries indicate encoded knowledge.
    expect(qualifiesForSkillCapture('npm run build --silent', 9)).toBe(false);
  });
});

describe('renderSkillCaptureNudge', () => {
  it('names the command, the count, and the tool to call', () => {
    const nudge = renderSkillCaptureNudge('npm test 2>&1 | tail -20', 3);

    expect(nudge).toContain('npm test 2>&1 | tail -20');
    expect(nudge).toContain('3');
    expect(nudge).toContain('knowl_skill_create');
  });

  it('asks for the purpose, which is the thing only the agent knows', () => {
    expect(renderSkillCaptureNudge('cmd | grep x', 3)).toMatch(/what it is for|purpose/i);
  });

  it('never tells the agent to run the command', () => {
    // A captured command is an unvetted shell string; the nudge must suggest saving,
    // never executing.
    const nudge = renderSkillCaptureNudge('rm -rf build | tee log', 5);

    // Assert the nudge is really there first: against an empty string the negative
    // assertion below would pass while proving nothing.
    expect(nudge).toContain('knowl_skill_create');
    expect(nudge).not.toMatch(/\brun it\b|\bexecute\b/i);
  });

  it('says "this turn", because that is the window the count covers', () => {
    // Stop closes the turn-scoped memory session binding, so repeats reset at every turn
    // boundary. "this session" overstated the evidence behind the number.
    const nudge = renderSkillCaptureNudge('npm test | tail -20', 3);

    expect(nudge).toContain('3 times this turn');
    expect(nudge).not.toContain('this session');
  });

  it('truncates a very long command rather than flooding the slot', () => {
    const nudge = renderSkillCaptureNudge(`echo ${'x'.repeat(500)} | cat`, 3);

    expect(nudge.length).toBeLessThan(400);
  });
});
