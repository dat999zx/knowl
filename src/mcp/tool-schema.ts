/**
 * The tool surface validates its arguments against the schema it publishes.
 *
 * Every tool already declares an `inputSchema` in `tools/list`, and nothing enforced it: the
 * MCP SDK validates the *envelope* of a `tools/call` request, never the tool's own schema, so
 * `arguments` reached the handlers exactly as the caller wrote them. That single gap is the
 * mechanism behind a cluster of findings -- an out-of-range `confidence` poisoning ranking, a
 * negative `maxChars` returning a slice of the truncation marker, a `banana` timestamp
 * degrading to "now", an unbounded `limit`, a missing required field reaching the SQL layer --
 * and each of them is a symptom of the declaration and the behaviour being two different
 * things. Validating against the published schema makes the declaration the behaviour.
 *
 * Deliberately not a general JSON Schema implementation. It covers exactly the keywords this
 * server publishes, and it fails loudly on a keyword it does not understand rather than
 * silently accepting whatever the caller sent -- a validator that quietly ignores half its own
 * schema is the defect it exists to close, one layer up.
 */

/** Refused before anything ran. Distinguishable from an execution failure by the caller. */
export class ToolInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ToolInputError';
  }
}

type Schema = Record<string, any>;

const KNOWN_KEYWORDS = new Set([
  'type', 'description', 'properties', 'required', 'additionalProperties', 'items',
  'enum', 'const', 'minLength', 'maxLength', 'format', 'minimum', 'maximum',
  'minItems', 'maxItems', 'oneOf', 'default',
]);

function kindOf(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  return typeof value;
}

/** What the caller actually sent, short enough to sit inside an error message. */
function describe(value: unknown): string {
  if (value === undefined) return 'nothing';
  if (value === null) return 'null';
  if (Array.isArray(value)) return `an array`;
  if (typeof value === 'object') return 'an object';
  if (typeof value === 'string') return value.length > 40 ? `a ${value.length}-character string` : JSON.stringify(value);
  return String(value);
}

const at = (tool: string, path: string): string => (path ? `${tool}: "${path}"` : `${tool}: arguments`);

function fail(tool: string, path: string, detail: string): never {
  throw new ToolInputError(`${at(tool, path)} ${detail}`);
}

/** The `type` literal each branch of a discriminated union declares. */
function branchDiscriminator(branch: Schema): string | undefined {
  const discriminator = branch?.properties?.type;
  if (!discriminator) return undefined;
  if (typeof discriminator.const === 'string') return discriminator.const;
  if (Array.isArray(discriminator.enum) && typeof discriminator.enum[0] === 'string') return discriminator.enum[0];
  return undefined;
}

