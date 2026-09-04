import Go from 'tree-sitter-go';
import JavaScript from 'tree-sitter-javascript';
import Python from 'tree-sitter-python';
import TypeScript from 'tree-sitter-typescript';

export type CodeLanguage = 'javascript' | 'python' | 'go';

export interface CodeGrammar {
  grammar: unknown;
  language: CodeLanguage;
}

const GRAMMARS: Record<string, CodeGrammar> = {
  '.ts': { grammar: TypeScript.typescript, language: 'javascript' },
  '.tsx': { grammar: TypeScript.tsx, language: 'javascript' },
  '.js': { grammar: JavaScript, language: 'javascript' },
  '.jsx': { grammar: JavaScript, language: 'javascript' },
  '.py': { grammar: Python, language: 'python' },
  '.go': { grammar: Go, language: 'go' },
};

export const CODE_EXTENSIONS = new Set(Object.keys(GRAMMARS));

export function grammarForExtension(extension: string): CodeGrammar | null {
  return GRAMMARS[extension] ?? null;
}
