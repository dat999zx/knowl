import type { KnowledgeWriteInput, KnowledgeWriteValidationOptions } from './types.js';

/**
 * `confidence` refused rather than clamped, at the store rather than at one caller.
 *
 * It was bounded in the MCP tool schema, which covers exactly one of the doors: CLI, hook and
 * in-process writes reach the store without passing that schema, and what lands there is
 * permanent. The ranker clamps on read, so ranking itself is no longer poisoned -- but the
 * stored number still decides which of two duplicates GC keeps and hard deletes the other,
 * weights session-candidate promotion, and is handed to the agent verbatim in every compact
 * MCP response, on a scale the response never declares.
 *
 * **Refused, not clamped**, for two reasons and one measurement. The MCP schema already refuses
 * and says so in its own description, so clamping here would make the same input behave
 * differently depending on which door it came in -- and the silent door is the one with no
 * schema and no reviewer. A refusal is also recoverable: the caller is told the value was
 * rejected and can send the right one, where a clamp is undetectable afterwards.
 *
 * The measurement settles what a clamp would actually do. Across the five real stores on this
 * machine -- 764 items -- every confidence sits in [0.70, 1.00], and 487 of them are exactly
 * 1.00. So a caller on a percent scale writing 90, meaning "less sure than usual", would be
 * clamped to 1.00: not rounded, but moved to the most confident value the store holds and tied
 * with the default. Clamping inverts the claim it is trying to salvage.
 *
 * Absent stays absent -- "no opinion" is not an error, and the column defaults to 1.0.
 *
 * It lives here, beside the other write invariants, rather than in `knowledge-writer.ts` where
 * it started: the repository is the last door before the row and has to call it too, and
 * `knowledge-writer` already imports the repository -- so importing it back the other way
 * would be a cycle. Both writers already sit above this module.
 */
export function assertConfidenceInRange(confidence: number | null | undefined, subject: string): void {
  if (confidence === undefined || confidence === null) return;
  if (Number.isFinite(confidence) && confidence >= 0 && confidence <= 1) return;
  throw new Error(
    `Invalid confidence ${String(confidence)} for "${subject}": confidence is a probability in [0, 1] and was refused rather than clamped, `
    + 'because clamping a percent-scale value would silently record it as maximum confidence. Divide by 100 if you meant a percentage.',
  );
}

const DEFAULT_MAX_FIELD_LENGTH = 20_000;
const DEFAULT_MAX_RAW_OUTPUT_LENGTH = 50_000;
const SENSITIVE_PATH = /(^|[\\/])(?:\.env(?:\.[^\\/]+)?|[^\\/]*(?:credential|secret)[^\\/]*|id_rsa(?:\.pub)?|[^\\/]*\.(?:pem|p12|pfx|key))$/i;
// `.env.example` and friends exist to be committed -- they document the configuration
// surface and hold placeholders, not secrets. Treating them as sensitive blocks storing
// legitimate knowledge about a project's own setup. The suffix must be exact, so
// `.env.exampled` is still rejected.
const TEMPLATE_PATH_SUFFIX = /\.(?:example|sample|template|dist)$/i;

function isSensitivePath(path: string): boolean {
  return SENSITIVE_PATH.test(path) && !TEMPLATE_PATH_SUFFIX.test(path);
}
const CREDENTIAL_URL = /\b[a-z][a-z\d+.-]*:\/\/[^\s/:@]+:[^\s@/]+@/i;
const PEM_BLOCK = /-----BEGIN (?:[A-Z0-9 ]+ )?PRIVATE KEY-----/i;
const NAMED_SECRET = /\b(?:bearer|api[_-]?key|access[_-]?token|secret|password)\s*(?:=|:)?\s*[A-Za-z0-9._~+\/-]{16,}/i;
const KNOWN_TOKEN = /\b(?:sk-[A-Za-z0-9_-]{16,}|AKIA[A-Z0-9]{16}|gh[pousr]_[A-Za-z0-9_]{20,}|xox[baprs]-[A-Za-z0-9-]{10,})\b/;
const HIGH_ENTROPY_TOKEN = /\b(?=[A-Za-z0-9_-]{32,}\b)(?=[A-Za-z0-9_-]*[a-z])(?=[A-Za-z0-9_-]*[A-Z])(?=[A-Za-z0-9_-]*\d)[A-Za-z0-9_-]+\b/;
const GENERIC_SECRET_INDICATORS = new Set([
  'password', 'api_key', 'token', 'secret', 'private_key', 'credential', 'db_password',
]);

