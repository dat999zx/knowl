import {
  KNOWL_CLAUDE_CONTINUATION_REMINDER,
  KNOWL_CLAUDE_PROMPT_REMINDER,
} from '../../core/knowl-guidance.js';

export interface ClaudePromptReminderOutput {
  hookSpecificOutput: {
    hookEventName: 'UserPromptSubmit';
    additionalContext: string;
  };
}

// Alias rather than interface for the implicit index signature — see change-card.ts.
export type ClaudePostToolReminderOutput = {
  hookSpecificOutput: {
    hookEventName: 'PostToolUse';
    additionalContext: string;
  };
};

export function createAgentReminderOutput(host: string): ClaudePromptReminderOutput {
  if (host !== 'claude') throw new Error(`Unsupported reminder host: ${host}`);
  return {
    hookSpecificOutput: {
      hookEventName: 'UserPromptSubmit',
      additionalContext: KNOWL_CLAUDE_PROMPT_REMINDER,
    },
  };
}

export function createClaudePostToolReminderOutput(): ClaudePostToolReminderOutput {
  return {
    hookSpecificOutput: {
      hookEventName: 'PostToolUse',
      additionalContext: KNOWL_CLAUDE_CONTINUATION_REMINDER,
    },
  };
}
