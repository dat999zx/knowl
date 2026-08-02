#!/usr/bin/env node
/**
 * Generates `docs/evals/retrieval-suite-v2.json`.
 *
 * Why a generator rather than a checked-in blob: the suite this replaces was hand-written, and
 * counting it was the only way to discover it could not measure what we were using it for --
 * 0 of its 506 expected items were stale, so every increase to the freshness penalty scored as
 * free. A benchmark whose construction is a script can be audited by reading the rules; one
 * that is 2,000 hand-written objects cannot.
 *
 * Deterministic: a seeded PRNG, no Date.now(), no Math.random(). Re-running produces byte
 * identical output, so a diff means someone changed the rules.
 *
 * ## What this suite is for
 *
 * Not to replace `retrieval-suite.json`. That one stays as the regression guard whose numbers
 * every historical measurement is quoted against. This one exists to *discriminate*, which the
 * old one no longer can: it sits at Recall@10 0.996, so a change has almost no room to show up.
 *
 * ## The case types, and what each one can catch
 *
 * - `direct`        — keywords from the title. The easy baseline; if these break, something is
 *                     badly wrong.
 * - `paraphrase`    — asks for the same fact with deliberately minimal token overlap. Fails if
 *                     the semantic path stops working; BM25 alone cannot answer these.
 * - `identifier`    — an exact symbol, path or config key. The mirror image: the embedder
 *                     smears rare identifiers, so these fail if lexical evidence is discarded.
 *                     This is the family that the fusion gate silently broke.
 * - `disambiguate`  — two near-identical fixtures differing in one detail, and a query that
 *                     names that detail. Fails when ranking is dominated by topic similarity.
 * - `stale-excluded`— a superseded fact with a fresh replacement. The stale one must not appear.
 * - `stale-required`— **the half the old suite was missing.** A stale fact with no replacement,
 *                     which is still the only answer. It must be returned. A freshness penalty
 *                     tuned only against `stale-excluded` will bury these, and the old suite had
 *                     no way to notice.
 * - `review-required` — same shape for `needs_review`, which is a weaker signal than stale and
 *                     should cost even less.
 * - `multi`         — several correct answers; measures whether recall degrades past the first.
 *                     Every expected set is derived from a property the fixtures actually share
 *                     (a service's stated datastore, a config key's suffix, an error code's
 *                     family), never from a random sample -- see the note above that section.
 *
 * ## Measured baseline, so a later run has something to compare against
 *
 * At `BM25_LEXICAL_WEIGHT` 3.0 and a stale rerank of -0.05 (the settings shipped in 2.11.1):
 * Recall@3 0.9650, Recall@10 0.9891, MRR 0.9050, nDCG 0.9252, 153 failures.
 *
 * Sweeping the stale penalty shows the trade this suite exists to expose, and which
 * `retrieval-suite.json` reports as free in both directions:
 *
 * | stale rerank | Recall@10 | MRR | `sup` failures | `orphan` failures | stale hits |
 * | --- | --- | --- | --- | --- | --- |
 * | -0.05 | 0.9891 | 0.9050 | 78 | 1 | 1169 |
 * | -0.15 | 0.9872 | 0.9062 | 69 | 5 | 715 |
 * | -0.25 | 0.9812 | 0.8921 | 47 | 15 | 537 |
 *
 * `sup` falls and `orphan` rises together: suppressing superseded facts harder also buries the
 * legacy facts nothing has replaced. The old suite contains only the first kind, so it scores
 * the whole curve as improvement.
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const OUT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'docs', 'evals', 'retrieval-suite-v2.json');

/** Mulberry32. Small, deterministic, and sufficient for shuffling word lists. */
function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const rand = rng(20260801);
const pick = (list) => list[Math.floor(rand() * list.length) % list.length];
const some = (list, n) => {
  const copy = [...list];
  const out = [];
  while (out.length < n && copy.length) out.push(copy.splice(Math.floor(rand() * copy.length), 1)[0]);
  return out;
};

const fixtures = [];
const cases = [];
const add = (fixture) => { fixtures.push(fixture); return fixture.id; };
const ask = (id, query, expectedItemIds, mustNotReturn = [], limit = 10) =>
  cases.push({ id, query, expectedItemIds, mustNotReturn, limit });

// ---------------------------------------------------------------------------
// Vocabulary. Kept deliberately domain-flavoured rather than lorem-ipsum: retrieval over text
// that shares no structure with real notes would measure the generator, not the ranker.
// ---------------------------------------------------------------------------

const SERVICES = [
  ['cart', 'shopping cart', 'holds a shopper\'s selected items and pricing until checkout'],
  ['checkout', 'checkout orchestration', 'sequences payment authorisation, stock reservation and order creation'],
  ['catalogue', 'product catalogue', 'serves product records, media references and category trees'],
  ['pricing', 'price resolution', 'resolves list price, promotions and per-customer contract rates'],
  ['inventory', 'stock levels', 'tracks on-hand and reserved quantity per warehouse'],
  ['fulfilment', 'order fulfilment', 'assigns orders to warehouses and emits picking instructions'],
  ['shipping', 'carrier integration', 'quotes carriers, buys labels and tracks parcels'],
  ['returns', 'returns handling', 'authorises returns, issues labels and triggers refunds'],
  ['payments', 'payment capture', 'authorises, captures and refunds against payment providers'],
  ['invoicing', 'invoice generation', 'produces invoices and credit notes for completed orders'],
  ['tax', 'tax calculation', 'computes VAT and sales tax per destination and product class'],
  ['identity', 'customer identity', 'owns accounts, credentials and session issuance'],
  ['permissions', 'access control', 'evaluates role and scope grants for internal tools'],
  ['notifications', 'customer messaging', 'sends transactional email, SMS and push'],
  ['search', 'product search', 'serves the storefront query index and autocomplete'],
  ['recommendations', 'recommendation feed', 'ranks related and personalised product suggestions'],
  ['reviews', 'customer reviews', 'accepts, moderates and aggregates product ratings'],
  ['loyalty', 'loyalty points', 'accrues and redeems points against qualifying orders'],
  ['giftcards', 'gift card balances', 'issues gift cards and applies balances at checkout'],
  ['subscriptions', 'recurring orders', 'schedules and bills repeating deliveries'],
  ['warehouse', 'warehouse operations', 'exposes picking, packing and stock-move endpoints'],
  ['procurement', 'supplier purchasing', 'raises purchase orders against supplier catalogues'],
  ['suppliers', 'supplier records', 'holds supplier terms, lead times and contacts'],
  ['reporting', 'analytics extracts', 'builds nightly extracts for the analytics warehouse'],
  ['audit', 'audit trail', 'records who changed what across internal tooling'],
  ['imports', 'bulk import', 'ingests supplier feeds and merchant spreadsheets'],
  ['exports', 'bulk export', 'produces merchant-facing data exports on request'],
  ['media', 'image pipeline', 'transcodes and serves product imagery at request-time sizes'],
  ['sessions', 'session store', 'holds browser session state for signed-in shoppers'],
  ['config', 'runtime configuration', 'serves feature flags and tuning values to every service'],
];

