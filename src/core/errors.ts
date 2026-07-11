export class KnowlError extends Error {
  constructor(message: string, public readonly code: string) {
    super(message);
    this.name = 'KnowlError';
  }
}

export class ConfigError extends KnowlError {
  constructor(message: string) {
    super(message, 'CONFIG_ERROR');
    this.name = 'ConfigError';
  }
}

export class DatabaseError extends KnowlError {
  constructor(message: string) {
    super(message, 'DATABASE_ERROR');
    this.name = 'DatabaseError';
  }
}

export class PipelineError extends KnowlError {
  constructor(message: string) {
    super(message, 'PIPELINE_ERROR');
    this.name = 'PipelineError';
  }
}

export class AIProviderError extends KnowlError {
  constructor(message: string) {
    super(message, 'AI_PROVIDER_ERROR');
    this.name = 'AIProviderError';
  }
}

export class ProjectNotFoundError extends KnowlError {
  constructor(path: string) {
    super(`No Knowl project found at "${path}". Run "knowl init" to initialize.`, 'PROJECT_NOT_FOUND');
    this.name = 'ProjectNotFoundError';
  }
}

export class KnowledgeConflictError extends KnowlError {
  constructor(public readonly conflicts: Array<{ id: string; title: string }>) {
    super(`KNOWLEDGE_CONFLICT: ${conflicts.map(item => item.title).join(', ')}`, 'KNOWLEDGE_CONFLICT');
  }
}
