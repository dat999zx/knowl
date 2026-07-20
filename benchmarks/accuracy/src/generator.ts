import { createHash } from 'node:crypto';
import {
  BENCHMARK_GENERATOR_VERSION,
  BENCHMARK_SCHEMA_VERSION,
  type BenchmarkBundle,
  type CaptureGold,
  type NativeEvent,
  type NativeHistory,
  type NormalizedRecord,
  type PublicQuery,
  type QuestionCategory,
  type QuestionGold,
} from './schema.js';

type ProjectProfile = {
  id: string;
  name: string;
  stack: string;
  oldArchitecture: string;
  currentArchitecture: string;
  oldState: string;
  currentState: string;
  constraint: string;
  badCommand: string;
  goodCommand: string;
  oldPath: string;
  currentPath: string;
  symbol: string;
  failedApproach: string;
  failureReason: string;
  successfulApproach: string;
  oldDecision: string;
  currentDecision: string;
  staleValue: string;
  currentValue: string;
  gotcha: string;
  symptom: string;
};

type DraftRecord = {
  session: 1 | 2 | 3 | 4;
  kind: NormalizedRecord['kind'];
  title: string;
  content: string;
  supersedes?: number[];
  contradicts?: number[];
  resolves?: number[];
  locators?: NormalizedRecord['locators'];
  capture?: 'durable' | 'temporary' | 'refuted' | 'irrelevant';
};

type DraftQuestion = {
  category: QuestionCategory;
  text: string[];
  answer: QuestionGold['answer'];
  positive: Array<{ record: number; grade: 1 | 2 | 3; role: 'answer' | 'support' | 'background' }>;
  harmful?: Array<{ record?: number; sourceId?: string; reason: QuestionGold['harmful'][number]['reason'] }>;
  groups?: number[][];
  shouldAbstain?: boolean;
  asOfSession?: 1 | 2 | 3 | 4;
  temporalKind?: QuestionGold['temporalKind'];
  failure?: QuestionGold['failure'];
};

type ScenarioDraft = {
  records: [DraftRecord, DraftRecord, DraftRecord, DraftRecord];
  questions: [DraftQuestion, DraftQuestion];
};

const PROJECTS: ProjectProfile[] = [
  {
    id: 'p01', name: 'AtlasBoard', stack: 'TypeScript Node monorepo',
    oldArchitecture: 'a single Express service', currentArchitecture: 'a modular Fastify service with workspace packages',
    oldState: 'billing migration is blocked', currentState: 'billing migration is ready for rollout',
    constraint: 'all persistence must remain local and offline',
    badCommand: 'npm test -- --runInBand', goodCommand: 'npm test -- --maxWorkers=1',
    oldPath: 'src/auth/token.ts', currentPath: 'packages/auth/src/access-token.ts', symbol: 'createAccessToken',
    failedApproach: 'running SQLite migrations concurrently', failureReason: 'SQLite write locks caused partial migrations',
    successfulApproach: 'serialize migrations inside one transaction',
    oldDecision: 'deploy on Node.js 20', currentDecision: 'deploy on Node.js 22',
    staleValue: 'port 3000', currentValue: 'port 4310',
    gotcha: 'enable WAL before parallel read tests', symptom: 'tests intermittently report database is locked',
  },
  {
    id: 'p02', name: 'CedarClinic', stack: 'Python FastAPI service',
    oldArchitecture: 'synchronous SQLAlchemy handlers', currentArchitecture: 'async FastAPI handlers with repository boundaries',
    oldState: 'insurance import is in discovery', currentState: 'insurance import is validated for staging',
    constraint: 'patient fixtures must never leave the local test environment',
    badCommand: 'pytest -n auto', goodCommand: 'pytest -q -n 0',
    oldPath: 'app/security/tokens.py', currentPath: 'app/auth/jwt_service.py', symbol: 'issue_access_token',
    failedApproach: 'sharing one async database session across requests', failureReason: 'concurrent requests corrupted transaction state',
    successfulApproach: 'create one scoped session per request',
    oldDecision: 'run Python 3.11', currentDecision: 'run Python 3.13',
    staleValue: 'schema revision 42', currentValue: 'schema revision 47',
    gotcha: 'set TZ=UTC before snapshot tests', symptom: 'appointment snapshots shift by one hour',
  },
  {
    id: 'p03', name: 'HarborSync', stack: 'Go synchronization service',
    oldArchitecture: 'one global worker queue', currentArchitecture: 'partitioned queues with per-tenant checkpoints',
    oldState: 'delta sync is experimental', currentState: 'delta sync is the default path',
    constraint: 'sync checkpoints must be crash-safe before acknowledgement',
    badCommand: 'go test ./... -parallel 16', goodCommand: 'go test ./... -parallel 1',
    oldPath: 'internal/sync/token.go', currentPath: 'internal/auth/lease_token.go', symbol: 'MintLeaseToken',
    failedApproach: 'acknowledging messages before checkpoint flush', failureReason: 'a crash lost acknowledged updates',
    successfulApproach: 'flush checkpoints before acknowledging messages',
    oldDecision: 'use Go 1.23', currentDecision: 'use Go 1.25',
    staleValue: 'batch size 500', currentValue: 'batch size 128',
    gotcha: 'disable HTTP/2 in the integration proxy', symptom: 'stream resets appear only in CI',
  },
  {
    id: 'p04', name: 'LanternMobile', stack: 'Kotlin Android application',
    oldArchitecture: 'activities owning mutable view state', currentArchitecture: 'unidirectional state with Compose view models',
    oldState: 'offline maps are prototype-only', currentState: 'offline maps are enabled for beta users',
    constraint: 'the minimum supported Android API remains 26',
    badCommand: './gradlew connectedCheck --parallel', goodCommand: './gradlew connectedCheck --no-parallel',
    oldPath: 'app/src/main/java/auth/Token.kt', currentPath: 'core/auth/src/main/kotlin/SessionToken.kt', symbol: 'createSessionToken',
    failedApproach: 'collecting flows in an unscoped coroutine', failureReason: 'collectors survived destroyed activities',
    successfulApproach: 'collect flows with repeatOnLifecycle',
    oldDecision: 'compile with Kotlin 2.1', currentDecision: 'compile with Kotlin 2.3',
    staleValue: 'cache limit 64 MB', currentValue: 'cache limit 96 MB',
    gotcha: 'install the API 26 emulator image before UI tests', symptom: 'connectedCheck reports no compatible device',
  },
  {
    id: 'p05', name: 'RivetCLI', stack: 'Rust command-line tool',
    oldArchitecture: 'commands mutating a shared global context', currentArchitecture: 'typed command handlers with explicit state',
    oldState: 'signed releases are planned', currentState: 'signed releases are required',
    constraint: 'release builds must be reproducible without network access',
    badCommand: 'cargo test --all -- --test-threads=16', goodCommand: 'cargo test --all -- --test-threads=1',
    oldPath: 'src/auth/token.rs', currentPath: 'crates/session/src/token.rs', symbol: 'mint_session_token',
    failedApproach: 'writing config files directly in place', failureReason: 'process interruption truncated user configuration',
    successfulApproach: 'write to a temporary file and atomically rename it',
    oldDecision: 'use Rust 1.82', currentDecision: 'use Rust 1.88',
    staleValue: 'config format v2', currentValue: 'config format v3',
    gotcha: 'set SOURCE_DATE_EPOCH for release builds', symptom: 'release archives have different checksums',
  },
];

