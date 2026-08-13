import type { Command } from 'commander';
import { describe, expect, it } from 'vitest';
import { buildProgram } from '../../src/cli/program.js';

/**
 * `help` is filtered out on purpose. Whether Commander materialises an implicit help subcommand
 * inside `.commands` is a version-dependent implementation detail, and pinning it here would
 * make this file fail on a Commander bump that changed nothing about our command tree.
 */
function subcommandNames(path: string[]): string[] {
  let node: Command = buildProgram();
  for (const name of path) node = node.commands.find(command => command.name() === name)!;
  return node.commands.map(command => command.name()).filter(name => name !== 'help').sort();
}

describe('the 5.0 cloud namespace', () => {
  it('holds every cloud verb', () => {
    // `send` and `receive` are the pair `push` and `pull` cannot be: a handful of atoms to one
    // person, once, expiring. They sit here rather than at the top level because they are cloud
    // verbs -- both require an account, and neither works on a repo that never connected.
    expect(subcommandNames(['cloud'])).toEqual([
      'autopush', 'connect', 'login', 'logout', 'pull', 'push',
      'receive', 'retract', 'send', 'stage', 'status', 'unstage', 'workspaces',
    ]);
  });

  /**
   * Help output, not `.commands`.
   *
   * The signposts register `login`, `logout` and `publish` as HIDDEN top-level commands so a
   * removed name can fail with a message that names its replacement. Commander keeps hidden
   * commands in `.commands` — it only omits them from help — so asserting `.commands` does not
   * contain them could never pass. What the user must not see is the help listing.
   */
  it('lists no cloud verb in top-level help', () => {
    const help = buildProgram().helpInformation();
    for (const gone of ['login', 'logout', 'publish']) {
      expect(help).not.toMatch(new RegExp(`^\\s+${gone}\\b`, 'm'));
    }
  });

  it('still recognises the removed names, so they can signpost instead of saying "unknown command"', () => {
    const top = buildProgram().commands.map(command => command.name());
    for (const gone of ['login', 'logout', 'publish']) expect(top).toContain(gone);
  });

  it('has no group left that wraps a single leaf', () => {
    const top = buildProgram().commands.map(command => command.name());
    for (const gone of ['code', 'eval-group']) expect(top).not.toContain(gone);
    for (const flat of ['index-code', 'symbols', 'eval', 'access', 'pr', 'evidence']) {
      expect(top).toContain(flat);
    }
    // `eval`, `access`, `pr` and `evidence` are now leaves rather than groups.
    for (const name of ['eval', 'access', 'pr', 'evidence']) {
      const command = buildProgram().commands.find(entry => entry.name() === name)!;
      expect(command.commands.filter(sub => sub.name() !== 'help')).toEqual([]);
    }
  });

  it('keeps snapshot as a group, because create and restore are a genuine pair', () => {
    expect(subcommandNames(['snapshot'])).toEqual(['create', 'restore']);
  });

  it('gives a human the three writes that were MCP-only', () => {
    const top = buildProgram().commands.map(command => command.name());
    for (const added of ['store', 'park', 'handoff']) expect(top).toContain(added);
  });

  it('keeps the local workspace group untouched', () => {
    expect(subcommandNames(['workspace'])).toEqual([
      'add', 'demand', 'init', 'join', 'list',
      'promote', 'remove', 'repin-embedding', 'set', 'status',
    ]);
  });
});
