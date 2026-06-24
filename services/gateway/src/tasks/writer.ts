// task-writer.ts — Generate TASK.md from worker template + ticket data + slot vars

import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, readdir, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import {
  type ArtifactRef,
  type FlowType,
  isLightweightInteractiveDevRun,
  type Run,
  type TaskSchema,
  type TaskSchemaPhase,
  type TemplateProvenance,
} from '@farmslot/protocol';

import { getProjectField, loadProjectVars, loadSlotVars, resolveProjectTaskDirName } from '../core/config.js';
import { expandTemplate } from '../core/hooks.js';
import { execLocal, farmslotRoot, getOrchestratorTaskRoot } from '../core/index.js';
import {
  buildFollowUpScopeContractSection,
  materializeInheritedContext,
} from '../family-observability/context.js';
import {
  buildSmartBranch,
  flowDir as computeFlowDir,
  generateTaskContent,
  ticketSlug as computeTicketSlug,
} from '../intelligence/engine.js';
import { getPRRawData, parseJsonLines } from '../methods/pr/raw-cache.js';
import { harnessRoot } from '../projects/harness-root.js';
import { extractRecipeFromPRBody, materializeExtractedRecipe } from '../quality/pr-body-recipe.js';

import {
  assertArtifactOnlyTaskGuard,
  evaluateArtifactOnlyTaskGuard,
} from './artifact-only-guard.js';
import { resolveWorkerTemplateSelectionForRun } from './worker-template-options.js';

// Remote deployment dir — kept in sync with REMOTE_AGENT_DIR in core/hooks.ts
const REMOTE_FARMSLOT_DIR = '~/farmslot-node';
const localHostname = os.hostname().replace(/\.local$/, '');

export { FLOW_TO_TEMPLATE } from './worker-template-options.js';

export const TEMPLATE_PROVENANCE_INPUT = 'inputs/template-provenance.json';

/** Error thrown when a task dir collision is detected */
export class TaskCollisionError extends Error {
  constructor(
    public readonly existingDirs: string[],
    public readonly ticketSlug: string,
  ) {
    super(
      `Task dir collision: ${existingDirs.length} existing dir(s) for ${ticketSlug}: ${existingDirs.join(', ')}`,
    );
    this.name = 'TaskCollisionError';
  }
}

export interface CommentRow {
  source: 'issue' | 'review';
  id?: number;
  author: string;
  userType?: string;
  body: string;
  path?: string;
  line?: number;
  url?: string;
  createdAt?: string;
}

export const COMMENT_SUMMARY_MAX_ROWS = 40;

export function formatPrTitleSuffix(suffix: unknown): string {
  if (typeof suffix !== 'string') return '';
  const trimmed = suffix.trim();
  return trimmed ? ` ${trimmed}` : '';
}

export function isBotAuthor(row: { author: string; userType?: string }): boolean {
  if (row.userType === 'Bot') return true;
  return /\[bot\]$/i.test(row.author);
}

export function renderCommentSummary(rows: CommentRow[]): string {
  // Bots flood issue comments with build links / CLA / sonarcloud noise — drop them
  // from the preview but keep them in inputs/pr-comments.json for the worker's full triage.
  // Inline review-source bots (cursor[bot], etc.) flag real findings — keep all of those.
  const filtered = rows.filter((r) => r.source === 'review' || !isBotAuthor(r));
  if (filtered.length === 0) {
    return rows.length > 0
      ? `_All ${rows.length} fetched comment(s) were bot-issue noise. Worker MUST still re-fetch in step 4 — \`inputs/pr-comments.json\` has the full unfiltered set._`
      : '_No human or unresolved bot comments fetched at task-write time. Worker MUST still re-fetch in step 4._';
  }
  const capped = filtered.slice(0, COMMENT_SUMMARY_MAX_ROWS);
  const header = '| Source | Author | Where | Body |\n|---|---|---|---|';
  const body = capped
    .map((r) => {
      const where = r.source === 'review' ? `${r.path ?? '?'}:${r.line ?? '?'}` : 'conversation';
      const oneLine = (r.body ?? '').replace(/\s+/g, ' ').trim();
      return `| ${r.source} | ${r.author} | ${where} | ${oneLine} |`;
    })
    .join('\n');
  const droppedNote =
    rows.length > filtered.length
      ? `\n\n_${rows.length - filtered.length} bot-issue comment(s) hidden from preview — see \`inputs/pr-comments.json\` for full set._`
      : '';
  const truncated =
    filtered.length > capped.length
      ? `\n\n_${filtered.length - capped.length} more comment(s) omitted — fetch in step 4 for full set._`
      : '';
  return `${header}\n${body}${droppedNote}${truncated}`;
}

function taskBlockValue(markdown: string, key: string): string {
  const match = markdown.match(new RegExp(`^${key}:\\s*(.+)$`, 'm'));
  return match?.[1]?.trim() ?? '';
}

function stripPublicationLines(markdown: string): string {
  let inFence = false;
  return markdown
    .split('\n')
    .map((line) => {
      if (line.trim().startsWith('```')) {
        inFence = !inFence;
        return line;
      }
      const guard = evaluateArtifactOnlyTaskGuard(line);
      if (guard.allowed) return line;
      const indent = line.match(/^\s*/)?.[0] ?? '';
      return inFence
        ? `${indent}# Artifact-only replay: publication command removed.`
        : `${indent}Artifact-only replay: publication instruction removed.`;
    })
    .join('\n');
}