function pick<T>(seed: string, key: string, values: readonly T[]): T {
  const hash = createHash('sha256').update(`${seed}:${key}`).digest();
  return values[hash.readUInt32BE(0) % values.length];
}

function accepted(value: string, kind: QuestionGold['answer']['kind'] = 'string'): QuestionGold['answer'] {
  return { kind, canonical: value, acceptedText: [value] };
}

function scenario(template: number, p: ProjectProfile, nextProjectId: string): ScenarioDraft {
  const durable = (session: 1 | 2 | 3 | 4, kind: DraftRecord['kind'], title: string, content: string, extra: Partial<DraftRecord> = {}): DraftRecord =>
    ({ session, kind, title, content, capture: 'durable', ...extra });
  const question = (
    category: QuestionCategory,
    text: string[],
    answer: QuestionGold['answer'],
    positive: DraftQuestion['positive'],
    extra: Partial<DraftQuestion> = {},
  ): DraftQuestion => ({ category, text, answer, positive, ...extra });

  switch (template) {
    case 1:
      return {
        records: [
          durable(1, 'architecture', 'Initial service architecture', `${p.name} uses ${p.oldArchitecture}.`),
          durable(2, 'observation', 'Architecture pressure', `The ${p.oldArchitecture} makes isolated deployment difficult.`),
          durable(3, 'architecture', 'Current service architecture', `${p.name} now uses ${p.currentArchitecture}.`, { supersedes: [0] }),
          durable(4, 'architecture', 'Rejected architecture alternative', `${p.name} considered a serverless rewrite but did not adopt it.`),
        ],
        questions: [
          question('architecture_decision', ['What architecture does the project use now?', 'Describe the current service architecture.'], accepted(p.currentArchitecture), [{ record: 2, grade: 3, role: 'answer' }, { record: 1, grade: 2, role: 'support' }], { harmful: [{ record: 0, reason: 'superseded' }], temporalKind: 'current' }),
          question('historical_state', ['What architecture was used before the replacement?', 'Which architecture was active initially?'], accepted(p.oldArchitecture), [{ record: 0, grade: 3, role: 'answer' }], { harmful: [{ record: 2, reason: 'future' }], asOfSession: 2, temporalKind: 'as_of' }),
        ],
      };
    case 2:
      return {
        records: [
          durable(1, 'state', 'Initial delivery state', `${p.name}: ${p.oldState}.`),
          durable(2, 'observation', 'State blocker removed', `The validation blocker for ${p.name} was resolved.`),
          durable(3, 'state', 'Current delivery state', `${p.name}: ${p.currentState}.`, { supersedes: [0] }),
          durable(4, 'state', 'Unrelated UI state', `${p.name} documentation theme remains under review.`),
        ],
        questions: [
          question('current_state', ['What is the current delivery state?', 'What status should a new session assume?'], accepted(p.currentState), [{ record: 2, grade: 3, role: 'answer' }, { record: 1, grade: 2, role: 'support' }], { harmful: [{ record: 0, reason: 'superseded' }], temporalKind: 'current' }),
          question('multi_session', ['Why is the current state no longer blocked?', 'What changed before the current status was recorded?'], accepted('the validation blocker was resolved'), [{ record: 1, grade: 3, role: 'answer' }, { record: 2, grade: 2, role: 'support' }], { groups: [[1], [2]] }),
        ],
      };
    case 3:
      return {
        records: [
          durable(1, 'state', 'January project state', `${p.name} reported ${p.oldState}.`),
          durable(2, 'state', 'March project state', `${p.name} moved into validation.`, { supersedes: [0] }),
          durable(3, 'state', 'June project state', `${p.name} reported ${p.currentState}.`, { supersedes: [1] }),
          durable(4, 'state', 'Similar dependency state', `${p.name} dependency refresh remains blocked.`),
        ],
        questions: [
          question('historical_state', ['What state was recorded in March?', 'Which project state was valid after January but before June?'], accepted('moved into validation'), [{ record: 1, grade: 3, role: 'answer' }], { harmful: [{ record: 2, reason: 'future' }], asOfSession: 2, temporalKind: 'as_of' }),
          question('current_state', ['What is the latest project state?', 'Which state supersedes the March update?'], accepted(p.currentState), [{ record: 2, grade: 3, role: 'answer' }], { harmful: [{ record: 0, reason: 'superseded' }, { record: 1, reason: 'superseded' }], temporalKind: 'current' }),
        ],
      };
    case 4:
      return {
        records: [
          durable(1, 'constraint', 'Non-negotiable project constraint', `${p.name}: ${p.constraint}.`),
          durable(2, 'failure', 'Constraint violation', `A proposed hosted workflow violated the rule that ${p.constraint}.`),
          durable(3, 'decision', 'Constraint reaffirmed', `The team reaffirmed that ${p.constraint}.`),
          durable(4, 'constraint', 'Different subsystem constraint', `${p.name} documentation may use a hosted preview.`),
        ],
        questions: [
          question('constraint', ['What constraint must every implementation preserve?', 'Which project rule is non-negotiable?'], accepted(p.constraint), [{ record: 0, grade: 3, role: 'answer' }, { record: 2, grade: 3, role: 'support' }], { groups: [[0, 2]] }),
          question('failed_approach', ['Should a hosted workflow that violates the core constraint proceed?', 'Warn or proceed with a design that breaks the recorded constraint?'], accepted('warn', 'warning'), [{ record: 0, grade: 3, role: 'answer' }, { record: 1, grade: 2, role: 'support' }], { failure: { shouldWarn: true, failedApproachSourceIds: [], requiredReasonFacts: [p.constraint] } }),
        ],
      };
    case 5:
      return {
        records: [
          durable(1, 'command', 'Old test command', `The old workflow used ${p.badCommand}.`, { locators: { command: p.badCommand } }),
          durable(2, 'failure', 'Old command failure', `${p.badCommand} produced nondeterministic shared-state failures.`),
          durable(3, 'command', 'Current test command', `Run ${p.goodCommand}.`, { supersedes: [0], locators: { command: p.goodCommand } }),
          durable(4, 'command', 'Documentation command', `Run a documentation-only check after tests.`),
        ],
        questions: [
          question('command_workflow', ['What command should run the tests now?', 'Give the current test command.'], accepted(p.goodCommand), [{ record: 2, grade: 3, role: 'answer' }], { harmful: [{ record: 0, reason: 'superseded' }] }),
          question('failed_approach', ['Why should the old parallel test command be avoided?', 'What failed when the earlier test command was used?'], accepted('nondeterministic shared-state failures'), [{ record: 1, grade: 3, role: 'answer' }, { record: 0, grade: 2, role: 'support' }], { failure: { shouldWarn: true, failedApproachSourceIds: [], requiredReasonFacts: ['nondeterministic shared-state failures'] } }),
        ],
      };
    case 6:
      return {
        records: [
          durable(1, 'symbol', 'Original symbol location', `${p.symbol} was defined in ${p.oldPath}.`, { locators: { path: p.oldPath, symbol: p.symbol } }),
          durable(2, 'decision', 'Symbol move approved', `The team approved moving ${p.symbol} into the shared module.`),
          durable(3, 'symbol', 'Current symbol location', `${p.symbol} is defined in ${p.currentPath}.`, { supersedes: [0], locators: { path: p.currentPath, symbol: p.symbol } }),
          durable(4, 'symbol', 'Similar helper location', `A test-only token helper remains in test/support/token-helper.`),
        ],
        questions: [
          question('code_symbol', [`Where is ${p.symbol} implemented now?`, `Give the current file for ${p.symbol}.`], accepted(p.currentPath), [{ record: 2, grade: 3, role: 'answer' }, { record: 1, grade: 1, role: 'background' }], { harmful: [{ record: 0, reason: 'superseded' }] }),
          question('historical_state', [`Where was ${p.symbol} before it moved?`, `Which file originally owned ${p.symbol}?`], accepted(p.oldPath), [{ record: 0, grade: 3, role: 'answer' }], { harmful: [{ record: 2, reason: 'future' }], asOfSession: 1, temporalKind: 'as_of' }),
        ],
      };
    case 7:
      return {
        records: [
          durable(1, 'failure', 'Failed implementation approach', `${p.failedApproach} failed.`),
          durable(2, 'failure', 'Failure root cause', `The attempt failed because ${p.failureReason}.`),
          durable(3, 'correction', 'Working implementation approach', `Use this approach instead: ${p.successfulApproach}.`, { supersedes: [0] }),
          durable(4, 'observation', 'Similar but unrelated success', `A documentation migration succeeded with parallel workers.`),
        ],
        questions: [
          question('failed_approach', ['Should the previously failed strategy be attempted again?', 'Warn or proceed with the recorded failed approach?'], accepted('warn', 'warning'), [{ record: 0, grade: 3, role: 'answer' }, { record: 1, grade: 3, role: 'support' }], { failure: { shouldWarn: true, failedApproachSourceIds: [], requiredReasonFacts: [p.failureReason] } }),
          question('failed_approach', ['Why did the earlier approach fail?', 'State the known root cause of the failed strategy.'], accepted(p.failureReason), [{ record: 1, grade: 3, role: 'answer' }, { record: 0, grade: 2, role: 'support' }]),
        ],
      };
    case 8:
      return {
        records: [
          durable(1, 'decision', 'Original runtime decision', `${p.name}: ${p.oldDecision}.`),
          durable(2, 'observation', 'Runtime upgrade evidence', `Compatibility testing passed for the newer runtime.`),
          durable(3, 'decision', 'Current runtime decision', `${p.name}: ${p.currentDecision}.`, { supersedes: [0] }),
          durable(4, 'decision', 'Unrelated build runtime', `Documentation generation still uses a separate container runtime.`),
        ],
        questions: [
          question('superseded_decision', ['What is the current runtime decision?', 'Which runtime decision is active now?'], accepted(p.currentDecision), [{ record: 2, grade: 3, role: 'answer' }, { record: 1, grade: 2, role: 'support' }], { harmful: [{ record: 0, reason: 'superseded' }] }),
          question('superseded_decision', ['Which source replaced the original runtime decision?', 'What decision superseded the old runtime choice?'], accepted(p.currentDecision), [{ record: 2, grade: 3, role: 'answer' }, { record: 0, grade: 1, role: 'background' }]),
        ],
      };
    case 9:
      return {
        records: [
          durable(1, 'observation', 'First configuration claim', `One note says the active value is ${p.staleValue}.`),
          durable(2, 'observation', 'Conflicting configuration claim', `A second note says the active value is ${p.currentValue}.`, { contradicts: [0] }),
          durable(3, 'decision', 'Authoritative conflict resolution', `The release owner confirmed ${p.currentValue}.`, { resolves: [0, 1], supersedes: [0] }),
          durable(4, 'observation', 'Unverified repeated claim', `An old chat message repeats ${p.staleValue}.`),
        ],
        questions: [
          question('contradiction', ['Which conflicting value is authoritative?', 'How was the configuration conflict resolved?'], accepted(p.currentValue), [{ record: 2, grade: 3, role: 'answer' }, { record: 1, grade: 2, role: 'support' }], { harmful: [{ record: 0, reason: 'contradicted' }, { record: 3, reason: 'contradicted' }], temporalKind: 'contradiction' }),
          question('contradiction', ['Which source resolves the contradictory notes?', 'What evidence should win the conflict?'], accepted('the release owner confirmation'), [{ record: 2, grade: 3, role: 'answer' }], { harmful: [{ record: 3, reason: 'contradicted' }] }),
        ],
      };
    case 10:
      return {
        records: [
          durable(1, 'state', 'Cached configuration value', `A cached report lists ${p.staleValue}.`),
          durable(2, 'state', 'Current configuration value', `The authoritative configuration is ${p.currentValue}.`, { supersedes: [0] }),
          durable(3, 'observation', 'Stale report repeated', `A stale diagnostic still prints ${p.staleValue}.`, { capture: 'temporary' }),
          durable(4, 'decision', 'Current value confirmed', `The team confirmed ${p.currentValue}.`),
        ],
        questions: [
          question('stale_evidence', ['What is the current authoritative value?', 'Which value should a new session use?'], accepted(p.currentValue), [{ record: 1, grade: 3, role: 'answer' }, { record: 3, grade: 3, role: 'support' }], { harmful: [{ record: 0, reason: 'superseded' }, { record: 2, reason: 'refuted_temporary' }] }),
          question('stale_evidence', ['Is the value printed by the stale diagnostic still valid?', 'Should the cached value be trusted now?'], accepted('no'), [{ record: 1, grade: 3, role: 'answer' }, { record: 3, grade: 2, role: 'support' }], { harmful: [{ record: 2, reason: 'refuted_temporary' }] }),
        ],
      };
    case 11:
      return {
        records: [
          durable(1, 'constraint', 'First workflow prerequisite', `${p.gotcha}.`),
          durable(2, 'command', 'Second workflow prerequisite', `Use ${p.goodCommand} after satisfying the environment prerequisite.`, { locators: { command: p.goodCommand } }),
          durable(3, 'decision', 'Combined workflow', `The supported workflow combines the environment prerequisite with ${p.goodCommand}.`),
          durable(4, 'command', 'Similar unsupported shortcut', `A shortcut skips the environment prerequisite.`),
        ],
        questions: [
          question('multi_session', ['What two prerequisites make the workflow reliable?', 'Combine the environment and command requirements.'], accepted(`${p.gotcha}; ${p.goodCommand}`, 'set'), [{ record: 0, grade: 3, role: 'answer' }, { record: 1, grade: 3, role: 'answer' }, { record: 2, grade: 2, role: 'support' }], { groups: [[0], [1]] }),
          question('multi_session', ['Why is the shortcut unsupported?', 'Which prerequisite does the shortcut omit?'], accepted(p.gotcha), [{ record: 0, grade: 3, role: 'answer' }, { record: 3, grade: 1, role: 'background' }]),
        ],
      };
    case 12:
      return {
        records: [
          durable(1, 'architecture', 'Deployment overview', `${p.name} documents its deployment architecture.`),
          durable(2, 'constraint', 'Local development note', `${p.name} documents local development constraints.`),
          durable(3, 'command', 'Routine maintenance command', `${p.name} has a routine maintenance command.`),
          durable(4, 'state', 'Unrelated credential wording', `Credential rotation is mentioned, but no credential value is stored.`),
        ],
        questions: [
          question('abstention', ['What is the production administrator password?', 'Return the stored production password.'], { kind: 'abstain', canonical: null, acceptedText: ['unknown'] }, [], { shouldAbstain: true }),
          question('abstention', ['Which private signing key is deployed?', 'Give the production signing secret.'], { kind: 'abstain', canonical: null, acceptedText: ['unknown'] }, [], { shouldAbstain: true }),
        ],
      };
    case 13:
      return {
        records: [
          durable(1, 'observation', 'Temporary debugging hypothesis', `The team temporarily suspected a network timeout.`, { capture: 'refuted' }),
          durable(2, 'observation', 'Hypothesis refuted', `Tracing disproved the network-timeout hypothesis.`),
          durable(3, 'correction', 'Confirmed root cause', `The confirmed root cause was: ${p.failureReason}.`, { supersedes: [0] }),
          durable(4, 'observation', 'Similar unresolved symptom', `A separate documentation task reported a timeout message.`),
        ],
        questions: [
          question('current_state', ['What is the confirmed root cause?', 'Which diagnosis replaced the temporary hypothesis?'], accepted(p.failureReason), [{ record: 2, grade: 3, role: 'answer' }, { record: 1, grade: 2, role: 'support' }], { harmful: [{ record: 0, reason: 'refuted_temporary' }] }),
          question('stale_evidence', ['Was the temporary network hypothesis confirmed?', 'Should the first debugging hypothesis be retained as truth?'], accepted('no'), [{ record: 1, grade: 3, role: 'answer' }, { record: 2, grade: 2, role: 'support' }], { harmful: [{ record: 0, reason: 'refuted_temporary' }] }),
        ],
      };
    case 14:
      return {
        records: [
          durable(1, 'gotcha', 'Environment prerequisite', `${p.name}: ${p.gotcha}.`),
          durable(2, 'failure', 'Missing prerequisite symptom', `Without the prerequisite, ${p.symptom}.`),
          durable(3, 'command', 'Validated environment workflow', `Set up the prerequisite before running ${p.goodCommand}.`),
          durable(4, 'gotcha', 'Different platform note', `A different platform uses an unrelated emulator setting.`),
        ],
        questions: [
          question('constraint', ['What environment gotcha must setup handle?', 'Which prerequisite is easy to miss?'], accepted(p.gotcha), [{ record: 0, grade: 3, role: 'answer' }, { record: 2, grade: 2, role: 'support' }]),
          question('failed_approach', ['What symptom appears when the prerequisite is missing?', 'How does the environment fail without the gotcha fix?'], accepted(p.symptom), [{ record: 1, grade: 3, role: 'answer' }, { record: 0, grade: 2, role: 'support' }]),
        ],
      };
    case 15:
      return {
        records: [
          durable(1, 'command', 'Command that failed', `The team first ran ${p.badCommand}.`, { locators: { command: p.badCommand } }),
          durable(2, 'failure', 'Command failure reason', `The command failed because ${p.failureReason}.`),
          durable(3, 'command', 'Command that succeeded', `The corrected command is ${p.goodCommand}.`, { supersedes: [0], locators: { command: p.goodCommand } }),
          durable(4, 'command', 'Similar command for another task', `A packaging task uses a similar but different command.`),
        ],
        questions: [
          question('command_workflow', ['Which command succeeded after the correction?', 'What is the working command?'], accepted(p.goodCommand), [{ record: 2, grade: 3, role: 'answer' }], { harmful: [{ record: 0, reason: 'superseded' }] }),
          question('failed_approach', ['Why did the first command fail?', 'Give the known reason the original command was rejected.'], accepted(p.failureReason), [{ record: 1, grade: 3, role: 'answer' }, { record: 0, grade: 2, role: 'support' }]),
        ],
      };
    case 16:
      return {
        records: [
          durable(1, 'state', 'Project-scoped active value', `${p.name} uses ${p.currentValue}.`),
          durable(2, 'decision', 'Project scope confirmed', `The value applies only to ${p.name}.`),
          durable(3, 'state', 'Project-scoped fallback', `${p.name} falls back to ${p.staleValue} only during rollback.`),
          durable(4, 'state', 'Similar local wording', `A sample project uses a different active value.`),
        ],
        questions: [
          question('current_state', [`What active value belongs to ${p.name}?`, `Within this project, what value is current?`], accepted(p.currentValue), [{ record: 0, grade: 3, role: 'answer' }, { record: 1, grade: 2, role: 'support' }], { harmful: [{ sourceId: sourceId(nextProjectId, 16, 1), reason: 'cross_project' }] }),
          question('abstention', [`What active value belongs to an unmentioned external project?`, `Give the value for a project that is not in this history.`], { kind: 'abstain', canonical: null, acceptedText: ['unknown'] }, [], { shouldAbstain: true, harmful: [{ record: 0, reason: 'cross_project' }] }),
        ],
      };
    case 17:
      return {
        records: [
          durable(1, 'decision', 'Durable release decision', `${p.name}: ${p.currentDecision}.`),
          durable(2, 'constraint', 'Release decision reason', `The decision preserves ${p.constraint}.`),
          durable(3, 'state', 'Release decision confirmed', `The release configuration now reflects ${p.currentDecision}.`),
          durable(4, 'observation', 'Credential redaction note', `A synthetic credential appeared in raw output and must not be retained.`),
        ],
        questions: [
          question('current_state', ['Which durable release decision should be remembered?', 'What release decision survived the noisy session?'], accepted(p.currentDecision), [{ record: 0, grade: 3, role: 'answer' }, { record: 2, grade: 2, role: 'support' }]),
          question('abstention', ['What synthetic credential value appeared in raw output?', 'Return the credential that should have been redacted.'], { kind: 'abstain', canonical: null, acceptedText: ['unknown'] }, [], { shouldAbstain: true }),
        ],
      };
    case 18:
      return {
        records: [
          durable(1, 'decision', 'Decision before interruption', `${p.name} chose to ${p.successfulApproach}.`),
          durable(2, 'observation', 'Interrupted implementation progress', `Implementation began but the session ended unexpectedly.`),
          durable(3, 'state', 'Recovered session state', `The resumed session recovered the earlier decision.`),
          durable(4, 'state', 'Recovered outcome', `The resumed work completed using ${p.successfulApproach}.`),
        ],
        questions: [
          question('current_state', ['Which decision must survive the interrupted session?', 'What should the resumed session remember?'], accepted(p.successfulApproach), [{ record: 0, grade: 3, role: 'answer' }, { record: 2, grade: 2, role: 'support' }]),
          question('multi_session', ['What approach connected the interrupted and resumed sessions?', 'How did the resumed work finish successfully?'], accepted(p.successfulApproach), [{ record: 0, grade: 3, role: 'answer' }, { record: 3, grade: 3, role: 'support' }], { groups: [[0], [3]] }),
        ],
      };
    case 19:
      return {
        records: [
          durable(1, 'decision', 'Idempotent event decision', `${p.name}: ${p.currentDecision}.`),
          durable(2, 'observation', 'First event delivery', `The decision event was delivered once.`),
          durable(3, 'observation', 'Replay detected', `The same event was replayed and must not create another memory.`),
          durable(4, 'state', 'Decision remains singular', `Only one durable decision remains active.`),
        ],
        questions: [
          question('current_state', ['What decision remains after duplicate delivery?', 'Which single decision should be active?'], accepted(p.currentDecision), [{ record: 0, grade: 3, role: 'answer' }, { record: 3, grade: 2, role: 'support' }]),
          question('multi_session', ['How many durable copies should duplicate delivery create?', 'What is the idempotent outcome of replaying the event?'], accepted('one'), [{ record: 2, grade: 2, role: 'support' }, { record: 3, grade: 3, role: 'answer' }]),
        ],
      };
    default:
      return {
        records: [
          durable(1, 'observation', 'Malformed tool output observed', `A tool returned malformed JSON but no durable fact.`),
          durable(2, 'decision', 'Useful decision beside noise', `${p.name}: ${p.currentDecision}.`),
          durable(3, 'observation', 'Irrelevant build output', `A verbose build log contained no new decision.`),
          durable(4, 'state', 'Useful decision confirmed', `The active decision remains ${p.currentDecision}.`),
        ],
        questions: [
          question('current_state', ['Which useful decision should survive malformed output?', 'What durable fact appeared beside the junk output?'], accepted(p.currentDecision), [{ record: 1, grade: 3, role: 'answer' }, { record: 3, grade: 2, role: 'support' }]),
          question('abstention', ['What valid JSON value was contained in the malformed tool output?', 'Recover the missing field from the broken JSON.'], { kind: 'abstain', canonical: null, acceptedText: ['unknown'] }, [], { shouldAbstain: true }),
        ],
      };
  }
}

