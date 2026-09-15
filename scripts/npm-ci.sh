#!/usr/bin/env bash
# `npm ci` for CI, plus the check that it actually installed the optional embedding stack.
#
# `@huggingface/transformers` is an optionalDependency so that a CDN blip on
# `onnxruntime-node`'s postinstall cannot fail a user's install. The cost of that is paid in
# CI: when the blip happens npm rolls the whole optional subtree back and `npm ci` STILL EXITS
# 0, so the job goes on without it and dies later for a reason that has nothing to do with the
# change under test -- `Cannot find package` in three suites that load a real model, or
# `TS2307: Cannot find module '@huggingface/transformers'` in the typecheck.
#
# One retry, because the blip is transient by definition; if it is still missing after that,
# fail loudly rather than silently lose the semantic path.
#
# Lives in a script rather than inline in one job because all three installs need it: the test
# matrix, the checks job (typecheck imports the types), and the publish job (it runs the suite).
# Observed inline-in-one-job cost: b46fd61 went red on main in `checks` alone with TS2307,
# while every test leg was green -- the guard was there and the sibling job did not have it.
set -euo pipefail

have() { test -d node_modules/@huggingface/transformers && test -d node_modules/onnxruntime-node; }

npm ci

if ! have; then
  echo "::warning::optional embedding stack was rolled back by npm ci -- retrying once"
  npm ci
fi

if ! have; then
  echo "::error::@huggingface/transformers or onnxruntime-node is missing after npm ci."
  echo "The optional install failed twice. Every suite on the semantic path, and the typecheck,"
  echo "would now fail for a reason that has nothing to do with the change."
  exit 1
fi
