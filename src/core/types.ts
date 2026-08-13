export type KnowledgeCategory =
  | 'fact'           // Objective truths
  | 'decision'       // Choices with reasoning
  | 'goal'           // Desired outcomes
  | 'constraint'     // Hard rules
  | 'architecture'   // Structural understanding
  | 'state'          // Current activity
  | 'skill';         // Learned procedures

const CATEGORY_VALUES = ['fact', 'decision', 'goal', 'constraint', 'architecture', 'state', 'skill'] as const;

/**
 * The same categories as a runtime list, for validating input and for enumerating them.
 *
 * The `Exclude<...> extends never` guard makes a category added to the union but not to this
 * list a compile error. Without it, the list silently drifts and the validator starts
 * rejecting a category the rest of the system accepts -- which is the failure this constant
 * exists to prevent, since it now backs both the MCP tool schemas and CLI input checking.
 */
export const KNOWLEDGE_CATEGORIES: Exclude<KnowledgeCategory, typeof CATEGORY_VALUES[number]> extends never
  ? typeof CATEGORY_VALUES
  : never = CATEGORY_VALUES;

export function isKnowledgeCategory(value: string): value is KnowledgeCategory {
  return (KNOWLEDGE_CATEGORIES as readonly string[]).includes(value);
}

export type KnowledgeStatus =
  | 'active'
  | 'deprecated'
  | 'rejected'
  | 'archived'
  | 'superseded';

export type KnowledgeFreshness =
  | 'fresh'
  | 'stale'
  | 'needs_review';

/**
 * Standing earned by use, orthogonal to self-reported confidence. Every write starts
 * `asserted`; repeated confirmed-useful feedback promotes to `verified`; a correction or a
 * content edit resets, because verified means verified-verbatim. Deliberately absent from
 * lifecycleHash: verification is this machine's own experience with the item, and an
 * imported copy has not been used here yet.
 */
export type KnowledgeTier = 'asserted' | 'verified';

/**
 * How the knowledge came to be believed, fixed at write time. `observed` — from execution
 * or direct inspection; `user_stated` — the human said so; `inferred` — the agent
 * concluded it. A reflected lesson reads as authoritative once stored, so the class it
 * was born with is the only record that it was ever a guess.
 */
export type KnowledgeProvenance = 'observed' | 'user_stated' | 'inferred';

export type SessionStatus = 'active' | 'finished' | 'failed' | 'abandoned' | 'recovered';
export type SessionEventType = 'start' | 'command' | 'test' | 'error' | 'git' | 'decision' | 'checkpoint' | 'stop';

export interface MemorySession {
  id: string; agent?: string | null; title: string; query?: string | null; status: SessionStatus;
  startedAt: string; lastHeartbeatAt: string; finishedAt?: string | null; baselineCommit?: string | null; expiresAt: string;
}

export interface MemorySessionEvent {
  id: string; sessionId: string; type: SessionEventType; payload: Record<string, unknown>; observedAt: string; expiresAt: string;
}

export interface MemoryCandidate extends KnowledgeAtom {
  candidateType: 'outcome' | 'decision' | 'error' | 'commit' | 'verified-command' | 'task-state';
  sessionId: string;
  evidence: EvidenceInput[];
}