function opaqueId(prefix: string, ...parts: Array<string | number>): string {
  const value = createHash('sha256')
    .update(`coding-memory-v1:${prefix}:${parts.join(':')}`)
    .digest('hex')
    .slice(0, 24);
  return `${prefix}_${value}`;
}

function sourceId(projectId: string, template: number, session: number): string {
  return opaqueId('src', projectId, template, session, 'record');
}

function nativeNoise(template: number, projectId: string, session: number, occurredAt: string): Array<{ event: NativeEvent; exclusion: CaptureGold['exclusions'][number] }> {
  if (template === 17 && session === 2) {
    const id = opaqueId('src', projectId, template, session, 'noise-a');
    return [{
      event: { sourceId: id, occurredAt, type: 'tool_result', content: `<SYNTHETIC_SECRET:${projectId}:t17>` },
      exclusion: { sourceId: id, reason: 'secret' },
    }];
  }
  if (template === 19 && session === 3) {
    const id = opaqueId('src', projectId, template, session, 'noise-a');
    return [{
      event: { sourceId: id, occurredAt, type: 'assistant', content: 'Duplicate replay of the prior decision.', replayOf: sourceId(projectId, template, 1) },
      exclusion: { sourceId: id, reason: 'duplicate' },
    }];
  }
  if (template === 20 && session === 1) {
    const malformed = opaqueId('src', projectId, template, session, 'noise-a');
    const irrelevant = opaqueId('src', projectId, template, session, 'noise-b');
    return [
      { event: { sourceId: malformed, occurredAt, type: 'tool_result', content: '{"broken":' }, exclusion: { sourceId: malformed, reason: 'malformed' } },
      { event: { sourceId: irrelevant, occurredAt, type: 'tool_result', content: 'progress 1 2 3 4 5' }, exclusion: { sourceId: irrelevant, reason: 'irrelevant' } },
    ];
  }
  return [];
}

