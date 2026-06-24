import { defineConfig } from 'drizzle-kit';

export default defineConfig({
  schema: './src/store/schema.ts',
  out: './drizzle',
  dialect: 'sqlite',
  dbCredentials: {
    url: '', // Will be configured dynamically or via env at runtime, but drizzle-kit needs a schema definition
  },
});
