export type KnowledgeCategory =
  | 'fact'           // Objective truths
  | 'decision'       // Choices with reasoning
  | 'goal'           // Desired outcomes
  | 'constraint'     // Hard rules
  | 'architecture'   // Structural understanding
  | 'state'          // Current activity
  | 'skill';         // Learned procedures

export type KnowledgeStatus =
  | 'active'
  | 'deprecated'
  | 'rejected'
  | 'archived'
  | 'superseded';

export interface KnowledgeItem {
  id: string;
  projectId: string;
  category: KnowledgeCategory;
  status: KnowledgeStatus;
  title: string;
  content: string;
  reasoning?: string | null;
  alternatives?: string[] | null; // stored as JSON array of strings
  tags?: string[] | null;         // stored as JSON array of strings
  source?: string | null;
  confidence: number;
  supersededById?: string | null;
  version: number;
  createdAt: string;
  updatedAt: string;
}

export interface KnowledgeCommit {
  id: string;
  projectId: string;
  message: string;
  changes: CommitChange[]; // stored as JSON
  createdAt: string;
}

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
  project: {
    name: string;
    description?: string;
  };
  ai: {
    provider: 'openai' | 'anthropic' | 'ollama' | 'custom';
    model: string;
    temperature?: number;
    baseUrl?: string;
    apiKey?: string;
  };
  security: {
    rejectSecrets: boolean;
    secretPatterns: string[];
  };
}

export interface FilterResult {
  pass: boolean;
  reason?: string;
}

export interface KnowledgeAtom {
  category: KnowledgeCategory;
  title: string;
  content: string;
  reasoning?: string | null;
  alternatives?: string[] | null;
  tags?: string[] | null;
  confidence?: number;
  steps?: string[]; // If category is 'skill'
}
