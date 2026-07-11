import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { ProjectConfig, KnowledgeCategory, KnowledgeStatus } from '../core/types.js';
import { hasAiConfigured } from '../core/config.js';
import { initAI } from '../ai/provider.js';
import { runPipeline } from '../pipeline/pipeline.js';
import { getHierarchicalKnowledge } from '../store/queries.js';
import { formatHierarchyToMarkdown, formatRecentContextToMarkdown } from '../core/format.js';
import { getRecentContext } from '../store/recent-context.js';
import { storeKnowledgeItemDeduped, storeKnowledgeAtomsDeduped } from '../store/knowledge-writer.js';
import { recordDecisionDirect, updateKnowledgeItemWithCommit } from '../store/knowledge-actions.js';
import { isVectorSearchEnabled, createLocalEmbeddingProvider, getVectorSearchConfig } from '../ai/embeddings.js';
import { queryKnowledgeForAgent } from '../store/agent-query.js';
import { previewKnowledgeGc, applyKnowledgeGc } from '../store/gc.js';
import { checkpointWorkLoop, finishWorkLoop, startWorkLoop } from '../store/work-loop.js';
import { indexSkillPackage, recordSkillRun } from '../skills/knowledge-index.js';
import { createSkillPackage, listSkillPackages, readSkillPackage, runSkillPackage } from '../skills/registry.js';
import { KnowledgeValidationError } from '../core/knowledge-validation.js';
import { isEvidenceStale, listEvidenceForItem } from '../store/evidence-repository.js';

const KNOWLEDGE_CATEGORIES: KnowledgeCategory[] = ['fact', 'decision', 'goal', 'constraint', 'architecture', 'state', 'skill'];

