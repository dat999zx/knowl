import { z } from 'zod';

export const FilterResultSchema = z.object({
  pass: z.boolean().describe('True if the input contains valid project knowledge, decisions, constraints, or state updates. False if it is noise, typos, passwords, API keys, or temporary debugging output.'),
  reason: z.string().optional().describe('Short explanation of why the input was accepted or rejected.'),
});

export const KnowledgeAtomSchema = z.object({
  category: z.enum(['fact', 'decision', 'goal', 'constraint', 'architecture', 'state', 'skill']).describe('The category of the knowledge.'),
  title: z.string().describe('A concise, descriptive, and search-friendly title for this knowledge atom.'),
  content: z.string().describe('The core knowledge content in clean markdown format. Keep it concise, focused, and free from conversational noise.'),
  reasoning: z.string().optional().describe('The reasoning or justification, especially important for decisions.'),
  alternatives: z.array(z.string()).optional().describe('Alternative options considered (relevant for decisions).'),
  tags: z.array(z.string()).optional().describe('Keywords or tags to categorize this knowledge (e.g. backend, auth, database).'),
  confidence: z.number().min(0).max(1).optional().default(1.0).describe('Confidence score from 0.0 to 1.0.'),
  steps: z.array(z.string()).optional().describe('Ordered procedural steps, required if the category is "skill".'),
});

export const ExtractionResultSchema = z.object({
  atoms: z.array(KnowledgeAtomSchema).describe('List of extracted knowledge atoms from the input text.'),
});

export const CompareResultSchema = z.object({
  relationship: z.enum(['duplicate', 'update', 'contradiction', 'unrelated']).describe('How this new atom relates to the existing knowledge item.'),
  reason: z.string().describe('Explanation of the detected relationship, detailing any conflicts or updates.'),
  updatedContent: z.string().optional().describe('If the relationship is an update, provide the new fully merged content (combining old and new information cleanly).'),
  updatedTitle: z.string().optional().describe('The new title if it should be updated.'),
  updatedReasoning: z.string().optional().describe('The updated reasoning if applicable.'),
  updatedAlternatives: z.array(z.string()).optional().describe('The updated list of alternatives if applicable.'),
  updatedTags: z.array(z.string()).optional().describe('The updated list of tags if applicable.'),
  updatedSteps: z.array(z.string()).optional().describe('The updated list of skill steps if applicable.'),
});

export const DerivedTruthSchema = z.object({
  truths: z.array(
    z.object({
      key: z.string().describe('Lowercase key with underscores, e.g. "database", "auth_method".'),
      value: z.string().describe('Concise value representing the derived truth, e.g. "SQLite", "JWT".'),
    })
  ).describe('List of derived state key-value pairs.'),
});