export function generateCodingMemoryBundle(seed: string = BENCHMARK_GENERATOR_VERSION): BenchmarkBundle {
  const normalizedRecords: NormalizedRecord[] = [];
  const nativeHistories: NativeHistory[] = [];
  const queries: PublicQuery[] = [];
  const questionGold: QuestionGold[] = [];
  const captureGold: CaptureGold[] = [];

  PROJECTS.forEach((project, projectIndex) => {
    const nextProjectId = PROJECTS[(projectIndex + 1) % PROJECTS.length].id;
    for (let template = 1; template <= 20; template += 1) {
      const historyId = opaqueId('history', project.id, template);
      const draft = scenario(template, project, nextProjectId);
      const base = Date.UTC(2026, 0, 1) + projectIndex * 120 * 86_400_000 + template * 5 * 86_400_000;
      const sessionTimes = [1, 2, 3, 4].map(index => new Date(base + index * 86_400_000).toISOString());
      const ids = draft.records.map(record => sourceId(project.id, template, record.session));
      const historyExclusions: CaptureGold['exclusions'] = [];
      const targets: CaptureGold['targets'] = [];

      draft.records.forEach((record, index) => {
        const sessionId = opaqueId('session', project.id, template, record.session);
        const relations = {
          ...(record.supersedes?.length ? { supersedes: record.supersedes.map(value => ids[value]) } : {}),
          ...(record.contradicts?.length ? { contradicts: record.contradicts.map(value => ids[value]) } : {}),
          ...(record.resolves?.length ? { resolves: record.resolves.map(value => ids[value]) } : {}),
        };
        normalizedRecords.push({
          sourceId: ids[index],
          projectId: project.id,
          historyId,
          sessionId,
          occurredAt: sessionTimes[record.session - 1],
          availableAt: sessionTimes[record.session - 1],
          kind: record.kind,
          title: record.title,
          content: record.content,
          ...(Object.keys(relations).length ? { relations } : {}),
          ...(record.locators ? { locators: record.locators } : {}),
        });
        if (!record.capture || record.capture === 'durable') {
          targets.push({ targetId: opaqueId('target', project.id, template, index + 1), canonicalFact: record.content, evidenceSourceIds: [ids[index]] });
        } else {
          historyExclusions.push({ sourceId: ids[index], reason: record.capture });
        }
      });

      const sessions = draft.records.map((record, index) => {
        const sessionId = opaqueId('session', project.id, template, record.session);
        const startedAt = sessionTimes[record.session - 1];
        const noise = nativeNoise(template, project.id, record.session, startedAt);
        historyExclusions.push(...noise.map(item => item.exclusion));
        const interrupted = template === 18 && record.session === 3;
        return {
          sessionId,
          startedAt,
          endedAt: interrupted ? null : new Date(Date.parse(startedAt) + 3_600_000).toISOString(),
          termination: interrupted ? 'interrupted' as const : 'normal' as const,
          events: [
            { sourceId: opaqueId('src', project.id, template, record.session, 'lifecycle-start'), occurredAt: startedAt, type: 'lifecycle' as const, content: 'session_start' },
            { sourceId: opaqueId('src', project.id, template, record.session, 'user'), occurredAt: startedAt, type: 'user' as const, content: `Continue work on ${project.name}.` },
            { sourceId: ids[index], occurredAt: startedAt, type: 'assistant' as const, content: record.content },
            ...noise.map(item => item.event),
            { sourceId: opaqueId('src', project.id, template, record.session, 'lifecycle-end'), occurredAt: startedAt, type: 'lifecycle' as const, content: interrupted ? 'interruption' : 'session_end' },
          ],
        };
      });
      nativeHistories.push({ historyId, projectId: project.id, sessions });
      captureGold.push({ historyId, targets, exclusions: historyExclusions });

      draft.questions.forEach((draftQuestion, questionIndex) => {
        const questionId = opaqueId('question', project.id, template, questionIndex + 1);
        const issuedAt = new Date(base + 5 * 86_400_000).toISOString();
        const asOf = draftQuestion.asOfSession
          ? new Date(Date.parse(sessionTimes[draftQuestion.asOfSession - 1]) + 12 * 3_600_000).toISOString()
          : undefined;
        queries.push({
          questionId,
          projectId: project.id,
          historyId,
          issuedAt,
          ...(asOf ? { asOf } : {}),
          text: pick(seed, `${questionId}:wording`, draftQuestion.text),
        });
        const judgments = draftQuestion.positive.map(item => ({ sourceId: ids[item.record], grade: item.grade, role: item.role }));
        const harmful = (draftQuestion.harmful ?? []).map(item => ({
          sourceId: item.sourceId ?? ids[item.record!],
          reason: item.reason,
        }));
        const failure = draftQuestion.failure
          ? {
              ...draftQuestion.failure,
              failedApproachSourceIds: draftQuestion.failure.failedApproachSourceIds.length
                ? draftQuestion.failure.failedApproachSourceIds
                : judgments.filter(item => item.role !== 'background').map(item => item.sourceId),
            }
          : undefined;
        questionGold.push({
          questionId,
          category: draftQuestion.category,
          shouldAbstain: draftQuestion.shouldAbstain ?? false,
          answer: draftQuestion.answer,
          judgments,
          requiredEvidenceGroups: (draftQuestion.groups ?? draftQuestion.positive.filter(item => item.grade === 3).map(item => [item.record]))
            .map(group => group.map(record => ids[record])),
          harmful,
          ...(draftQuestion.temporalKind ? { temporalKind: draftQuestion.temporalKind } : {}),
          ...(failure ? { failure } : {}),
        });
      });
    }
  });

  return {
    manifest: {
      schemaVersion: BENCHMARK_SCHEMA_VERSION,
      datasetId: 'coding-memory-v1',
      generatorVersion: BENCHMARK_GENERATOR_VERSION,
      seed,
      defaultRelevanceGrade: 0,
      generatedAt: '2026-07-13T00:00:00.000Z',
      counts: { projects: PROJECTS.length, histories: nativeHistories.length, sessions: nativeHistories.length * 4, questions: queries.length },
      digests: {},
    },
    normalizedRecords,
    nativeHistories,
    queries,
    questionGold,
    captureGold,
  };
}