export interface KnowledgeItem {
  id: string;
  category: KnowledgeCategory;
  status: KnowledgeStatus;
  title: string;
  content: string;
  reasoning?: string | null;
  alternatives?: string[] | null; // stored as JSON array of strings
  tags?: string[] | null;         // stored as JSON array of strings
  source?: string | null;
  sourceCommit?: string | null;
  affectedPaths?: string[] | null; // stored as JSON array of repository-relative paths
  contentHash?: string | null;
  /**
   * Fingerprint of status, freshness, supersession, owner and visibility. Distinct from
   * `contentHash` because the two diverge independently: a promotion or a retirement leaves
   * content byte-identical, and an import classifying on content alone skipped it.
   */
  lifecycleHash?: string | null;
  /** Owning repo in a workspace; null outside one. The only lifecycle key. */
  originRepo?: string | null;
  /** 'repo' | 'workspace'. Logical scope, independent of which file holds the row. */
  visibility?: string | null;
  freshness: KnowledgeFreshness;
  confidence: number;
  tier: KnowledgeTier;
  /** When `tier` was last set; confirmations before it belong to a superseded standing. */
  tierSince?: string | null;
  provenance?: KnowledgeProvenance | null;
  conflictKey?: string | null;
  conflictScope?: Record<string, unknown> | null;
  conflictExclusive?: boolean;
  supersededById?: string | null;
  version: number;
  createdAt: string;
  updatedAt: string;
}

export interface KnowledgeAssertion {
  id: string;
  knowledgeItemId: string;
  content: string;
  validFrom: string;
  validTo?: string | null;
  recordedAt: string;
  replacedAt?: string | null;
  confidence: number;
  sourceEvidenceId?: string | null;
  conflictKey?: string | null;
  conflictScope?: Record<string, unknown> | null;
  conflictExclusive?: boolean;
}

export interface KnowledgeCommit {
  id: string;
  message: string;
  changes: CommitChange[]; // stored as JSON
  createdAt: string;
}

export type EvidenceType = 'file' | 'symbol' | 'commit' | 'test' | 'command' | 'url' | 'user' | 'agent';
export type EvidenceRelationship = 'supports' | 'contradicts' | 'derived_from';

export interface Evidence {
  id: string;
  type: EvidenceType;
  locator: string;
  contentHash?: string | null;
  excerpt?: string | null;
  observedAt: string;
  metadata?: Record<string, unknown> | null;
}

export interface KnowledgeEvidence {
  knowledgeItemId: string;
  evidenceId: string;
  relationship: EvidenceRelationship;
}

export type CodeSymbolKind = 'class' | 'function' | 'method' | 'import' | 'export' | 'variable';

export interface CodeFile {
  path: string;
  contentHash: string;
  updatedAt: string;
}

export interface CodeSymbol {
  locator: string;
  filePath: string;
  qualifiedName: string;
  kind: CodeSymbolKind;
  startLine: number;
  endLine: number;
  signature: string | null;
  signatureHash: string | null;
}

export interface CodeSymbolEdge {
  fromLocator: string;
  toLocator: string;
  kind: 'imports' | 'exports';
}

export type KnowledgeSearchExplanation = {
  finalScore: number;
  bm25Rank?: number;
  vectorRank?: number;
  contributions: Record<string, number>;
  reason: string;
  /**
   * The relevance floor found no confident match for this query, and this row is one of the
   * stores it judged. Present only when true, so an answered query costs nothing.
   *
   * A verdict rather than a filter. The floor used to delete the whole ranking here; it was
   * measured deleting real answers, because a fixed absolute cosine does not transfer between
   * corpora (docs/evals/floor-sweep.md).
   */
  abstained?: boolean;
  /**
   * `finalScore` is not a calibrated relevance for this row, and this is why. Present only
   * when set, mirroring `abstained`, so the calibrated path costs nothing.
   *
   * Two reasons are the ranker's to know: no semantic half ran at all (`lexical-only` -- the
   * ranking is each corpus's rows against its own best hit, so the top result scores ~1.0
   * whatever it is), or vector ran and never saw this row (`not embedded` -- its semantic half
   * is 0 by absence, not by verdict, the same predicate the relevance floor exempts on). The
   * third reason a caller can add, `layered namespaces`, belongs to the path that layers.
   */
  uncalibrated?: 'lexical-only' | 'not embedded';
};

export type ExplainedKnowledgeItem = KnowledgeItem & { explanation: KnowledgeSearchExplanation };

export type EvidenceInput = Omit<Evidence, 'id'> & { relationship?: EvidenceRelationship };

