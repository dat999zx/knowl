export type MismatchProfile = {
  provider: string;
  model: string;
  dtype: string;
  pooling: string;
  recipeVersion: number;
};

export type ProfileMismatch = {
  workspace: MismatchProfile;
  repo: MismatchProfile;
  differing: string[];
  itemCount: number;
};

const describe = (profile: MismatchProfile): string =>
  `${profile.model} (${profile.dtype}, ${profile.pooling}, recipe ${profile.recipeVersion})`;

/**
 * Why a connection or a push was refused, and what the reader can actually do about it.
 *
 * The previous message gave one remedy for every mismatch -- "switch this repository to that model
 * and re-embed its N item(s)" -- which is unfollowable in the two cases that actually occur.
 *
 * **When only `recipeVersion` differs there is no model to switch to.** Both sides print an
 * identical model string, so the instruction reads as nonsense, and `EMBED_RECIPE_VERSION` is a
 * compiled constant: no amount of local configuration can change what this client sends. A recipe
 * difference is version skew between the client and the workspace, and saying so is the only
 * honest remedy.
 *
 * **When `itemCount` is 0 the instruction is vacuous.** "Re-embed its 0 item(s)" tells the reader
 * nothing except that the tool has lost track of what it is describing.
 */
export function formatProfileMismatch(mismatch: ProfileMismatch): string {
  const onlyRecipe = mismatch.differing.length === 1 && mismatch.differing[0] === 'recipeVersion';

  const lines = [
    `This workspace embeds with ${describe(mismatch.workspace)}.`,
    `This repository builds     ${describe(mismatch.repo)}.`,
    '',
    `Differing: ${mismatch.differing.join(', ')}.`,
    '',
    'Vectors are shared with the team, so they have to be built the same way.',
    '',
  ];

  if (onlyRecipe) {
    // Named as skew rather than as a setting, because it is not one. The recipe is how the text
    // that goes INTO the model is assembled, so an identical model on both sides can still
    // produce different vectors -- which is exactly why the field exists.
    lines.push(
      'The model is the same on both sides; only the recipe differs — the way the text fed to',
      'the model is assembled. That is a compiled constant, not a setting, so there is nothing',
      'to change in this repository.',
      '',
      ...(mismatch.workspace.recipeVersion < mismatch.repo.recipeVersion
        ? [
          'This workspace was created before the recipe was recorded. A workspace owner has to',
          'adopt the current one; until then this client cannot publish to it.',
        ]
        : ['This client is older than the workspace. Upgrade Knowl and try again.']),
    );
    return lines.join('\n');
  }

  lines.push(
    `Switch this repository to ${mismatch.workspace.model} (${mismatch.workspace.dtype}, `
    + `${mismatch.workspace.pooling}), then connect again:`,
    '',
    '  knowl config set-model <model>',
    '  knowl reindex --vectors --force',
  );

  // The count is a cost, so it is only worth stating when there is one. Zero means the switch is
  // free, which is useful to know and is not what "re-embed 0 items" conveys.
  lines.push(
    '',
    mismatch.itemCount === 0
      ? 'Nothing is embedded here yet, so the switch costs no re-indexing.'
      : `That re-embeds ${mismatch.itemCount} item(s).`,
  );

  return lines.join('\n');
}
