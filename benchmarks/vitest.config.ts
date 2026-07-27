import { defineConfig } from 'vitest/config';

// Benchmark harness tests are pure unit tests over scoring functions -- no dataset, no database,
// no network. They live in their own project so `npm test` stays focused on the product, and so
// benchmark work can never slow down or destabilise the main suite.
export default defineConfig({
  test: {
    // Globs resolve against the repo root (vitest's root), not this config's directory.
    include: ['benchmarks/*/tests/**/*.test.ts'],
    env: {
      OPENAI_API_KEY: '',
      ANTHROPIC_API_KEY: '',
    },
  },
});