export function registerTools(
  server: Server,
  getProjectId: () => string | null,
  getProjectRoot: () => string | null,
  getConfig: () => ProjectConfig | null,
  getInitError: () => string | null
): void {
  // 1. List tools
  server.setRequestHandler(ListToolsRequestSchema, async () => {
    return {
      tools: [
        {
          name: 'knowl_ingest',
          description: 'Process raw text or conversational inputs (like decision discussions, developer notes, or bug reports) through the Knowl pipeline to filter, extract, and store verified knowledge.',
          inputSchema: {
            type: 'object',
            properties: {
              text: {
                type: 'string',
                description: 'The raw text or conversation log to ingest.',
              },
              commitMessage: {
                type: 'string',
                description: 'Optional human-readable description for the knowledge commit.',
              },
              autoResolve: {
                type: 'boolean',
                description: 'Whether to auto-resolve contradictions by superseding old knowledge (defaults to false).',
              },
            },
            required: ['text'],
          },
        },
        {
          name: 'knowl_state',
          description: 'Get the full current active state of the project. Use for broad project-memory summaries, status checks, or full-state requests; prefer knowl_query for specific factual questions.',
          inputSchema: {
            type: 'object',
            properties: {},
          },
        },
        {
          name: 'knowl_recent',
          description: 'Get compact recent session context for starting or resuming work: recent active knowledge plus recent knowledge commits. Use this at the start of a new project-specific session before targeted knowl_query calls.',
          inputSchema: {
            type: 'object',
            properties: {
              itemLimit: {
                type: 'number',
                description: 'Maximum recent active knowledge items to return; defaults to 12.',
              },
              commitLimit: {
                type: 'number',
                description: 'Maximum recent knowledge commits to return; defaults to 8.',
              },
            },
          },
        },
        {
          name: 'knowl_store',
          description: 'Store one concise structured knowledge atom directly, not raw chat transcripts. Use immediately after discovering durable project knowledge or completing each subtask, not only at the end. This is deterministic and does not require Knowl AI configuration.',
          inputSchema: {
            type: 'object',
            properties: {
              category: {
                type: 'string',
                enum: KNOWLEDGE_CATEGORIES,
                description: 'Knowledge category.',
              },
              title: {
                type: 'string',
                description: 'Concise title for the knowledge item.',
              },
              content: {
                type: 'string',
                description: 'Knowledge content in markdown or plain text.',
              },
              reasoning: {
                type: 'string',
                description: 'Optional reasoning or justification.',
              },
              alternatives: {
                type: 'array',
                items: { type: 'string' },
                description: 'Optional alternatives considered for decisions.',
              },
              tags: {
                type: 'array',
                items: { type: 'string' },
                description: 'Optional tags.',
              },
              source: {
                type: 'string',
                description: 'Optional source label.',
              },
              sourceCommit: {
                type: 'string',
                description: 'Optional git commit where this knowledge was last reviewed.',
              },
              affectedPaths: {
                type: 'array',
                items: { type: 'string' },
                description: 'Optional repository-relative file paths that this knowledge depends on.',
              },
              confidence: {
                type: 'number',
                description: 'Optional confidence from 0.0 to 1.0.',
              },
              steps: {
                type: 'array',
                items: { type: 'string' },
                description: 'Ordered steps when category is skill.',
              },
            },
            required: ['category', 'title', 'content'],
          },
        },
        {
          name: 'knowl_ingest_atoms',
          description: 'Store pre-extracted structured knowledge atoms from an MCP client. Do not store raw chat transcripts; extract durable facts, decisions, constraints, architecture, state, skills, and batch store implementation summaries during execution or after each completed subtask. This is the preferred MCP ingestion path and does not require Knowl AI configuration.',
          inputSchema: {
            type: 'object',
            properties: {
              atoms: {
                type: 'array',
                items: {
                  type: 'object',
                  properties: {
                    category: { type: 'string', enum: KNOWLEDGE_CATEGORIES },
                    title: { type: 'string' },
                    content: { type: 'string' },
                    reasoning: { type: 'string' },
                    alternatives: { type: 'array', items: { type: 'string' } },
                    tags: { type: 'array', items: { type: 'string' } },
                    source: { type: 'string' },
                    sourceCommit: { type: 'string' },
                    affectedPaths: { type: 'array', items: { type: 'string' } },
                    confidence: { type: 'number' },
                    steps: { type: 'array', items: { type: 'string' } },
                  },
                  required: ['category', 'title', 'content'],
                },
                description: 'Structured knowledge atoms extracted by the MCP client model.',
              },
              commitMessage: {
                type: 'string',
                description: 'Optional commit message for the batch.',
              },
            },
            required: ['atoms'],
          },
        },
        {
          name: 'knowl_decide',
          description: 'Record a specific project decision directly into the knowledge base without requiring Knowl AI configuration.',
          inputSchema: {
            type: 'object',
            properties: {
              title: {
                type: 'string',
                description: 'Descriptive title of the decision (e.g. "Use PostgreSQL").',
              },
              content: {
                type: 'string',
                description: 'The decision details (what was decided).',
              },
              reasoning: {
                type: 'string',
                description: 'The reasoning or justification for the choice.',
              },
              alternatives: {
                type: 'array',
                items: { type: 'string' },
                description: 'List of alternative options considered.',
              },
              tags: {
                type: 'array',
                items: { type: 'string' },
                description: 'Tags to organize this decision.',
              },
            },
            required: ['title', 'content', 'reasoning'],
          },
        },
        {
          name: 'knowl_query',
          description: 'Use this first for specific project questions, before each new subtask, and when switching areas during multi-step work. If results contain a relevant active item, answer from Knowl without inspecting repository files. Inspect files only on miss, conflict, stale or low-confidence results, or explicit verification requests.',
          inputSchema: {
            type: 'object',
            properties: {
              query: {
                type: 'string',
                description: 'Use 2-6 concise keywords from the user question, not the whole sentence. Example: "database sqlite persistence".',
              },
              category: {
                type: 'string',
                enum: ['fact', 'decision', 'goal', 'constraint', 'architecture', 'state', 'skill'],
                description: 'Optional category hint. Omit unless you are certain; MCP queries retry without it on miss to avoid false negatives.',
              },
              status: {
                type: 'string',
                enum: ['active', 'deprecated', 'rejected', 'archived', 'superseded'],
                description: 'Filter by status (defaults to active).',
              },
              tags: {
                type: 'array',
                items: { type: 'string' },
                description: 'Filter items that contain all of these tags.',
              },
              limit: {
                type: 'number',
                description: 'Maximum results to return; defaults to 3 for MCP queries.',
              },
              includeEvidence: {
                type: 'boolean',
                description: 'Include linked evidence. Omit for compact results.',
              },
            },
          },
        },
        {
          name: 'knowl_evidence_list',
          description: 'List inspectable evidence linked to one knowledge item.',
          inputSchema: {
            type: 'object',
            properties: { itemId: { type: 'string', description: 'Knowledge item ID.' } },
            required: ['itemId'],
          },
        },
        {
          name: 'knowl_update',
          description: 'Update the metadata, status, or content of an existing knowledge item. Use immediately when execution reveals stale or contradicted memory instead of adding duplicates.',
          inputSchema: {
            type: 'object',
            properties: {
              id: {
                type: 'string',
                description: 'The unique ID of the knowledge item.',
              },
              title: {
                type: 'string',
                description: 'New title.',
              },
              content: {
                type: 'string',
                description: 'New content markdown.',
              },
              status: {
                type: 'string',
                enum: ['active', 'deprecated', 'rejected', 'archived', 'superseded'],
                description: 'New status.',
              },
              reasoning: {
                type: 'string',
                description: 'Updated reasoning.',
              },
              source: {
                type: 'string',
                description: 'Updated source label.',
              },
              sourceCommit: {
                type: 'string',
                description: 'Updated git commit for the reviewed knowledge.',
              },
              affectedPaths: {
                type: 'array',
                items: { type: 'string' },
                description: 'Updated repository-relative file paths tied to this knowledge.',
              },
              freshness: {
                type: 'string',
                enum: ['fresh', 'stale', 'needs_review'],
                description: 'Optional freshness override. Defaults to fresh when updating reviewed knowledge content or provenance.',
              },
            },
            required: ['id'],
          },
        },
        {
          name: 'knowl_gc_preview',
          description: 'Preview knowledge garbage collection recommendations without changing the database. Use to find duplicate, stale, or cold memory before applying GC.',
          inputSchema: {
            type: 'object',
            properties: {},
          },
        },
        {
          name: 'knowl_task_start',
          description: 'Start a manual Knowl work loop for a multi-step task. Stores active task state and returns relevant memory before execution begins.',
          inputSchema: {
            type: 'object',
            properties: {
              title: {
                type: 'string',
                description: 'Short task title.',
              },
              query: {
                type: 'string',
                description: 'Optional focused retrieval query for pre-task memory lookup. Defaults to the task title.',
              },
            },
            required: ['title'],
          },
        },
        {
          name: 'knowl_task_checkpoint',
          description: 'Record a work-loop checkpoint during execution so the task writes durable progress before the final summary.',
          inputSchema: {
            type: 'object',
            properties: {
              taskId: {
                type: 'string',
                description: 'The taskId returned by knowl_task_start.',
              },
              summary: {
                type: 'string',
                description: 'Durable checkpoint summary.',
              },
            },
            required: ['taskId', 'summary'],
          },
        },
        {
          name: 'knowl_task_finish',
          description: 'Finish a work loop by storing a durable completion summary for the task.',
          inputSchema: {
            type: 'object',
            properties: {
              taskId: {
                type: 'string',
                description: 'The taskId returned by knowl_task_start.',
              },
              summary: {
                type: 'string',
                description: 'Durable completion summary.',
              },
            },
            required: ['taskId', 'summary'],
          },
        },
        {
          name: 'knowl_gc_apply',
          description: 'Apply knowledge garbage collection transactionally: purge duplicates, archive stale state, compress cold archives, and record a knowledge commit.',
          inputSchema: {
            type: 'object',
            properties: {},
          },
        },
        {
          name: 'knowl_skill_list',
          description: 'List learned file-backed skills from `.knowl/skills`. This is a stable MCP bridge so old sessions can discover newly created skills.',
          inputSchema: {
            type: 'object',
            properties: {},
          },
        },
        {
          name: 'knowl_skill_read',
          description: 'Read one learned skill package from `.knowl/skills/<name>/`, including `skill.json` and `SKILL.md`.',
          inputSchema: {
            type: 'object',
            properties: {
              name: {
                type: 'string',
                description: 'Skill package name.',
              },
            },
            required: ['name'],
          },
        },
        {
          name: 'knowl_skill_create',
          description: 'Create a learned file-backed skill package under `.knowl/skills/<name>/` and index it as a `skill` knowledge item.',
          inputSchema: {
            type: 'object',
            properties: {
              name: {
                type: 'string',
                description: 'Path-safe skill name using lowercase letters, numbers, underscores, and hyphens.',
              },
              purpose: {
                type: 'string',
                description: 'One-sentence purpose for the skill.',
              },
              markdown: {
                type: 'string',
                description: 'Content for `SKILL.md`.',
              },
              triggers: {
                type: 'array',
                items: { type: 'string' },
                description: 'Optional trigger phrases for discovery.',
              },
              files: {
                type: 'array',
                items: {
                  type: 'object',
                  properties: {
                    path: { type: 'string' },
                    content: { type: 'string' },
                  },
                  required: ['path', 'content'],
                },
                description: 'Optional files to create inside the skill package, such as `run.ps1` or `run.cmd`.',
              },
              entrypoints: {
                type: 'object',
                description: 'Entrypoints keyed by name, for example `default` or `fallback`.',
                additionalProperties: {
                  type: 'object',
                },
              },
            },
            required: ['name', 'purpose'],
          },
        },
        {
          name: 'knowl_skill_run',
          description: 'Auto-run a learned skill package entrypoint from `.knowl/skills`. Prefer repo-local scripts; shell fallbacks are allowed when the skill defines them.',
          inputSchema: {
            type: 'object',
            properties: {
              name: {
                type: 'string',
                description: 'Skill package name.',
              },
              entrypoint: {
                type: 'string',
                description: 'Entrypoint name; defaults to `default`.',
              },
              args: {
                type: 'array',
                items: { type: 'string' },
                description: 'Optional runtime arguments passed to the entrypoint.',
              },
            },
            required: ['name'],
          },
        },
      ],
    };
  });

  // 2. Call tool
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;
    const initError = getInitError();
    const projectId = getProjectId();
    const projectRoot = getProjectRoot();
    const config = getConfig();

    if (initError) {
      return {
        content: [
          {
            type: 'text',
            text: `❌ Knowl MCP Server is active but not initialized for the current directory.\nReason: ${initError}\n\nPlease run 'knowl init' in your project root to initialize this project.`,
          },
        ],
      };
    }

    try {
      if (name === 'knowl_ingest') {
        const { text, commitMessage, autoResolve } = args as any;
        if (!config || !hasAiConfigured(config)) {
          return {
            isError: true,
            content: [
              {
                type: 'text',
                text: 'Raw text ingestion requires explicit Knowl AI configuration. For MCP clients like Codex, extract knowledge with the client model and call knowl_ingest_atoms instead.',
              },
            ],
          };
        }

        initAI(config.ai!);
        const result = await runPipeline(projectId!, text, config!, {
          autoResolveContradictions: autoResolve ?? false,
          commitMessage: commitMessage || 'Ingest via MCP tool',
        });

        return {
          content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
        };
      }
      
      else if (name === 'knowl_state') {
        const hierarchy = await getHierarchicalKnowledge(projectId!);
        const md = formatHierarchyToMarkdown(hierarchy);
        return {
          content: [{ type: 'text', text: md }],
        };
      }

      else if (name === 'knowl_recent') {
        const { itemLimit, commitLimit } = args as any;
        const context = await getRecentContext(projectId!, {
          itemLimit,
          commitLimit,
        });
        return {
          content: [{ type: 'text', text: formatRecentContextToMarkdown(context) }],
        };
      }

      else if (name === 'knowl_store') {
        const { category, title, content, reasoning, alternatives, tags, source, sourceCommit, affectedPaths, confidence, steps } = args as any;

        if (!KNOWLEDGE_CATEGORIES.includes(category)) {
          throw new Error(`Invalid knowledge category: ${category}`);
        }

        const result = await storeKnowledgeItemDeduped(
          projectId!,
          {
            category,
            title,
            content,
            reasoning,
            alternatives,
            tags,
            source,
            sourceCommit,
            affectedPaths,
            confidence,
            steps,
          },
          `Store ${category}: ${title}`,
          config?.security,
        );

        if (result.action === 'duplicate') {
          return {
            content: [{ type: 'text', text: `Matched existing ${category} ${result.item.id}; skipped duplicate insert` }],
          };
        }

        return {
          content: [{ type: 'text', text: `Successfully stored ${category} ${result.item.id}` }],
        };
      }

      else if (name === 'knowl_ingest_atoms') {
        const { atoms, commitMessage } = args as any;

        if (!Array.isArray(atoms) || atoms.length === 0) {
          throw new Error('atoms must be a non-empty array');
        }

        for (const atom of atoms) {
          if (!KNOWLEDGE_CATEGORIES.includes(atom.category)) {
            throw new Error(`Invalid knowledge category: ${atom.category}`);
          }
        }

        const result = await storeKnowledgeAtomsDeduped(
          projectId!,
          atoms,
          commitMessage || `Store ${atoms.length} structured knowledge atom(s)`,
          config?.security,
        );

        return {
          content: [{ type: 'text', text: `Stored ${result.itemIds.length} knowledge atom(s): ${result.itemIds.join(', ')}` }],
        };
      }
      
      else if (name === 'knowl_decide') {
        const { title, content, reasoning, alternatives, tags } = args as any;
        const item = await recordDecisionDirect(projectId!, {
          title,
          content,
          reasoning,
          alternatives,
          tags: tags || [],
        }, `Record decision via MCP: ${title}`, config || undefined);

        return {
          content: [{ type: 'text', text: `Successfully recorded decision ${item.id}` }],
        };
      } 
      
      else if (name === 'knowl_query') {
        const { query, category, status, tags, limit, includeEvidence } = args as any;
        let vector;
        if (config && projectRoot && query && isVectorSearchEnabled(config)) {
          const embedder = await createLocalEmbeddingProvider(config, projectRoot);
          const [embedding] = await embedder.embed([query]);
          const vectorConfig = getVectorSearchConfig(config);
          vector = {
            enabled: true,
            provider: embedder.provider,
            model: vectorConfig.model,
            embedding,
          };
        }

        const items = await queryKnowledgeForAgent(projectId!, {
          query,
          category: category as KnowledgeCategory,
          status: status as KnowledgeStatus,
          tags,
          limit,
          vector,
        });

        const withStaleStatus = async (itemId: string) => Promise.all((await listEvidenceForItem(itemId)).map(async evidence => ({
          ...evidence,
          stale: projectRoot ? await isEvidenceStale(evidence, projectRoot) : false,
        })));
        const payload = includeEvidence
          ? await Promise.all(items.map(async item => ({ ...item, evidence: await withStaleStatus(item.id) })))
          : items;
        return { content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }] };
      } 

      else if (name === 'knowl_evidence_list') {
        const { itemId } = args as any;
        const evidence = await Promise.all((await listEvidenceForItem(itemId)).map(async item => ({
          ...item,
          stale: projectRoot ? await isEvidenceStale(item, projectRoot) : false,
        })));
        return { content: [{ type: 'text', text: JSON.stringify(evidence, null, 2) }] };
      }
      
      else if (name === 'knowl_update') {
        const { id, title, content, status, reasoning, source, sourceCommit, affectedPaths, freshness } = args as any;
        const updated = await updateKnowledgeItemWithCommit(projectId!, id, {
          title,
          content,
          status: status as KnowledgeStatus,
          reasoning,
          source,
          sourceCommit,
          affectedPaths,
        }, {
          projectRoot,
          freshness,
          validationOptions: config?.security,
        });

        return {
          content: [{ type: 'text', text: `Successfully updated item ${id}:\n\n${JSON.stringify(updated, null, 2)}` }],
        };
      }

      else if (name === 'knowl_gc_preview') {
        const result = await previewKnowledgeGc(projectId!);
        return {
          content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
        };
      }

      else if (name === 'knowl_task_start') {
        const { title, query } = args as any;
        const result = await startWorkLoop(projectId!, title, query);
        return {
          content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
        };
      }

      else if (name === 'knowl_task_checkpoint') {
        const { taskId, summary } = args as any;
        const result = await checkpointWorkLoop(projectId!, taskId, summary);
        return {
          content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
        };
      }

      else if (name === 'knowl_task_finish') {
        const { taskId, summary } = args as any;
        const result = await finishWorkLoop(projectId!, taskId, summary);
        return {
          content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
        };
      }

      else if (name === 'knowl_gc_apply') {
        const result = await applyKnowledgeGc(projectId!);
        return {
          content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
        };
      }

      else if (name === 'knowl_skill_list') {
        const skills = await listSkillPackages(projectRoot!);
        return {
          content: [{ type: 'text', text: JSON.stringify(skills, null, 2) }],
        };
      }

      else if (name === 'knowl_skill_read') {
        const { name: skillName } = args as any;
        const skill = await readSkillPackage(projectRoot!, skillName);
        return {
          content: [{ type: 'text', text: JSON.stringify(skill, null, 2) }],
        };
      }

      else if (name === 'knowl_skill_create') {
        const { name: skillName, purpose, markdown, triggers, files, entrypoints } = args as any;
        const skill = await createSkillPackage(projectRoot!, {
          name: skillName,
          purpose,
          markdown,
          triggers,
          files,
          entrypoints,
        });
        await indexSkillPackage(projectId!, skill.manifest);
        return {
          content: [{ type: 'text', text: `Successfully created skill ${skill.manifest.name}` }],
        };
      }

      else if (name === 'knowl_skill_run') {
        const { name: skillName, entrypoint, args: runtimeArgs } = args as any;
        const result = await runSkillPackage(projectRoot!, skillName, entrypoint || 'default', runtimeArgs || []);
        await recordSkillRun(projectId!, skillName, result.exitCode === 0);
        return {
          content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
        };
      }

      throw new Error(`Unknown tool: ${name}`);
    } catch (error: any) {
      const message = error instanceof KnowledgeValidationError
        ? `${error.code}: ${error.message}`
        : error.message;
      return {
        isError: true,
        content: [{ type: 'text', text: `Error executing tool "${name}": ${message}` }],
      };
    }
  });
}
