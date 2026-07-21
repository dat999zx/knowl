export type AgentName = 'codex' | 'claude' | 'cursor' | 'gemini' | 'claude-desktop';
export type IntegrationScope = 'project' | 'global';
export type IntegrationStatus = 'configured' | 'updated' | 'unchanged' | 'skipped' | 'failed';
export type LifecycleCapability = 'supported' | 'unsupported' | 'degraded';
export type LifecycleEvent = 'session-start' | 'session-event' | 'session-stop' | 'session-recover';

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
  instructions?: IntegrationDetail;
  lifecycle?: {
    capability: LifecycleCapability;
    status: IntegrationStatus;
    message?: string;
  };
}

export interface IntegrationDetail {
  status: IntegrationStatus;
  configPath: string;
  message?: string;
}

export interface AgentInstructionAdapter {
  configureInstructions(projectRoot: string): Promise<IntegrationDetail>;
  verifyInstructions(projectRoot: string): Promise<boolean>;
}

export interface AgentLifecycleAdapter {
  lifecycleCapability(projectRoot: string): Promise<LifecycleCapability>;
  configureLifecycle(projectRoot: string): Promise<AgentIntegrationResult>;
  verifyLifecycle(projectRoot: string): Promise<boolean>;
}

export interface AgentAdapter extends Partial<AgentLifecycleAdapter>, Partial<AgentInstructionAdapter> {
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