export function shouldApplyArtifactOnlyTaskPolicy(
  run: Pick<Run, 'completionPolicy' | 'flowType' | 'lane' | 'startRef'>,
): boolean {
  return (
    run.completionPolicy === 'artifact-only' &&
    (run.flowType === 'dev' || run.flowType === 'fix-bug') &&
    run.lane === 'comparison'
  );
}

export function applyArtifactOnlyTaskPolicy(
  markdown: string,
  run: Pick<Run, 'completionPolicy' | 'flowType' | 'lane' | 'startRef' | 'engineState'>,
): string {
  if (!shouldApplyArtifactOnlyTaskPolicy(run)) return markdown;

  const branch = taskBlockValue(markdown, 'BRANCH') || '<branch-from-task-block>';
  const repo = taskBlockValue(markdown, 'REPO') || '<repo-from-task-block>';
  const replayBase =
    run.startRef?.resolvedSha ?? run.startRef?.requestedRef ?? 'selected reference/base';
  const harnessOverlayGlob = '`' + harnessRoot() + '/**`';
  const harnessOverlayGuardrail = run.engineState?.evalExperiment
    ? [
        'Ignore injected recipe-harness overlay paths when reasoning about the product bug or product diff:',
        '`scripts/perps/agentic/**`, `app/core/AgenticService/**`, ' +
          harnessOverlayGlob +
          ', `temp/agentic/recipes/**`, and package `a:*` script aliases are harness infrastructure, not candidate product fixes.',
      ].join('\n')
    : '';
  const artifactOnlyPreamble = [
    '## Artifact-only replay guardrails',
    '',
    `This task is an artifact-only comparison replay from \`${replayBase}\`.`,
    'The local `main` branch may be newer than this replay base and may already contain the original fix; do not use `main` as the comparison baseline.',
    `When inspecting candidate changes, compare against the replay base: \`git diff ${replayBase}\` (or \`git diff ${replayBase} -- <paths>\`).`,
    harnessOverlayGuardrail,
    'Avoid every publication action: no remote pushes, no GitHub PR CLI mutations, no ready/merge/publication state changes.',
    'Leave the local working-tree diff, validation evidence, and artifacts as the output. Stop after writing `artifacts/report.md` and the completion signal.',
    '',
  ]
    .filter(Boolean)
    .join('\n');

  let result = markdown.replace(/^(#.+\n)/, `$1\n${artifactOnlyPreamble}`);

  result = result.replace(
    / {2}- \*\*If PR_NUMBER is empty\*\* — create the branch and draft PR:[\s\S]*? {4}Update `PR_NUMBER:`[^\n]*(?:\n|$)/g,
    [
      '  - **If PR_NUMBER is empty** — artifact-only replay mode: do not open a PR and do not publish. Confirm a local work branch exists only:',
      '    ```bash',
      `    cd "${repo.replace(/"/g, '\\"')}"`,
      `    branch="${branch.replace(/"/g, '\\"')}"`,
      '    current=$(git symbolic-ref --short HEAD 2>/dev/null || true)',
      '    if [ "$current" != "$branch" ]; then',
      '      git checkout -B "$branch"',
      '    fi',
      '    git status --short',
      '    ```',
      '    Leave `PR_NUMBER:` empty. This run ends with local artifacts and working-tree diff only.',
      '',
    ].join('\n'),
  );

  result = result.replace(
    /or create it from `[^`]+` if needed\./g,
    `or verify it was prepared from replay base \`${replayBase}\`; do not recreate it from \`main\`.`,
  );
  result = result.replace(/git diff main\.\.\.HEAD/g, `git diff ${replayBase}`);
  result = result.replace(/git diff main\.\.HEAD/g, `git diff ${replayBase}`);
  result = result.replace(/git log main\.\.HEAD/g, `git log ${replayBase}..HEAD`);
  result = result.replace(/git log HEAD\.\.main/g, `git log HEAD..${replayBase}`);
  result = result.replace(/commit\/push approval/g, 'artifact-only completion approval');
  result = result.replace(
    /- \[ \] \*\*(\d+)\. On approval — commit, push, update PR:\*\*[\s\S]*?(?=\s*Set `STATUS: done`\.)/g,
    [
      '- [ ] **$1. Artifact-only completion — leave local evidence only:**',
      '  - Do not push to any remote, use GitHub PR CLI mutation commands, edit/comment on PRs, mark ready, merge, or publish this replay.',
      '  - Leave the working-tree diff, `artifacts/report.md`, and validation artifacts as the comparison output.',
      '',
    ].join('\n'),
  );

  result = stripPublicationLines(result);
  assertArtifactOnlyTaskGuard(result);
  return result;
}

function checklistForInteractiveDev(run: Run): string[] {
  const configured =
    run.engineState?.interactiveDev?.checklist?.map((item) => item.trim()).filter(Boolean) ?? [];
  if (configured.length > 0) return configured;
  const acs = run.ticketData?.acceptanceCriteria?.map((item) => item.trim()).filter(Boolean) ?? [];
  if (acs.length > 0) return acs;
  return [
    'Clarify the target outcome with the operator',
    'Implement the smallest useful change on the selected branch',
    'Run focused validation or capture why validation was skipped',
    'Choose an interactive completion action in Farmslot',
  ];
}

async function writeInteractiveDevSidecars(
  run: Run,
  taskAbsDir: string,
  branch: string,
): Promise<ArtifactRef[]> {
  if (!isLightweightInteractiveDevRun(run)) return [];
  const checklist = checklistForInteractiveDev(run);
  const initialContext =
    run.engineState?.interactiveDev?.initialContext ??
    run.ticketData?.description ??
    run.ticketOrPr;
  await writeFile(
    path.join(taskAbsDir, 'inputs', 'dev-intake.json'),
    `${JSON.stringify(
      {
        kind: 'interactive-dev-intake',
        profile: run.devInteractiveProfile ?? 'lightweight',
        runId: run.id,
        ticketOrPr: run.ticketOrPr,
        initialContext,
        branch,
        title: run.ticketData?.title ?? run.ticketOrPr,
        description: run.ticketData?.description ?? initialContext,
        checklist,
        createdAt: new Date().toISOString(),
      },
      null,
      2,
    )}\n`,
    'utf-8',
  );
  await writeFile(
    path.join(taskAbsDir, 'CHECKLIST.md'),
    [
      '# Interactive Dev Checklist',
      '',
      `Run: ${run.id}`,
      `Branch: ${branch}`,
      '',
      ...checklist.map((item) => `- [ ] ${item}`),
      '',
      'Completion is operator-owned in Farmslot; do not fake worker signal files to finish this run.',
      '',
    ].join('\n'),
    'utf-8',
  );
  return [
    { path: 'inputs/dev-intake.json', purpose: 'dev-intake' },
    { path: 'CHECKLIST.md', purpose: 'interactive-checklist' },
  ];
}

async function buildPRCompleteContext(
  ghRepo: string,
  prNum: number,
  taskAbsDir: string,
): Promise<{ commentSummary: string; hasRecipe: 'yes' | 'no'; rows: CommentRow[] }> {
  const hasRecipe: 'yes' | 'no' = existsSync(path.join(taskAbsDir, 'artifacts', 'recipe.json'))
    ? 'yes'
    : 'no';
  if (!ghRepo || !prNum || !Number.isFinite(prNum)) {
    return { commentSummary: renderCommentSummary([]), hasRecipe, rows: [] };
  }
  const raw = await getPRRawData(ghRepo, prNum);
  const issueRaw = parseJsonLines(raw.commentsStdout);
  const reviewRaw = parseJsonLines(raw.reviewCommentsStdout);
  const rows: CommentRow[] = [
    ...issueRaw.map(
      (c): CommentRow => ({
        source: 'issue',
        id: c.id,
        author: c.author ?? 'unknown',
        userType: c.user_type,
        body: c.body ?? '',
        url: c.html_url,
        createdAt: c.created_at,
      }),
    ),
    ...reviewRaw.map(
      (c): CommentRow => ({
        source: 'review',
        id: c.id,
        author: c.author ?? 'unknown',
        userType: c.user_type,
        body: c.body ?? '',
        path: c.path,
        line: c.line ?? undefined,
        url: c.html_url,
        createdAt: c.created_at,
      }),
    ),
  ];
  return { commentSummary: renderCommentSummary(rows), hasRecipe, rows };
}

export function buildTaskFolderPrefix(ticketOrPr: string, variant?: string | null): string {
  const tSlug = computeTicketSlug(ticketOrPr);
  const variantSuffix = variant ? `-${computeTicketSlug(variant)}` : '';
  return `${tSlug}${variantSuffix}-`;
}

export function findTaskDirCollisions(
  entries: string[],
  ticketOrPr: string,
  variant?: string | null,
): string[] {
  const prefix = buildTaskFolderPrefix(ticketOrPr, variant);
  return entries.filter((e) => e.startsWith(prefix));
}

/**
 * Slot-less collision precheck used before GRADE so the engine can short-circuit
 * the LLM-bound grading step when a colliding task dir already exists. Returns
 * the colliding folder names + the canonical ticket slug used to build them.
 * Does NOT throw — caller decides how to surface.
 */
export async function precheckTaskDirCollision(
  run: Run,
): Promise<{ existingDirs: string[]; ticketSlug: string }> {
  const ticketSlug = computeTicketSlug(run.ticketOrPr);
  const projectVars = await loadProjectVars(run.project);
  const fDir = computeFlowDir(run.flowType);
  const tasksBaseDir = path.join(
    getOrchestratorTaskRoot(run.project, projectVars.projectJson),
    fDir,
  );
  if (!existsSync(tasksBaseDir)) return { existingDirs: [], ticketSlug };
  try {
    const entries = await readdir(tasksBaseDir);
    const existingDirs = findTaskDirCollisions(
      entries,
      run.ticketOrPr,
      run.lane === 'comparison' ? run.variant : null,
    );
    return { existingDirs, ticketSlug };
  } catch (err) {
    // readdir failure here is a transient FS error (dir removed mid-check, perms, etc.).
    // Treat as "no collision detected" — the real WRITE_TASK step will still pre-check and
    // catch any real collision. We're only saving LLM cost on the happy path.
    console.warn(
      `[run-engine] precheckTaskDirCollision readdir failed for ${tasksBaseDir}: ${(err as Error).message}`,
    );
    return { existingDirs: [], ticketSlug };
  }
}

export type WriteTaskProgressFn = (
  event: string,
  payload: { name?: string; detail?: string },
) => void;

function sha256Text(input: string): string {
  return createHash('sha256').update(input).digest('hex');
}

async function readGitHead(cwd: string): Promise<string | undefined> {
  const result = await execLocal('git rev-parse HEAD', { cwd, timeout: 10_000 });
  if (result.exitCode !== 0) return undefined;
  const sha = result.stdout.trim();
  return sha || undefined;
}

async function readGitDirty(cwd: string): Promise<boolean | undefined> {
  const result = await execLocal('git status --porcelain', { cwd, timeout: 10_000 });
  if (result.exitCode !== 0) return undefined;
  return result.stdout.trim().length > 0;
}

export async function buildTemplateProvenance(input: {
  flowType: FlowType;
  project: string;
  templatePath: string;
  templateName: string;
  templateContent: string;
  templateVariant?: string | null;
  templateIsDefault?: boolean;
  templateSelectionSource?: TemplateProvenance['templateSelectionSource'];
  templateSelectionReason?: string;
  role?: TemplateProvenance['role'];
  source?: TemplateProvenance['source'];
  projectRepoPath?: string;
  renderedAt?: string;
}): Promise<TemplateProvenance> {
  const projectRepoPath = input.projectRepoPath ?? path.dirname(path.dirname(input.templatePath));
  const [projectRepoHeadSha, projectRepoDirty, farmslotHeadSha] = await Promise.all([
    readGitHead(projectRepoPath),
    readGitDirty(projectRepoPath),
    readGitHead(farmslotRoot),
  ]);
  return {
    kind: 'task-template',
    flowType: input.flowType,
    taskProfile:
      input.flowType === 'fix-bug' || input.flowType === 'dev' ? input.flowType : undefined,
    project: input.project,
    role: input.role ?? 'worker',
    templatePath: input.templatePath,
    templateName: input.templateName,
    templateVariant: input.templateVariant ?? null,
    templateIsDefault: input.templateIsDefault,
    templateSelectionSource: input.templateSelectionSource,
    templateSelectionReason: input.templateSelectionReason,
    contentHash: sha256Text(input.templateContent),
    projectRepoPath,
    projectRepoHeadSha,
    projectRepoDirty,
    farmslotHeadSha,
    source: input.source ?? 'current-project',
    renderedAt: input.renderedAt ?? new Date().toISOString(),
  };
}

function buildInteractivePrCompleteHandoffSection(taskDir: string): string {
  return [
    '',
    '---',
    '',
    '## Interactive PR-complete handoff',
    '',
    'This run is interactive. Complete the PR-complete prep, context reload, comment triage, fixes, validation, and artifacts, but **stop before terminal completion**.',
    '',
    'This section overrides any earlier checklist item that says to write a terminal `SIGNAL.json` automatically.',
    '',
    'Before handing off to the operator:',
    '',
    `- Write or update \`${taskDir}/artifacts/report.md\` with summary, files changed, validation, comments handled, and remaining manual work.`,
    `- Write or update \`${taskDir}/artifacts/comments-report.md\` when PR comments were triaged.`,
    `- If family context was inherited, write \`${taskDir}/artifacts/family-scope.json\` before handoff.`,
    '- Set this task status to `STATUS: waiting-human` instead of `STATUS: done`.',
    '- Do **not** write a terminal `SIGNAL.json` with `complete`, `done`, `blocked`, or `failed`.',
    '',
    'The human operator will inspect the workspace, do any manual edits/review/replies, and write the terminal signal only when the PR-complete session is actually ready to close.',
  ].join('\n');
}

export async function writeTaskFile(
  run: Run,
  opts?: {
    skipCollisionCheck?: boolean;
    extraVars?: Record<string, string>;
    onProgress?: WriteTaskProgressFn;
  },
): Promise<string> {
  if (!run.slotId) throw new Error('No slot assigned — cannot write task');

  const emit = opts?.onProgress ?? (() => {});

  emit('substep', { name: 'load-config', detail: 'Loading slot + project config' });
  const slotVars = await loadSlotVars(run.slotId);
  const projectVars = await loadProjectVars(run.project);

  // Read worker template. A selected template version is render-only: it affects this
  // run's TASK.md and provenance, never the project template files themselves.
  const templateSelection = await resolveWorkerTemplateSelectionForRun(
    projectVars,
    run.flowType,
    run.mode,
    run.taskTemplate,
  );
  const templateName = templateSelection.fileName;
  const templatePath = templateSelection.templatePath;
  let template = templateSelection.content;
  const templateProvenance = await buildTemplateProvenance({
    flowType: run.flowType,
    project: run.project,
    templatePath,
    templateName,
    templateContent: template,
    templateVariant: templateSelection.variant,
    templateIsDefault: templateSelection.isDefault,
    templateSelectionSource: templateSelection.selectionSource,
    templateSelectionReason: templateSelection.selectionReason,
    role: shouldApplyArtifactOnlyTaskPolicy(run) ? 'eval-candidate' : 'worker',
  });

  // Inject mode preamble after first heading line (# Worker: Dev, # Session Context, etc.)
  const modePreamble =
    run.mode === 'autonomous'
      ? '> Fully autonomous — zero human input. Execute all phases without stopping.'
      : run.flowType === 'pr-complete' && run.mode === 'interactive'
        ? '> Interactive PR-complete — reload prior PR/run context and perform the PR-complete work, then stop before terminal SIGNAL.json so the operator can take over.'
        : isLightweightInteractiveDevRun(run)
          ? '> Interactive lightweight dev — operator may steer the session; keep CHECKLIST.md and inputs/dev-intake.json current, then wait for Farmslot operator completion.'
          : '> Human-operated — pauses at HUMAN GATE steps for approval.';
  template = template.replace(/^(#.+\n)/, `$1\n${modePreamble}\n`);

  // Build task folder — each run gets its own timestamped dir (allows comparison across runs).
  // Timestamp is MMDD-HHMMSS (seconds precision). Minute-only precision caused the E12 race
  // where two run.create calls within 60s for the same ticket generated identical dir names.
  const now = new Date();
  const pad = (n: number) => String(n).padStart(2, '0');
  const timestamp = `${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
  const tSlug = computeTicketSlug(run.ticketOrPr);
  const fDir = computeFlowDir(run.flowType);
  const variantSuffix = run.variant ? `-${computeTicketSlug(run.variant)}` : '';
  const baseFolderId = `${tSlug}${variantSuffix}-${timestamp}`;
  const tasksBaseDir = path.join(
    getOrchestratorTaskRoot(run.project, projectVars.projectJson),
    fDir,
  );

  // Collision pre-check: scan for existing dirs sharing the ticket+variant prefix.
  // Produces a readable error listing conflicting dirs. Skipped on retry (create-new
  // action after user resolves engine_collision decision).
  if (!opts?.skipCollisionCheck && existsSync(tasksBaseDir)) {
    try {
      const entries = await readdir(tasksBaseDir);
      const collisions = findTaskDirCollisions(
        entries,
        run.ticketOrPr,
        run.lane === 'comparison' ? run.variant : null,
      );
      if (collisions.length > 0) {
        throw new TaskCollisionError(collisions, tSlug);
      }
    } catch (err) {
      if (err instanceof TaskCollisionError) throw err;
      // readdir failure is non-fatal
    }
  }

  // Ensure parent exists (idempotent), then atomic leaf mkdir to close the race window
  // the pre-check leaves open. EEXIST on the leaf = race was lost; surface as collision
  // so the engine emits engine_collision instead of silently sharing a task dir.
  await mkdir(tasksBaseDir, { recursive: true });
  let taskFolderId = baseFolderId;
  let taskAbsDir = path.join(tasksBaseDir, taskFolderId);
  for (let suffix = 1; ; suffix++) {
    try {
      await mkdir(taskAbsDir, { recursive: false });
      break;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== 'EEXIST') throw err;
      if (!opts?.skipCollisionCheck) {
        throw new TaskCollisionError([taskFolderId], tSlug);
      }
      if (suffix >= 99) {
        throw new Error(`Cannot allocate task dir: 99 collisions exhausted for ${baseFolderId}`);
      }
      taskFolderId = `${baseFolderId}-${suffix + 1}`;
      taskAbsDir = path.join(tasksBaseDir, taskFolderId);
    }
  }
  const taskRelDir = `${fDir}/${taskFolderId}`;
  await mkdir(path.join(taskAbsDir, 'assets'), { recursive: true });
  await mkdir(path.join(taskAbsDir, 'artifacts'), { recursive: true });
  await mkdir(path.join(taskAbsDir, 'inputs'), { recursive: true });

  emit('substep', { name: 'inherited-context', detail: 'Resolving family-inherited context' });
  const inheritedContext = await materializeInheritedContext(run, taskAbsDir);

  // Build branch name
  const branch =
    run.branch || buildSmartBranch(run.flowType, run.ticketOrPr, undefined, undefined, run.variant);
  await writeInteractiveDevSidecars(run, taskAbsDir, branch);

  // Build template variables
  const ticket = run.ticketData ?? {
    title: run.ticketOrPr,
    description: '',
    acceptanceCriteria: [],
    affectedArea: '',
    stepsToReproduce: [],
    screenshots: [],
    labels: [],
    source: 'manual' as const,
  };

  const screenshotsMd =
    ticket.screenshots.length > 0
      ? ticket.screenshots
          .map((s) => (s.startsWith('http') ? `![screenshot](${s})` : `![screenshot](assets/${s})`))
          .join('\n')
      : '_No screenshots_';

  const description = (ticket.description ?? '').trim();

  // ─── Source-agnostic ticket identity ───
  // TICKET = primary ref as a plain string ("PROJ-2863" or "owner/repo#123" or "")
  // TICKET_URL = deep link to the source (Jira browse URL, GitHub issue URL, or "")
  // Templates MUST use these generic names — NEVER hardcode JIRA/GITHUB_ISSUE.
  // This lets a future freeform/manual flow reuse the same template shape.
  const jiraBaseUrl: string = (projectVars.projectJson as any)?.jira?.base_url ?? '';
  let ticketRef = run.ticketOrPr;
  let ticketUrl = '';
  if (ticket.jiraKey) {
    ticketRef = ticket.jiraKey;
    ticketUrl = jiraBaseUrl ? `${jiraBaseUrl.replace(/\/$/, '')}/browse/${ticket.jiraKey}` : '';
  } else if (ticket.githubIssue) {
    ticketRef = ticket.githubIssue;
    const m = ticket.githubIssue.match(/^([^#]+)#(\d+)$/);
    if (m) ticketUrl = `https://github.com/${m[1]}/issues/${m[2]}`;
  }

  const vars: Record<string, string> = {
    SLOT: run.slotId!,
    TICKET: ticketRef,
    TICKET_ID: ticketRef,
    TICKET_URL: ticketUrl,
    TITLE: ticket.title,
    TICKET_TITLE: ticket.title,
    BRANCH: branch,
    PR_NUMBER: '',
    TASK_DIR: `${resolveProjectTaskDirName(projectVars.projectJson)}/${taskRelDir}`,
    SESSION: slotVars.session,
    REPO: slotVars.remoteRepo,
    PLATFORM: slotVars.platform,
    ADB_SERIAL: slotVars.resourceVars.adb_serial ?? '',
    IOS_SIMULATOR: slotVars.resourceVars.simulator ?? '',
    WATCHER_PORT: slotVars.resourceVars.port ?? '',
    CDP_PORT: slotVars.resourceVars.cdp_port ?? '',
    RUNTIME_DIR: getProjectField(projectVars.projectJson, 'paths.runtime_dir') || '.agent',
    RECIPE_DIR:
      getProjectField(projectVars.projectJson, 'paths.recipe_dir') ||
      `${getProjectField(projectVars.projectJson, 'paths.runtime_dir') || '.agent'}/recipes`,
    DESCRIPTION: description || '_No description_',
    ACCEPTANCE_CRITERIA: ticket.acceptanceCriteria.join('\n') || '_Not specified_',
    AFFECTED_AREA: ticket.affectedArea || '_Not specified_',
    SCREENSHOTS: screenshotsMd,
    COMMENTS:
      ticket.comments && ticket.comments.length > 0
        ? ticket.comments.map((c) => `- ${c}`).join('\n')
        : '_No comments_',
  };

  // Project-level command snippets are part of the template contract. Keep them
  // in project.json so worker templates don't hardcode repo-local tool paths.
  if (projectVars.projectJson.vars) {
    for (const [key, rawValue] of Object.entries(projectVars.projectJson.vars)) {
      vars[key] = expandTemplate(String(rawValue), slotVars, projectVars);
      vars[key.toUpperCase()] = vars[key];
    }
  }

  // Build --label flags from project config
  const prLabels = (projectVars.projectJson as any)?.ci?.pr_labels as string[] | undefined;
  vars.PR_LABELS = prLabels?.length ? prLabels.map((l) => `--label "${l}"`).join(' ') : '';

  // Optional human gate suffix for PRs created by workers.
  // Templates opt in with {{PR_TITLE_SUFFIX}} so each farm can keep its own title shape
  // without breaking Conventional Commit title linters.
  vars.PR_TITLE_SUFFIX = formatPrTitleSuffix((projectVars.projectJson as any)?.ci?.pr_title_suffix);

  // Default branch for --base flag in gh pr create
  vars.DEFAULT_BRANCH = projectVars.projectJson.default_branch || 'main';

  // farmslot_dir — local = repo root, remote = agent deployment dir.
  // Kept in sync with the same logic in core/hooks.ts expandTemplate.
  // Needed by templates that invoke framework scripts (e.g. record-window.sh).
  const slotHost = slotVars.host.replace(/\.local$/, '');
  const isLocal =
    slotHost === 'localhost' || slotHost === '127.0.0.1' || slotHost === localHostname;
  const farmslotDirForSlot = isLocal ? farmslotRoot : REMOTE_FARMSLOT_DIR;
  vars.farmslot_dir = farmslotDirForSlot;
  vars.FARMSLOT_DIR = farmslotDirForSlot;

  // ─── Linked tickets (plural, pre-rendered markdown) ───
  // A PR can reference multiple tickets ("Fixes PROJ-123, PROJ-456"). Templates
  // can't loop, so we pre-render two markdown blocks:
  //   LINKED_TICKETS      — bullet list of "- [ref](url) — title"
  //   LINKED_DESCRIPTIONS — each ticket's full description, separated by ---
  // Both render as empty-state placeholder strings when there are no links.
  const linked = ticket.linkedTickets ?? [];
  vars.LINKED_TICKETS =
    linked.length > 0
      ? linked.map((t) => `- [${t.ref}](${t.url})${t.title ? ` — ${t.title}` : ''}`).join('\n')
      : '_No linked tickets_';
  vars.LINKED_DESCRIPTIONS =
    linked.length > 0
      ? linked
          .map(
            (t) =>
              `### ${t.ref}${t.title ? ` — ${t.title}` : ''}\n\n${t.description || '_No description_'}`,
          )
          .join('\n\n---\n\n')
      : '_No linked tickets_';

  // PR-specific vars (review-pr, pr-complete, merge-main).
  if (
    run.flowType === 'review-pr' ||
    run.flowType === 'pr-complete' ||
    run.flowType === 'merge-main'
  ) {
    const prMatch = run.ticketOrPr.match(/#?(\d+)$/);
    const prNumber = prMatch?.[1] ?? '';
    const repoMatch = run.ticketOrPr.match(/^([^#]+)#/);
    const repo = repoMatch?.[1] ?? '';

    vars.PR_NUMBER = prNumber;
    vars.PR_TITLE = ticket.title;
    vars.PR_BRANCH = run.branch || branch;
    vars.GH_REPO = repo;
    vars.PR_URL = repo && prNumber ? `https://github.com/${repo}/pull/${prNumber}` : '';
    vars.PR_BODY = ticket.description || '';
    vars.REVIEW_TIER = run.reviewTier || 'standard';
    vars.RECIPE_STRATEGY = opts?.extraVars?.RECIPE_STRATEGY ?? '';
  }

  // pr-complete pre-fetches GitHub comments so {{COMMENT_SUMMARY}} + {{HAS_RECIPE}}
  // resolve in TASK.md instead of leaking as literal placeholders. Worker still
  // re-fetches in step 4; this is a context preview, not an authoritative list.
  if (run.flowType === 'pr-complete') {
    const prNumParsed = parseInt(vars.PR_NUMBER, 10);
    // HAS_RECIPE is local-only (orchestrator artifacts dir) and survives a fetch
    // failure, so compute it once outside the try/catch.
    vars.HAS_RECIPE = existsSync(path.join(taskAbsDir, 'artifacts', 'recipe.json')) ? 'yes' : 'no';
    // Always set RECIPE_SOURCE so the worker template's `{{RECIPE_SOURCE}}`
    // substitution never leaks the literal placeholder. The trusted path
    // (family-inheritance produced a recipe) gets a positive label; the
    // PR-body extraction branches below overwrite when they fire. Empty
    // string when there's neither inherited recipe nor extraction attempt.
    vars.RECIPE_SOURCE = vars.HAS_RECIPE === 'yes' ? 'family-inherited' : '';
    emit('substep', {
      name: 'pr-comments',
      detail: `Fetching PR #${vars.PR_NUMBER} comments + reviews`,
    });
    try {
      const ctx = await buildPRCompleteContext(vars.GH_REPO, prNumParsed, taskAbsDir);
      vars.COMMENT_SUMMARY = ctx.commentSummary;
      if (ctx.rows.length > 0) {
        await writeFile(
          path.join(taskAbsDir, 'inputs', 'pr-comments.json'),
          JSON.stringify(ctx.rows, null, 2),
          'utf-8',
        );
      }
    } catch (err) {
      // Fetch failure is recoverable — worker re-fetches in step 4. Surface the
      // miss in the prompt so the worker doesn't act on stale context.
      console.warn(`[task-writer] pr-complete pre-fetch failed: ${(err as Error).message}`);
      vars.COMMENT_SUMMARY = `_Pre-fetch failed (${(err as Error).message}). Worker MUST fetch comments in step 4._`;
    }

    // Last-resort: extract recipe + subflows from the PR body via LLM. Only
    // runs when family inheritance produced no recipe — covers human-authored
    // PRs where farmslot has no fix-bug/dev ancestor in the family chain.
    // Skip when the worker template doesn't reference {{RECIPE_SOURCE}} —
    // without the provenance gate the staged recipe goes nowhere and the LLM
    // call is wasted (e.g. projects/farmslot-farm has no recipe runner and
    // its pr-complete.md doesn't render the placeholder).
    if (vars.HAS_RECIPE === 'no' && vars.PR_BODY && template.includes('{{RECIPE_SOURCE}}')) {
      emit('substep', {
        name: 'pr-body-recipe-llm',
        detail: 'Extracting recipe + sub-flows from PR body (LLM)',
      });
      try {
        const extraction = await extractRecipeFromPRBody(vars.PR_BODY);
        if (extraction.bundle) {
          await materializeExtractedRecipe(extraction.bundle, taskAbsDir);
          // HAS_RECIPE intentionally stays 'no' — the recipe is staged at
          // inputs/inherited/ but NOT seeded into artifacts/recipe.json.
          // RECIPE_SOURCE='pr-body-llm' tells the worker template to run
          // its provenance gate: read + validate the staged recipe, and
          // copy to artifacts/ only if the trust check passes (then the
          // worker re-evaluates HAS_RECIPE on disk before running step
          // 10's recipe path).
          vars.RECIPE_SOURCE = 'pr-body-llm';
          console.log(
            `[task-writer] pr-body recipe staged for ${run.ticketOrPr} (untrusted, gated): 1 recipe + ${Object.keys(extraction.bundle.flows).length} flows at inputs/inherited/`,
          );
        } else {
          // Surface the reason so operators can distinguish "model truncated"
          // from "no recipe in body" without grepping logs. The worker
          // template can render this verbatim under {{RECIPE_SOURCE}} when
          // HAS_RECIPE stays 'no'.
          vars.RECIPE_SOURCE = `pr-body-llm-${extraction.reason}`;
          console.log(
            `[task-writer] pr-body recipe extraction skipped for ${run.ticketOrPr}: ${extraction.reason}${extraction.stopReason ? ` (stopReason=${extraction.stopReason})` : ''}`,
          );
        }
      } catch (err) {
        vars.RECIPE_SOURCE = 'pr-body-llm-error';
        console.warn(`[task-writer] pr-body recipe extraction failed: ${(err as Error).message}`);
      }
    }
  }

  // Resolve mobile reference repo path (for cross-codebase comparison steps in templates).
  // Absence is valid for projects without a mobile reference checkout; malformed
  // path/config errors should throw from their concrete operation instead of
  // being hidden behind a blanket catch.
  vars.MOBILE_REPO = '';
  const parentDir = path.dirname(slotVars.remoteRepo);
  const refName = (projectVars.projectJson as any)?.reference_repos?.mobile?.local_name as
    | string
    | undefined;
  const candidates = refName
    ? [path.join(parentDir, refName), path.join(parentDir, refName.replace(/-ref$/, '-1'))]
    : [path.join(parentDir, 'example-mobile-1')];
  for (const c of candidates) {
    if (existsSync(c)) {
      vars.MOBILE_REPO = c;
      break;
    }
  }

  emit('substep', {
    name: 'render-template',
    detail: `Rendering ${path.basename(taskAbsDir)}/TASK.md`,
  });
  const content = await generateTaskContent(template, vars);
  const taskFilePath = path.join(taskAbsDir, 'TASK.md');
  const withInheritedContext = inheritedContext
    ? `${content.trimEnd()}\n${buildFollowUpScopeContractSection(vars.TASK_DIR, inheritedContext)}\n`
    : content;
  const withInteractivePrCompleteHandoff =
    run.flowType === 'pr-complete' && run.mode === 'interactive'
      ? `${withInheritedContext.trimEnd()}\n${buildInteractivePrCompleteHandoffSection(vars.TASK_DIR)}\n`
      : withInheritedContext;
  const finalContent = applyArtifactOnlyTaskPolicy(withInteractivePrCompleteHandoff, run);
  if (shouldApplyArtifactOnlyTaskPolicy(run)) {
    assertArtifactOnlyTaskGuard(finalContent);
  }
  await writeFile(taskFilePath, finalContent, 'utf-8');

  // Write template provenance as inputs/template-provenance.json
  await writeFile(
    path.join(taskAbsDir, TEMPLATE_PROVENANCE_INPUT),
    `${JSON.stringify(templateProvenance, null, 2)}\n`,
    'utf-8',
  );

  // Write ticket data as inputs/bug-input.json
  if (run.ticketData) {
    await writeFile(
      path.join(taskAbsDir, 'inputs', 'bug-input.json'),
      JSON.stringify(run.ticketData, null, 2),
      'utf-8',
    );
  }

  // Write ticket comments as inputs/ticket-comments.json
  if (run.ticketData?.comments && run.ticketData.comments.length > 0) {
    await writeFile(
      path.join(taskAbsDir, 'inputs', 'ticket-comments.json'),
      JSON.stringify(run.ticketData.comments, null, 2),
      'utf-8',
    );
  }

  // Download Jira image attachments to assets/
  if (run.ticketData?.jiraKey && run.ticketData.screenshots.length > 0) {
    try {
      const jiraConfig = (projectVars.projectJson as Record<string, unknown>).jira as
        | { base_url: string; email_env?: string; api_token_env?: string }
        | undefined;
      if (jiraConfig?.base_url) {
        const { downloadJiraAttachments } = await import('../external/jira.js');
        const assetsDir = path.join(taskAbsDir, 'assets');
        const downloaded = await downloadJiraAttachments(run.ticketData.jiraKey, assetsDir, {
          baseUrl: jiraConfig.base_url,
          emailEnv: jiraConfig.email_env,
          apiTokenEnv: jiraConfig.api_token_env,
        });
        console.log(`[task-writer] downloaded ${downloaded.length} image(s) to assets/`);
      }
    } catch (err) {
      console.warn(`[task-writer] image download failed: ${(err as Error).message}`);
    }
  }

  console.log(`[task-writer] wrote ${taskFilePath}`);
  return taskFilePath;
}

/**
 * Parse a rendered TASK.md template into a TaskSchema.
 * See docs/template-conventions.md for the full format spec.
 *
 * - Checkboxes (`- [ ]` / `- [x]`) are steps — the only required element
 * - Any heading (`##`, `###`, `####`) groups subsequent checkboxes into a phase
 * - `<details>` blocks are skipped (reference sections)
 * - Headings with no checkboxes below them are pruned
 * - Checkboxes before any heading go into a "Checklist" phase
 */
export function generateTaskSchema(templateContent: string, flowType: string): TaskSchema {
  const phases: TaskSchemaPhase[] = [];
  let currentPhase: TaskSchemaPhase | null = null;
  let stepIndex = 0;
  let inDetails = 0;
  let inCodeBlock = false;
  let inSkippedSection = false;

  // Sections that contain informational checkboxes (ACs, descriptions, upstream
  // PR-template fields) — not task steps. `pre-merge` covers Example App's
  // upstream "Pre-merge author/reviewer checklist" sections that arrive via
  // {{PR_BODY}} interpolation and would otherwise inflate the worker schema.
  const SKIP_SECTIONS =
    /^\**\s*(acceptance criteria|description|task|affected area|screenshots|comments|root cause|rules|recipe acs|pre-merge)/i;

  for (const line of templateContent.split('\n')) {
    const trimmed = line.trim();

    // Track fenced code blocks (``` or ```lang) — skip embedded markdown
    if (trimmed.startsWith('```')) {
      inCodeBlock = !inCodeBlock;
      continue;
    }
    if (inCodeBlock) continue;

    // Track <details> nesting — skip reference sections
    if (trimmed.startsWith('<details')) inDetails++;
    if (trimmed.startsWith('</details')) {
      inDetails = Math.max(0, inDetails - 1);
      continue;
    }
    if (inDetails > 0) continue;

    // Any markdown heading (##, ###, ####, etc.) starts a new phase group.
    // The heading level doesn't matter — whatever heading sits above checkboxes
    // becomes the phase name. Empty phases (no checkboxes) are pruned later.
    if (/^#{2,}\s+[^#]/.test(trimmed)) {
      const name = trimmed.replace(/^#{2,}\s+/, '').trim();
      if (SKIP_SECTIONS.test(name)) {
        inSkippedSection = true;
        continue;
      }
      inSkippedSection = false;
      currentPhase = { name, steps: [] };
      phases.push(currentPhase);
      continue;
    }

    if (inSkippedSection) continue;

    // - [ ] or - [x] or - [X] — step within current phase
    if (/^- \[[xX ]\]/.test(trimmed)) {
      // If no phase yet, create a default one
      if (!currentPhase) {
        currentPhase = { name: 'Checklist', steps: [] };
        phases.push(currentPhase);
      }
      stepIndex++;
      // Extract step name: strip the checkbox prefix and bold numbering like "**1. Text**"
      let stepName = trimmed.replace(/^- \[[xX ]\]\s*/, '');
      // Remove bold markdown wrapper if present: **1. Text** → 1. Text
      stepName = stepName.replace(/^\*\*(.+?)\*\*.*$/, '$1').trim();
      currentPhase.steps.push({ index: stepIndex, name: stepName });
    }
  }

  // Remove empty phases (e.g. headers with no steps)
  const nonEmpty = phases.filter((p) => p.steps.length > 0);

  // Extract title from first H1 or H2
  let title = flowType;
  const titleMatch = templateContent.match(/^##?\s+(.+)/m);
  if (titleMatch) {
    title = titleMatch[1].trim();
  }

  return {
    flowType,
    title,
    totalSteps: stepIndex,
    phases: nonEmpty,
  };
}
