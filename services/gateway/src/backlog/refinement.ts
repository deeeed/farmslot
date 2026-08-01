// Backlog item refinement sessions — tighten an existing work contract without
// mutating lifecycle, source identity, or run/work-graph linkage.

import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

import {
  type BacklogItem,
  type BacklogRefineParams,
  type BacklogRefineResult,
  type BacklogRefinementSessionGetParams,
  type BacklogRefinementSessionGetResult,
  DEFAULT_BACKLOG_REFINEMENT_MODEL,
  DEFAULT_BACKLOG_REFINEMENT_RUNNER,
} from '@farmslot/protocol';

import { farmslotRoot } from '../fleet/state.js';
import {
  attachCommandForSession,
  buildRefinementShellCommand,
  launchRefinementTmuxSession,
  resolveTmuxSessionWorker,
  tmuxSessionExists,
} from '../refinement/session.js';
import { runnerDefaultModel } from '../runners/registry.js';

import { getBacklogItemSnapshot, getBacklogSpec } from './store.js';

const REFINEMENT_PROMPT_ROOT =
  process.env.FARMSLOT_BACKLOG_REFINEMENT_PROMPT_DIR ??
  path.join(farmslotRoot, '.backlog', 'refinement-prompts');

function slugify(value: string): string {
  const slug = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48);
  return slug || 'backlog-item';
}

function repoRelative(filePath: string): string {
  const relative = path.relative(farmslotRoot, filePath);
  return relative.startsWith('..') ? filePath : relative;
}

export function backlogRefinementSessionName(item: Pick<BacklogItem, 'id' | 'sourceRef'>): string {
  return `backlog-${slugify(item.sourceRef || item.id)}`;
}

