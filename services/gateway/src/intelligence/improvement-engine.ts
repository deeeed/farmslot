// improvement-engine.ts — Self-improving feedback loop engine
// On retrospective accept, analyzes learnings and proposes template diffs.
// Uses tool-equipped LLM chat so the model can read/search project files itself.

import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { readdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

import type { Message as PiMessage, Tool } from '@earendil-works/pi-ai';
import { Type } from '@sinclair/typebox';

import {
  Events,
  type ImprovementDiffPayload,
  type ImprovementFileChange,
  type RunDecision,
} from '@farmslot/protocol';

import { executeTool } from '../chat/chat-tools.js';
import { FLEET_TOOLS } from '../chat/tool-definitions.js';
import { loadPromptTemplate } from '../core/prompt-templates.js';
import { farmslotRoot } from '../fleet/state.js';
import { getLLMConfig } from '../llm/config.js';
import { callLLMChat } from '../llm/index.js';
import { pendingDecisionForRun } from '../run-engine/decision-projection.js';
import { getRun, updateRun } from '../runs/store.js';

// ─── Chat State (with TTL) ───

const MAX_CHAT_SESSIONS = 20;
const CHAT_SESSION_TTL_MS = 2 * 60 * 60 * 1000; // 2 hours

interface ChatSession {
  messages: PiMessage[];
  createdAt: number;
}

const chatSessions = new Map<string, ChatSession>();

function getChatMessages(decisionId: string): PiMessage[] | undefined {
  const session = chatSessions.get(decisionId);
  if (!session) return undefined;
  if (Date.now() - session.createdAt > CHAT_SESSION_TTL_MS) {
    cleanupChatSession(decisionId);
    return undefined;
  }
  return session.messages;
}

function setChatMessages(decisionId: string, messages: PiMessage[]): void {
  // Evict oldest if at capacity
  if (chatSessions.size >= MAX_CHAT_SESSIONS && !chatSessions.has(decisionId)) {
    const oldest = [...chatSessions.entries()].sort((a, b) => a[1].createdAt - b[1].createdAt)[0];
    if (oldest) chatSessions.delete(oldest[0]);
  }
  chatSessions.set(decisionId, {
    messages,
    createdAt: chatSessions.get(decisionId)?.createdAt ?? Date.now(),
  });
}

// ─── Path Safety ───

function isSafeProjectRelativePath(p: string): boolean {
  if (typeof p !== 'string' || p.length === 0) return false;
  // Null byte: truncates paths on older Node fs APIs — hard reject.
  if (p.includes('\0')) return false;
  // Backslash: Windows separator; could smuggle `..\` past the `/` split.
  if (p.includes('\\')) return false;
  // Windows drive letter prefix (C:\, d:/…) — treat as absolute.
  if (/^[a-zA-Z]:/.test(p)) return false;
  // POSIX absolute.
  if (p.startsWith('/')) return false;
  // Any segment that resolves upward or is a self-reference.
  return !p.split('/').some((seg) => seg === '..' || seg === '.' || seg === '');
}

// ─── Improvement Tools ───
// Subset of tools for reading/searching project files. No fleet/slot ops.

// Reuse generic tools from copilot (read_task_file reads any file by path)
// Only add improvement-specific tools: read_learnings, propose_changes
const REUSED_TOOL_NAMES = new Set(['read_task_file']);
const REUSED_TOOLS = FLEET_TOOLS.filter((t) => REUSED_TOOL_NAMES.has(t.name));

const IMPROVEMENT_ONLY_TOOLS: Tool[] = [
  {
    name: 'gather_project_context',
    description:
      'Gather all project context in a single call: file tree, all template contents, fixture contents, project.json, and curated learnings. Call this FIRST before analyzing — it gives you everything you need.',
    parameters: Type.Object({
      project: Type.String({
        description: 'Project name (provided in the system prompt under ## Project)',
      }),
    }),
  },
  {
    name: 'propose_changes',
    description:
      'Submit your proposed file changes. Call this after analyzing the project context and the learning.',
    parameters: Type.Object({
      rationale: Type.String({ description: '1-3 sentence explanation of why these changes help' }),
      changes: Type.Array(
        Type.Object({
          filePath: Type.String({ description: 'File path relative to farmslot root' }),
          description: Type.String({ description: 'What this change does' }),
          content: Type.String({ description: 'The complete new file content' }),
        }),
      ),
    }),
  },
];

const IMPROVEMENT_TOOLS: Tool[] = [...REUSED_TOOLS, ...IMPROVEMENT_ONLY_TOOLS];

// ─── Tool Executor ───
// Handles improvement-only tools locally, delegates shared tools to copilot's executeTool.

async function executeImprovementTool(
  name: string,
  args: Record<string, unknown>,
  callId: string,
): Promise<{ toolCallId: string; toolName: string; content: string; isError: boolean }> {
  // Shared tools — delegate to copilot executor
  if (REUSED_TOOL_NAMES.has(name)) {
    return executeTool(name, args, callId);
  }

  try {
    let result: unknown;

    switch (name) {
      case 'gather_project_context': {
        const project = String(args.project);
        if (project.includes('..') || !/^[\w-]+$/.test(project))
          throw new Error('Invalid project name');
        const projectDir = path.join(farmslotRoot, 'projects', project);
        if (!existsSync(projectDir)) throw new Error(`Project ${project} not found`);

        const files: Array<{ path: string; content: string }> = [];
        let totalSize = 0;
        const MAX_SIZE = 80 * 1024; // 80KB total budget

        async function walk(dir: string) {
          if (totalSize >= MAX_SIZE) return;
          const entries = await readdir(dir, { withFileTypes: true });
          for (const entry of entries) {
            if (totalSize >= MAX_SIZE) break;
            const fullPath = path.join(dir, entry.name);
            if (entry.isDirectory()) {
              if (entry.name === 'node_modules' || entry.name === '.git') continue;
              await walk(fullPath);
            } else {
              const relPath = path.relative(farmslotRoot, fullPath);
              try {
                const content = await readFile(fullPath, 'utf-8');
                const truncated =
                  content.length > 15000 ? content.slice(0, 15000) + '\n[...truncated]' : content;
                files.push({ path: relPath, content: truncated });
                totalSize += truncated.length;
              } catch {
                /* skip binary/unreadable */
              }
            }
          }
        }
        await walk(projectDir);

        // Also read curated learnings
        const learningsPath = path.join(
          farmslotRoot,
          'projects',
          project,
          'learnings',
          'LEARNINGS.md',
        );
        let learnings = '';
        if (existsSync(learningsPath)) {
          learnings = await readFile(learningsPath, 'utf-8');
        }

        result = {
          project,
          fileCount: files.length,
          files,
          learnings: learnings || 'No curated learnings found.',
        };
        break;
      }
      case 'propose_changes': {
        result = {
          accepted: true,
          message: 'Changes recorded. The orchestrator will present them for review.',
        };
        break;
      }
      default:
        throw new Error(`Unknown tool: ${name}`);
    }

    return {
      toolCallId: callId,
      toolName: name,
      content: JSON.stringify(result, null, 2),
      isError: false,
    };
  } catch (err) {
    return { toolCallId: callId, toolName: name, content: (err as Error).message, isError: true };
  }
}

// ─── System Prompts ───

const DEFAULT_SYSTEM_PROMPT = `You are a template improvement analyst for a coding agent farm called Farmslot.

A worker agent just completed a task and reported a learning. Your job is to:
1. Read the relevant project files using the tools available to you
2. Understand the current templates, fixtures, and scripts
3. Propose minimal, targeted changes that prevent the reported issue from recurring

## Workflow
1. Call gather_project_context with the project name — this returns ALL project files + curated learnings in one call
2. Analyze the learning against the project files
3. If you need to read additional files outside the project dir, use read_task_file
4. Call propose_changes with your improvements

## Rules
- Only propose changes to files under the relevant project directory (projects/<project>/)
- Always read the actual file content before proposing changes — never guess
- Make the smallest change that addresses the learning
- Preserve existing formatting, step numbering, and structure
- If the learning is noise (not actionable), call propose_changes with an empty changes array and explain why`;

// ─── Core Functions ───

type BroadcastFn = (event: string, payload: unknown) => void;

// Module-scoped broadcast — set at gateway init via initImprovementEngine.
// Used by every placeholder/terminal/proposal event so the inbox path that
// goes through decision.resolve (which calls runResolveDecision with a no-op
// per-request emit) still pushes events to all connected clients. Mirrors
// the run-engine.ts / run-completion.ts pattern.
let broadcastFn: BroadcastFn = () => {};

export function initImprovementEngine(broadcast: BroadcastFn): void {
  broadcastFn = broadcast;
}

/**
 * Emit an "analyzing" placeholder improvement decision so the inbox shows
 * progress immediately when the operator clicks Accept for Learning. Returns
 * the new decision id, or null if the run was not found.
 */
export function emitImprovementPlaceholder(runId: string): string | null {
  const run = getRun(runId);
  if (!run) return null;
  const placeholder: RunDecision = {
    id: `imp-${runId}-${randomUUID()}`,
    type: 'improvement',
    title: 'Analyzing learnings…',
    description:
      "Improvement engine is analyzing this run's combined learnings. The tool-equipped LLM may take a minute or two; the card will update in place.",
    actions: [],
    createdAt: new Date().toISOString(),
    payload: {
      kind: 'improvement',
      learningContent: '',
      proposedChanges: [],
      rationale: '',
      sourceRunId: runId,
      project: run.project,
      analysisStatus: 'analyzing',
      analysisStartedAt: new Date().toISOString(),
      analysisAttempts: 1,
    },
  };
  const decisions = [...(run.decisions ?? []), placeholder];
  updateRun(runId, { decisions });
  broadcastFn(Events.RUN_DECISION_NEW, {
    runId,
    decision: pendingDecisionForRun(run, placeholder),
    slotId: run.slotId,
  });
  return placeholder.id;
}

/**
 * Replace a placeholder improvement decision with a terminal status (no-content,
 * no-changes, error). Keeps the card visible in the inbox with a Dismiss action
 * so silent skips become observable.
 */
export function markImprovementTerminal(
  runId: string,
  decisionId: string,
  status: 'no-content' | 'no-changes' | 'error',
  message: string,
): void {
  const run = getRun(runId);
  if (!run) {
    console.warn(
      `[improvement] terminalize ${status} skipped — run ${runId.slice(0, 8)} no longer in store`,
    );
    return;
  }
  const decision = run.decisions.find((d) => d.id === decisionId);
  if (!decision) {
    console.warn(
      `[improvement] terminalize ${status} skipped — decision ${decisionId} not on run ${runId.slice(0, 8)}`,
    );
    return;
  }
  // No-op when the decision already terminalized — guards against double
  // terminalization if both the LLM error path and a recovery sweep race for
  // the same placeholder.
  const existingStatus = (decision.payload as ImprovementDiffPayload | undefined)?.analysisStatus;
  if (existingStatus && existingStatus !== 'analyzing') return;
  const titles: Record<'no-content' | 'no-changes' | 'error', string> = {
    'no-content': 'No learnings to analyze',
    'no-changes': 'No template changes proposed',
    error: 'Improvement analysis failed',
  };
  decision.title = titles[status];
  decision.description = message;
  decision.actions = [{ id: 'dismiss', label: 'Dismiss', style: 'secondary' }];
  const existing = decision.payload as ImprovementDiffPayload | undefined;
  decision.payload = {
    kind: 'improvement',
    learningContent: existing?.learningContent ?? '',
    proposedChanges: [],
    rationale: message,
    sourceRunId: runId,
    project: run.project,
    analysisStatus: status,
    analysisStartedAt: existing?.analysisStartedAt,
    analysisAttempts: existing?.analysisAttempts,
    ...(status === 'error' ? { analysisError: message } : {}),
  };
  updateRun(runId, { decisions: run.decisions });
  const pendingDecision = pendingDecisionForRun(run, decision);
  broadcastFn(Events.RUN_DECISION_UPDATED, {
    runId,
    decision: pendingDecision,
    slotId: run.slotId,
  });
  broadcastFn(Events.DECISION_UPDATED, {
    decision: pendingDecision,
    runId,
    slotId: run.slotId,
  });
}

export async function analyzeAndPropose(
  runId: string,
  learningContent: string,
  placeholderDecisionId?: string,
): Promise<void> {
  const run = getRun(runId);
  if (!run) {
    console.warn(`[improvement] run ${runId} not found`);
    return;
  }

  const project = run.project;
  if (!project) {
    console.warn(`[improvement] run ${runId} has no project`);
    return;
  }

  console.log(`[improvement] analyzing learning for run ${runId} (project: ${project})`);

  // Load per-project system prompt or use default
  const projectPrompt = await loadPromptTemplate(project, 'improvement-system.md', {
    LEARNING: learningContent,
    PROJECT_NAME: project,
  });

  const systemPrompt =
    (projectPrompt ?? DEFAULT_SYSTEM_PROMPT) +
    `\n\n## Current Learning\n${learningContent}\n\n## Project\n${project}`;

  const cfg = getLLMConfig();

  try {
    const result = await callLLMChat({
      provider: cfg.defaultProvider,
      model: cfg.improvementModel,
      systemPrompt,
      messages: [
        {
          role: 'user',
          content: `Analyze this worker learning and propose template improvements for project "${project}":\n\n${learningContent}`,
        },
      ],
      maxTokens: 4096,
      tools: IMPROVEMENT_TOOLS,
      toolExecutor: executeImprovementTool,
    });

    // Extract proposed changes from the conversation
    // Scan piMessages in REVERSE to get the LAST propose_changes call (avoids stale matches)
    let payload: ImprovementDiffPayload | null = null;

    if (result.piMessages) {
      for (let i = result.piMessages.length - 1; i >= 0 && !payload; i--) {
        const msg = result.piMessages[i];
        if (msg.role === 'assistant' && Array.isArray(msg.content)) {
          for (const block of msg.content) {
            if ((block as any).type === 'toolCall' && (block as any).name === 'propose_changes') {
              const toolArgs = (block as any).arguments as {
                rationale: string;
                changes: Array<{ filePath: string; description: string; content: string }>;
              };
              // Read original files for before content
              const proposedChanges: ImprovementFileChange[] = [];
              for (const change of toolArgs.changes ?? []) {
                let before = '';
                try {
                  before = await readFile(path.join(farmslotRoot, change.filePath), 'utf-8');
                } catch {
                  // New file — before is empty
                }
                proposedChanges.push({
                  filePath: change.filePath,
                  before,
                  after: change.content,
                });
              }
              payload = {
                kind: 'improvement',
                learningContent,
                proposedChanges,
                rationale: toolArgs.rationale,
                sourceRunId: runId,
                project,
              };
            }
          }
        }
      }
    }

    // Fallback: try parsing the text response as JSON
    if (!payload) {
      const jsonMatch = result.text.match(/\{[\s\S]*"proposedChanges"[\s\S]*\}/);
      if (jsonMatch) {
        try {
          const parsed = JSON.parse(jsonMatch[0]);
          payload = {
            kind: 'improvement',
            learningContent,
            proposedChanges: parsed.proposedChanges ?? [],
            rationale: parsed.rationale ?? result.text.slice(0, 200),
            sourceRunId: runId,
            project,
          };
        } catch {
          /* LLM text not JSON-shaped — fall through to deterministic no-changes payload below */
        }
      }
    }

    if (!payload) {
      payload = {
        kind: 'improvement',
        learningContent,
        proposedChanges: [],
        rationale:
          result.text.length > 0
            ? `LLM analysis:\n${result.text.slice(0, 500)}\n\nNo structured changes proposed. Refine via chat.`
            : result.stopReason === 'length'
              ? 'LLM hit the max-token cap before emitting any text (stopReason=length). Retry or refine via chat.'
              : 'LLM returned no response. Refine via chat.',
        sourceRunId: runId,
        project,
      };
    }

    // No proposed changes is always a terminal "no-changes" state. Both
    // callers of analyzeAndPropose pass a placeholderDecisionId, so we just
    // terminalize that placeholder.
    if (payload.proposedChanges.length === 0) {
      console.log(`[improvement] no changes proposed for run ${runId}: ${payload.rationale}`);
      if (placeholderDecisionId) {
        markImprovementTerminal(runId, placeholderDecisionId, 'no-changes', payload.rationale);
      }
      return;
    }

    payload.analysisStatus = 'completed';

    const updatedRun = getRun(runId);
    if (!updatedRun) return;

    if (placeholderDecisionId) {
      // Replace the placeholder card in place — preserves position in inbox + survives reload.
      const placeholder = updatedRun.decisions.find((d) => d.id === placeholderDecisionId);
      if (placeholder) {
        placeholder.title = 'Template improvement proposed';
        placeholder.description = payload.rationale;
        placeholder.actions = [
          { id: 'apply', label: 'Apply', style: 'primary' },
          { id: 'dismiss', label: 'Dismiss', style: 'secondary' },
        ];
        // Carry the attempt count across the replacement — the success payload
        // is built fresh from the LLM proposal and would otherwise drop it.
        payload.analysisAttempts = (
          placeholder.payload as ImprovementDiffPayload | undefined
        )?.analysisAttempts;
        placeholder.payload = payload;
        updateRun(runId, { decisions: updatedRun.decisions });
        const pendingDecision = pendingDecisionForRun(updatedRun, placeholder);
        broadcastFn(Events.RUN_DECISION_UPDATED, {
          runId,
          decision: pendingDecision,
          slotId: updatedRun.slotId,
        });
        broadcastFn(Events.DECISION_UPDATED, {
          decision: pendingDecision,
          runId,
          slotId: updatedRun.slotId,
        });
        console.log(
          `[improvement] updated placeholder ${placeholder.id} for run ${runId} (${payload.proposedChanges.length} file(s))`,
        );
        return;
      }
    }

    // No placeholder (legacy path) — create a fresh decision.
    const decision: RunDecision = {
      id: `imp-${runId}-${randomUUID()}`,
      type: 'improvement',
      title: 'Template improvement proposed',
      description: payload.rationale,
      actions: [
        { id: 'apply', label: 'Apply', style: 'primary' },
        { id: 'dismiss', label: 'Dismiss', style: 'secondary' },
      ],
      createdAt: new Date().toISOString(),
      payload,
    };
    const decisions = [...(updatedRun.decisions ?? []), decision];
    updateRun(runId, { decisions });
    broadcastFn(Events.RUN_DECISION_NEW, {
      runId,
      decision: pendingDecisionForRun(updatedRun, decision),
      slotId: updatedRun.slotId,
    });
    console.log(
      `[improvement] created improvement decision ${decision.id} for run ${runId} (${payload.proposedChanges.length} file(s))`,
    );
  } catch (err) {
    const message = (err as Error).message;
    console.warn(`[improvement] LLM call failed for run ${runId}: ${message}`);
    if (placeholderDecisionId) {
      markImprovementTerminal(runId, placeholderDecisionId, 'error', message);
    }
  }
}

export async function chatRefine(
  runId: string,
  decisionId: string,
  message: string,
  onDelta?: (text: string) => void,
): Promise<{ text: string; updatedChanges?: ImprovementFileChange[] }> {
  const run = getRun(runId);
  if (!run) throw new Error(`Run ${runId} not found`);

  const decision = run.decisions?.find((d) => d.id === decisionId);
  if (!decision) throw new Error(`Decision ${decisionId} not found on run ${runId}`);

  const payload = decision.payload as ImprovementDiffPayload;
  const cfg = getLLMConfig();

  const piMessages = getChatMessages(decisionId);

  const systemPrompt = `You are helping refine a template improvement proposal. You have tools to read project files.

Current proposal:
${JSON.stringify(
  payload.proposedChanges.map((c) => ({
    filePath: c.filePath,
    description: c.after.length + ' chars',
  })),
  null,
  2,
)}

Rationale: ${payload.rationale}
Original learning: ${payload.learningContent}

When the user asks for changes, use gather_project_context or read_task_file to check current file content, then call propose_changes with the updated proposal.
Otherwise respond conversationally.`;

  const result = await callLLMChat({
    provider: cfg.defaultProvider,
    model: cfg.improvementModel,
    systemPrompt,
    messages: [{ role: 'user', content: message }],
    piMessages,
    maxTokens: 4096,
    onDelta,
    tools: IMPROVEMENT_TOOLS,
    toolExecutor: executeImprovementTool,
  });

  if (result.piMessages) {
    setChatMessages(decisionId, result.piMessages);
  }

  // Scan REVERSE for the LAST propose_changes call (avoids stale matches from prior rounds)
  let updatedChanges: ImprovementFileChange[] | undefined;
  if (result.piMessages) {
    for (let i = result.piMessages.length - 1; i >= 0 && !updatedChanges; i--) {
      const msg = result.piMessages[i];
      if (msg.role === 'assistant' && Array.isArray(msg.content)) {
        for (const block of msg.content) {
          if ((block as any).type === 'toolCall' && (block as any).name === 'propose_changes') {
            const toolArgs = (block as any).arguments as {
              rationale: string;
              changes: Array<{ filePath: string; description: string; content: string }>;
            };
            updatedChanges = [];
            for (const change of toolArgs.changes ?? []) {
              let before = '';
              try {
                before = await readFile(path.join(farmslotRoot, change.filePath), 'utf-8');
              } catch {
                /* new file */
              }
              updatedChanges.push({ filePath: change.filePath, before, after: change.content });
            }
            const updatedPayload: ImprovementDiffPayload = {
              ...payload,
              proposedChanges: updatedChanges,
              rationale: toolArgs.rationale ?? payload.rationale,
            };
            decision.payload = updatedPayload;
            updateRun(runId, { decisions: run.decisions });
          }
        }
      }
    }
  }

  // Fallback: check text for JSON
  if (!updatedChanges) {
    const jsonMatch = result.text.match(/\{[\s\S]*"proposedChanges"[\s\S]*\}/);
    if (jsonMatch) {
      try {
        const parsed = JSON.parse(jsonMatch[0]);
        if (Array.isArray(parsed.proposedChanges)) {
          updatedChanges = parsed.proposedChanges;
          const updatedPayload: ImprovementDiffPayload = {
            ...payload,
            proposedChanges: updatedChanges!,
            ...(parsed.rationale ? { rationale: parsed.rationale } : {}),
          };
          decision.payload = updatedPayload;
          updateRun(runId, { decisions: run.decisions });
        }
      } catch {
        /* chat refine response not JSON-shaped — keep prior payload, return text-only reply */
      }
    }
  }

  return { text: result.text, updatedChanges };
}

export async function applyImprovement(
  runId: string,
  decisionId: string,
): Promise<{
  applied: ImprovementFileChange[];
  validationPassed: boolean;
  validationOutput?: string;
}> {
  const run = getRun(runId);
  if (!run) throw new Error(`Run ${runId} not found`);

  const decision = run.decisions?.find((d) => d.id === decisionId);
  if (!decision) throw new Error(`Decision ${decisionId} not found`);

  const payload = decision.payload as ImprovementDiffPayload;
  if (!payload?.proposedChanges?.length) {
    throw new Error('No proposed changes to apply');
  }

  const applied: ImprovementFileChange[] = [];

  for (const change of payload.proposedChanges) {
    const expectedPrefix = `projects/${payload.project}/`;
    if (
      !isSafeProjectRelativePath(change.filePath) ||
      !change.filePath.startsWith(expectedPrefix)
    ) {
      console.warn(`[improvement] rejected filePath outside ${expectedPrefix}: ${change.filePath}`);
      continue;
    }
    const fullPath = path.join(farmslotRoot, change.filePath);
    try {
      await writeFile(fullPath, change.after, 'utf-8');
      // Force-add: project files may be gitignored by the parent repo
      execFileSync('git', ['add', '-f', '--', change.filePath], { cwd: farmslotRoot });
      applied.push(change);
      console.log(`[improvement] applied: ${change.filePath}`);
    } catch (err) {
      console.warn(`[improvement] failed to write ${change.filePath}: ${(err as Error).message}`);
    }
  }

  // Run project-specific validation if available, fall back to command-center typecheck
  let validationPassed = true;
  let validationOutput = '';
  try {
    const projectJson = path.join(farmslotRoot, 'projects', payload.project, 'project.json');
    let validateCmd = 'yarn';
    let validateArgs = ['typecheck'];
    let validateCwd = path.join(farmslotRoot, 'apps/command-center');

    if (existsSync(projectJson)) {
      try {
        const projConfig = JSON.parse(await readFile(projectJson, 'utf-8'));
        if (projConfig.hooks?.validate) {
          const parts = projConfig.hooks.validate.split(/\s+/);
          validateCmd = parts[0];
          validateArgs = parts.slice(1);
          validateCwd = farmslotRoot;
        }
      } catch {
        /* use default */
      }
    }

    const output = execFileSync(validateCmd, validateArgs, {
      cwd: validateCwd,
      encoding: 'utf-8',
      timeout: 60000,
    });
    validationOutput = output;
  } catch (err) {
    validationPassed = false;
    validationOutput =
      (err as { stdout?: string; stderr?: string }).stdout ?? (err as Error).message;
    console.warn(`[improvement] validation failed after apply: ${validationOutput.slice(0, 200)}`);
  }

  // Only resolve if ALL files applied AND validation passed
  const allApplied = applied.length === payload.proposedChanges.length;
  if (validationPassed && allApplied) {
    decision.resolvedAt = new Date().toISOString();
    decision.resolvedAction = 'applied';
    cleanupChatSession(decisionId);
  } else {
    const reason = !allApplied
      ? `${applied.length}/${payload.proposedChanges.length} files applied`
      : 'validation failed';
    console.warn(`[improvement] decision ${decisionId} stays pending: ${reason}`);
  }
  updateRun(runId, { decisions: run.decisions });

  // Append to project LEARNINGS.md for historical tracking
  if (applied.length > 0) {
    await appendToLearningsHistory(payload, runId, validationPassed);
  }

  return { applied, validationPassed, validationOutput };
}

async function appendToLearningsHistory(
  payload: ImprovementDiffPayload,
  runId: string,
  validationPassed: boolean,
): Promise<void> {
  const learningsDir = path.join(farmslotRoot, 'projects', payload.project, 'learnings');
  const learningsPath = path.join(learningsDir, 'LEARNINGS.md');

  const date = new Date().toISOString().slice(0, 10);
  const filesChanged = payload.proposedChanges.map((c) => c.filePath).join(', ');
  const validation = validationPassed ? 'passed' : 'FAILED';

  const entry = `
---

## Improvement: ${runId.slice(0, 8)} (${date}) — auto-applied, validation ${validation}

**Learning:** ${payload.learningContent.split('\n')[0].slice(0, 200)}

**Rationale:** ${payload.rationale}

**Files changed:** ${filesChanged}
`;

  try {
    if (!existsSync(learningsDir)) {
      const { mkdir } = await import('node:fs/promises');
      await mkdir(learningsDir, { recursive: true });
    }

    if (existsSync(learningsPath)) {
      const existing = await readFile(learningsPath, 'utf-8');
      await writeFile(learningsPath, existing.trimEnd() + '\n' + entry, 'utf-8');
    } else {
      const header = `# ${payload.project} Learnings\n\nHistorical record of accepted template improvements.\n`;
      await writeFile(learningsPath, header + entry, 'utf-8');
    }

    console.log(`[improvement] appended to ${learningsPath}`);
  } catch (err) {
    console.warn(`[improvement] failed to append learnings history: ${(err as Error).message}`);
  }
}

export function cleanupChatSession(decisionId: string): void {
  chatSessions.delete(decisionId);
}
