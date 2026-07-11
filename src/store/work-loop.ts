import type { KnowledgeItem } from '../core/types.js';
import { queryKnowledgeForAgent } from './agent-query.js';
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

export type WorkLoopStepResult = {
  taskId: string;
  itemId: string;
  summary: string;
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
  stepTag: 'checkpoint' | 'finish'
): Promise<WorkLoopStepResult> {
  const task = await requireWorkLoopTask(taskId);
  const now = new Date().toISOString();
  const item = await repo.createKnowledgeItem(projectId, {
    category: 'state',
    title,
    content: [
      `Task ID: ${taskId}`,
      `Task: ${task.title.replace(/^Work Loop: /, '')}`,
      `Recorded at: ${now}`,
      `Summary: ${summary}`,
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
      else await captureMemorySessionEvent(sessionId, 'checkpoint', { summary });
    } catch (error: any) {
      console.error(`Warning: session capture unavailable: ${error.message}`);
    }
  }

  return {
    taskId,
    itemId: item.id,
    summary,
  };
}

export async function checkpointWorkLoop(
  projectId: string,
  taskId: string,
  summary: string
): Promise<WorkLoopStepResult> {
  return recordWorkLoopStep(
    projectId,
    taskId,
    'Work Loop checkpoint',
    summary,
    `Work loop checkpoint: ${taskId}`,
    'checkpoint'
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
