import { describe, expect, it } from 'vitest';
import {
  KnowledgeValidationError,
  validateKnowledgeWrite,
} from '../../src/core/knowledge-validation.js';

describe('validateKnowledgeWrite', () => {
  it('accepts clean structured knowledge', () => {
    expect(validateKnowledgeWrite({
      title: 'SQLite persistence',
      content: 'Knowl stores project knowledge in a local SQLite database.',
      affectedPaths: ['src/store/repository.ts'],
    })).toEqual({ pass: true });
  });

  it('rejects a credential-like token without echoing it', () => {
    const secret = 'sk-test-123456789012345678901234567890';

    expect(() => validateKnowledgeWrite({ title: 'x', content: secret }))
      .toThrow(/secret/i);

    try {
      validateKnowledgeWrite({ title: 'x', content: secret });
      throw new Error('expected rejection');
    } catch (error) {
      expect(error).toBeInstanceOf(KnowledgeValidationError);
      expect(String(error)).not.toContain(secret);
    }
  });

  it('rejects PEM blocks', () => {
    expect(() => validateKnowledgeWrite({
      content: '-----BEGIN PRIVATE KEY-----\nprivate material',
    })).toThrow(/secret/i);
  });

  it('rejects credential-bearing URLs', () => {
    expect(() => validateKnowledgeWrite({
      source: 'postgres://admin:password@example.test/knowl',
    })).toThrow(/secret/i);
  });

  it('rejects high-entropy token runs', () => {
    expect(() => validateKnowledgeWrite({
      content: 'Token: AKIAIOSFODNN7EXAMPLEa8Zk0mN2pQ4rS6tV9wX1yC3dE5fG7hJ',
    })).toThrow(/secret/i);
  });

  it('rejects configured secret patterns case-insensitively', () => {
    expect(() => validateKnowledgeWrite(
      { content: 'Deploy with InternalProdCredential.' },
      { secretPatterns: ['internalprodcredential'] },
    )).toThrow(/configured-pattern/i);
  });

  it('rejects environment and credential paths', () => {
    expect(() => validateKnowledgeWrite({
      affectedPaths: ['apps/api/.env.production'],
    })).toThrow(/path/i);
  });

  it('allows env template files, which exist to be committed', () => {
    // .env.example and friends are documentation of the configuration surface, not
    // secrets. Rejecting them blocks storing legitimate knowledge about a project's
    // own setup, which is exactly what a memory tool is for.
    for (const path of ['.env.example', '.env.sample', '.env.template', 'apps/api/.env.dist', '.env.local.example']) {
      expect(() => validateKnowledgeWrite({ affectedPaths: [path] })).not.toThrow();
    }
  });

  it('still rejects real env and key paths that resemble templates', () => {
    for (const path of ['.env', '.env.production', 'deploy/.env.exampled', 'certs/server.key', 'id_rsa']) {
      expect(() => validateKnowledgeWrite({ affectedPaths: [path] })).toThrow(/path/i);
    }
  });

  it('honours rejectSecrets: false for sensitive paths too', () => {
    // The observable contract of the only knob users have is "secret rejection is off".
    // Leaving the path check enabled made `rejectSecrets: false` silently partial and
    // left `knowl doctor` failing with no way to clear it.
    expect(() => validateKnowledgeWrite(
      { affectedPaths: ['apps/api/.env.production'] },
      { rejectSecrets: false },
    )).not.toThrow();
  });

  it('rejects oversized payloads', () => {
    expect(() => validateKnowledgeWrite(
      { rawOutput: 'x'.repeat(11) },
      { maxRawOutputLength: 10 },
    )).toThrow(/length/i);
  });

  it('rejects oversized normal fields', () => {
    expect(() => validateKnowledgeWrite(
      { content: 'x'.repeat(11) },
      { maxFieldLength: 10 },
    )).toThrow(/length/i);
  });

  /**
   * The scan set, pinned field by field.
   *
   * `stringFields` says in its own docblock that `tags`, `alternatives` and skill `steps` used
   * to be unscanned, that the same `ghp_…` token refused in `content` stored cleanly in `tags`,
   * and that `auditKnowledgeStore` inherited the blind spot and reported clean. Nothing pinned
   * the fix: deleting any one of those lines from the returned array -- title included -- left
   * all 1,725 tests green. A regression fix with no test is a comment.
   */
  describe('every field a caller can fill is scanned', () => {
    const SECRET = 'ghp_abcdefghijklmnopqrstuvwxyz0123456789';

    it('refuses a secret in the title', () => {
      expect(() => validateKnowledgeWrite({ title: SECRET, content: 'Safe.' })).toThrow(/secret/i);
    });

    it('refuses a secret in the source', () => {
      expect(() => validateKnowledgeWrite({ title: 'x', content: 'Safe.', source: SECRET })).toThrow(/secret/i);
    });

    it('refuses a secret in tags', () => {
      expect(() => validateKnowledgeWrite(
        { title: 'x', content: 'Safe.', tags: ['fine', SECRET] } as never,
      )).toThrow(/secret/i);
    });

    it('refuses a secret in alternatives', () => {
      expect(() => validateKnowledgeWrite(
        { title: 'x', content: 'Safe.', alternatives: ['fine', SECRET] } as never,
      )).toThrow(/secret/i);
    });

    it('refuses a secret in the reasoning', () => {
      expect(() => validateKnowledgeWrite({ title: 'x', content: 'Safe.', reasoning: `Justified by ${SECRET}.` }))
        .toThrow(/secret/i);
    });

    it('refuses a secret in raw output', () => {
      // rawOutput is scanned by being appended to the value list rather than by being a named
      // field, so it is the one input a "which fields are scanned" test can miss. Replacing the
      // whole `input.rawOutput ?? ''` expression with a constant left every test green.
      expect(() => validateKnowledgeWrite({ title: 'x', content: 'Safe.', rawOutput: `stdout: ${SECRET}` }))
        .toThrow(/secret/i);
    });

    it('refuses a secret in a skill step instruction', () => {
      expect(() => validateKnowledgeWrite(
        { title: 'x', content: 'Safe.', steps: [{ instruction: `Run with ${SECRET}` }] } as never,
      )).toThrow(/secret/i);
    });
  });

  /**
   * The rule code, not just the message.
   *
   * `KnowledgeValidationError.code` is what callers branch on -- `tests/store/store.test.ts`
   * matches `{ code: 'KNOWLEDGE_SECRET_TOKEN' }` -- but nothing here pinned it, so blanking any
   * of the six code literals to `""` was invisible.
   */
  it('names the rule that refused the write', () => {
    const codeOf = (input: Parameters<typeof validateKnowledgeWrite>[0], options?: Parameters<typeof validateKnowledgeWrite>[1]) => {
      try {
        validateKnowledgeWrite(input, options);
        return null;
      } catch (error) {
        return (error as KnowledgeValidationError).code;
      }
    };

    expect(codeOf({ content: '-----BEGIN PRIVATE KEY-----' })).toBe('KNOWLEDGE_SECRET_PEM');
    expect(codeOf({ source: 'postgres://admin:hunter22@example.test/db' })).toBe('KNOWLEDGE_SECRET_URL');
    expect(codeOf({ content: 'ghp_abcdefghijklmnopqrstuvwxyz0123456789' })).toBe('KNOWLEDGE_SECRET_TOKEN');
    expect(codeOf({ affectedPaths: ['.env.production'] })).toBe('KNOWLEDGE_SENSITIVE_PATH');
    expect(codeOf({ content: 'x'.repeat(11) }, { maxFieldLength: 10 })).toBe('KNOWLEDGE_FIELD_TOO_LARGE');
    expect(codeOf({ rawOutput: 'x'.repeat(11) }, { maxRawOutputLength: 10 })).toBe('KNOWLEDGE_RAW_OUTPUT_TOO_LARGE');
    expect(codeOf({ content: 'Deploy with InternalProdCredential.' }, { secretPatterns: ['internalprodcredential'] }))
      .toBe('KNOWLEDGE_CONFIGURED_PATTERN');
  });

  /**
   * The limits are ceilings, so the limit itself is allowed.
   *
   * Both length checks were only tested one side of the boundary -- 11 characters against a
   * limit of 10 -- so flipping `>` to `>=` refused a payload of exactly the documented size and
   * nothing noticed. The ceiling is the number in the error message a caller is told to fit
   * under; if fitting under it exactly is refused, the message is a lie.
   */
  it('allows a field of exactly the maximum length, and refuses one character more', () => {
    expect(() => validateKnowledgeWrite({ content: 'x'.repeat(10) }, { maxFieldLength: 10 })).not.toThrow();
    expect(() => validateKnowledgeWrite({ content: 'x'.repeat(11) }, { maxFieldLength: 10 })).toThrow(/length/i);
  });

  it('allows raw output of exactly the maximum length, and refuses one byte more', () => {
    expect(() => validateKnowledgeWrite({ rawOutput: 'x'.repeat(10) }, { maxRawOutputLength: 10 })).not.toThrow();
    expect(() => validateKnowledgeWrite({ rawOutput: 'x'.repeat(11) }, { maxRawOutputLength: 10 })).toThrow(/length/i);
  });

  /**
   * A configured pattern that would refuse everything is not a pattern.
   *
   * `hasConfiguredPattern` guards two ways and neither was tested. An empty string passes
   * `String.includes` for every value, so relaxing `normalized.length > 0` to `>= 0` turns one
   * stray entry in a config array into a store that refuses every write. And
   * `GENERIC_SECRET_INDICATORS` exists so that configuring the word "token" or "password" --
   * words that appear in ordinary prose about a codebase -- does not do the same thing more
   * slowly; emptying that set entirely was invisible.
   */
  describe('configured secret patterns cannot refuse everything', () => {
    it('ignores an empty pattern instead of matching every value', () => {
      expect(() => validateKnowledgeWrite(
        { title: 'Deploy notes', content: 'Nothing sensitive here.' },
        { secretPatterns: [''] },
      )).not.toThrow();
    });

    it('ignores a generic indicator, which would otherwise match ordinary prose', () => {
      for (const indicator of ['password', 'api_key', 'token', 'secret', 'private_key', 'credential', 'db_password']) {
        expect(() => validateKnowledgeWrite(
          { title: 'Auth notes', content: `The login form asks for a ${indicator}.` },
          { secretPatterns: [indicator] },
        )).not.toThrow();
      }
    });

    it('still matches a specific configured pattern', () => {
      expect(() => validateKnowledgeWrite(
        { content: 'Deploy with AcmeInternalProdKey.' },
        { secretPatterns: ['acmeinternalprodkey'] },
      )).toThrow(/configured-pattern/i);
    });
  });

  /**
   * One example per detector proves the example, not the detector.
   *
   * Each pattern here recognises a family -- four token vendors, three key-name spellings, an
   * optional `RSA` in a PEM header -- and each was pinned by exactly ONE member of its family.
   * Mutating a pattern to drop a sibling alternative (`gh[pousr]_` to `gh[^pousr]_`,
   * `api[_-]?key` to `api[_-]key`, `[A-Z0-9 ]+ ` to `[A-Z0-9 ] `) therefore let real secret
   * shapes through with every test still green: measured, 25 of the 32 surviving regex mutants
   * differ from the original on at least one input in this table.
   *
   * Every row is a shape the module's own docblocks claim to catch.
   */
  it.each([
    ['OpenAI-style key', 'sk-test-123456789012345678901234567890'],
    ['GitHub personal token', 'ghp_abcdefghijklmnopqrstuvwxyz0123456789'],
    ['GitHub OAuth token', 'gho_abcdefghijklmnopqrstuvwxyz0123456789'],
    ['AWS access key id', 'AKIAIOSFODNN7EXAMPLE'],
    ['Slack bot token', 'xoxb-1234567890-abcdefghij'],
    ['Slack app token', 'xoxa-1234567890-abcdefghij'],
    ['underscored key name', 'api_key = AbCdEf0123456789xyz'],
    ['unpunctuated key name', 'apikey: AbCdEf0123456789xyz'],
    ['hyphenated token name', 'access-token=AbCdEf0123456789xyz'],
    ['bearer token', 'bearer AbCdEf0123456789xyz'],
    ['named password', 'password: correcthorsebatterystaple1'],
    ['plain PEM header', '-----BEGIN PRIVATE KEY-----'],
    ['RSA PEM header', '-----BEGIN RSA PRIVATE KEY-----'],
    ['credential-bearing URL', 'postgres://admin:hunter22@example.test/db'],
    ['bare high-entropy run', 'AbCdEf0123456789AbCdEf0123456789xy'],
  ])('refuses a %s', (_label, secret) => {
    expect(() => validateKnowledgeWrite({ title: 'Deploy notes', content: `Use ${secret} to connect.` }))
      .toThrow(/secret/i);
  });

  it.each([
    ['a credentials file path', 'config/credentials.json'],
    ['a secrets directory entry', 'secrets/prod.pem'],
    ['a private key', 'certs/server.key'],
    ['an ssh key', 'id_rsa'],
    ['an ssh public key', 'id_rsa.pub'],
  ])('refuses %s in affectedPaths', (_label, sensitivePath) => {
    expect(() => validateKnowledgeWrite({ affectedPaths: [sensitivePath] })).toThrow(/path/i);
  });

  it('leaves ordinary project prose alone', () => {
    // The counterweight: a detector that refuses everything is not a detector. These read like
    // the knowledge this tool exists to store, and none of them may be refused.
    for (const content of [
      'The API allows 100 requests per minute.',
      'Auth uses a bearer token issued by the gateway.',
      'The password reset flow sends a signed link.',
      'Secrets live in the deployment environment, not the repo.',
      'src/store/connection-pool.ts owns the read replicas.',
    ]) {
      expect(() => validateKnowledgeWrite({ title: 'Notes', content })).not.toThrow();
    }
  });
});