async function allocateRefinementPromptPath(item: BacklogItem): Promise<string> {
  await mkdir(REFINEMENT_PROMPT_ROOT, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  return path.join(
    REFINEMENT_PROMPT_ROOT,
    `${stamp}-${slugify(item.sourceRef || item.id)}-${slugify(item.title)}.md`,
  );
}

function formatDispatchSettings(item: BacklogItem): string {
  const lines = [
    `- flowType: ${item.flowType}`,
    `- priority: ${item.priority}`,
    `- autoDispatch: ${item.autoDispatch === true ? 'true' : 'false'}`,
    `- multiPr: ${item.multiPr === true ? 'true' : 'false'}`,
    `- runner: ${item.runner?.trim() || '(unset)'}`,
    `- model: ${item.model?.trim() || '(unset)'}`,
    `- mode: ${item.mode?.trim() || '(unset)'}`,
    `- effort: ${item.effort?.trim() || '(unset)'}`,
    `- app: ${item.app?.trim() || '(unset)'}`,
    `- prepareProfile: ${item.prepareProfile?.trim() || '(unset)'}`,
    `- allowedSlots: ${(item.allowedSlots ?? []).join(', ') || '(any)'}`,
    `- taskTemplate: ${
      item.taskTemplate
        ? JSON.stringify(item.taskTemplate)
        : '(unset)'
    }`,
    `- reviewDepth: ${item.reviewDepth ? JSON.stringify(item.reviewDepth) : '(unset)'}`,
    `- launchPlan: ${item.launchPlan ? JSON.stringify(item.launchPlan) : '(unset)'}`,
  ];
  return lines.join('\n');
}

function formatLinkedContext(item: BacklogItem): string {
  return [
    `- roadmapItemId: ${item.roadmapItemId?.trim() || '(none)'}`,
    `- workGraphId: ${item.workGraphId?.trim() || '(none)'}`,
    `- workNodeId: ${item.workNodeId?.trim() || '(none)'}`,
    `- runId: ${item.runId?.trim() || '(none)'}`,
    `- queuedQueueItemId: ${item.queuedQueueItemId?.trim() || '(none)'}`,
    `- lastObservedRunStatus: ${item.lastObservedRunStatus?.trim() || '(none)'}`,
  ].join('\n');
}

async function loadSpecSection(item: BacklogItem): Promise<string> {
  if (!item.specPath?.trim()) {
    return [
      '## Attached spec',
      '',
      '(no attached spec — refine title/notes/dispatch settings and propose a spec draft if needed)',
      '',
    ].join('\n');
  }
  try {
    const spec = await getBacklogSpec({ itemId: item.id });
    return [
      '## Attached spec',
      '',
      `Path: ${spec.path}`,
      `Hash: ${spec.hash}`,
      '',
      '```markdown',
      spec.content.trimEnd(),
      '```',
      '',
    ].join('\n');
  } catch (err) {
    return [
      '## Attached spec',
      '',
      `Path: ${item.specPath}`,
      `Could not read attached spec: ${(err as Error).message}`,
      '',
    ].join('\n');
  }
}

export async function renderBacklogRefinementPrompt(
  item: BacklogItem,
  runner?: string,
  model?: string,
): Promise<string> {
  const specSection = await loadSpecSection(item);
  return [
    '# Backlog refinement task',
    '',
    'This is an interactive backlog refinement session inside the Farmslot framework.',
    'Tighten **one existing backlog work contract** — do not invent a parallel item, do not dispatch, and do not change lifecycle or linkage fields.',
    '',
    '## Item identity',
    '',
    `- id: ${item.id}`,
    `- sourceRef: ${item.sourceRef}`,
    `- sourceKind: ${item.sourceKind}`,
    `- sourceUrl: ${item.sourceUrl?.trim() || '(none)'}`,
    `- project: ${item.project}`,
    `- title: ${item.title}`,
    `- status: ${item.status}`,
    `- tags: ${(item.tags ?? []).join(', ') || '(none)'}`,
    `- createdAt: ${item.createdAt}`,
    `- updatedAt: ${item.updatedAt}`,
    '',
    '## Source reference (canonical — do not change silently)',
    '',
    `- Keep sourceKind=${item.sourceKind} and sourceRef=${item.sourceRef} unless the operator explicitly requests a source change.`,
    '- Do not rewrite Jira/GitHub source content from this session.',
    '',
    '## Notes',
    '',
    item.notes?.trim() || '(empty)',
    '',
    specSection,
    '## Dispatch settings',
    '',
    formatDispatchSettings(item),
    '',
    '## Linked roadmap / work-graph / run context',
    '',
    formatLinkedContext(item),
    '',
    '## Quality contract',
    '',
    '- Follow the backlog-specific `fs-backlog-spec` skill/contract (`.agents/skills/fs-backlog-spec/SKILL.md`).',
    '- Specs must keep a non-empty `## Acceptance Criteria` section with concrete check markers.',
    '- Specs must keep a non-empty `## Non-goals` section.',
    '- Prefer `node .agents/skills/fs-backlog-spec/spec-lint.mjs` on any edited spec path.',
    '',
    '## Forbidden instructions',
    '',
    '- Do **not** promote roadmap drafts or create new backlog items from roadmap promotion.',
    '- Do **not** change roadmap item stages (rough/refining/refined/promoted).',
    '- Do **not** mark this backlog item ready, enqueue it, dispatch it, publish it, or mutate run/work-graph linkage automatically.',
    '- Do **not** mutate status, queuedQueueItemId, runId, workGraphId, workNodeId, launchPlanState, or shipped provenance unless the operator explicitly asks and the gateway path supports it.',
    '',
    '## Allowed outcomes',
    '',
    '- Improve the attached spec markdown (problem, scope, ACs, non-goals, verified refs).',
    '- Tighten title/notes/tags/dispatch configuration via operator-confirmed `farmslot backlog` updates.',
    '- Surface validation errors from `fs-backlog-spec` / spec-lint; leave the item for the operator to mark ready.',
    '',
    `Refinement runner: ${runner || '(project default)'}`,
    `Refinement model: ${model || '(project default)'}`,
    '',
    'Treat `farmslot backlog --help` as the discoverable command surface for backlog mutations.',
    'Before writing files, show the operator a concise proposed refinement and ask what to do next.',
    '',
  ].join('\n');
}

function backlogRefinementPrelude(): string {
  return [
    'unset TMUX TMUX_PANE',
    'export FARMSLOT_BACKLOG_REFINEMENT=1',
    'export FARMSLOT_RUNNER_SCOPE=backlog-refinement',
  ].join(' && ');
}

export function buildBacklogRefinementShellCommand(
  item: BacklogItem,
  promptPath: string,
  runnerCommand?: string,
  runner?: string,
  model?: string,
  safetyTier?: BacklogRefineParams['safetyTier'],
): string {
  return buildRefinementShellCommand({
    promptPath,
    itemFile: item.specPath?.trim() || `.backlog.json#${item.id}`,
    ...(runnerCommand ? { runnerCommand } : {}),
    ...(runner ? { runner } : {}),
    ...(model ? { model } : {}),
    ...(safetyTier ? { safetyTier } : {}),
    prelude: backlogRefinementPrelude(),
    commandLabel: 'Backlog refinement command',
    fallbackMessages: [
      `Backlog refinement prompt: ${path.resolve(farmslotRoot, promptPath)}`,
      `Backlog item: ${item.sourceRef} (${item.id})`,
    ],
  });
}

export async function getBacklogRefinementSession(
  params: BacklogRefinementSessionGetParams,
): Promise<BacklogRefinementSessionGetResult> {
  if (!params.itemId?.trim()) throw new Error('backlog.refinementSession.get requires itemId');
  const item = getBacklogItemSnapshot(params.itemId.trim());
  if (!item) throw new Error(`Backlog item not found: ${params.itemId}`);
  const session = backlogRefinementSessionName(item);
  const exists = await tmuxSessionExists(session);
  const tmuxWorker = exists ? await resolveTmuxSessionWorker(session) : undefined;
  return {
    itemId: item.id,
    tmuxSession: session,
    tmuxTarget: tmuxWorker?.target ?? session,
    exists,
    ...(tmuxWorker ? { tmuxWorker } : {}),
    attachCommand: attachCommandForSession(session),
  };
}

export async function startBacklogRefinement(
  params: BacklogRefineParams,
): Promise<BacklogRefineResult> {
  if (!params.itemId?.trim()) throw new Error('backlog.refine requires itemId');
  const item = getBacklogItemSnapshot(params.itemId.trim());
  if (!item) throw new Error(`Backlog item not found: ${params.itemId}`);
  if (item.status === 'archived') {
    throw new Error('Cannot refine an archived backlog item');
  }

  const runner =
    params.runner?.trim() ||
    item.runner?.trim() ||
    process.env.FARMSLOT_BACKLOG_REFINER_RUNNER?.trim() ||
    DEFAULT_BACKLOG_REFINEMENT_RUNNER;
  const model =
    params.model?.trim() ||
    item.model?.trim() ||
    process.env.FARMSLOT_BACKLOG_REFINER_MODEL?.trim() ||
    runnerDefaultModel(runner) ||
    DEFAULT_BACKLOG_REFINEMENT_MODEL;
  const runnerCommand =
    params.runnerCommand?.trim() || process.env.FARMSLOT_BACKLOG_REFINER_COMMAND?.trim();
  const safetyTier = params.safetyTier;
  const session = backlogRefinementSessionName(item);
  const existingSession = params.launch === true && (await tmuxSessionExists(session));

  const prompt = await renderBacklogRefinementPrompt(item, runner, model);
  const absolutePromptPath = await allocateRefinementPromptPath(item);
  await writeFile(absolutePromptPath, prompt, 'utf8');
  const promptPath = repoRelative(absolutePromptPath);

  let launched = false;
  if (params.launch === true && !existingSession) {
    const shellCommand = buildBacklogRefinementShellCommand(
      item,
      promptPath,
      runnerCommand,
      runner,
      model,
      safetyTier,
    );
    launched = await launchRefinementTmuxSession({ session, shellCommand });
  }

  const tmuxWorker =
    params.launch === true && (launched || existingSession)
      ? await resolveTmuxSessionWorker(session)
      : undefined;

  // Re-read snapshot after session work — refinement must not mutate item fields.
  const after = getBacklogItemSnapshot(item.id) ?? item;

  return {
    item: after,
    promptPath,
    tmuxSession: session,
    tmuxTarget: tmuxWorker?.target ?? session,
    ...(tmuxWorker ? { tmuxWorker } : {}),
    launched,
    ...(existingSession ? { attachedExisting: true } : {}),
    attachCommand: attachCommandForSession(session),
    ...(runner ? { runner } : {}),
    ...(model ? { model } : {}),
    ...(runnerCommand ? { runnerCommand } : {}),
    ...(safetyTier ? { safetyTier } : {}),
  };
}

export const __backlogRefinementTest = {
  backlogRefinementSessionName,
  buildBacklogRefinementShellCommand,
  renderBacklogRefinementPrompt,
};
