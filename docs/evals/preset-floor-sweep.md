# Preset sweep for the relevance floor — 2026-08-24

Issue [#169](https://github.com/dat999zx/knowl/issues/169) reports that the relevance floor cannot
be tuned on `granite-small-en-r2`, because its on-topic and off-topic cosine distributions had
already crossed — on-topic min 0.7637 against off-topic max 0.7644 — when 0.76 was calibrated in
[`per-model-floor.md`](per-model-floor.md). It names three directions, and calls the second the
cheapest by far:

> **Change the default preset.** Cheapest by far if the recall numbers hold — every other preset
> has a wider gap. Needs a recall sweep before anyone believes it.

This is that sweep. **The conclusion is that direction 2 is dead**: `granite-small-en-r2` is
already the best of the five presets on the property the floor needs, and moving the default would
make the problem worse while also costing recall.

Reproduce with `npx tsx scripts/sweep-preset-floor.ts --json out.json`. Raw output:
[`preset-floor-sweep-2026-08-24.json`](preset-floor-sweep-2026-08-24.json).

## What changed in the method, and why it matters more than the numbers

`per-model-floor.md` measured off-topic with 15 consumer probes — sourdough, the capital of Peru,
hiking in Patagonia. The 50 semantic-suite fixtures are generic backend-SaaS engineering, so that
class is trivially far from the corpus. **It is a smoke test, not a hazard.**

The hazard #169 actually reproduces is a *technical* query about a subject the store does not hold:
`kubernetes ingress nginx tls renewal` scoring 0.7928 against a store that knew only about billing
and refunds. Same register as the corpus, different subject. That is the query an integrator really
sends, and no consumer probe stands in for it.

So this sweep runs **two off-topic classes**, 15 each: `general` (the original consumer class) and
`technical` (iOS, gamedev, ML training, embedded, compilers, 3D, media, typesetting, plotting,
audio, HDL — each a domain absent from the fixture list). Deliberately excluded from the technical
class: Kafka rebalancing, SQL window functions, CDN cache headers. Those are adjacent to
`queue-retry`, `db-postgres` and `cdn-assets`, so a high cosine there is arguably correct and would
flatter the floor rather than test it.

Two other departures from `per-model-floor.md`, both of which move absolute numbers: the suite is
135 cases now rather than 110, and its 15 original probes were never written down verbatim (three
are quoted, the rest are an ellipsis), so the `general` class here is a reconstruction. **Absolute
cosines are therefore not comparable to that document row for row.** Every preset in this run sees
an identical corpus and identical probes, so the comparison *between* presets holds, and that is
the question #169 asks.

## 1. The gap, split by junk class

| preset | on min | general max | gap vs general | technical max | **gap vs technical** |
| --- | --- | --- | --- | --- | --- |
| arctic-embed-m-v2 | 0.1638 | 0.2201 | -0.0563 | 0.2893 | **-0.1255** |
| granite-small-en-r2 *(default)* | 0.7637 | 0.7439 | +0.0198 | 0.7888 | **-0.0251** |
| granite-97m-multilingual | 0.7443 | 0.7363 | +0.0081 | 0.8026 | **-0.0582** |
| bge-small-en | 0.5399 | 0.5787 | -0.0388 | 0.6509 | **-0.1110** |
| minilm-l6-en | 0.2003 | 0.1901 | +0.0102 | 0.3620 | **-0.1617** |

**Every preset has a negative gap against technical junk. Not one of the five separates the
distributions.** The positive `general` gaps are what `per-model-floor.md` was measuring, and they
are an artifact of the junk class being too easy.

Worst technical probe per preset:

- arctic-embed-m-v2: `kubernetes ingress nginx tls renewal` — 0.2893
- granite-small-en-r2: `pytorch dataloader num_workers deadlock on fork` — 0.7888
- granite-97m-multilingual: `ableton sidechain compression routing` — 0.8026
- bge-small-en: `verilog blocking versus nonblocking assignment` — 0.6509
- minilm-l6-en: `pytorch dataloader num_workers deadlock on fork` — 0.3620

## 2. Overlap size — the scale-free version of the same table

Gap magnitudes are **not comparable across models**, because each model has its own cosine scale;
granite's whole distribution sits ~0.5 above arctic's on identical inputs. `per-model-floor.md`
already measured and rejected scale-free threshold rules for this reason. The comparable quantity
is a count: how many real queries score at or below the single best piece of technical junk.

| preset | on p05 | on min | technical max | on-topic cases buried under it |
| --- | --- | --- | --- | --- |
| arctic-embed-m-v2 | 0.2439 | 0.1638 | 0.2893 | 21/135 (16%) |
| **granite-small-en-r2** *(default)* | 0.7767 | 0.7637 | 0.7888 | **14/135 (10%)** |
| granite-97m-multilingual | 0.7682 | 0.7443 | 0.8026 | 33/135 (24%) |
| bge-small-en | 0.5929 | 0.5399 | 0.6509 | 30/135 (22%) |
| minilm-l6-en | 0.2545 | 0.2003 | 0.3620 | 27/135 (20%) |

**The current default has the smallest overlap of the five, by a factor of two against three of
them.** The presets #169 identified as having "more room than the default" — bge-small-en at 0.0355
and minilm-l6-en at 0.0389 — are 22% and 20% here against granite-small's 10%. Their wider gaps
were wider only against consumer junk.

## 3. What the shipped floors actually do

| preset | floor | false abstentions | junk caught (all 30) | technical junk caught (15) |
| --- | --- | --- | --- | --- |
| arctic-embed-m-v2 | 0.16 | 0/135 | 14/30 | 2/15 |
| granite-small-en-r2 | 0.76 | 0/135 | 23/30 | 8/15 |
| granite-97m-multilingual | 0.74 | 0/135 | 24/30 | 9/15 |
| bge-small-en | 0.53 | 0/135 | 13/30 | **0/15** |
| minilm-l6-en | 0.20 | 0/135 | 23/30 | 8/15 |

No preset costs a false abstention on this suite, so the floors are all safely placed on the
recall side. What they differ in is how much junk they stop. `bge-small-en` stops **none** of the
technical class. Only `granite-97m-multilingual` beats the default, by one probe.

## 4. Recall, at each preset's own shipped floor

| preset | size | R@3 | R@10 | MRR | nDCG |
| --- | --- | --- | --- | --- | --- |
| arctic-embed-m-v2 | 305MB | 0.9481 | 0.9778 | 0.8942 | 0.9151 |
| granite-small-en-r2 | 52MB | 0.9185 | 0.9778 | 0.8701 | 0.8965 |
| granite-97m-multilingual | 98MB | 0.8889 | 0.9481 | 0.8556 | 0.8780 |
| bge-small-en | 34MB | 0.8889 | 0.9778 | 0.8619 | 0.8897 |
| minilm-l6-en | 23MB | 0.9111 | 0.9852 | 0.8741 | 0.9009 |

`granite-97m-multilingual` is the only preset that catches more technical junk than the default,
and it pays R@3 0.8889 against 0.9185 and carries the worst overlap in the table (24%). It is a
worse trade in both directions at once.

`arctic-embed-m-v2` has the best recall, as `model-and-dtype-2026-08-04.md` found, and it is not a
floor candidate: 2/15 technical junk caught.

## Conclusion

**Direction 2 of #169 is closed.** There is no preset to move to. `granite-small-en-r2` already has
the smallest on/off-topic overlap of the five and the second-best technical-junk catch rate at the
best recall of any preset that catches anything, so a swap trades recall away for a worse floor.

The finding underneath is larger than the preset question, and is what the issue should carry
forward: **the overlap is not a property of `granite-small-en-r2`. It is a property of embedding
cosine as a relevance signal for this corpus.** Five models with three different cosine scales, two
different pooling strategies and a 13x parameter spread all fail the same way on the same class of
query. That is not a model-selection problem, which leaves #169's other two directions:

1. **A relative signal instead of an absolute one** — best-vs-second-best margin, or the store's own
   self-similarity distribution measured at index time. Untouched by this sweep and now the only
   direction with evidence behind it, since the failure survives every model.
3. **Accept it per-model** — ship `relevanceFloor: null` and document that the store cannot answer
   the does-this-store-hold-it question. Still honest, still worse for integrators.

One caution for whoever takes direction 1: the technical class here is 15 probes against 50
fixtures. It is enough to show that all five presets fail, because they fail by margins far wider
than that sample can explain, but it is **not** enough to calibrate a relative rule against. That
needs a larger technical junk set and a real store.