// A second tranche, kept separate only so the first stays readable. Same shape.
SERVICES.push(
  ['ledger', 'financial ledger', 'records double-entry postings for every money movement'],
  ['settlement', 'merchant settlement', 'aggregates captures and pays out to merchant accounts'],
  ['disputes', 'chargeback handling', 'tracks disputes and assembles evidence bundles'],
  ['risk', 'fraud scoring', 'scores orders for fraud before authorisation'],
  ['kyc', 'merchant verification', 'runs identity and business checks on new merchants'],
  ['pricing-rules', 'promotion rules', 'evaluates promotion eligibility against a rule tree'],
  ['bundles', 'product bundles', 'expands bundle SKUs into component lines at checkout'],
  ['wishlist', 'saved items', 'stores shopper wishlists and back-in-stock intents'],
  ['addresses', 'address book', 'normalises and validates shipping addresses'],
  ['geo', 'geolocation', 'maps requests to a storefront region and currency'],
  ['currency', 'currency conversion', 'applies daily FX rates to non-base-currency orders'],
  ['translations', 'content localisation', 'serves translated product copy per locale'],
  ['seo', 'storefront metadata', 'generates canonical URLs, sitemaps and structured data'],
  ['banners', 'merchandising slots', 'schedules promotional banners per storefront region'],
  ['abtests', 'experiment assignment', 'assigns shoppers to experiment variants deterministically'],
  ['consent', 'cookie consent', 'records tracking consent per shopper and jurisdiction'],
  ['gdpr', 'data subject requests', 'coordinates export and erasure across every store'],
  ['webhooks', 'partner webhooks', 'delivers and retries outbound event callbacks'],
  ['scheduler', 'job scheduling', 'triggers recurring work across the estate'],
  ['ratelimiter', 'edge rate limiting', 'enforces per-key request budgets at the edge'],
  ['featureflags-svc', 'flag evaluation', 'evaluates feature flags with per-shopper targeting'],
  ['secrets-svc', 'secret distribution', 'delivers rotated credentials to running workloads'],
  ['telemetry', 'metric ingestion', 'accepts and aggregates service metrics'],
  ['logpipe', 'log shipping', 'ships, parses and routes structured logs'],
  ['costs', 'cloud cost attribution', 'attributes infrastructure spend to owning teams'],
  ['onboarding', 'merchant onboarding', 'guides a new merchant through activation steps'],
  ['support', 'support tooling', 'gives agents order lookup and refund controls'],
  ['sla', 'delivery promises', 'computes the delivery date shown at checkout'],
  ['packaging', 'packaging selection', 'chooses carton sizes to minimise volumetric cost'],
  ['carbon', 'emissions estimates', 'estimates per-shipment carbon for the storefront badge'],
);

const RUNTIMES = ['Node.js 22', 'Go 1.23', 'Python 3.12', 'Java 21', 'Rust 1.80', 'Kotlin on JVM 21', '.NET 8'];
const PLATFORMS = ['EKS in eu-west-1', 'ECS Fargate in eu-west-1', 'Cloud Run in europe-west4', 'Nomad in the Frankfurt DC', 'EKS in us-east-1', 'Lambda behind an HTTP API'];
const STORES = ['PostgreSQL 16', 'DynamoDB', 'Redis 7', 'ClickHouse', 'MongoDB 7', 'Cassandra 5', 'Aurora Serverless v2', 'S3 with Athena over it'];
const TRANSPORTS = ['gRPC', 'REST over HTTP/2', 'GraphQL', 'SQS-backed async messaging', 'Kafka topics', 'NATS request/reply'];
const TEAMS = ['storefront', 'fulfilment', 'platform', 'payments', 'growth', 'data', 'security', 'merchant'];

// ---------------------------------------------------------------------------
// Services: one architecture fixture each, plus direct / paraphrase / identifier queries.
// ---------------------------------------------------------------------------

const serviceFacts = [];
for (const [slug, label, purpose] of SERVICES) {
  const runtime = pick(RUNTIMES);
  const platform = pick(PLATFORMS);
  const store = pick(STORES);
  const transport = pick(TRANSPORTS);
  const team = pick(TEAMS);
  serviceFacts.push({ slug, label, runtime, platform, store, transport, team });
  const id = add({
    id: `svc-${slug}`,
    category: 'architecture',
    title: `${label} service (svc-${slug})`,
    content: `svc-${slug} ${purpose}. It runs ${runtime} on ${platform}, persists to ${store}, and is called over ${transport}. Owned by the ${team} team.`,
    tags: ['service', slug, 'architecture'],
  });

  ask(`svc-${slug}-direct`, `${label} service`, [id]);
  ask(`svc-${slug}-para`, `which component ${purpose.split(' ').slice(0, 6).join(' ')}`, [id]);
  ask(`svc-${slug}-ident`, `svc-${slug}`, [id]);
  ask(`svc-${slug}-owner`, `who owns ${label}`, [id]);
  ask(`svc-${slug}-runtime`, `what does ${label} run on`, [id]);
  ask(`svc-${slug}-store`, `where does ${label} store data`, [id]);
  ask(`svc-${slug}-transport`, `how is ${label} called`, [id]);
}

// ---------------------------------------------------------------------------
// Config keys. Pure identifier retrieval -- the family the embedder is worst at, because a key
// like `checkout.reservation.ttl_seconds` carries almost no distributional meaning.
// ---------------------------------------------------------------------------

const CONFIG = [
  ['checkout.reservation.ttl_seconds', '900', 'how long stock stays reserved before the cart releases it'],
  ['payments.authorisation.retry_limit', '3', 'attempts against the payment provider before failing the order'],
  ['search.index.refresh_interval_ms', '2000', 'delay before catalogue edits become searchable'],
  ['identity.session.idle_timeout_minutes', '30', 'idle time before a shopper session is invalidated'],
  ['identity.jwt.ttl_minutes', '15', 'lifetime of an issued access token'],
  ['identity.refresh.ttl_days', '30', 'lifetime of a refresh token'],
  ['media.transcode.max_edge_px', '2048', 'largest image edge the pipeline will produce'],
  ['imports.batch.max_rows', '50000', 'rows accepted in a single supplier feed batch'],
  ['notifications.email.rate_per_second', '120', 'outbound transactional email ceiling'],
  ['inventory.reservation.grace_seconds', '45', 'grace period before a reservation is reaped'],
  ['pricing.promotion.max_stack_depth', '2', 'promotions that may combine on one line'],
  ['shipping.quote.timeout_ms', '1200', 'carrier quote timeout before falling back to flat rate'],
  ['returns.window_days', '28', 'days a customer may raise a return'],
  ['loyalty.points.expiry_months', '18', 'months before unused points lapse'],
  ['reporting.extract.parallelism', '4', 'concurrent extract workers at night'],
  ['warehouse.pick.batch_size', '25', 'orders grouped into one picking run'],
  ['audit.retention_days', '400', 'days audit records are kept before archival'],
  ['sessions.store.max_bytes', '65536', 'ceiling on a single session payload'],
  ['catalogue.cache.ttl_seconds', '60', 'how long product reads may be served from cache'],
  ['subscriptions.retry.backoff_hours', '6', 'delay before retrying a failed recurring charge'],
];

// A second tranche generated per service, so identifier retrieval is tested across a corpus
// large enough that the right key has real competition from similarly-shaped neighbours.
const SETTINGS = [
  ['timeout_ms', () => String(200 + Math.floor(rand() * 20) * 100), (s) => `how long a call into ${s} may take before it is abandoned`],
  ['max_concurrency', () => String(2 + Math.floor(rand() * 30)), (s) => `how many requests ${s} will process at once per instance`],
  ['queue_depth_limit', () => String(100 * (1 + Math.floor(rand() * 40))), (s) => `the backlog ${s} accepts before shedding load`],
  ['cache_ttl_seconds', () => String(15 * (1 + Math.floor(rand() * 40))), (s) => `how long ${s} may serve a cached read`],
];
// Ids are derived by flattening `.` and `_`, so `a.cache_ttl` and `a.cache.ttl` collide. The
// hand-written keys above win; a generated key that would land on the same id is skipped.
const configId = (key) => `cfg-${key.replace(/[._]/g, '-')}`;
const takenConfigIds = new Set(CONFIG.map(([key]) => configId(key)));
for (const { slug, label } of serviceFacts.slice(0, 26)) {
  for (const [suffix, valueOf, meaningOf] of some(SETTINGS, 2)) {
    const key = `${slug}.${suffix}`;
    if (takenConfigIds.has(configId(key))) continue;
    takenConfigIds.add(configId(key));
    CONFIG.push([key, valueOf(), meaningOf(label)]);
  }
}

