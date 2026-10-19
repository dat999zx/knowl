import { FILTER_SYSTEM_PROMPT, EXTRACT_SYSTEM_PROMPT, ASK_SYSTEM_PROMPT, DERIVE_TRUTH_PROMPT } from '../prompts.js';
import type { DomainProfile } from './types.js';

export const codeProfile: DomainProfile = {
  id: 'code',
  filter: FILTER_SYSTEM_PROMPT,
  extract: EXTRACT_SYSTEM_PROMPT,
  ask: ASK_SYSTEM_PROMPT,
  deriveTruth: DERIVE_TRUTH_PROMPT,
};
