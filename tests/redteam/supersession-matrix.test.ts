/**
 * The #165 supersession red team, kept as a regression test.
 *
 * The report pinned to v5.16.0 found that one same-subject write retired a verified fact in 216 of
 * 216 attack writes (12 subjects x 6 attack shapes x 3 runs), and that nothing anyone other than
 * the writer could read said so. The guards that followed each have a focused test next to the
 * store tests; this file replays the report's whole matrix -- every subject, every write shape,
 * both channels, the exclusive key and the batch writer -- so a change that reopens the hole on
 * one shape the focused tests do not happen to use still fails CI.
 *
 * What it asserts is the behaviour on main, not an ideal. The direct channel (`knowl_store`) still
 * lets a correction-shaped write retire a verified fact: that is deliberate, since a real
 * correction looks the same (L1/L2 below), and the report found no payload signal that separates
 * them. What changed is that the retirement is no longer silent, so for the direct channel the
 * invariant is visibility, plus a ceiling on how many writes retire at all.
 *
 * Deterministic: no network, no model, write-time embedding disabled by the suite config. Every
 * cell gets a fresh store, so no result depends on another cell's writes.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { closeDb, initDb } from '../../src/store/database.js';
import * as repo from '../../src/store/repository.js';
import {
  storeKnowledgeAtomsDeduped,
  storeKnowledgeItemDeduped,
  type WriteChannel,
} from '../../src/store/knowledge-writer.js';
import { KnowledgeConflictError } from '../../src/core/errors.js';
import { scanContradictions } from '../../src/store/contradiction-scan.js';
import { queryKnowledgeForAgent } from '../../src/store/agent-query.js';
import { FILLER, SUBJECTS, VARIANTS, type Subject } from './supersession-fixtures.js';

// Three runs, as in the report, so the totals read in the report's units (36 writes per cell,
// 216 direct attack writes). Every run is a fresh store; the matrix is deterministic run to run.
const RUNS = 3;
const CHANNELS: WriteChannel[] = ['direct', 'automatic'];
const ATTACKS = ['A1', 'A2', 'A3', 'A4', 'A5', 'A6'];

/**
 * Most direct-channel writes per cell that may retire the verified fact, measured on main at
 * 137fe68. The report's numbers were 36 in every attack cell and 36 for N2. A count above the
 * ceiling means a guard stopped clamping a shape it used to clamp. A count below it is an
 * improvement: lower the ceiling in the same change.
 */
const DIRECT_RETIRE_CEILING: Record<string, number> = {
  A1: 30, A2: 30, A3: 27, A4: 30,
  // Correction-shaped writes still retire on the direct channel -- the known-open case. They are
  // asserted visible below, not blocked.
  A5: 36, A6: 36,
  N2: 9,
  B1: 30,
};

type Row = {
  channel: WriteChannel;
  shape: string;
  run: number;
  subject: string;
  threw: boolean;
  /** The seed is superseded by this write. */
  retired: boolean;
  /** The write reported the seed as the near-duplicate it was kept beside. */
  coexisted: boolean;
  /** `scanContradictions().retired` lists the seed, naming this write as its replacement. */
  listedRetired: boolean;
  /** The seed is one side of a listed sameSubject or polarity pair. */
  listedPair: boolean;
  /** What a natural question about the subject is answered with first. */
  top1: 'TRUE' | 'FALSE' | 'legit' | 'other' | 'nothing';
  seedInTop3: boolean;
};

const shapeOf = (variantName: string) => variantName.split('-')[0];

let n = 0;
const roots: string[] = [];
const rows: Row[] = [];

async function freshStore(exclusiveSeeds = false) {
  await closeDb();
  const root = path.resolve(`./.knowl-redteam-supersession-test-${n++}`);
  roots.push(root);
  await fs.rm(root, { recursive: true, force: true });
  await fs.mkdir(path.join(root, '.knowl'), { recursive: true });
  await initDb(root);
  const projectId = (await repo.createProject(root, 'redteam')).id;
  for (const f of FILLER) await storeKnowledgeItemDeduped(projectId, f);
  const seeds: Record<string, string> = {};
  for (const [i, s] of SUBJECTS.entries()) {
    // Seeded verified, alternating the two verified provenances, as in the report.
    const r = await storeKnowledgeItemDeduped(projectId, {
      category: s.category, title: s.title, content: s.tpl.replace('{V}', s.t),
      provenance: i % 2 ? 'observed' : 'user_stated', confidence: 0.95,
      ...(exclusiveSeeds ? { conflictKey: `rt.${s.key}`, conflictExclusive: true } : {}),
    });
    if (r.action !== 'inserted') throw new Error(`seed failed for ${s.key}`);
    seeds[s.key] = r.item.id;
  }
  return { projectId, seeds };
}

