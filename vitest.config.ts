import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Several suites are true integration tests that spawn `node dist/index.js`
    // per assertion. Process start-up costs 1-3s on Windows, so vitest's 5s
    // default makes them flake even when the code is correct.
    testTimeout: 30_000,
    hookTimeout: 30_000,
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
    },
  },
});
