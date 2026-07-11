import JavaScript from 'tree-sitter-javascript';
import TypeScript from 'tree-sitter-typescript';

export const CODE_EXTENSIONS = new Set(['.ts', '.tsx', '.js', '.jsx']);

export function languageForExtension(extension: string): unknown | null {
  switch (extension) {
    case '.ts': return TypeScript.typescript;
    case '.tsx': return TypeScript.tsx;
    case '.js':
    case '.jsx': return JavaScript;
    default: return null;
  }
}
