import path from 'node:path';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    alias: {
      '@dat999zx/knowl/plugin': path.resolve('./dist/plugin.js'),
      '@dat999zx/knowl': path.resolve('./dist/index.js'),
      // `openclaw` is a PEER dependency of integrations/openclaw and is deliberately absent
      // here: the host refuses a second registry copy of itself inside a managed plugin
      // project and relinks its own node_modules after install. Without this alias the
      // OpenClaw suite passes only on a machine that happens to have OpenClaw installed --
      // it died on CI's ubuntu and macOS legs with ERR_MODULE_NOT_FOUND while passing on the
      // developer's Windows box, which had it left over from a live install.
      'openclaw/plugin-sdk/plugin-entry': path.resolve('./tests/integrations/openclaw/plugin-entry-stub.ts'),
    },
  },
  test: {
    // Benchmark harness lives under benchmarks/ with its own vitest project (`npm run
    // test:bench`). Excluding it keeps `npm test` scoped to the product, so research tooling can
    // never slow down or destabilise the suite that gates releases.
    // `.claude/**` holds agent worktrees. A worktree is a second checkout of this repository, so
    // its `tests/` glob matches too and every suite runs twice -- once against the working tree
    // and once against whatever revision that worktree is parked on. That doubles the runtime and
    // reports failures for code the developer has not touched.
    exclude: ['**/node_modules/**', '**/dist/**', 'benchmarks/**', '**/.claude/**'],
    // Several suites are true integration tests that spawn `node dist/index.js`
    // per assertion. Process start-up costs 1-3s on Windows, so vitest's 5s
    // default makes them flake even when the code is correct.
    testTimeout: 30_000,
    hookTimeout: 30_000,
    // Suites delete their own fixtures, but on Windows libSQL holds the -shm sidecar until
    // the owning process lets go, so those removals routinely fail and are swallowed. This
    // sweeps up once, after every worker is done with its files. It also gives the run its own
    // `os.tmpdir()`, so the fixtures built there are one directory to collect rather than
    // thousands scattered through a shared `%TEMP%`.
    globalSetup: ['./tests/global-teardown.ts'],
    // These suites are dominated by child-process spawns rather than CPU work, so
    // extra workers buy little and instead starve vitest's own worker RPC on a
    // busy machine (surfacing as `Timeout calling "onTaskUpdate"`).
    maxWorkers: 4,
    // Keep the suite hermetic. Write-time truth derivation fires whenever an AI
    // provider looks configured, and config resolves `${OPENAI_API_KEY}` from the
    // environment — so a developer's real key would turn `knowl decide` in a test
    // into a live provider call. Blanking these makes hasAiConfigured() false.
    env: {
      OPENAI_API_KEY: '',
      ANTHROPIC_API_KEY: '',
      // Write-time vector indexing would load the embedding model on every write.
      // Tests that care about it opt back in explicitly.
      KNOWL_DISABLE_WRITE_EMBEDDING: '1',
      // Machine-local Knowl state -- workspace manifests and the known-repository registry --
      // lives under ~/.knowl by default. Suites that spawn the real CLI would otherwise write
      // their scratch fixtures into the developer's own home directory, where nothing cleans
      // them up and a later `knowl upgrade --all` would try to visit them. `knowl upgrade`
      // records every repo it visits in that registry, and `upgrade --all` and `doctor --fix`
      // act on every repo in it, so a suite spawning the CLI without this is one bug away from
      // sweeping real projects. Absolute because a spawned CLI runs with its fixture as the
      // working directory and `knowlHome()` resolves a relative override against that -- a
      // relative value here would scatter a scratch home under every fixture instead of one
      // shared, swept location. `.knowl-` prefixed, so global teardown sweeps it.
      KNOWL_HOME: path.resolve('./.knowl-test-home'),
    },
  },
});
