import js from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  { ignores: ['dist/**', 'node_modules/**', '.benchmark-dist/**', 'benchmarks/**/dist/**', '.tmp/**'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    rules: {
      // The base rule does not understand type-only usage or TypeScript's parameter forms and
      // double-reports everything the TS rule already covers. `tseslint.configs.recommended`
      // disables it, but it is named here so an added config block cannot silently reinstate it.
      // TypeScript resolves every identifier already, and it knows `process`, `console`,
      // `performance`, `URL` and `fetch` from the lib and @types/node. ESLint does not: with
      // `js.configs.recommended` alone this rule reported 93 undefined globals in code that
      // compiles cleanly. typescript-eslint's own guidance is to turn it off on TS files.
      'no-undef': 'off',
      'no-unused-vars': 'off',
      // A ratchet, not an endorsement. Introducing the linter surfaced ~50 pre-existing dead
      // bindings across 20 files; the unused IMPORTS were removed in the same commit because
      // deleting an import cannot change behaviour, and the rest -- unused locals, parameters
      // and destructured fields -- each need a judgement call about whether the value was
      // meant to be used. Bundling that refactor into the commit that adds the linter would
      // make both unreviewable. CI gates on errors, so this stays visible without blocking,
      // and every NEW occurrence shows up in the same output.
      '@typescript-eslint/no-unused-vars': ['warn', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
      // Same reasoning, same backlog: 7 dead stores and 5 rethrows that drop the original
      // error as `cause`. Both are real and neither is mechanical.
      'no-useless-assignment': 'warn',
      'preserve-caught-error': 'warn',
      // The codebase uses `any` deliberately at storage and import boundaries where the shape is
      // genuinely unknown until validated. Flagging every one trains the reader to ignore the
      // linter, which costs more than the rule earns.
      '@typescript-eslint/no-explicit-any': 'off',
      'no-console': 'off',
      // A swallowed error is a decision here, not an omission -- diagnostics and best-effort
      // cleanup paths say so in a comment above the empty block.
      'no-empty': ['error', { allowEmptyCatch: true }],
    },
  },
  {
    // Scripts and tests run under node and reach for globals the source never does.
    files: ['scripts/**/*.{mjs,ts}', 'tests/**/*.ts', '*.config.{ts,mjs}'],
    rules: {
      '@typescript-eslint/no-unused-expressions': 'off',
    },
  },
);
