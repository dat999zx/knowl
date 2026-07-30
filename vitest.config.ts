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
    testTimeout: 30_000,
    hookTimeout: 30_000,
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
    },
  },
});