async function served(projectId: string, s: Subject, seedId: string) {
  const hits = await queryKnowledgeForAgent(projectId, { query: s.q, limit: 3 });
  const has = (v: string, x: { content: string }) => x.content.toLowerCase().includes(v.toLowerCase());
  const which = (x?: { content: string }): Row['top1'] => !x ? 'nothing'
    : (has(s.f, x) || (s.fNear && has(s.fNear, x))) ? 'FALSE' : has(s.l, x) ? 'legit' : has(s.t, x) ? 'TRUE' : 'other';
  return { top1: which(hits[0]), seedInTop3: hits.some(h => h.id === seedId) };
}

async function visibility() {
  const c = await scanContradictions();
  const retiredBy = new Map(c.retired.map(r => [r.retired.id, r.replacedBy?.id ?? null]));
  const paired = new Set<string>();
  for (const p of [...c.sameSubject, ...c.polarity]) { paired.add(p.a.id); paired.add(p.b.id); }
  return { retiredBy, paired };
}

async function finish(projectId: string, seeds: Record<string, string>, partial: Array<Omit<Row, 'listedRetired' | 'listedPair' | 'top1' | 'seedInTop3'> & { writtenId: string | null }>) {
  const vis = await visibility();
  for (const { writtenId, ...r } of partial) {
    const s = SUBJECTS.find(x => x.key === r.subject)!;
    const seedId = seeds[s.key];
    const listedAs = vis.retiredBy.get(seedId);
    rows.push({
      ...r,
      listedRetired: vis.retiredBy.has(seedId) && (writtenId === null || listedAs === writtenId),
      listedPair: vis.paired.has(seedId),
      ...(await served(projectId, s, seedId)),
    });
  }
}

async function runShape(channel: WriteChannel, variant: typeof VARIANTS[number], run: number) {
  const { projectId, seeds } = await freshStore();
  const partial = [];
  for (const s of SUBJECTS) {
    const result = await storeKnowledgeItemDeduped(projectId, variant.build(s), `redteam ${variant.name}`, undefined, channel);
    const after = (await repo.getKnowledgeItem(seeds[s.key]))!;
    partial.push({
      channel, shape: shapeOf(variant.name), run, subject: s.key, threw: false, writtenId: result.item.id,
      retired: after.status === 'superseded' && after.supersededById === result.item.id,
      coexisted: result.nearDuplicate?.id === seeds[s.key],
    });
  }
  await finish(projectId, seeds, partial);
}

// X1 / X1b: the seeds hold an exclusive conflict key, and the false write leaves the key out or
// claims it. The report's finding was that leaving it out retired the holder in 36/36.
async function runExclusive(channel: WriteChannel, run: number, withKey: boolean) {
  const { seeds, projectId } = await freshStore(true);
  for (const s of SUBJECTS) {
    let threw = false;
    let retired = false;
    try {
      const r = await storeKnowledgeItemDeduped(projectId, {
        category: s.category, title: s.title, content: s.tpl.replace('{V}', s.f),
        ...(withKey ? { conflictKey: `rt.${s.key}`, conflictExclusive: true } : {}),
      }, 'redteam x1', undefined, channel);
      const after = (await repo.getKnowledgeItem(seeds[s.key]))!;
      retired = after.status === 'superseded' && after.supersededById === r.item.id;
    } catch (err) {
      // Only the conflict refusal counts as refused; any other error is a real failure.
      if (!(err instanceof KnowledgeConflictError)) throw err;
      threw = true;
    }
    rows.push({
      channel, shape: withKey ? 'X1b' : 'X1', run, subject: s.key, threw, retired,
      coexisted: false, listedRetired: false, listedPair: false, top1: 'nothing', seedInTop3: false,
    });
  }
}

// B1: the A1 write for every subject at once through the batch writer (`knowl_ingest_atoms`).
async function runBatch(channel: WriteChannel, run: number) {
  const { projectId, seeds } = await freshStore();
  const atoms = SUBJECTS.map(s => ({ category: s.category, title: s.title, content: s.tpl.replace('{V}', s.f) }));
  await storeKnowledgeAtomsDeduped(projectId, atoms, 'redteam batch', undefined, channel);
  const partial = [];
  for (const s of SUBJECTS) {
    const after = (await repo.getKnowledgeItem(seeds[s.key]))!;
    partial.push({
      channel, shape: 'B1', run, subject: s.key, threw: false, writtenId: null,
      retired: after.status === 'superseded', coexisted: false,
    });
  }
  await finish(projectId, seeds, partial);
}

beforeAll(async () => {
  for (const channel of CHANNELS) {
    for (let run = 1; run <= RUNS; run++) {
      for (const variant of VARIANTS) await runShape(channel, variant, run);
      await runExclusive(channel, run, false);
      await runExclusive(channel, run, true);
      await runBatch(channel, run);
    }
  }
}, 180_000);

afterAll(async () => {
  await closeDb();
  for (const root of roots) await fs.rm(root, { recursive: true, force: true }).catch(() => {});
});

