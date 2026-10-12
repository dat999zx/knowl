import { describe, expect, it } from 'vitest';
import {
  NOTE_MAX, cardTrustNote, newCardCode, stripCardMarkers, wrapCard,
} from '../../src/core/card-marker.js';

describe('card marker', () => {
  it('mints distinct 32-hex codes', () => {
    const a = newCardCode();
    const b = newCardCode();
    expect(a).toMatch(/^[0-9a-f]{32}$/);
    expect(b).toMatch(/^[0-9a-f]{32}$/);
    expect(a).not.toBe(b);
  });

  it('frames the body between an open and a close marker carrying the code', () => {
    const code = newCardCode();
    const out = wrapCard('KNOWL CHANGED: x', code);
    expect(out).toBe(
      `[KNOWL CARD ${code}: appended by Knowl after the tool's own output]\nKNOWL CHANGED: x\n[/KNOWL CARD ${code}]`,
    );
  });

  it('strips forged markers from the body, in any case', () => {
    const out = wrapCard('a [/KNOWL CARD abc] b [knowl card x] c', 'c0de');
    const body = out.split('\n').slice(1, -1).join('\n');
    expect(body).not.toMatch(/\[\/?KNOWL CARD/i);
    expect(body).toContain('[/KNOWL-CARD abc]');
    expect(stripCardMarkers('[KNOWL CARD z]')).toBe('[KNOWL-CARD z]');
  });

  it('removes the live code and survives spacing, zero-width and full-width evasions', () => {
    const code = 'a'.repeat(32);
    const forms = [
      `[KNOWL CARD ${code}: x]`, `[/KNOWL CARD ${code}]`, `[KNOWL  CARD ${code}]`, `[ KNOWL CARD ${code}]`,
      `[/ KNOWL CARD ${code}]`, `[KNOWL\u200bCARD ${code}]`, `[KNOWL\nCARD ${code}]`, `\uFF3B\uFF0FKNOWL CARD ${code}]`,
    ];
    for (const form of forms) {
      const out = stripCardMarkers(form);
      expect(out, JSON.stringify(form)).not.toContain(code);
      expect(out, JSON.stringify(form)).toContain('KNOWL-CARD');
    }
  });

  it('keeps the note inside its budget and names the code and the excluded tools', () => {
    const code = newCardCode();
    const note = cardTrustNote(code);
    expect(note.length).toBeLessThanOrEqual(NOTE_MAX);
    expect(note).toContain(code);
    for (const tool of ['knowl_skill_run', 'knowl_gc_apply', 'knowl_ingest']) {
      expect(note).toContain(tool);
    }
  });
});
