import type { ImportResult } from '../store/portability.js';

/**
 * What an import decided about ownership, in the one place the counts cannot say it.
 *
 * `knowl import` prints inserted/updated/identical, and none of those answer "is this mine
 * now?". For an `attributed` file the answer is no, and the consequence is delayed: the items
 * are searchable immediately and unpromotable forever, so the person finds out much later,
 * from a promote that reports nothing. Saying it at import is the only moment the explanation
 * is still attached to the cause.
 *
 * Silent on `trusted`, which is the ordinary two-machines sync path. A notice printed every
 * time teaches people to skip it, and the one case worth reading is the one that changed
 * something.
 */
export function importOwnershipNotice(ownership: ImportResult['ownership']): string[] {
  if (ownership === 'trusted') return [];

  if (ownership === 'claimed') {
    return [
      'Imported with --mine: these items are recorded as this repo\'s own work.',
      'They are private. --mine claims authorship, not publication -- share them, if you mean',
      'to, with `knowl workspace promote`.',
    ];
  }

  return [
    'These items came from another store, and are recorded as imported rather than as this',
    'repo\'s. They are searchable here and cannot be shared from here: `knowl workspace',
    'promote` will refuse them, because publishing another store\'s knowledge under this',
    'repo\'s name is not this repo\'s call.',
    'If this export is in fact your own -- your backup, or a machine you cannot link and',
    're-export from -- re-run the import with --mine to claim it.',
  ];
}