for (const [key, value, meaning] of CONFIG) {
  const id = add({
    id: `cfg-${key.replace(/[._]/g, '-')}`,
    category: 'constraint',
    title: `${key} = ${value}`,
    content: `${key} is set to ${value}. It controls ${meaning}. Changing it requires a platform review because it affects checkout conversion.`,
    tags: ['config', key.split('.')[0]],
  });
  ask(`cfg-${key}-ident`, key, [id]);
  ask(`cfg-${key}-value`, `${key} configured value`, [id]);
  ask(`cfg-${key}-para`, `${meaning}`, [id]);
  ask(`cfg-${key}-what`, `what is ${key.split('.').slice(1).join(' ').replace(/_/g, ' ')} for ${key.split('.')[0]}`, [id]);
}

// ---------------------------------------------------------------------------
// Near-duplicate pairs. Same topic, one distinguishing detail, and a query that names it.
// A ranker that scores on topic similarity alone cannot separate these.
// ---------------------------------------------------------------------------

const PAIRS = [
  ['retry', 'retry policy', 'read path', 'write path', 'reads retry three times with jitter', 'writes never retry automatically, because a duplicate write is worse than a failed one'],
  ['timeout', 'request timeout', 'internal calls', 'external calls', 'internal service calls time out at 800ms', 'external provider calls time out at 5s'],
  ['ratelimit', 'rate limit', 'per customer', 'per API key', 'customers are limited to 100 requests per minute', 'partner API keys are limited to 10,000 requests per minute'],
  ['encryption', 'encryption at rest', 'customer data', 'analytics extracts', 'customer records use per-tenant KMS keys', 'analytics extracts use a single shared bucket key'],
  ['backup', 'backup schedule', 'transactional stores', 'analytics stores', 'transactional stores snapshot every 15 minutes', 'analytics stores snapshot nightly'],
  ['deploy', 'deployment strategy', 'stateless services', 'stateful services', 'stateless services deploy blue-green with instant rollback', 'stateful services deploy in-place behind a maintenance flag'],
  ['logging', 'log retention', 'application logs', 'access logs', 'application logs are kept for 14 days', 'access logs are kept for 90 days for compliance'],
  ['cache', 'cache invalidation', 'price changes', 'stock changes', 'price changes invalidate the cache immediately', 'stock changes rely on a 60 second TTL'],
  ['auth', 'authentication', 'staff tools', 'shopper accounts', 'staff tools require SSO with hardware keys', 'shopper accounts use email and password with optional TOTP'],
  ['alerting', 'alert routing', 'business hours', 'out of hours', 'business-hours alerts go to the owning team channel', 'out-of-hours alerts page the on-call rota directly'],
  ['sharding', 'data partitioning', 'orders', 'events', 'orders are partitioned by customer id', 'events are partitioned by day'],
  ['migration', 'schema migration', 'additive changes', 'destructive changes', 'additive changes ship with the service', 'destructive changes require a separate release after a soak period'],
  ['idempotency', 'idempotency handling', 'payment calls', 'catalogue writes', 'payment calls require a caller-supplied idempotency key held for 24 hours', 'catalogue writes are last-write-wins with no idempotency key'],
  ['pii', 'personal data handling', 'shopper records', 'support transcripts', 'shopper records are pseudonymised in every non-production environment', 'support transcripts are excluded from non-production environments entirely'],
  ['approval', 'change approval', 'configuration changes', 'schema changes', 'configuration changes need one reviewer from the owning team', 'schema changes need a reviewer from both the owning team and the data team'],
  ['rollout', 'rollout pacing', 'storefront changes', 'checkout changes', 'storefront changes roll out to 10 percent for an hour before proceeding', 'checkout changes roll out to 1 percent for a full day before proceeding'],
  ['ownership', 'incident ownership', 'customer-facing failures', 'internal tooling failures', 'customer-facing failures are owned by the on-call engineer until resolved', 'internal tooling failures are queued to the owning team the next working day'],
  ['testing', 'test requirements', 'library changes', 'service changes', 'library changes require unit tests only', 'service changes require a contract test against every known consumer'],
  ['quota', 'storage quotas', 'per merchant', 'per shopper', 'merchants are capped at 40GB of product media', 'shoppers are capped at 200 saved items'],
  ['archival', 'archival timing', 'orders', 'support tickets', 'orders are archived after seven years', 'support tickets are archived after two years'],
  ['currency-rounding', 'rounding rules', 'display prices', 'settlement amounts', 'display prices round half up to two decimals', 'settlement amounts truncate to the minor unit and carry the remainder forward'],
  ['access-review', 'access review cadence', 'production access', 'analytics access', 'production access is reviewed monthly', 'analytics access is reviewed twice a year'],
  ['dependency', 'dependency updates', 'security patches', 'major versions', 'security patches are merged automatically once tests pass', 'major versions require a scheduled upgrade slot'],
  ['sampling', 'trace sampling', 'normal traffic', 'error traffic', 'normal traffic is sampled at one percent', 'error traffic is always sampled in full'],
];

for (const [slug, topic, aspectA, aspectB, ruleA, ruleB] of PAIRS) {
  const a = add({
    id: `pair-${slug}-a`,
    category: 'constraint',
    title: `${topic} for ${aspectA}`,
    content: `For ${aspectA}, ${ruleA}. This is the ${topic} that applies to ${aspectA} specifically and does not describe ${aspectB}.`,
    tags: ['policy', slug],
  });
  const b = add({
    id: `pair-${slug}-b`,
    category: 'constraint',
    title: `${topic} for ${aspectB}`,
    content: `For ${aspectB}, ${ruleB}. This is the ${topic} that applies to ${aspectB} specifically and does not describe ${aspectA}.`,
    tags: ['policy', slug],
  });
  ask(`pair-${slug}-a`, `${topic} ${aspectA}`, [a], [b], 3);
  ask(`pair-${slug}-b`, `${topic} ${aspectB}`, [b], [a], 3);
  ask(`pair-${slug}-a-para`, ruleA.split(' ').slice(0, 7).join(' '), [a]);
  ask(`pair-${slug}-b-para`, ruleB.split(' ').slice(0, 7).join(' '), [b]);
  ask(`pair-${slug}-both`, topic, [a, b], [], 10);
}

// ---------------------------------------------------------------------------
// Freshness, both directions. This is the reason the file exists.
// ---------------------------------------------------------------------------

