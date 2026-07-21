import { KNOWL_CLAUDE_OPERATIONAL_CARD } from '../../core/knowl-guidance.js';

export interface ClaudePromptReminderOutput {
  hookSpecificOutput: {
    hookEventName: 'UserPromptSubmit';
    additionalContext: string;
  };
}

export function createAgentReminderOutput(host: string): ClaudePromptReminderOutput {
  if (host !== 'claude') throw new Error(`Unsupported reminder host: ${host}`);
  return {
    hookSpecificOutput: {
      hookEventName: 'UserPromptSubmit',
      additionalContext: KNOWL_CLAUDE_OPERATIONAL_CARD,
    },
  };
}
