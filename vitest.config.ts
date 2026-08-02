import path from 'node:path';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Benchmark harness lives under benchmarks/ with its own vitest project (`npm run
    // test:bench`). Excluding it keeps `npm test` scoped to the product, so research tooling can
    // never slow down or destabilise the suite that gates releases.
    exclude: ['**/node_modules/**', '**/dist/**', 'benchmarks/**'],
    // Several suites are true integration tests that spawn `node dist/index.js`
    // per assertion. Process start-up costs 1-3s on Windows, so vitest's 5s
    // default makes them flake even when the code is correct.
    //
    // Raised from 30s once it was measured rather than estimated: the dominant cost is not
    // process spawn but per-test fixture rebuilds that open and close libSQL several times
    // (tests/store/rank-knowledge.test.ts runs at 27.4s / 29.1s / 28.4s per test IN ISOLATION).
    // Against a 30s cap those pass alone and fail under parallel load — a red suite that says
    // nothing about the code. The headroom is the fix for the false signal; the fixture cost
    // itself is worth attacking separately.
    testTimeout: 60_000,
    hookTimeout: 60_000,
    // Suites delete their own fixtures, but on Windows libSQL holds the -shm sidecar until
    // the owning process lets go, so those removals routinely fail and are swallowed. This
    // sweeps up once, after every worker is done with its files.
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
      // Machine-wide state gets a scratch home, so nothing a test does can reach the
      // developer's own ~/.knowl. `knowl upgrade` records every repo it visits in a registry
      // there, and `upgrade --all` and `doctor --fix` act on every repo in it -- so a suite
      // that spawns the CLI without this is one bug away from sweeping real projects.
      // Suites needing their own workspace still override this; they just no longer have to.
      //
      // ABSOLUTE, and declared exactly once. This key was previously written twice in this
      // object -- './.knowl-test-home' then the resolved path -- so the safety above held only
      // because a later duplicate key silently wins. A relative value is genuinely wrong here:
      // a spawned CLI runs with its fixture as the working directory and `knowlHome()` resolves
      // a relative override against THAT, which would put scratch state inside the fixture.
      // `.knowl-` prefixed, so global teardown sweeps it.
      KNOWL_HOME: path.resolve('./.knowl-test-home'),
    },
  },
});