// (1) Superseded: a stale fact WITH a fresh replacement. The stale one must not come back.
const SUPERSEDED = [
  ['queue', 'message transport', 'RabbitMQ', 'Amazon SQS', 'queueing'],
  ['cdn', 'content delivery', 'Fastly', 'CloudFront', 'delivery'],
  ['secrets', 'secret storage', 'HashiCorp Vault', 'AWS Secrets Manager', 'secrets'],
  ['ci', 'continuous integration', 'Jenkins', 'GitHub Actions', 'ci'],
  ['metrics', 'metrics backend', 'Graphite', 'Prometheus', 'observability'],
  ['tracing', 'distributed tracing', 'Zipkin', 'OpenTelemetry with Tempo', 'observability'],
  ['featureflags', 'feature flag service', 'a homegrown table', 'LaunchDarkly', 'delivery'],
  ['email', 'transactional email provider', 'Mandrill', 'Postmark', 'messaging'],
  ['payments-provider', 'payment provider', 'Worldpay', 'Stripe', 'payments'],
  ['imagestore', 'image storage', 'an NFS share', 'S3 with a CloudFront origin', 'media'],
  ['sessionstore', 'session storage', 'sticky sessions on the load balancer', 'Redis with per-region replicas', 'sessions'],
  ['search-engine', 'the search engine', 'Solr', 'OpenSearch', 'search'],
  ['deploy-tool', 'the deployment tool', 'Capistrano scripts', 'Argo CD', 'delivery'],
  ['iac', 'infrastructure definition', 'hand-maintained CloudFormation', 'Terraform with a shared module registry', 'infrastructure'],
  ['logstore', 'log storage', 'Elasticsearch on EC2', 'Loki', 'observability'],
  ['apigw', 'the public API edge', 'nginx on EC2', 'an AWS API Gateway HTTP API', 'infrastructure'],
  ['warehouse-db', 'the analytics warehouse', 'Redshift', 'Snowflake', 'data'],
  ['schema-registry', 'event schema management', 'a wiki page of JSON examples', 'a Confluent schema registry', 'data'],
  ['auth-protocol', 'staff authentication', 'LDAP against the office directory', 'Okta with SAML', 'security'],
  ['mobile-push', 'mobile push delivery', 'a self-hosted APNs bridge', 'Firebase Cloud Messaging', 'messaging'],
];

for (const [slug, topic, oldChoice, newChoice, tag] of SUPERSEDED) {
  const stale = add({
    id: `sup-${slug}-old`,
    category: 'decision',
    title: `${topic}: ${oldChoice}`,
    content: `${topic} is handled by ${oldChoice}. This was the original choice for Northwind and is no longer accurate.`,
    tags: [tag, slug],
    freshness: 'stale',
  });
  const fresh = add({
    id: `sup-${slug}-new`,
    category: 'decision',
    title: `${topic}: ${newChoice}`,
    content: `${topic} is handled by ${newChoice}, which replaced ${oldChoice}. This is the current arrangement.`,
    tags: [tag, slug],
  });
  ask(`sup-${slug}-current`, `${topic} current`, [fresh], [stale], 3);
  ask(`sup-${slug}-what`, topic, [fresh], [stale], 3);
  // Negation. The superseded item is lexically the best match for the old name, which is
  // exactly when a ranker is most tempted to return it.
  ask(`sup-${slug}-still`, `do we still use ${oldChoice}`, [fresh], [stale], 3);
  ask(`sup-${slug}-replaced`, `what replaced ${oldChoice}`, [fresh], [stale], 3);
}

// (2) Orphan stale: a stale fact with NO replacement. It is still the only answer, and it must
//     be returned. The old suite had nothing of this shape, so every increase to the freshness
//     penalty measured as free -- the exact blind spot this file was built to close.
const ORPHAN_STALE = [
  ['legacy-ledger', 'the legacy ledger export', 'A nightly job writes a fixed-width ledger export for the finance mainframe. Nobody has owned it since the finance migration and it has not been reviewed, but it still runs and finance still consumes it.'],
  ['fax-orders', 'fax order intake', 'A small number of wholesale customers still submit orders by fax, which are OCR-ed into the order API by a scheduled task.'],
  ['coupon-v1', 'the version 1 coupon format', 'Coupons issued before the pricing rewrite use an eight character alphanumeric format that the current validator still accepts for historical redemptions.'],
  ['warehouse-terminals', 'the handheld terminal fleet', 'The Bremen warehouse runs Windows CE handhelds against a SOAP endpoint that predates svc-warehouse. Replacement has been deferred twice.'],
  ['tape-archive', 'the offsite tape archive', 'Order records older than seven years are on offsite tape. Restoring one is a manual request to the facilities vendor with a five day turnaround.'],
  ['de-vat-quirk', 'the German VAT rounding quirk', 'German invoices round VAT per line rather than per invoice, a rule carried over from the pre-2019 accounting system that has never been revisited.'],
  ['partner-sftp', 'the partner SFTP drop', 'Two logistics partners collect manifests from an SFTP drop rather than the partner API. Credentials rotate manually once a year.'],
  ['old-loyalty-tiers', 'the grandfathered loyalty tiers', 'Around four thousand accounts hold tier names that no longer exist in the loyalty schema and are mapped at read time.'],
  ['pricelist-excel', 'the wholesale price workbook', 'Wholesale tiers are still maintained in a shared Excel workbook and imported nightly. The pricing service treats it as authoritative for contract customers.'],
  ['cheque-refunds', 'refunds by cheque', 'A handful of pre-2016 orders can only be refunded by cheque because the original payment instrument no longer exists.'],
  ['store-pickup-codes', 'the in-store pickup code scheme', 'Pickup codes use a six digit scheme tied to the old till system. Stores still key them in manually.'],
  ['edi-orders', 'EDI order intake', 'Three grocery chains submit orders over EDI X12 850 documents translated by a vendor gateway.'],
  ['legacy-sitemap', 'the handwritten sitemap', 'A static sitemap file covering discontinued category URLs is still served for SEO continuity.'],
  ['fr-invoice-numbering', 'the French invoice numbering rule', 'French invoices use a separate uninterrupted sequence required by local law, maintained outside the invoicing service.'],
  ['courier-phone-book', 'the courier escalation phone list', 'Escalating a lost parcel with two regional couriers is a phone call to a named contact, kept in a shared document.'],
  ['warehouse-label-printer', 'the Bremen label printer protocol', 'The Bremen site drives label printers over a raw socket protocol rather than the label service.'],
  ['tax-exempt-flags', 'the manual tax exemption flags', 'Around two hundred B2B accounts carry manually set tax exemption flags that no current workflow can produce.'],
  ['legacy-affiliate', 'the original affiliate tracking parameter', 'An older affiliate parameter is still honoured on inbound links for partners who never migrated.'],
  ['dvd-region-codes', 'region coding on physical media', 'Physical media SKUs carry region codes that constrain which storefronts may sell them.'],
  ['paper-catalogue', 'the printed catalogue export', 'A twice-yearly export feeds the printed catalogue layout tool. The format has not changed since 2014.'],
  ['legacy-oauth-app', 'the first-generation partner OAuth app', 'One partner integration still authenticates with a long-lived client credential that predates scoped tokens.'],
  ['gift-wrap-skus', 'gift wrap as a SKU', 'Gift wrapping is modelled as a purchasable SKU rather than a service line, which distorts unit counts in reporting.'],
  ['manual-fx-override', 'the manual FX override', 'Finance can pin a currency rate for a trading day. The override is applied by a script rather than the currency service.'],
  ['dc-tape-robot', 'the datacentre tape robot', 'A tape robot in the Frankfurt DC still performs the compliance archive. Its control software runs on an unsupported OS.'],
  ['barcode-checkdigit', 'the in-house barcode check digit', 'Own-brand SKUs carry a check digit computed by a rule that predates the GS1 alignment and is validated only by the warehouse scanners.'],
  ['telex-confirmations', 'telex order confirmations', 'One freight forwarder still expects confirmations in a fixed-column telex format produced by a nightly job.'],
  ['legacy-giftcard-pins', 'the original gift card PIN scheme', 'Cards issued before the loyalty rewrite use a four digit PIN that the current validator accepts only for balance checks.'],
  ['manual-price-freeze', 'the manual price freeze switch', 'Trading can freeze all price updates with a database flag set by hand. No service exposes it.'],
  ['fixed-carrier-zones', 'the hand-drawn carrier zone map', 'Domestic carrier zones come from a spreadsheet drawn in 2015 rather than from postcode geometry.'],
  ['legacy-return-labels', 'pre-printed return labels', 'Some catalogue orders shipped with pre-printed return labels whose reference format the returns service special-cases.'],
  ['supplier-fax-confirm', 'supplier purchase order faxes', 'Two long-standing suppliers acknowledge purchase orders by fax, which a clerk marks off manually.'],
  ['old-vat-registration', 'the dormant Irish VAT registration', 'A dormant Irish VAT registration is still filed against quarterly, though no orders have shipped from there since 2019.'],
  ['legacy-sku-prefixes', 'the discontinued SKU prefix ranges', 'Three SKU prefix ranges were retired but still appear in historical orders and must remain resolvable.'],
  ['photo-studio-naming', 'the photo studio file naming rule', 'Studio deliveries use a naming convention that the media pipeline parses rather than reading embedded metadata.'],
  ['pallet-height-rule', 'the Bremen pallet height rule', 'The Bremen site enforces a lower maximum pallet height than the other warehouses because of a door frame.'],
  ['legacy-loyalty-import', 'the annual loyalty reconciliation import', 'An annual reconciliation import corrects point balances against a partner statement. It has no owner in the current team structure.'],
  ['handwritten-tax-codes', 'the manual product tax codes', 'Around sixty product classes carry manually assigned tax codes that no rule in the tax service reproduces.'],
  ['old-support-macros', 'the retired support macros', 'Support macros written for the previous helpdesk are still pasted by some agents and reference a defunct order lookup URL.'],
  ['legacy-batch-window', 'the protected overnight batch window', 'A protected window between 01:00 and 03:00 CET is still respected by schedulers, though the constraint it protected no longer exists.'],
  ['paper-goods-inwards', 'paper goods-inwards notes', 'One receiving bay still records goods inwards on paper, keyed in the following morning.'],
];

