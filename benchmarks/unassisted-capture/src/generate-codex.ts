/**
 * Method 2's generator, backed by the local Codex CLI.
 *
 * Used because no API credential is configured. The tradeoff is recorded in the design spec:
 * Codex is a coding *agent*, not a bare model behind a structured-output call, so a good
 * result here does not establish that a plain model call would match it. A poor result is the
 * stronger signal.
 *
 * The prompt goes over stdin rather than argv: the largest session renders to ~43k characters
 * and Windows caps a command line near 32k.
 */
import { spawn } from 'node:child_process';
import type { GenerateAtoms } from './method-model-events.js';

export interface CodexGenerateOptions {
  /** JSON Schema file mirroring PredictedAtomSchema, passed to `codex exec --output-schema`. */
  schemaPath: string;
  /** Working root for the agent. Kept away from the repo so a read-only sweep finds nothing. */
  workdir: string;
  /** Per-session ceiling. A hung session must not stall a 32-session run. */
  timeoutMs?: number;
}

export interface CodexRunMeta {
  /** The model Codex reported using, captured from its banner so results can name it. */
  model: string | null;
}

const DEFAULT_TIMEOUT_MS = 180_000;

/** Codex prints a banner, the prompt, the answer, then a token count. The structured answer is
 *  the last line that parses as an object carrying `atoms`. */
export function extractAtoms(stdout: string): Array<{ category: string; title: string; content: string }> {
  const lines = stdout.split('\n').map((line) => line.trim()).filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i--) {
    if (!lines[i].startsWith('{')) continue;
    try {
      const parsed = JSON.parse(lines[i]);
      if (parsed && Array.isArray(parsed.atoms)) return parsed.atoms;
    } catch {
      // Not the answer line; keep walking back.
    }
  }
  throw new Error('Codex produced no line parseable as {"atoms": [...]}');
}

/** `model: gpt-5.6-sol` in the startup banner. */
export function extractModel(stdout: string): string | null {
  return /^model:\s*(\S+)/m.exec(stdout)?.[1] ?? null;
}

export function createCodexGenerate(
  options: CodexGenerateOptions,
  meta: CodexRunMeta = { model: null },
): GenerateAtoms {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  return async (prompt: string) => {
    const stdout = await new Promise<string>((resolve, reject) => {
      const child = spawn(
        'codex',
        [
          'exec',
          '--output-schema', options.schemaPath,
          '--sandbox', 'read-only',
          '--ephemeral',
          '--skip-git-repo-check',
          '-C', options.workdir,
          '-',
        ],
        { cwd: options.workdir, shell: true },
      );

      let out = '';
      let err = '';
      const timer = setTimeout(() => {
        child.kill();
        reject(new Error(`codex exec exceeded ${timeoutMs}ms`));
      }, timeoutMs);

      child.stdout.on('data', (chunk) => { out += String(chunk); });
      child.stderr.on('data', (chunk) => { err += String(chunk); });
      child.on('error', (error) => { clearTimeout(timer); reject(error); });
      child.on('close', (code) => {
        clearTimeout(timer);
        if (code === 0) resolve(out);
        else reject(new Error(`codex exec exited ${code}: ${err.slice(0, 400)}`));
      });

      child.stdin.write(prompt);
      child.stdin.end();
    });

    if (!meta.model) meta.model = extractModel(stdout);
    return extractAtoms(stdout);
  };
}
