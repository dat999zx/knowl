import path from 'node:path';
import { defineConfig, mergeConfig } from 'vitest/config';

import base from './vitest.config.js';

/**
 * The vitest project a mutation run uses. NOT used by `npm test`.
 *
 * It differs from `vitest.config.ts` in exactly two ways, both of them about what a source
 * mutation can possibly be observed by:
 *
 * **1. The dist-spawning suites are dropped.** Sixteen test files assert against
 * `node dist/index.js`, a tsup bundle built from `src/`. A mutation-testing tool rewrites
 * `src/` and nothing rebuilds `dist/` between mutants, so those files run the *unmutated*
 * program. They cost minutes per mutant and can never kill one. Their exclusion is not a
 * shortcut -- it is the measured reason mutation scores for this repo must be read as covering
 * the in-process surface only.
 *
 * **2. The test set is narrowed to the target's importers.** `KNOWL_MUTATION_TESTS` carries the
 * transitive-importer set computed by `scripts/mutation/select-tests.mjs`. Left unset, the
 * whole (non-dist-spawning) suite runs.
 */
const selected = (process.env.KNOWL_MUTATION_TESTS ?? '')
  .split(',')
  .map((entry) => entry.trim())
  .filter((entry) => entry.length > 0);

export default mergeConfig(
  base,
  defineConfig({
    test: {
      ...(selected.length > 0 ? { include: selected } : {}),
      exclude: [
        '**/node_modules/**',
        '**/dist/**',
        'benchmarks/**',
        // Structurally blind to source mutation: these spawn the prebuilt CLI.
        'tests/cli/agent-lifecycle.test.ts',
        'tests/cli/agent-reminder.test.ts',
        'tests/cli/claude-continuation-reminder.test.ts',
        'tests/cli/claude-subagent-notification.test.ts',
        'tests/cli/cli.test.ts',
        'tests/cli/codex-subagent-notification.test.ts',
        'tests/cli/config-secret-reference.test.ts',
        'tests/cli/import-mine.test.ts',
        'tests/cli/missing-database.test.ts',
        'tests/cli/onboarding-cli.test.ts',
        'tests/cli/session-cli.test.ts',
        'tests/cli/skill-cli.test.ts',
        'tests/cli/temporal-cli.test.ts',
        'tests/cli/upgrade-all.test.ts',
        'tests/cli/workspace-cli.test.ts',
        'tests/store/retention.test.ts',
      ],
      // `tests/global-teardown.ts` sweeps every `.knowl-*` directory in cwd after each vitest
      // run. Under `npm test` that is one run and pure housekeeping. Under mutation testing
      // there are several vitest runs alive at once in the SAME working directory, and each
      // one's teardown deletes the others' live fixtures -- including the shared
      // `.knowl-test-home`. Measured: it is what makes runner processes die and restart
      // (~40s each), not the mutants. Housekeeping is not a correctness gate; a mutation run
      // leaves its scratch behind and the next `npm test` collects it.
      globalSetup: [],
      // One vitest worker per Stryker runner, but ONLY under Stryker. Stryker already runs
      // several runners at once, so vitest's own 4-way fan-out multiplies into ~12 processes
      // fighting for the same fixed-name libSQL fixtures -- measured, that is what segfaults
      // the native addon. `probe.mjs` runs one mutant in one fresh process and wants the
      // normal fan-out back: serialised, a whole-suite confirmation costs ~8 minutes instead
      // of ~110 seconds, which is the difference between a shortlist that can be confirmed and
      // one that cannot.
      ...(process.env.KNOWL_MUTATION_SERIAL === '1'
        ? { maxWorkers: 1, minWorkers: 1, fileParallelism: false }
        : {}),
      // A mutant that hangs is a survivor we still have to pay for. Stryker applies its own
      // timeout on top; this keeps a single wedged test from holding a worker for 30s.
      testTimeout: 20_000,
      hookTimeout: 20_000,
      env: {
        ...base.test?.env,
        KNOWL_HOME: path.resolve('./.knowl-test-home'),
      },
    },
  }),
);