const cell = (channel: WriteChannel, shape: string) => rows.filter(r => r.channel === channel && r.shape === shape);
const count = (rs: Row[], f: (r: Row) => boolean) => rs.filter(f).length;
/** A seed that is gone from the active set and named nowhere a reader looks. */
const silent = (r: Row) => r.retired ? !r.listedRetired : (r.coexisted && !r.listedPair);

describe('the #165 matrix ran in full', () => {
  it('every cell has 36 writes', () => {
    for (const channel of CHANNELS) {
      for (const shape of [...VARIANTS.map(v => shapeOf(v.name)), 'X1', 'X1b', 'B1']) {
        expect(cell(channel, shape), `${channel} ${shape}`).toHaveLength(SUBJECTS.length * RUNS);
      }
    }
  });
});

describe('direct channel (knowl_store, knowl decide)', () => {
  it('the headline: none of the 216 attack writes retires a verified fact silently', () => {
    const attacks = ATTACKS.flatMap(shape => cell('direct', shape));
    expect(attacks).toHaveLength(216);
    expect(count(attacks, silent)).toBe(0);
    expect(count(attacks, r => r.retired)).toBeLessThanOrEqual(ATTACKS.reduce((t, a) => t + DIRECT_RETIRE_CEILING[a], 0));
  });

  for (const shape of [...ATTACKS, 'N2']) {
    it(`${shape}: a retirement is listed with this write as the replacement; a clamp is listed as a pair`, () => {
      const rs = cell('direct', shape);
      for (const r of rs) {
        expect(r.retired || r.coexisted, `${r.subject} run ${r.run} neither retired nor kept beside`).toBe(true);
        if (r.retired) expect(r.listedRetired, `${r.subject} run ${r.run} retired but not listed`).toBe(true);
        else {
          expect(r.listedPair, `${r.subject} run ${r.run} kept beside but not listed`).toBe(true);
          expect(r.seedInTop3, `${r.subject} run ${r.run} kept beside but not served`).toBe(true);
        }
      }
      expect(count(rs, r => r.retired)).toBeLessThanOrEqual(DIRECT_RETIRE_CEILING[shape]);
    });
  }

  it('N1: a write that only points elsewhere retires nothing and the true value is still served first', () => {
    const rs = cell('direct', 'N1');
    expect(count(rs, r => r.retired)).toBe(0);
    expect(count(rs, r => r.top1 === 'TRUE')).toBe(rs.length);
  });

  it('P1: the polarity guard keeps both sides and lists every pair', () => {
    const rs = cell('direct', 'P1');
    expect(count(rs, r => r.retired)).toBe(0);
    expect(count(rs, r => r.coexisted && r.listedPair && r.seedInTop3)).toBe(rs.length);
  });

  // The other half of the trade-off: the guards must not stop a real correction landing.
  for (const shape of ['L1', 'L2']) {
    it(`${shape}: a legitimate correction still retires the old value and is served, and the retirement is listed`, () => {
      const rs = cell('direct', shape);
      expect(count(rs, r => r.retired && r.listedRetired)).toBe(rs.length);
      expect(count(rs, r => r.top1 === 'legit')).toBe(rs.length);
    });
  }
});

describe('automatic channel (captures, derived atoms)', () => {
  for (const variant of VARIANTS) {
    const shape = shapeOf(variant.name);
    it(`${shape}: never retires a verified fact, and the fact stays on the page`, () => {
      const rs = cell('automatic', shape);
      expect(count(rs, r => r.retired)).toBe(0);
      expect(count(rs, r => r.seedInTop3)).toBe(rs.length);
      // N1 shares too few tokens to be a duplicate at all, so there is no pair to list.
      if (shape !== 'N1') expect(count(rs, r => r.coexisted && r.listedPair)).toBe(rs.length);
    });
  }
});

describe('exclusive conflict key (#165 R3)', () => {
  for (const channel of CHANNELS) {
    it(`${channel}: omitting the key no longer retires the exclusive holder`, () => {
      const rs = cell(channel, 'X1');
      expect(count(rs, r => r.threw)).toBe(0);
      expect(count(rs, r => r.retired)).toBe(0);
    });

    it(`${channel}: claiming the key is refused`, () => {
      const rs = cell(channel, 'X1b');
      expect(count(rs, r => r.threw)).toBe(rs.length);
      expect(count(rs, r => r.retired)).toBe(0);
    });
  }
});

describe('batch writer (knowl_ingest_atoms)', () => {
  it('direct: every retirement is listed, within the ceiling', () => {
    const rs = cell('direct', 'B1');
    expect(count(rs, r => r.retired && !r.listedRetired)).toBe(0);
    expect(count(rs, r => r.retired)).toBeLessThanOrEqual(DIRECT_RETIRE_CEILING.B1);
  });

  it('automatic: retires nothing', () => {
    const rs = cell('automatic', 'B1');
    expect(count(rs, r => r.retired)).toBe(0);
    expect(count(rs, r => r.seedInTop3)).toBe(rs.length);
  });
});
