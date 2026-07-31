import fs from 'node:fs/promises';
import path from 'node:path';
import { generateObject } from 'ai';
import { initAI } from '../../../src/ai/provider.js';
import { createLocalEmbeddingProvider } from '../../../src/ai/embeddings.js';
import { loadConfig } from '../../../src/core/config.js';
import { loadAnswerKey } from './answer-key.js';
import { calibrate, type CalibrationPair, type Embed } from './calibrate.js';
import { loadCorpus } from './corpus.js';
import { MODEL_EVENTS_SYSTEM_PROMPT, PredictedAtomSchema, runModelOnEvents } from './method-model-events.js';
import { readStage1, renderReport } from './report.js';
import { scoreMethod } from './score.js';

// These paths are relative to process.cwd() (see corpus.ts's DEFAULT_CORPUS_DIR for the same
// pattern) -- this CLI must be run from the repo root.
const ANSWER_KEY_DIR = path.join('benchmarks', 'unassisted-capture', 'answer-key');
const THRESHOLD_FILE = path.join(ANSWER_KEY_DIR, 'threshold.json');
const PAIRS_FILE = path.join(ANSWER_KEY_DIR, 'calibration-pairs.json');
const RESULTS_FILE = path.join('benchmarks', 'unassisted-capture', 'results.json');

async function embedder(): Promise<Embed> {
  const config = await loadConfig(process.cwd());
  const provider = await createLocalEmbeddingProvider(config, process.cwd());
  return (texts: string[]) => provider.embed(texts);
}

async function commandCalibrate(): Promise<void> {
  const pairs = JSON.parse(await fs.readFile(PAIRS_FILE, 'utf8')) as CalibrationPair[];
  const result = await calibrate(pairs, await embedder());

  await fs.writeFile(
    THRESHOLD_FILE,
    `${JSON.stringify({ threshold: result.threshold, agreement: result.agreement, pairs: pairs.length, frozenAt: new Date().toISOString() }, null, 2)}\n`,
  );
  console.log(`threshold ${result.threshold.toFixed(4)} (agreement ${result.agreement.toFixed(2)} over ${pairs.length} pairs) -> ${THRESHOLD_FILE}`);
}

async function commandRun(): Promise<void> {
  const frozen = JSON.parse(await fs.readFile(THRESHOLD_FILE, 'utf8')) as { threshold: number };
  const answerKey = await loadAnswerKey();
  const corpus = await loadCorpus();
  const scored = corpus.filter((session) => answerKey.some((key) => key.sessionId === session.sessionId));

  const config = await loadConfig(process.cwd());
  if (!config.ai) throw new Error('No AI provider configured; method 2 cannot run.');
  const model = initAI(config.ai);

  const predictions = await runModelOnEvents(scored, async (prompt) => {
    const { object } = await generateObject({
      model,
      schema: PredictedAtomSchema,
      system: MODEL_EVENTS_SYSTEM_PROMPT,
      prompt,
      temperature: 0.1,
    });
    return object.atoms;
  });

  const score = await scoreMethod({
    method: 'model-events',
    answerKey,
    predictions,
    threshold: frozen.threshold,
    embed: await embedder(),
  });
  const reading = readStage1(score);

  await fs.writeFile(RESULTS_FILE, `${JSON.stringify({ score, reading, threshold: frozen.threshold }, null, 2)}\n`);
  console.log(renderReport(score, reading));
}

const command = process.argv[2];
const run = command === 'calibrate' ? commandCalibrate : command === 'run' ? commandRun : null;
if (!run) {
  console.error('usage: cli.ts <calibrate|run>');
  process.exit(1);
}
run().catch((error: Error) => {
  console.error(error.message);
  process.exit(1);
});
