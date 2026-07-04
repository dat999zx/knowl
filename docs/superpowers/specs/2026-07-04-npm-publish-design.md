# Knowl npm Publish Design

## Goal

Publish Knowl to the public npm registry so users can install it globally and run the `knowl` CLI.

## Constraints

- The unscoped npm package name `knowl` is already taken on the public registry.
- The CLI command should remain `knowl`.
- Changes should stay limited to package metadata and install documentation.

## Decision

Publish the package as `@dat999zx/knowl` with public access while keeping the binary name `knowl`.

## Package Design

- Set `package.json` `name` to `@dat999zx/knowl`.
- Keep `bin.knowl` pointing at `./dist/index.js`.
- Add a `files` allowlist so publish output only includes built artifacts and the README.
- Add `publishConfig.access = "public"` for scoped public publish.
- Add `prepublishOnly` to force a fresh build before `npm publish`.

## Docs Design

- README installation should lead with `npm install -g @dat999zx/knowl`.
- Source install remains as a secondary path for contributors.

## Verification

- Run `npm.cmd test`.
- Run `npm.cmd run build`.
- Run `npm.cmd pack --dry-run`.
- Publish with `npm.cmd publish`.