export interface CommitChange {
  itemId: string;
  action: 'insert' | 'update' | 'delete' | 'supersede' | 'deprecate' | 'archive' | 'reject' | 'restore';
  before?: Partial<KnowledgeItem> | null;
  after?: Partial<KnowledgeItem> | null;
}

export interface SkillStep {
  id: string;
  knowledgeItemId: string;
  stepOrder: number;
  instruction: string;
  createdAt: string;
}

export interface SkillMetadata {
  knowledgeItemId: string;
  usageCount: number;
  successCount: number;
  lastUsed?: string | null;
}

export interface Project {
  id: string;
  name: string;
  description?: string | null;
  rootPath: string;
  createdAt: string;
  updatedAt: string;
}

export interface ProjectConfig {
  version: number;
  // `project` used to hold a name and description. Nothing has read either for a long time and
  // `stripDeprecatedConfigFields` deletes the block on every load, so declaring it here described
  // a field the product does not have. The strip stays: it is what cleans the key out of configs
  // written before this.
  ai?: {
    provider: 'openai' | 'anthropic' | 'ollama' | 'custom';
    model: string;
    temperature?: number;
    baseUrl?: string;
    apiKey?: string;
  };
  search?: {
    vector?: {
      enabled?: boolean;
      provider?: 'local';
      /** Named profile bundling model, dtype and pooling. See resolveVectorProfile. */
      preset?: string;
      model?: string;
      dtype?: 'q4' | 'q8' | 'fp32' | 'fp16';
      /** Only read when the preset is `custom` or absent; a preset carries its own. */
      pooling?: 'mean' | 'cls';
      cacheDir?: string;
    };
    /**
     * Searchable session transcripts. Off by default: enabling it creates a second
     * database and registers two more MCP tools, which costs guidance-card space in
     * every session of every user -- including those who never search a transcript.
     */
    transcripts?: {
      enabled?: boolean;
      /** Let linked workspace repos open this index read-only. Requires `enabled`. */
      share?: boolean;
    };
  };
  memory?: {
    organization?: { enabled?: boolean; path?: string };
    global?: { enabled?: boolean; path?: string };
  };
  /**
   * Pointer to a Knowl Cloud workspace. Never a credential -- this file is deliberately
   * force-committable so the pointer travels with a clone, and `isConfigTrackedByGit`
   * exists for that case. Credentials live in `knowlHome()/credentials.json`.
   */
  cloud?: {
    apiHost: string;
    workspaceId: string;
    workspaceName?: string;
    /**
     * What this project publishes under: a normalized remote identity when there is a remote,
     * otherwise a name that was given or taken from the project directory. A label, not a claim
     * about version control -- the server accepts any non-empty string here.
     */
    repo: string;
    /**
     * Which remote it was derived from, so a fork's choice stays inspectable. Absent when the
     * identity did not come from one, which is not the same as `origin`.
     */
    remote?: string;
    /**
     * Stage new knowledge as it is written. Absent means on; only an explicit false disables it.
     *
     * Safe to keep in this committable file, unlike auto-push consent: staging sends nothing, is
     * visible in `knowl cloud status`, and is reversible with `knowl cloud unstage`. Consent to
     * send irreversibly is per-machine and lives under `knowlHome()` instead.
     */
    autoStage?: boolean;
  };
  /**
   * Live change-impact detection: what a session read, whether that code moved underneath
   * it, and findings an agent can pull and adjudicate. Off by default for two separate
   * reasons. Refusing the write itself is a separate switch, `gate` below, for a separate
   * risk.
   *
   * It is advisory machinery that spends context: findings reach the agent through the
   * shared change card, and tool-side noise is the channel a wrong finding damages most, so
   * a repository that never asked for it must pay nothing -- not a card line and not a
   * capture write.
   *
   * Deliberately absent from DEFAULT_CONFIG for the same reason `search.transcripts` is:
   * `upgradeConfigDefaults` merges that object into every config on the machine, so a
   * default written there would switch the subsystem on in every repository the user has
   * ever initialized, at once, with nothing in any of them recording that it happened.
   */
  impact?: {
    enabled?: boolean;
    /**
     * Whether the `PreToolUse` write gate refuses an edit whose premise has already moved.
     *
     * A second switch rather than a mode of `enabled`, because the two carry different kinds of
     * risk. Detection spends context and can be wrong inside a card; the gate refuses a tool
     * call, and being wrong there costs somebody their working session. Arming it is therefore a
     * separate, deliberate act.
     *
     * `shadow` computes the identical verdict, records it in `impact_gate_shadow`, and lets the
     * write through -- the state the certain tier's ≥95%-over-≥40-findings bar is measured in,
     * before anything is permitted to block. `enforce` denies and hands back what changed.
     *
     * Meaningless without `enabled`, and resolved to `off` in that case rather than honoured:
     * the gate reads the findings the detector writes, so an armed gate over a disabled detector
     * can never fire while claiming it can.
     */
    gate?: 'off' | 'shadow' | 'enforce';
  };
  /**
   * The write side's negative signal: sessions that talked and stored nothing.
   *
   * The write path has admission control -- secret validation, categories, conflict keys --
   * deciding what gets *in*. Nothing detected what should have got in and did not, and the
   * knowledge with no verification moment to trigger a save is exactly the most durable kind:
   * declared intent. The only detector before this was a user noticing and asking.
   *
   * Measurement is unconditional and costs one counter per session; `nudge` decides only what
   * is done with the answer. Deliberately absent from DEFAULT_CONFIG, for the reason `impact`
   * and `search.transcripts` are: `upgradeConfigDefaults` merges defaults into every config on
   * the machine, so a value written there would arm this in every repository at once.
   */
  capture?: {
    /**
     * `shadow` records the nudge it would have delivered and delivers nothing. `enforce` blocks
     * the stop once, with the nudge as the reason, and never blocks that session again.
     *
     * A separate switch from measurement, and off by default, because the two carry different
     * risk. Counting is invisible; blocking a stop takes a turn the person did not ask for, and
     * a heuristic that fires on a session which stored plenty is the fatigue that teaches
     * everyone to ignore the channel. Shadow is where this is expected to sit until the numbers
     * say otherwise -- the same ladder `impact.gate` climbs.
     */
    nudge?: 'off' | 'shadow' | 'enforce';
  };
  /**
   * This repo's half of workspace membership. The other half is the workspace manifest
   * listing this repo; either alone is not membership, which is what makes linkage
   * un-forgeable by a cloned repository.
   */
  workspace?: { workspace: string; repo: string };
  security: {
    rejectSecrets: boolean;
    secretPatterns: string[];
  };
  /** Opt out of the once-a-day npm update check shown by `status` and `doctor`. */
  updateCheck?: {
    enabled?: boolean;
  };
}

export interface FilterResult {
  pass: boolean;
  reason?: string;
}

export type KnowledgeWriteInput = {
  title?: string | null;
  content?: string | null;
  reasoning?: string | null;
  source?: string | null;
  affectedPaths?: string[] | null;
  rawOutput?: string | null;
};

export type KnowledgeWriteValidationOptions = {
  rejectSecrets?: boolean;
  secretPatterns?: string[];
  maxFieldLength?: number;
  maxRawOutputLength?: number;
};

export interface KnowledgeAtom {
  category: KnowledgeCategory;
  title: string;
  content: string;
  reasoning?: string | null;
  alternatives?: string[] | null;
  tags?: string[] | null;
  source?: string | null;
  sourceCommit?: string | null;
  affectedPaths?: string[] | null;
  confidence?: number;
  provenance?: KnowledgeProvenance | null;
  conflictKey?: string | null;
  conflictScope?: Record<string, unknown> | null;
  conflictExclusive?: boolean;
  steps?: string[]; // If category is 'skill'
  evidence?: EvidenceInput[];
}
