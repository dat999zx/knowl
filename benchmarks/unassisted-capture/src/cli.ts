import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { generateObject } from 'ai';
import { initAI } from '../../../src/ai/provider.js';
import { createLocalEmbeddingProvider } from '../../../src/ai/embeddings.js';
import { loadConfig } from '../../../src/core/config.js';
import type { ProjectConfig } from '../../../src/core/types.js';
import { loadAnswerKey } from './answer-key.js';
import { calibrate, type CalibrationPair, type Embed } from './calibrate.js';
import { loadCorpus } from './corpus.js';
import { MODEL_EVENTS_SYSTEM_PROMPT, PredictedAtomSchema, runModelOnEvents } from './method-model-events.js';
import { assertAnswerKeyResolves, parseFrozenThreshold, type FrozenThreshold } from './preflight.js';
import { readStage1, renderReport } from './report.js';
import { scoreMethod } from './score.js';

// These paths are relative to process.cwd() (see corpus.ts's DEFAULT_CORPUS_DIR for the same
// pattern) -- this CLI must be run from the repo root.
const ANSWER_KEY_DIR = path.join('benchmarks', 'unassisted-capture', 'answer-key');
const THRESHOLD_FILE = path.join(ANSWER_KEY_DIR, 'threshold.json');
const PAIRS_FILE = path.join(ANSWER_KEY_DIR, 'calibration-pairs.json');
const RESULTS_FILE = path.join('benchmarks', 'unassisted-capture', 'results.json');
const PREDICTIONS_FILE = path.join('benchmarks', 'unassisted-capture', 'predictions.json');

async function embedderFor(config: ProjectConfig): Promise<Embed> {
  const provider = await createLocalEmbeddingProvider(config, process.cwd());
  return (texts: string[]) => provider.embed(texts);
}

async function fileExists(file: string): Promise<boolean> {
  return fs
    .access(file)
    .then(() => true)
    .catch(() => false);
}

async function readFrozenThreshold(): Promise<FrozenThreshold> {
  return parseFrozenThreshold(await fs.readFile(THRESHOLD_FILE, 'utf8'), THRESHOLD_FILE);
}

async function commandCalibrate(argv: string[]): Promise<void> {
  const force = argv.includes('--force');
  if (!force && (await fileExists(THRESHOLD_FILE))) {
    throw new Error(
      `${THRESHOLD_FILE} already exists. The match threshold is preregistered: overwriting it after seeing any result is threshold tuning, which invalidates the experiment. Pass --force only when re-freezing deliberately, before the run.`,
    );
  }

  const pairsRaw = await fs.readFile(PAIRS_FILE, 'utf8');
  const pairs = JSON.parse(pairsRaw) as CalibrationPair[];
  const config = await loadConfig(process.cwd());
  const result = await calibrate(pairs, await embedderFor(config));

  const frozen: FrozenThreshold = {
    threshold: result.threshold,
    agreement: result.agreement,
    pairs: pairs.length,
    frozenAt: new Date().toISOString(),
    // Pins the threshold to the exact pair file it came from, so an edited calibration set is
    // visible rather than silently inherited.
    pairsSha256: createHash('sha256').update(pairsRaw).digest('hex'),
  };

  await fs.mkdir(ANSWER_KEY_DIR, { recursive: true });
  await fs.writeFile(THRESHOLD_FILE, `${JSON.stringify(frozen, null, 2)}\n`);
  console.log(`threshold ${result.threshold.toFixed(4)} (agreement ${result.agreement.toFixed(2)} over ${pairs.length} pairs) -> ${THRESHOLD_FILE}`);
}

async function commandRun(): Promise<void> {
  const frozen = await readFrozenThreshold();
  const answerKey = await loadAnswerKey();
  const corpus = await loadCorpus();

  // Before anything is spent.
  assertAnswerKeyResolves(answerKey.map((key) => key.sessionId), corpus.map((session) => session.sessionId));
  const scored = corpus.filter((session) => answerKey.some((key) => key.sessionId === session.sessionId));

  const config = await loadConfig(process.cwd());
  if (!config.ai) throw new Error('No AI provider configured; method 2 cannot run.');

  // Built before the paid loop, not after it. `createLocalEmbeddingProvider` throws when vector
  // search is disabled, and paying for 32 model calls first would throw that away.
  const embed = await embedderFor(config);
  const model = initAI(config.ai);

  const { predictions, failures } = await runModelOnEvents(scored, async (prompt) => {
    const { object } = await generateObject({
      model,
      schema: PredictedAtomSchema,
      system: MODEL_EVENTS_SYSTEM_PROMPT,
      prompt,
      temperature: 0.1,
    });
    return object.atoms;
  });

  // Written before scoring. The predictions are the paid artifact; scoring is free and
  // repeatable from this file, and at temperature 0.1 a re-run would not reproduce them.
  const payload = `${JSON.stringify(
    {
      method: 'model-events',
      generatedAt: new Date().toISOString(),
      sessionsSelected: scored.length,
      failures,
      predictions,
    },
    null,
    2,
  )}\n`;
  try {
    await fs.writeFile(PREDICTIONS_FILE, payload);
    console.log(`${predictions.length} prediction(s), ${failures.length} failed session(s) of ${scored.length} selected -> ${PREDICTIONS_FILE}`);
  } catch (error) {
    // Last resort: the run has already been paid for, so put it in the scrollback rather than
    // let a filesystem error destroy it.
    console.error(`Could not write ${PREDICTIONS_FILE}: ${(error as Error).message}. Dumping predictions to stdout.`);
    console.log(payload);
  }

  const score = await scoreMethod({
    method: 'model-events',
    answerKey,
    predictions,
    threshold: frozen.threshold,
    embed,
    failedSessions: failures,
  });
  const reading = readStage1(score);

  await fs.writeFile(
    RESULTS_FILE,
    `${JSON.stringify(
      {
        score,
        reading,
        // Echoed so the preregistration is auditable from this file alone.
        threshold: frozen.threshold,
        thresholdFrozenAt: frozen.frozenAt,
        thresholdAgreement: frozen.agreement,
        thresholdPairs: frozen.pairs,
        thresholdPairsSha256: frozen.pairsSha256 ?? null,
        predictionsFile: PREDICTIONS_FILE,
      },
      null,
      2,
    )}\n`,
  );
  console.log(renderReport(score, reading));
}

const argv = process.argv.slice(2);
const command = argv[0];
const run = command === 'calibrate' ? () => commandCalibrate(argv) : command === 'run' ? commandRun : null;
if (!run) {
  console.error('usage: cli.ts <calibrate [--force]|run>');
  process.exit(1);
}
run().catch((error: Error) => {
  console.error(error.message);
  process.exit(1);
});