for (const [slug, subject, body] of ORPHAN_STALE) {
  const id = add({
    id: `orphan-${slug}`,
    category: 'fact',
    title: `${subject}`,
    content: `${body}`,
    tags: ['legacy', slug.split('-')[0]],
    freshness: 'stale',
  });
  // Deliberately no fresh sibling anywhere in the corpus. If freshness handling buries stale
  // items, or the relevance floor silences them, these are what fail.
  ask(`orphan-${slug}-direct`, subject, [id]);
  ask(`orphan-${slug}-para`, body.split(' ').slice(0, 8).join(' '), [id]);
  ask(`orphan-${slug}-mid`, body.split(' ').slice(8, 17).join(' '), [id]);
  ask(`orphan-${slug}-tag`, `${slug.split('-').join(' ')}`, [id]);
}

// (3) needs_review: a weaker signal than stale, and should cost less. Also has no replacement.
const NEEDS_REVIEW = [
  ['capacity-model', 'the peak capacity model', 'Peak sizing assumes 4x Black Friday headroom on the storefront tier. The figure predates the move to Fargate and has not been re-derived.'],
  ['fraud-thresholds', 'manual fraud review thresholds', 'Orders above 750 EUR or shipping to a new address go to manual review. The thresholds were set by the risk team and have not been revisited this year.'],
  ['db-connection-budget', 'the database connection budget', 'Each service instance is budgeted 20 PostgreSQL connections. Whether this still holds after the pooler change is unconfirmed.'],
  ['search-synonyms', 'the search synonym list', 'The storefront search synonym list is maintained by hand in a spreadsheet and imported weekly.'],
  ['gdpr-erasure', 'the erasure request runbook', 'Erasure requests are fulfilled by a scripted sequence across seven stores. The list of stores may be incomplete after recent additions.'],
  ['oncall-rota', 'the out-of-hours rota composition', 'The rota assumes eight engineers per rotation. Two have since moved teams and the rota has not been rebalanced.'],
  ['backup-restore-time', 'the documented restore time', 'A full restore of the orders database is documented at 90 minutes. That figure was measured before the volume doubled.'],
  ['dr-region', 'the disaster recovery region', 'Failover targets eu-central-1. Whether every dependency now has capacity there has not been re-tested since the Fargate migration.'],
  ['pen-test-scope', 'the penetration test scope', 'The last external test covered the storefront and the partner API. Newer internal tooling may be out of scope.'],
  ['image-cdn-costs', 'the image delivery cost assumption', 'Cost planning assumes a 92 percent cache hit rate at the edge. Recent long-tail catalogue growth may have moved it.'],
  ['stock-accuracy', 'the assumed stock accuracy', 'Reservations assume 99.4 percent stock record accuracy. The figure comes from a single warehouse audit.'],
  ['partner-slas', 'partner response time commitments', 'Partner integrations are documented as 99.5 percent monthly availability. Several contracts were renegotiated and may differ.'],
  ['queue-sizing', 'the queue capacity plan', 'Queue sizing assumes peak throughput of 900 messages per second. Measured peaks have approached that number.'],
  ['locale-coverage', 'the supported locale list', 'Fourteen locales are documented as supported. Two were added for a campaign and may not have full translation coverage.'],
  ['retention-schedule', 'the data retention schedule', 'The retention schedule lists nine data classes. Whether event streams are covered by any of them is unclear.'],
];

for (const [slug, subject, body] of NEEDS_REVIEW) {
  const id = add({
    id: `review-${slug}`,
    category: 'fact',
    title: subject,
    content: body,
    tags: ['review', slug.split('-')[0]],
    freshness: 'needs_review',
  });
  ask(`review-${slug}-direct`, subject, [id]);
  ask(`review-${slug}-para`, body.split(' ').slice(0, 8).join(' '), [id]);
  ask(`review-${slug}-mid`, body.split(' ').slice(8, 17).join(' '), [id]);
}

// ---------------------------------------------------------------------------
// Incidents. Longer prose, and queries phrased as symptoms rather than causes.
// ---------------------------------------------------------------------------

