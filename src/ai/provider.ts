import { createOpenAI } from '@ai-sdk/openai';
import { createAnthropic } from '@ai-sdk/anthropic';
import { generateObject, generateText, LanguageModel } from 'ai';
import { ProjectConfig, FilterResult, KnowledgeAtom, KnowledgeItem } from '../core/types.js';
import { AIProviderError } from '../core/errors.js';
import {
  FilterResultSchema,
  ExtractionResultSchema,
  CompareResultSchema,
  DerivedTruthSchema
} from './schemas.js';
import {
  FILTER_SYSTEM_PROMPT,
  EXTRACT_SYSTEM_PROMPT,
  COMPARE_SYSTEM_PROMPT,
  ASK_SYSTEM_PROMPT,
  DERIVE_TRUTH_PROMPT
} from './prompts.js';

let currentModel: LanguageModel | null = null;
let currentConfig: ProjectConfig['ai'] | null = null;

/**
 * Initializes the AI provider model based on project configuration.
 */
export function initAI(config: ProjectConfig['ai']): LanguageModel {
  // If config hasn't changed and model is initialized, reuse it
  if (currentModel && JSON.stringify(currentConfig) === JSON.stringify(config)) {
    return currentModel;
  }

  const { provider, model, apiKey, baseUrl, temperature } = config;

  try {
    if (provider === 'openai') {
      const openai = createOpenAI({
        apiKey: apiKey || process.env.OPENAI_API_KEY,
        baseURL: baseUrl || undefined,
      });
      currentModel = openai(model);
    } else if (provider === 'anthropic') {
      const anthropic = createAnthropic({
        apiKey: apiKey || process.env.ANTHROPIC_API_KEY,
        baseURL: baseUrl || undefined,
      });
      currentModel = anthropic(model);
    } else if (provider === 'ollama') {
      // Ollama's local API has a standard OpenAI compatibility endpoint
      const openaiOllama = createOpenAI({
        apiKey: 'ollama',
        baseURL: baseUrl || 'http://localhost:11434/v1',
      });
      currentModel = openaiOllama(model);
    } else if (provider === 'custom') {
      const customOpenAI = createOpenAI({
        apiKey: apiKey || '',
        baseURL: baseUrl,
      });
      currentModel = customOpenAI(model);
    } else {
      throw new Error(`Unsupported AI provider: ${provider}`);
    }

    currentConfig = config;
    return currentModel;
  } catch (error: any) {
    throw new AIProviderError(`Failed to initialize AI provider: ${error.message}`);
  }
}

/**
 * Gets the initialized LanguageModel or throws if not configured.
 */
function getModel(): LanguageModel {
  if (!currentModel) {
    throw new AIProviderError('AI provider has not been initialized. Call initAI() first.');
  }
  return currentModel;
}

/**
 * Stages the raw input against a filter to detect noise, sensitive secrets, or valid knowledge.
 */
export async function filterInput(input: string, config: ProjectConfig): Promise<FilterResult> {
  const model = getModel();

  // Pre-filter for basic secrets if rejectSecrets is enabled
  if (config.security?.rejectSecrets) {
    const lowerInput = input.toLowerCase();
    for (const pattern of config.security.secretPatterns || []) {
      if (lowerInput.includes(pattern.toLowerCase())) {
        const words = input.split(/[\s:="']+/);
        // Look for any word that seems to be a token/key (at least 16 chars, alphanumeric/dashes)
        const hasLongHash = words.some(w => /^[a-zA-Z0-9_\-]{16,}$/.test(w));
        if (hasLongHash) {
          return {
            pass: false,
            reason: `Rejected: Detected potential sensitive information matching pattern "${pattern}".`,
          };
        }
      }
    }
  }

  try {
    const { object } = await generateObject({
      model,
      schema: FilterResultSchema,
      system: FILTER_SYSTEM_PROMPT,
      prompt: `Analyze the following input:\n\n${input}`,
      temperature: 0.1,
    });

    return object;
  } catch (error: any) {
    throw new AIProviderError(`Filter classification failed: ${error.message}`);
  }
}

/**
 * Extracts structured knowledge atoms from unstructured text.
 */
export async function extractKnowledge(input: string): Promise<KnowledgeAtom[]> {
  const model = getModel();
  try {
    const { object } = await generateObject({
      model,
      schema: ExtractionResultSchema,
      system: EXTRACT_SYSTEM_PROMPT,
      prompt: `Extract knowledge atoms from the following input:\n\n${input}`,
      temperature: 0.1,
    });

    return object.atoms;
  } catch (error: any) {
    throw new AIProviderError(`Knowledge extraction failed: ${error.message}`);
  }
}

/**
 * Compares a new knowledge atom against an existing stored item to identify updates, duplicates, or conflicts.
 */
export async function compareKnowledge(
  atom: KnowledgeAtom,
  existingItem: KnowledgeItem
): Promise<{
  relationship: 'duplicate' | 'update' | 'contradiction' | 'unrelated';
  reason: string;
  updatedContent?: string;
  updatedTitle?: string;
  updatedReasoning?: string;
  updatedAlternatives?: string[];
  updatedTags?: string[];
  updatedSteps?: string[];
}> {
  const model = getModel();
  try {
    const promptContent = `
NEW ATOM:
Category: ${atom.category}
Title: ${atom.title}
Content: ${atom.content}
Reasoning: ${atom.reasoning || 'N/A'}
Alternatives: ${JSON.stringify(atom.alternatives || [])}
Tags: ${JSON.stringify(atom.tags || [])}
Steps: ${JSON.stringify(atom.steps || [])}

EXISTING ITEM:
Category: ${existingItem.category}
Title: ${existingItem.title}
Content: ${existingItem.content}
Reasoning: ${existingItem.reasoning || 'N/A'}
Alternatives: ${JSON.stringify(existingItem.alternatives || [])}
Tags: ${JSON.stringify(existingItem.tags || [])}
`;

    const { object } = await generateObject({
      model,
      schema: CompareResultSchema,
      system: COMPARE_SYSTEM_PROMPT,
      prompt: promptContent,
      temperature: 0.1,
    });

    return object;
  } catch (error: any) {
    throw new AIProviderError(`Knowledge comparison failed: ${error.message}`);
  }
}

/**
 * Answers a user's question using hierarchical active project context.
 */
export async function askQuestion(question: string, contextMarkdown: string): Promise<string> {
  const model = getModel();
  try {
    const { text } = await generateText({
      model,
      system: ASK_SYSTEM_PROMPT,
      prompt: `
CONTEXT:
${contextMarkdown}

QUESTION:
${question}
`,
      temperature: 0.2,
    });

    return text;
  } catch (error: any) {
     throw new AIProviderError(`Failed to answer question: ${error.message}`);
  }
}

/**
 * Derives key=value active state truths from a given KnowledgeItem.
 */
export async function deriveTruth(item: KnowledgeItem): Promise<{ key: string; value: string }[]> {
  const model = getModel();
  try {
    const { object } = await generateObject({
      model,
      schema: DerivedTruthSchema,
      system: DERIVE_TRUTH_PROMPT,
      prompt: `
Analyze this knowledge item and extract any derived truths:
Category: ${item.category}
Title: ${item.title}
Content: ${item.content}
Reasoning: ${item.reasoning || 'N/A'}
Alternatives: ${item.alternatives ? item.alternatives.join(', ') : 'N/A'}
Tags: ${item.tags ? item.tags.join(', ') : 'N/A'}
`,
      temperature: 0.1,
    });

    return object.truths;
  } catch (error: any) {
    throw new AIProviderError(`Truth derivation failed: ${error.message}`);
  }
}

