import { defineConfig } from 'tsup';

/**
 * Bundle the dependencies instead of resolving them at every startup.
 *
 * tsup leaves everything in `dependencies` external by default, so `dist/index.js` shipped
 * bare `import … from "drizzle-orm/libsql"` and Node resolved, stat'd, read and compiled the
 * packages file by file on every invocation. Measured: `knowl --version` -- a command that
 * prints a string -- loaded **339 modules**, among them 112 drizzle files, the remote-libsql
 * hrana client, `ws`, and the whole LLM SDK. Isolated, `drizzle-orm/libsql` alone costs
 * 1.5-1.6s to import.
 *
 * That is the startup cost, and it is paid on every agent tool call because the lifecycle
 * hook is a fresh process each time. Bundling takes it from 339 modules to 42, and the hook
 * from ~2.5s to ~0.9s, with no source change at all.
 *
 * Two exclusions are load-bearing rather than stylistic:
 *
 * `libsql` must stay external. It reaches its native binding through a dynamic
 * `require('@neon-rs/load')`, which esbuild cannot follow, and bundling it fails at runtime
 * with "Dynamic require of \"@neon-rs/load\" is not supported". The same is true of the
 * tree-sitter addons and of `@huggingface/transformers`, which is already loaded lazily and
 * carries its own native runtime.
 *
 * The `createRequire` banner is equally required: bundled `ws` calls `require('events')`, and
 * without a `require` in scope an ESM bundle throws on it.
 */
export default defineConfig({
  entry: ['src/index.ts'],
  format: ['esm'],
  clean: true,
  dts: true,
  // Native addons and anything that resolves its own binaries at runtime.
  external: [
    'libsql',
    'tree-sitter',
    'tree-sitter-javascript',
    'tree-sitter-typescript',
    '@huggingface/transformers',
  ],
  noExternal: [
    'drizzle-orm',
    '@libsql/client',
    '@libsql/core',
    '@libsql/hrana-client',
    '@libsql/isomorphic-fetch',
    '@libsql/isomorphic-ws',
    'ws',
    'zod',
    'commander',
    'smol-toml',
    'dotenv',
    'stream-json',
    'stream-chain',
    'ai',
    '@ai-sdk/anthropic',
    '@ai-sdk/openai',
    '@modelcontextprotocol/sdk',
    '@clack/prompts',
    'picocolors',
  ],
  banner: {
    js: "import{createRequire as __knowlCreateRequire}from'node:module';const require=__knowlCreateRequire(import.meta.url);",
  },
});
