import type { KnowledgeItem } from '../core/types.js';
import { queryKnowledgeForAgent } from './agent-query.js';
import { getClient } from './database.js';
import * as repo from './repository.js';
import { captureMemorySessionEvent } from './session-capture.js';
import { finishMemorySession, startMemorySession } from './session-repository.js';
import { finalizeMemorySession } from './session-finalizer.js';

export type WorkLoopMemoryHit = {
  id: string;
  category: string;
  title: string;
  content: string;
};

export type WorkLoopStartResult = {
  taskId: string;
  itemId: string;
  title: string;
  query: string;
  relevantMemory: WorkLoopMemoryHit[];
  memorySessionId?: string;
};

export type WorkLoopTaskState = {
  goal?: string;
  completed?: string[];
  nextAction?: string;
  blocker?: string;
  artifactRefs?: string[];
  verificationStatus?: string;
};

export type WorkLoopCheckpointInput = {
  summary: string;
} & WorkLoopTaskState;

export type WorkLoopStepResult = {
  taskId: string;
  itemId: string;
  summary: string;
  taskState?: WorkLoopTaskState;
};

function compactMemoryHit(item: KnowledgeItem): WorkLoopMemoryHit {
  return {
    id: item.id,
    category: item.category,
    title: item.title,
    content: item.content,
  };
}

async function requireWorkLoopTask(taskId: string): Promise<KnowledgeItem> {
  const task = await repo.getKnowledgeItem(taskId);
  if (!task || task.category !== 'state' || !task.tags?.includes('work-loop')) {
    throw new Error(`Work loop task not found: ${taskId}`);
  }
  return task;
}

/**
 * Whether a `finish` step has already been recorded for this task.
 *
 * An existence check rather than a scan. This runs on every checkpoint and every finish, and
 * `listKnowledgeItems` reads and maps every row in the store to answer it -- the same cost
 * `listActiveSkillItems` exists to avoid on the mid-turn skill lookup. Tag matching follows
 * the store's own idiom (`search.ts`, `vector.ts`): tags serialize as a JSON array, so the
 * quoted needle cannot match a longer tag that merely starts with the same characters.
 */
async function taskAlreadyFinished(taskId: string): Promise<boolean> {
  const rows = (await getClient().execute({
    sql: `SELECT 1 FROM knowledge_items
      WHERE tags LIKE ? AND tags LIKE '%"finish"%'
      LIMIT 1`,
    args: [`%"task:${taskId}"%`],
  })).rows;
  return rows.length > 0;
}

function stringList(value: unknown, maxItems = 20, maxLength = 500): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const values = value
    .filter((entry): entry is string => typeof entry === 'string' && entry.trim().length > 0)
    .slice(0, maxItems)
    .map(entry => entry.trim().slice(0, maxLength));
  return values.length ? values : undefined;
}

function normalizeTaskState(input: WorkLoopTaskState): WorkLoopTaskState | undefined {
  const taskState: WorkLoopTaskState = {
    goal: typeof input.goal === 'string' && input.goal.trim() ? input.goal.trim().slice(0, 1_000) : undefined,
    completed: stringList(input.completed, 20, 500),
    nextAction: typeof input.nextAction === 'string' && input.nextAction.trim() ? input.nextAction.trim().slice(0, 1_000) : undefined,
    blocker: typeof input.blocker === 'string' && input.blocker.trim() ? input.blocker.trim().slice(0, 1_000) : undefined,
    artifactRefs: stringList(input.artifactRefs, 20, 500),
    verificationStatus: typeof input.verificationStatus === 'string' && input.verificationStatus.trim()
      ? input.verificationStatus.trim().slice(0, 100)
      : undefined,
  };
  return Object.values(taskState).some(value => value !== undefined) ? taskState : undefined;
}

function taskStateLines(taskState: WorkLoopTaskState | undefined): string[] {
  if (!taskState) return [];
  const lines: string[] = [];
  if (taskState.goal) lines.push(`Goal: ${taskState.goal}`);
  if (taskState.completed?.length) lines.push(`Completed: ${taskState.completed.join('; ')}`);
  if (taskState.nextAction) lines.push(`Next action: ${taskState.nextAction}`);
  if (taskState.blocker) lines.push(`Blocker: ${taskState.blocker}`);
  if (taskState.artifactRefs?.length) lines.push(`Artifacts: ${taskState.artifactRefs.join(', ')}`);
  if (taskState.verificationStatus) lines.push(`Verification: ${taskState.verificationStatus}`);
  return lines;
}

function memorySessionId(task: KnowledgeItem): string | undefined {
  return task.tags?.find(tag => tag.startsWith('memory-session:'))?.slice('memory-session:'.length);
}

