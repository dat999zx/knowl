/**
 * Global setup for `vitest.mutation.config.ts`: the temporary-directory half of
 * `tests/global-teardown.ts`, and nothing else.
 *
 * A mutation run keeps several vitest runs alive at once in one working directory, which is why
 * that config sets `globalSetup: []` -- the repository sweep would have each run deleting the
 * others' live fixtures. Giving every run its own `os.tmpdir()` has no such hazard: a run root
 * is created by, named for, and known only to the run that owns it. Without this, a mutation
 * job leaks a run's worth of `mkdtemp` fixtures per mutant, tens of times over.
 *
 * Kept as its own entry point rather than a flag on the other one, so it is impossible to
 * re-enable the repository sweep here by accident.
 */
export { setup, teardownTemporaryOnly as teardown } from './global-teardown.js';
