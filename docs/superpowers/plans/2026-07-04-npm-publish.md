# Knowl npm Publish Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Publish Knowl as a public scoped npm package while preserving the `knowl` CLI command.

**Architecture:** Limit changes to package metadata, lockfile metadata, and installation docs. Publish the package as `@dat999zx/knowl` with the binary entrypoint unchanged.

**Tech Stack:** npm, Node.js, tsup, Vitest

---

### Task 1: Update publish metadata

**Files:**
- Modify: `package.json`
- Modify: `package-lock.json`

- [ ] **Step 1: Rename the package and add publish metadata**

Set `package.json` root fields to:

```json
{
  "name": "@dat999zx/knowl",
  "files": ["dist", "README.md"],
  "publishConfig": { "access": "public" }
}
```

Keep:

```json
"bin": {
  "knowl": "./dist/index.js"
}
```

- [ ] **Step 2: Add a publish-time build guard**

Add this script:

```json
"prepublishOnly": "npm run build"
```

- [ ] **Step 3: Mirror the package name in the lockfile**

Update these `package-lock.json` values:

```json
{
  "name": "@dat999zx/knowl",
  "packages": {
    "": {
      "name": "@dat999zx/knowl"
    }
  }
}
```

### Task 2: Update install documentation

**Files:**
- Modify: `README.md`

- [ ] **Step 1: Add npm-first global install instructions**

Place this install block before the source-build instructions:

```bash
npm install -g @dat999zx/knowl
knowl --version
```

- [ ] **Step 2: Keep source install as contributor guidance**

Retain the existing `git clone`, `npm install`, `npm run build`, and `npm link` flow beneath the npm install path.

### Task 3: Verify and publish

**Files:**
- Verify: `package.json`
- Verify: `README.md`

- [ ] **Step 1: Run tests**

Run: `npm.cmd test`
Expected: test suite passes

- [ ] **Step 2: Run build**

Run: `npm.cmd run build`
Expected: tsup emits `dist/index.js` and types

- [ ] **Step 3: Check publish contents**

Run: `npm.cmd pack --dry-run`
Expected: tarball contains package metadata, `dist/`, and `README.md`

- [ ] **Step 4: Publish**

Run: `npm.cmd publish`
Expected: npm accepts `@dat999zx/knowl` as a public package
