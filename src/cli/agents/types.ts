export type AgentName = 'codex' | 'claude' | 'cursor' | 'claude-desktop';
export type IntegrationScope = 'project' | 'global';
export type IntegrationStatus = 'configured' | 'updated' | 'unchanged' | 'skipped' | 'failed';

export interface AgentDetection {
  installed: boolean;
  configured: boolean;
  scope: IntegrationScope;
  configPath: string;
}

export interface AgentIntegrationResult {
  agent: AgentName;
  status: IntegrationStatus;
  scope: IntegrationScope;
  configPath: string;
  message?: string;
}

export interface AgentAdapter {
  name: AgentName;
  label: string;
  detect(projectRoot: string): Promise<AgentDetection>;
  configure(projectRoot: string): Promise<AgentIntegrationResult>;
  verify(projectRoot: string): Promise<boolean>;
}

export interface AgentEnvironment {
  platform: NodeJS.Platform;
  homeDir: string;
  appDataDir: string;
  commandExists(command: string): Promise<boolean>;
}