export class KnowledgeValidationError extends Error {
  constructor(public readonly code: string, message: string) {
    super(message);
    this.name = 'KnowledgeValidationError';
  }
}

function reject(code: string, message: string): never {
  throw new KnowledgeValidationError(code, message);
}

/**
 * Every field a secret can arrive in, not just the prose ones.
 *
 * `tags`, `alternatives` and skill `steps` are all writable from the MCP surface, and all
 * three used to be unscanned: the same `ghp_…` token refused in `content` stored cleanly in
 * `tags`. The scan set has to be the set of fields a caller can fill, or the check is a
 * suggestion. `auditKnowledgeStore` reads this same function, so the store-wide audit
 * inherited the blind spot and reported clean.
 */
function stringFields(input: KnowledgeWriteInput): Array<[string, string]> {
  const arrayField = (label: string, values: unknown): Array<[string, string]> =>
    Array.isArray(values)
      ? values.flatMap((value, index): Array<[string, string]> =>
        typeof value === 'string' ? [[`${label}[${index}]`, value]] : [])
      : [];

  const anyInput = input as unknown as Record<string, unknown>;
  // A skill step is an object; its instruction is the part a caller writes prose into.
  const steps = Array.isArray(anyInput.steps)
    ? anyInput.steps.flatMap((step, index): Array<[string, string]> => {
      const instruction = (step as Record<string, unknown> | null)?.instruction;
      return typeof instruction === 'string' ? [[`steps[${index}].instruction`, instruction]] : [];
    })
    : [];

  return [
    ['title', input.title],
    ['content', input.content],
    ['reasoning', input.reasoning],
    ['source', input.source],
    ...arrayField('tags', anyInput.tags),
    ...arrayField('alternatives', anyInput.alternatives),
    ...steps,
  ].filter((field): field is [string, string] => typeof field[1] === 'string');
}

function hasConfiguredPattern(value: string, patterns: string[]): boolean {
  return patterns.some((pattern) => {
    const normalized = pattern.toLocaleLowerCase();
    return normalized.length > 0 &&
      !GENERIC_SECRET_INDICATORS.has(normalized) &&
      value.toLocaleLowerCase().includes(normalized);
  });
}

export function validateKnowledgeWrite(
  input: KnowledgeWriteInput,
  options: KnowledgeWriteValidationOptions = {},
): { pass: true } {
  const maxFieldLength = options.maxFieldLength ?? DEFAULT_MAX_FIELD_LENGTH;
  const maxRawOutputLength = options.maxRawOutputLength ?? DEFAULT_MAX_RAW_OUTPUT_LENGTH;
  const fields = stringFields(input);

  if (fields.some(([, value]) => value.length > maxFieldLength)) {
    reject('KNOWLEDGE_FIELD_TOO_LARGE', 'Knowledge write rejected: a field exceeds the allowed length.');
  }

  if ((input.rawOutput?.length ?? 0) > maxRawOutputLength) {
    reject('KNOWLEDGE_RAW_OUTPUT_TOO_LARGE', 'Knowledge write rejected: raw output exceeds the allowed length.');
  }

  // Everything below is secret detection, so it all sits behind the one knob users have.
  // The sensitive-path check used to run above this line, which made `rejectSecrets: false`
  // silently partial: `knowl doctor` kept failing its integrity audit with no setting that
  // could clear it.
  if (options.rejectSecrets === false) return { pass: true };

  if ((input.affectedPaths ?? []).some(isSensitivePath)) {
    reject('KNOWLEDGE_SENSITIVE_PATH', 'Knowledge write rejected: a sensitive path cannot be stored.');
  }

  const values = [...fields.map(([, value]) => value), input.rawOutput ?? ''];
  if (values.some((value) => PEM_BLOCK.test(value))) {
    reject('KNOWLEDGE_SECRET_PEM', 'Knowledge write rejected: secret material was detected.');
  }
  if (values.some((value) => CREDENTIAL_URL.test(value))) {
    reject('KNOWLEDGE_SECRET_URL', 'Knowledge write rejected: secret material was detected.');
  }
  if (values.some((value) => NAMED_SECRET.test(value) || KNOWN_TOKEN.test(value) || HIGH_ENTROPY_TOKEN.test(value))) {
    reject('KNOWLEDGE_SECRET_TOKEN', 'Knowledge write rejected: secret material was detected.');
  }
  if (values.some((value) => hasConfiguredPattern(value, options.secretPatterns ?? []))) {
    reject('KNOWLEDGE_CONFIGURED_PATTERN', 'Knowledge write rejected: a configured-pattern secret was detected.');
  }

  return { pass: true };
}
