# Contributing to Knowl

Thanks for wanting to help.

## Before your first pull request: sign the CLA

Knowl requires every contributor to agree to the [Contributor License Agreement](CLA.md). You
keep the copyright on your work; you grant permission broad enough that the project can be
maintained and relicensed without chasing signatures later.

It takes one comment. A bot asks on your first pull request; you reply with the sentence it
quotes, and it never asks again.

If you wrote the code while employed somewhere, please read section 4 of the CLA before you
sign. Many employment contracts claim ownership of code written outside work hours. It is much
easier to sort out before a contribution is merged than after.

## Getting set up

Knowl needs **Node 22 or newer**.

```bash
git clone https://github.com/dat999zx/knowl.git
cd knowl
npm ci
npm run build
npm test
```

## Before you open a pull request

Run all three, and make sure all three pass:

```bash
npm test          # vitest
npm run build     # tsup
git diff --check  # whitespace damage
```

CLI tests run against `dist/`, so **rebuild before** touching anything CLI-related or those
tests will quietly check stale output.

Two more gates run in CI and are worth running locally if you touched what they cover:

```bash
npx tsc --noEmit       # types
npm run check:lockfile # package.json and package-lock.json agree on the version
```

## How the codebase is written

Read a neighbouring file before writing a new one. A few things that are not obvious:

- **Comments explain why, not what.** Most comments in this codebase record a decision, a
  measurement, or a bug that a change prevents. If a comment could be deleted without losing
  information, it should be.
- **Tests come first.** Write the failing test, watch it fail for the right reason, then fix it.
  A test that has never failed has not been shown to test anything.
- **Test roots** follow `path.resolve('./.knowl-<name>-test')`, created in `beforeAll` and
  removed in `afterAll`. Clean up after yourself — stray `.db` files in the repo root mean a
  test did not.
- **Windows and POSIX both matter.** Development happens on Windows, CI runs Ubuntu. Paths,
  symlinks, junctions, file locking and `rename` all behave differently. Gate genuinely
  platform-specific tests with `it.skipIf` / `it.runIf`, but prefer writing tests that pass on
  both.
- **Schema changes touch more than the schema.** Any new table needs an entry in
  `src/store/snapshot-tables.ts` saying what a restore does with it. A test fails if you forget,
  which is deliberate — a table nobody classified is a table whose recovery behaviour nobody
  decided.
- **No new runtime dependencies** without discussing it in an issue first.

## Commits

[Conventional Commits](https://www.conventionalcommits.org/): `fix(snapshots): ...`,
`feat(cli): ...`, `docs: ...`, `chore(release): ...`.

Write the body for someone reading it in a year with no memory of the conversation. What was
broken, how you know, what changed.

## Reporting a bug

Include the Knowl version, your platform and Node version, what you expected, what happened,
and the smallest reproduction you can manage. If it involves the store, `knowl doctor` output
helps.

## Security issues

**Do not open a public issue.** See [SECURITY.md](SECURITY.md) if present, or contact the
maintainer privately through GitHub.

## Licence

Knowl is [Apache-2.0](LICENSE). Contributions are accepted under the terms of the
[CLA](CLA.md).