function validateValue(tool: string, path: string, value: unknown, schema: Schema): void {
  for (const keyword of Object.keys(schema)) {
    if (!KNOWN_KEYWORDS.has(keyword)) {
      throw new ToolInputError(`${at(tool, path)} declares unsupported schema keyword "${keyword}"; this is a server bug, not a caller error.`);
    }
  }

  if (Array.isArray(schema.oneOf)) {
    // Discriminated by `type`, which is the only union this surface publishes. Picking the
    // branch first is what makes the error useful: reporting "matched none of 2 schemas" is
    // exactly the unhelpful message that made `entrypoints` uncallable in the first place.
    const allowed = schema.oneOf.map(branchDiscriminator).filter(Boolean) as string[];
    const actual = kindOf(value) === 'object' ? (value as Record<string, unknown>).type : undefined;
    const branch = schema.oneOf.find(candidate => branchDiscriminator(candidate) === actual);
    if (!branch) {
      fail(tool, path, `must be an object whose "type" is ${allowed.map(name => `"${name}"`).join(' or ')} (received ${describe(actual)}).`);
    }
    validateValue(tool, path, value, branch);
    return;
  }

  switch (schema.type) {
    case 'string':
      if (typeof value !== 'string') fail(tool, path, `must be a string (received ${describe(value)}).`);
      break;
    case 'boolean':
      if (typeof value !== 'boolean') fail(tool, path, `must be true or false (received ${describe(value)}).`);
      break;
    case 'integer':
    case 'number':
      // NaN and Infinity are `typeof number` and both survive every comparison below, which is
      // how a non-finite budget reached a slice() and returned an empty string as success.
      if (typeof value !== 'number' || !Number.isFinite(value)) {
        fail(tool, path, `must be a finite number (received ${describe(value)}).`);
      }
      if (schema.type === 'integer' && !Number.isInteger(value)) {
        fail(tool, path, `must be a whole number (received ${describe(value)}).`);
      }
      break;
    case 'array':
      if (!Array.isArray(value)) fail(tool, path, `must be an array (received ${describe(value)}).`);
      break;
    case 'object':
      if (kindOf(value) !== 'object') fail(tool, path, `must be an object (received ${describe(value)}).`);
      break;
    default:
      break;
  }

  if (typeof value === 'number') {
    if (typeof schema.minimum === 'number' && value < schema.minimum) {
      fail(tool, path, `must be at least ${schema.minimum} (received ${value}).`);
    }
    if (typeof schema.maximum === 'number' && value > schema.maximum) {
      fail(tool, path, `must be at most ${schema.maximum} (received ${value}).`);
    }
  }

  if (typeof value === 'string') {
    if (Array.isArray(schema.enum) && !schema.enum.includes(value)) {
      fail(tool, path, `must be one of ${schema.enum.join(', ')} (received ${describe(value)}).`);
    }
    if (typeof schema.const === 'string' && value !== schema.const) {
      fail(tool, path, `must be "${schema.const}" (received ${describe(value)}).`);
    }
    if (typeof schema.minLength === 'number' && value.length < schema.minLength) {
      fail(tool, path, schema.minLength === 1
        ? 'must not be empty.'
        : `must be at least ${schema.minLength} characters (received ${value.length}).`);
    }
    if (typeof schema.maxLength === 'number' && value.length > schema.maxLength) {
      fail(tool, path, `must be at most ${schema.maxLength} characters (received ${value.length}).`);
    }
    if (schema.format === 'date-time' && Number.isNaN(Date.parse(value))) {
      fail(tool, path, `must be an ISO-8601 timestamp (received ${describe(value)}).`);
    }
  }

  if (Array.isArray(value)) {
    if (typeof schema.minItems === 'number' && value.length < schema.minItems) {
      fail(tool, path, `must have at least ${schema.minItems} item(s) (received ${value.length}).`);
    }
    if (typeof schema.maxItems === 'number' && value.length > schema.maxItems) {
      fail(tool, path, `must have at most ${schema.maxItems} item(s) (received ${value.length}).`);
    }
    if (schema.items) {
      value.forEach((entry, index) => validateValue(tool, `${path}[${index}]`, entry, schema.items));
    }
  }

  if (kindOf(value) === 'object') {
    const record = value as Record<string, unknown>;
    for (const key of (schema.required as string[] | undefined) ?? []) {
      // Names the field. The old behaviour let a missing field travel to the SQL layer, which
      // reported the whole failed statement and never said which argument was absent.
      if (record[key] === undefined) fail(tool, path ? `${path}.${key}` : key, 'is required.');
    }
    const properties: Record<string, Schema> = schema.properties ?? {};
    for (const [key, entry] of Object.entries(record)) {
      if (entry === undefined) continue;
      const child = path ? `${path}.${key}` : key;
      if (properties[key]) {
        validateValue(tool, child, entry, properties[key]);
        continue;
      }
      if (schema.additionalProperties === false) {
        fail(tool, child, `is not a recognised argument; allowed: ${Object.keys(properties).join(', ')}.`);
      }
      if (schema.additionalProperties && typeof schema.additionalProperties === 'object') {
        validateValue(tool, child, entry, schema.additionalProperties);
      }
    }
  }
}

/**
 * Refuse a call whose arguments do not match the tool's published schema.
 *
 * `undefined` arguments are treated as `{}` so a no-argument tool stays callable the way
 * every client already calls it.
 */
export function validateToolArguments(toolName: string, schema: Schema | undefined, args: unknown): void {
  if (!schema) return;
  if (args !== undefined && args !== null && kindOf(args) !== 'object') {
    fail(toolName, '', `must be an object (received ${describe(args)}).`);
  }
  validateValue(toolName, '', args ?? {}, schema);
}

/**
 * Statement text and bound parameters never leave the process.
 *
 * The driver's message for a failed write is the whole SQL statement, its placeholder list and
 * every bound argument -- content hashes, titles, the content itself. That is a copy of the
 * row handed to whatever is on the other end of the transport, for what is usually a caller
 * mistake. The part of the message before the query is the part that describes what failed, so
 * it is kept and the rest is dropped.
 */
const QUERY_LEAK = /Failed query:|\bparams:\s|\binsert into\b|\bdelete from\b|\bcreate table\b|\bupdate\s+"?[a-z_]+"?\s+set\b|\bselect\b[\s\S]{0,200}?\bfrom\b/i;

export function sanitizeToolErrorMessage(message: string): string {
  const match = QUERY_LEAK.exec(message);
  if (!match) return message;
  const prefix = message.slice(0, match.index).trim().replace(/[:\-\s]+$/, '');
  return `${prefix || 'The database rejected this call'} (SQL statement and bound parameters withheld).`;
}