export async function startWorkLoop(
  projectId: string,
  title: string,
  query?: string
): Promise<WorkLoopStartResult> {
  const effectiveQuery = query || title;
  const relevantMemory = await queryKnowledgeForAgent(projectId, {
    query: effectiveQuery,
    status: 'active',
    limit: 3,
  });
  const now = new Date().toISOString();
  let sessionId: string | undefined;
  try {
    sessionId = (await startMemorySession({ title, query: effectiveQuery, agent: 'work-loop' })).id;
  } catch (error: any) {
    console.error(`Warning: session capture unavailable: ${error.message}`);
  }

  const item = await repo.createKnowledgeItem(projectId, {
    category: 'state',
    title: `Work Loop: ${title}`,
    content: [
      'Status: active',
      `Task: ${title}`,
      `Started at: ${now}`,
      `Pre-task query: ${effectiveQuery}`,
      `Relevant memory hits: ${relevantMemory.length}`,
    ].join('\n'),
    tags: ['work-loop', 'task-start', ...(sessionId ? [`memory-session:${sessionId}`] : [])],
    source: 'knowl work loop',
    confidence: 1.0,
  });

  await repo.createKnowledgeCommit(projectId, `Start work loop: ${title}`, [
    { itemId: item.id, action: 'insert', after: item },
  ]);

  return {
    taskId: item.id,
    itemId: item.id,
    title,
    query: effectiveQuery,
    relevantMemory: relevantMemory.map(compactMemoryHit),
    memorySessionId: sessionId,
  };
}

async function recordWorkLoopStep(
  projectId: string,
  taskId: string,
  title: 'Work Loop checkpoint' | 'Work Loop finish',
  summary: string,
  commitMessage: string,
  stepTag: 'checkpoint' | 'finish',
  taskStateInput: WorkLoopTaskState = {},
): Promise<WorkLoopStepResult> {
  const task = await requireWorkLoopTask(taskId);
  // Finish once. The session layer already enforces a terminal state -- a second finish logs
  // "Cannot append an event to a terminal memory session" -- but the work-loop layer ignored
  // that and wrote a fresh `finish` item anyway, minting two different completions for one
  // task against a description that says "exactly once". A checkpoint after finish is the same
  // contradiction. Refuse both, naming the earlier finish.
  if (await taskAlreadyFinished(taskId)) {
    throw new Error(
      `Work loop ${taskId} is already finished; it cannot be ${stepTag === 'finish' ? 'finished again' : 'checkpointed after finishing'}. ` +
      'Start a new work loop for further steps.',
    );
  }
  const now = new Date().toISOString();
  const taskState = normalizeTaskState(taskStateInput);
  const item = await repo.createKnowledgeItem(projectId, {
    category: 'state',
    title,
    content: [
      `Task ID: ${taskId}`,
      `Task: ${task.title.replace(/^Work Loop: /, '')}`,
      `Recorded at: ${now}`,
      `Summary: ${summary}`,
      ...taskStateLines(taskState),
    ].join('\n'),
    tags: ['work-loop', `task:${taskId}`, stepTag],
    source: 'knowl work loop',
    confidence: 1.0,
  });

  await repo.createKnowledgeCommit(projectId, commitMessage, [
    { itemId: item.id, action: 'insert', after: item },
  ]);

  const sessionId = memorySessionId(task);
  if (sessionId) {
    try {
      if (stepTag === 'finish') { await finishMemorySession(sessionId, 'finished', summary); await finalizeMemorySession(projectId, sessionId); }
      else await captureMemorySessionEvent(sessionId, 'checkpoint', { summary, ...taskState });
    } catch (error: any) {
      console.error(`Warning: session capture unavailable: ${error.message}`);
    }
  }

  return {
    taskId,
    itemId: item.id,
    summary,
    ...(taskState ? { taskState } : {}),
  };
}

export async function checkpointWorkLoop(
  projectId: string,
  taskId: string,
  input: string | WorkLoopCheckpointInput,
): Promise<WorkLoopStepResult> {
  const checkpoint = typeof input === 'string' ? { summary: input } : input;
  return recordWorkLoopStep(
    projectId,
    taskId,
    'Work Loop checkpoint',
    checkpoint.summary,
    `Work loop checkpoint: ${taskId}`,
    'checkpoint',
    checkpoint,
  );
}

export async function finishWorkLoop(
  projectId: string,
  taskId: string,
  summary: string
): Promise<WorkLoopStepResult> {
  return recordWorkLoopStep(
    projectId,
    taskId,
    'Work Loop finish',
    summary,
    `Finish work loop: ${taskId}`,
    'finish'
  );
}
