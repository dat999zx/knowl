import { readFileSync } from 'node:fs';

const packageMetadata = JSON.parse(
  readFileSync(new URL('../package.json', import.meta.url), 'utf-8')
) as { version: string; name: string };

export const PACKAGE_VERSION = packageMetadata.version;
export const PACKAGE_NAME = packageMetadata.name;