const INCIDENTS = [
  ['checkout-timeouts', 'checkout timeouts under load', 'a connection pool exhausted by a slow supplier lookup', 'shoppers saw spinning checkout buttons and abandoned carts'],
  ['duplicate-charges', 'duplicate payment captures', 'a retry that did not carry an idempotency key', 'a hundred and forty customers were charged twice'],
  ['stock-oversell', 'overselling during a flash sale', 'reservations expiring faster than the checkout could complete', 'orders were accepted for stock that no longer existed'],
  ['image-blowup', 'image pipeline saturation', 'a supplier feed containing 40 megapixel source images', 'product pages loaded without imagery for two hours'],
  ['search-blank', 'blank search results', 'an index refresh that deleted before it wrote', 'the storefront search box returned nothing for eleven minutes'],
  ['email-storm', 'duplicate order confirmations', 'a consumer that acknowledged after processing rather than before', 'some customers received the same confirmation nine times'],
  ['tax-mismatch', 'incorrect VAT on invoices', 'a rounding change deployed without recalculating cached rates', 'invoices disagreed with order totals by a few cents'],
  ['session-loss', 'shoppers logged out mid-checkout', 'a session store failover that dropped in-flight keys', 'carts were lost and conversion dropped sharply for an hour'],
  ['queue-backlog', 'fulfilment backlog after a deploy', 'a poison message blocking an ordered partition', 'orders were paid for but not picked for six hours'],
  ['cdn-purge', 'stale prices on category pages', 'a purge that targeted the wrong surrogate key', 'promotional prices did not appear when the sale opened'],
  ['deadlock-migration', 'write failures during a migration', 'an index build taking a lock the write path needed', 'order creation failed intermittently for twenty minutes'],
  ['slow-regex', 'CPU saturation in the import worker', 'a catastrophically backtracking regular expression on supplier titles', 'imports stopped and the worker fleet pegged at full CPU'],
  ['clock-skew', 'token rejections after a host rebuild', 'clock skew of ninety seconds on a rebuilt node', 'signed-in shoppers were rejected at random for half an hour'],
  ['dns-ttl', 'a partial outage after a failover', 'a DNS record with a six hour TTL cached by resolvers', 'a third of traffic kept hitting the retired region'],
  ['leap-day', 'scheduled jobs skipped on 29 February', 'a date helper that assumed 365 day years', 'nightly extracts did not run and reporting was a day behind'],
  ['unicode-names', 'label printing failures for some addresses', 'a printer driver that rejected non-Latin characters', 'parcels for a subset of customers could not be labelled'],
  ['thundering-herd', 'a cache stampede after a purge', 'ten thousand instances refilling one key simultaneously', 'the catalogue database saturated and the storefront degraded'],
  ['float-money', 'penny discrepancies in settlement', 'money held as a floating point value in one service', 'settlement totals disagreed with the ledger by small amounts'],
  ['timezone-cutoff', 'orders counted on the wrong day', 'a report boundary computed in local time rather than UTC', 'daily revenue figures were misstated either side of midnight'],
  ['retry-storm', 'a cascading failure across services', 'aggressive retries amplifying a single slow dependency', 'four services became unavailable within ninety seconds'],
  ['disk-full', 'ingestion halted overnight', 'log rotation that stopped when a symlink was replaced', 'the import worker filled its volume and stopped accepting work'],
  ['null-locale', 'blank product pages in one market', 'a missing translation row treated as an empty string rather than a fallback', 'Dutch category pages rendered without titles'],
  ['stale-flag', 'a feature enabled for the wrong cohort', 'a flag evaluated against a cached shopper profile', 'a beta checkout flow was shown to non-beta shoppers'],
  ['cert-expiry', 'partner callbacks failing silently', 'an expired client certificate on the outbound webhook path', 'partners stopped receiving events for nine hours'],
  ['double-consume', 'inventory decremented twice', 'two consumers on a queue without a shared consumer group', 'stock levels drifted below reality across a weekend'],
  ['memory-leak', 'gradual latency growth over a week', 'an unbounded in-process cache keyed by request id', 'p99 latency tripled between deployments'],
  ['bad-migration', 'a rollback that lost writes', 'a rollback path that dropped a column already receiving traffic', 'two hours of address changes were lost'],
  ['api-breaking', 'partner integrations breaking after a release', 'a field made required without a deprecation window', 'six partner integrations began rejecting responses'],
  ['queue-ordering', 'out-of-order status updates', 'partition keys chosen per event rather than per order', 'orders briefly showed a delivered state before dispatch'],
];

for (const [slug, headline, cause, impact] of INCIDENTS) {
  const id = add({
    id: `inc-${slug}`,
    category: 'fact',
    title: `Incident: ${headline}`,
    content: `${headline}. Root cause: ${cause}. Impact: ${impact}. The fix and its follow-up actions were tracked to completion.`,
    tags: ['incident', slug.split('-')[0]],
  });
  ask(`inc-${slug}-symptom`, impact.split(' ').slice(0, 7).join(' '), [id]);
  ask(`inc-${slug}-cause`, cause, [id]);
  ask(`inc-${slug}-headline`, headline, [id]);
}

// ---------------------------------------------------------------------------
// Runbooks. Procedural knowledge, queried the way someone under pressure phrases it.
// ---------------------------------------------------------------------------

const RUNBOOKS = [
  ['rotate-db-credentials', 'rotating database credentials', 'issue a new role in the cluster, publish it to the secret store, roll instances one zone at a time, then revoke the old role after a full deployment cycle'],
  ['drain-queue-backlog', 'draining a queue backlog', 'raise consumer concurrency, confirm no poison message is blocking a partition, and only then increase the shard count'],
  ['restore-order-database', 'restoring the orders database', 'stop write traffic at the edge, restore the latest snapshot into a new cluster, replay the write-ahead log to the chosen point, and repoint the connection alias'],
  ['revoke-partner-key', 'revoking a partner API key', 'disable the key at the edge, notify the partner contact, then remove it from the registry once traffic has stopped'],
  ['failover-region', 'failing over to the secondary region', 'promote the standby datastores, switch the traffic weights, and verify that asynchronous consumers reconnected before declaring the failover complete'],
  ['purge-cdn', 'purging the CDN', 'purge by surrogate key rather than by URL, confirm the key is present on the origin response, and watch origin load while the cache refills'],
  ['replay-failed-webhooks', 'replaying failed webhooks', 'select the failed deliveries by partner and window, confirm the endpoint is healthy, then replay in batches with backoff'],
  ['reindex-search', 'rebuilding the search index', 'build into a new alias target, verify document counts against the catalogue, then swap the alias atomically'],
  ['unstick-stuck-order', 'unsticking a stuck order', 'identify the last successful step from the audit trail, resolve the blocking dependency, then re-drive the workflow from that step rather than from the start'],
  ['emergency-flag-off', 'turning off a feature in an emergency', 'flip the kill switch rather than deploying a revert, record the incident, and only then plan the code change'],
  ['expand-warehouse-capacity', 'adding warehouse capacity', 'register the site, seed its stock positions, enable it for a single low-volume region first, then widen'],
  ['rotate-signing-cert', 'rotating the webhook signing certificate', 'publish the new public key, sign with both keys for one delivery window, then retire the old key'],
  ['handle-poison-message', 'handling a poison message', 'move the message to the dead letter queue with its full context, unblock the partition, and open a defect against the producer'],
  ['scale-for-sale', 'scaling ahead of a sale', 'pre-warm the storefront tier, raise the connection budget, confirm the rate limiter headroom, and freeze unrelated deploys'],
  ['recover-lost-session-store', 'recovering after a session store failure', 'accept that in-flight sessions are gone, force re-authentication rather than serving a partial cart, and communicate through the storefront banner'],
  ['investigate-slow-endpoint', 'investigating a slow endpoint', 'compare traces either side of the regression, check for a changed query plan before blaming the network, and confirm the sampling rate is high enough to trust the sample'],
  ['stop-runaway-import', 'stopping a runaway import', 'pause the schedule, cancel the in-flight batch, and reconcile partial writes before restarting'],
  ['add-supported-locale', 'adding a supported locale', 'register the locale, load translations, verify currency and tax behaviour, then expose it in the storefront switcher'],
  ['respond-to-erasure', 'responding to an erasure request', 'confirm identity, run the erasure sequence across every store on the register, and retain only the legally required record of the request itself'],
  ['roll-back-migration', 'rolling back a schema migration', 'stop writes to the affected table, apply the down migration only if it is non-destructive, and otherwise restore rather than roll back'],
];

for (const [slug, task, steps] of RUNBOOKS) {
  const id = add({
    id: `run-${slug}`,
    category: 'skill',
    title: `Runbook: ${task}`,
    content: `To handle ${task}: ${steps}.`,
    tags: ['runbook', slug.split('-')[0]],
    steps: steps.split(', then ').flatMap(part => part.split(', and ')),
  });
  ask(`run-${slug}-direct`, task, [id]);
  ask(`run-${slug}-how`, `how do I ${task.replace(/^(\w+)ing/, '$1')}`, [id]);
  ask(`run-${slug}-step`, steps.split(', ')[0], [id]);
  ask(`run-${slug}-last`, steps.split(', ').slice(-1)[0], [id]);
}

// ---------------------------------------------------------------------------
// Decisions carrying the alternatives that were rejected. A query naming the rejected option
// must still return the decision -- not nothing, and not a different decision.
// ---------------------------------------------------------------------------

