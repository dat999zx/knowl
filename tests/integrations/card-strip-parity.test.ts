import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { stripCardMarkers } from '../../src/core/card-marker.js';
import { stripCardTextForTest } from '../../integrations/openclaw/src/index.js';

// The same fixture runs in tests/integrations/hermes/test_plugin.py: three copies of one regex,
// one list of inputs, so they cannot drift without a test failing.
const cases = JSON.parse(fs.readFileSync(path.resolve(__dirname, 'card-strip-cases.json'), 'utf8')) as { in: string; out: string }[];

describe('card marker strip parity', () => {
  it.each(cases)('core strips %j', ({ in: input, out }) => {
    expect(stripCardMarkers(input)).toBe(out);
  });

  it.each(cases)('openclaw copy strips %j', ({ in: input, out }) => {
    expect(stripCardTextForTest(input)).toBe(out);
  });
});
