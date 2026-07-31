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
  candidateType: 'outcome' | 'decision' | 'error' | 'verified-command' | 'task-state';
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
  project?: {
    name?: string;
    description?: string;
  };
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
      model?: string;
      dtype?: 'q4' | 'q8' | 'fp32' | 'fp16';
      cacheDir?: string;
    };
  };
  memory?: {
    organization?: { enabled?: boolean; path?: string };
    global?: { enabled?: boolean; path?: string };
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