const DECISIONS = [
  ['monorepo', 'a single repository for backend services', 'separate repositories per service', 'shared tooling and atomic cross-service changes outweighed the build complexity'],
  ['sql-first', 'relational storage as the default', 'document storage as the default', 'most access patterns turned out to be relational once reporting was included'],
  ['async-fulfilment', 'asynchronous fulfilment', 'synchronous fulfilment inside checkout', 'checkout latency mattered more than immediate confirmation'],
  ['own-search', 'running our own search cluster', 'a hosted search product', 'per-query cost at catalogue scale was prohibitive on the hosted option'],
  ['edge-ratelimit', 'rate limiting at the edge', 'rate limiting in each service', 'a single enforcement point was easier to reason about during incidents'],
  ['no-orm', 'hand-written SQL in the data layer', 'a full ORM', 'query plans were too important to leave implicit'],
  ['single-currency-ledger', 'a base-currency ledger', 'a multi-currency ledger', 'reconciliation was simpler with conversion at the boundary'],
  ['event-sourcing-orders', 'event sourcing for orders only', 'event sourcing everywhere', 'the audit requirement applied to orders and nowhere else'],
  ['blue-green', 'blue-green deployment for stateless services', 'rolling deployment everywhere', 'instant rollback was worth the doubled capacity during a release'],
  ['managed-postgres', 'managed PostgreSQL', 'self-managed PostgreSQL on EC2', 'the operational burden was not where the team could add value'],
  ['grpc-internal', 'gRPC for internal calls', 'REST for internal calls', 'schema enforcement across teams mattered more than curl-ability'],
  ['feature-flags-buy', 'buying a feature flag service', 'extending the homegrown table', 'targeting and audit requirements had outgrown the internal version'],
  ['no-shared-db', 'one datastore per service', 'a shared datastore across services', 'shared schemas had repeatedly coupled unrelated releases'],
  ['utc-everywhere', 'storing all timestamps in UTC', 'storing local time with an offset', 'reporting boundaries had already been misstated twice'],
  ['idempotent-payments', 'caller-supplied idempotency keys on payments', 'server-side deduplication windows', 'the duplicate charge incident made caller intent the safer signal'],
  ['read-replicas', 'read replicas for reporting', 'reporting against the primary', 'nightly extracts were competing with checkout traffic'],
  ['soft-delete', 'soft deletion for customer records', 'hard deletion', 'erasure requirements needed a deliberate, auditable path rather than a cascade'],
  ['api-versioning', 'versioning the partner API by URL', 'versioning by header', 'partners found the URL form easier to pin and to debug'],
  ['central-config', 'a central configuration service', 'per-service environment variables', 'changing a value across the estate had required a deploy per service'],
  ['sync-inventory', 'strongly consistent inventory reads', 'eventually consistent inventory reads', 'overselling cost more than the added read latency'],
];

for (const [slug, chosen, rejected, because] of DECISIONS) {
  const id = add({
    id: `dec-${slug}`,
    category: 'decision',
    title: `Decision: ${chosen}`,
    content: `Northwind uses ${chosen}. ${rejected} was considered and rejected, because ${because}.`,
    tags: ['decision', slug.split('-')[0]],
    alternatives: [rejected],
  });
  ask(`dec-${slug}-direct`, chosen, [id]);
  ask(`dec-${slug}-why`, `why ${because.split(' ').slice(0, 6).join(' ')}`, [id]);
  // Naming the rejected option must still find the decision that rejected it.
  ask(`dec-${slug}-rejected`, `${rejected}`, [id]);
  ask(`dec-${slug}-alt`, `did we consider ${rejected}`, [id]);
};

// ---------------------------------------------------------------------------
// Glossary. Short definitions with heavy vocabulary overlap between neighbours, which is where
// a purely semantic ranker struggles to pick the right one.
// ---------------------------------------------------------------------------

const GLOSSARY = [
  ['reservation', 'a temporary hold on stock created when a shopper reaches checkout'],
  ['allocation', 'the binding of reserved stock to a specific warehouse for picking'],
  ['authorisation', 'a payment provider agreeing to hold funds without moving them'],
  ['capture', 'the movement of previously authorised funds'],
  ['settlement', 'the payout of captured funds to a merchant account'],
  ['chargeback', 'a shopper-initiated reversal raised through their bank'],
  ['refund', 'a merchant-initiated return of funds against an original capture'],
  ['credit note', 'a document reversing part or all of an issued invoice'],
  ['manifest', 'the list of parcels handed to a carrier in one collection'],
  ['consignment', 'a group of parcels travelling together under one carrier reference'],
  ['backorder', 'an accepted order line with no stock currently available'],
  ['preorder', 'an accepted order line for stock not yet released'],
  ['dropship', 'fulfilment shipped directly by a supplier rather than a warehouse'],
  ['cross-dock', 'inbound stock forwarded to an outbound lane without being put away'],
  ['pick face', 'the accessible storage location a picker draws from'],
  ['replenishment', 'moving stock from bulk storage into the pick face'],
  ['cycle count', 'a rolling partial stock count performed without stopping operations'],
  ['shrinkage', 'the difference between recorded and actual stock, however caused'],
  ['lead time', 'the interval between raising a purchase order and receiving stock'],
  ['safety stock', 'the buffer held to absorb demand variability during lead time'],
  ['SKU', 'the smallest sellable unit distinguished by its own identifier'],
  ['variant', 'a sellable option of a product differing in size, colour or format'],
  ['bundle', 'a sellable item that expands into several component units at checkout'],
  ['contract price', 'an agreed price for a named customer that overrides list price'],
  ['list price', 'the default price before promotions or contract terms'],
];

for (const [term, definition] of GLOSSARY) {
  const slug = term.replace(/\s+/g, '-');
  const id = add({
    id: `glo-${slug}`,
    category: 'fact',
    title: `${term}`,
    content: `In Northwind, ${term} means ${definition}.`,
    tags: ['glossary'],
  });
  ask(`glo-${slug}-direct`, `what is a ${term}`, [id]);
  ask(`glo-${slug}-def`, definition, [id]);
  ask(`glo-${slug}-term`, term, [id]);
};

// ---------------------------------------------------------------------------
// Service level objectives and endpoints, generated per service. Both are identifier-shaped,
// which is the lexical half of the corpus.
// ---------------------------------------------------------------------------

for (const { slug, label } of serviceFacts.slice(0, 24)) {
  const p99 = 50 + Math.floor(rand() * 20) * 25;
  const availability = pick(['99.9', '99.95', '99.5', '99.99']);
  const id = add({
    id: `slo-${slug}`,
    category: 'goal',
    title: `${label} service level objective`,
    content: `svc-${slug} targets ${availability} percent monthly availability and a p99 latency of ${p99}ms measured at the edge. Breaching either for two consecutive weeks triggers a reliability review.`,
    tags: ['slo', slug],
  });
  ask(`slo-${slug}-direct`, `${label} service level objective`, [id]);
  ask(`slo-${slug}-latency`, `p99 latency target for ${label}`, [id]);
  ask(`slo-${slug}-avail`, `availability target for svc-${slug}`, [id]);
}

const VERBS = [['GET', 'reads'], ['POST', 'creates'], ['PUT', 'replaces'], ['DELETE', 'removes']];
for (const { slug, label } of serviceFacts.slice(0, 22)) {
  const [verb, action] = pick(VERBS);
  const resource = pick(['items', 'records', 'entries', 'jobs', 'batches']);
  const route = `/v2/${slug}/${resource}`;
  const id = add({
    id: `api-${slug}-${resource}`,
    category: 'architecture',
    title: `${verb} ${route}`,
    content: `${verb} ${route} ${action} ${resource} in ${label}. It requires a scoped token and is rate limited per API key.`,
    tags: ['api', slug],
  });
  ask(`api-${slug}-route`, route, [id]);
  ask(`api-${slug}-verb`, `${verb} ${route}`, [id]);
}

// ---------------------------------------------------------------------------
// Error codes. Pure identifiers a shopper or partner would quote verbatim.
// ---------------------------------------------------------------------------

const ERRORS = [
  ['NW-1001', 'the cart no longer holds the requested quantity'],
  ['NW-1002', 'the reservation expired before checkout completed'],
  ['NW-1010', 'the payment provider declined the authorisation'],
  ['NW-1011', 'the payment provider timed out and the outcome is unknown'],
  ['NW-1020', 'the shipping address failed validation'],
  ['NW-1021', 'no carrier could quote for the destination'],
  ['NW-1030', 'the promotion is not valid for this basket'],
  ['NW-1031', 'promotions may not be combined beyond the stack limit'],
  ['NW-1040', 'the gift card balance is insufficient'],
  ['NW-1041', 'the gift card has expired'],
  ['NW-2001', 'the partner token has expired'],
  ['NW-2002', 'the partner token lacks the required scope'],
  ['NW-2010', 'the request exceeded the per-key rate limit'],
  ['NW-2020', 'the supplied idempotency key was reused with a different body'],
  ['NW-3001', 'the requested locale is not supported'],
  ['NW-3002', 'no translation exists for the requested field'],
  ['NW-4001', 'the import batch exceeded the row limit'],
  ['NW-4002', 'the import file could not be parsed'],
  ['NW-5001', 'an upstream dependency is unavailable'],
  ['NW-5002', 'the request was shed to protect the service'],
];

for (const [code, meaning] of ERRORS) {
  const id = add({
    id: `err-${code.toLowerCase()}`,
    category: 'fact',
    title: `${code}`,
    content: `${code} is returned when ${meaning}. Callers should surface a specific message rather than a generic failure.`,
    tags: ['error', code.split('-')[0].toLowerCase()],
  });
  ask(`err-${code}-ident`, code, [id]);
  ask(`err-${code}-meaning`, `what does ${code} mean`, [id]);
  ask(`err-${code}-para`, meaning, [id]);
}

// ---------------------------------------------------------------------------
// Multi-answer cases.
//
// Every expected set here is derived from a property the fixtures actually share, never from a
// random sample. An earlier draft of this file built them with `some(ids, 3)`, which produced
// questions like "incidents involving a deploy" expecting three arbitrary incidents -- cases no
// ranker could pass and none could fail for a meaningful reason. A benchmark that cannot be
// answered does not measure quality, it just adds a constant to the error bar.
// ---------------------------------------------------------------------------

const idsWhere = (predicate) => fixtures.filter(predicate).map(f => f.id);

// Services grouped by a fact stated in their own content.
const byStore = new Map();
const byTeam = new Map();
const byTransport = new Map();
for (const f of serviceFacts) {
  for (const [map, key] of [[byStore, f.store], [byTeam, f.team], [byTransport, f.transport]]) {
    if (!map.has(key)) map.set(key, []);
    map.get(key).push(`svc-${f.slug}`);
  }
}
for (const [store, group] of byStore) {
  if (group.length < 2 || group.length > 10) continue;
  ask(`multi-store-${store.replace(/[^a-z0-9]+/gi, '-').toLowerCase()}`, `services that persist to ${store}`, group, [], 10);
}
for (const [team, group] of byTeam) {
  if (group.length < 2 || group.length > 10) continue;
  ask(`multi-team-${team}`, `services owned by the ${team} team`, group, [], 10);
}
for (const [transport, group] of byTransport) {
  if (group.length < 2 || group.length > 10) continue;
  ask(`multi-transport-${transport.replace(/[^a-z0-9]+/gi, '-').toLowerCase()}`, `services called over ${transport}`, group, [], 10);
}

// Config keys grouped by the setting they express, which is literally in the key.
for (const suffix of ['timeout', 'ttl', 'retry', 'limit', 'max', 'batch', 'concurrency']) {
  const group = idsWhere(f => f.id.startsWith('cfg-') && f.id.includes(suffix));
  if (group.length < 2 || group.length > 10) continue;
  ask(`multi-cfg-${suffix}`, `${suffix} configuration values`, group, [], 10);
}

// Error codes grouped by their numeric family, which is how they were assigned.
const ERROR_FAMILIES = [
  ['nw-10', 'checkout and cart errors'],
  ['nw-20', 'partner API errors'],
  ['nw-30', 'localisation errors'],
  ['nw-40', 'bulk import errors'],
  ['nw-50', 'availability errors'],
];
for (const [prefix, description] of ERROR_FAMILIES) {
  const group = idsWhere(f => f.id.startsWith(`err-${prefix}`));
  if (group.length < 2 || group.length > 10) continue;
  ask(`multi-err-${prefix}`, description, group, [], 10);
}

// Near-duplicate pairs, asked as a pair. Both sides are legitimately about the topic, so a
// ranker that can only find one of them scores exactly half.
// (emitted inside the PAIRS loop above as `pair-<slug>-both`)

// Superseded topics asked without a currency qualifier: the fresh answer is expected and the
// retired one is still forbidden, so this measures suppression rather than recall.
for (const [slug, topic] of SUPERSEDED) {
  ask(`multi-sup-${slug}`, `what do we use for ${topic}`, [`sup-${slug}-new`], [`sup-${slug}-old`], 5);
}

// ---------------------------------------------------------------------------
// Emit.
// ---------------------------------------------------------------------------

const seen = new Set();
for (const f of fixtures) {
  if (seen.has(f.id)) throw new Error(`duplicate fixture id: ${f.id}`);
  seen.add(f.id);
}
const caseIds = new Set();
for (const c of cases) {
  if (caseIds.has(c.id)) throw new Error(`duplicate case id: ${c.id}`);
  caseIds.add(c.id);
  for (const id of [...c.expectedItemIds, ...c.mustNotReturn]) {
    if (!seen.has(id)) throw new Error(`case ${c.id} references unknown fixture ${id}`);
  }
  if (c.expectedItemIds.length === 0) throw new Error(`case ${c.id} expects nothing`);
}

const staleExpected = cases.filter(c => c.expectedItemIds.some(id => {
  const f = fixtures.find(x => x.id === id);
  return f && f.freshness && f.freshness !== 'fresh';
})).length;

const payload = {
  version: 2,
  description:
    'Retrieval evaluation suite v2. Generated by scripts/generate-retrieval-suite.mjs -- edit the '
    + 'generator, not this file. Built to discriminate where retrieval-suite.json is saturated, and '
    + 'specifically to be two-sided about freshness: it contains cases whose correct answer is itself '
    + 'stale or needs_review and must still be returned, which retrieval-suite.json has none of.',
  fixtures,
  cases,
};

await fs.writeFile(OUT, JSON.stringify(payload, null, 1) + '\n', 'utf-8');

const freshnessCounts = fixtures.reduce((acc, f) => {
  const key = f.freshness || 'fresh';
  acc[key] = (acc[key] || 0) + 1;
  return acc;
}, {});

console.log(`wrote ${path.relative(process.cwd(), OUT)}`);
console.log(`  fixtures ${fixtures.length}  ${JSON.stringify(freshnessCounts)}`);
console.log(`  cases    ${cases.length}`);
console.log(`  cases whose correct answer is NOT fresh: ${staleExpected}  (retrieval-suite.json has 0)`);
console.log(`  cases with mustNotReturn: ${cases.filter(c => c.mustNotReturn.length).length}`);
