// task-document.ts — TASK.md as the task document beside the CHECKLIST.md
// execution checklist.
//
// The execution template is rendered verbatim into CHECKLIST.md, the only file
// whose checkboxes count as steps. TASK.md carries
// the ticket (description, acceptance criteria, screenshots, comments), the
// slot facts, the mark instructions, and pointers to `inputs/`. That is the
// same shape a standalone skill run produces, so the checklist file can be the
// same bytes on both surfaces.

import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import path from 'node:path';

import {
  type ArtifactRef,
  EXECUTION_CHECKLIST_DOCUMENT,
  type ExecutionTemplateReference,
  type Run,
  type WorkerTerminalContractDocument,
} from '@farmslot/protocol';

export const EXECUTION_TEMPLATE_INPUT = 'inputs/execution-template.json';
export const HANDOFF_INPUT = 'inputs/handoff.json';
/** Optional project-owned addendum rendered into TASK.md (relative to `templates/`). */
export const TASK_DOCUMENT_ADDENDUM_TEMPLATE = 'task-document.md';

/** Ordered keys of the `## Task` block. Empty values are omitted for optional slot resources. */
const TASK_BLOCK_KEYS: ReadonlyArray<{ key: string; optional?: boolean; label?: string }> = [
  { key: 'TICKET' },
  { key: 'TICKET_URL' },
  { key: 'TITLE' },
  { key: 'RUN_ID', optional: true },
  { key: 'FAMILY_ID', optional: true },
  { key: 'BRANCH' },
  { key: 'PR_NUMBER' },
  { key: 'PR_URL', optional: true },
  { key: 'PR_BRANCH', optional: true },
  { key: 'GH_REPO', optional: true },
  { key: 'PR_INTEGRATION_NOTE', optional: true, label: 'PR_INTEGRATION' },
  { key: 'REVIEW_TIER', optional: true },
  { key: 'RECIPE_STRATEGY', optional: true },
  { key: 'BRANCH_UPDATE_STRATEGY', optional: true },
  { key: 'HAS_RECIPE', optional: true },
  { key: 'RECIPE_SOURCE', optional: true },
  { key: 'TASK_DIR' },
  { key: 'SESSION' },
  { key: 'REPO' },
  { key: 'PLATFORM' },
  { key: 'SLOT_ID' },
  { key: 'RUNTIME_DIR' },
  { key: 'WATCHER_PORT', optional: true },
  { key: 'CDP_PORT', optional: true },
  { key: 'IOS_SIMULATOR', optional: true },
  { key: 'ADB_SERIAL', optional: true },
];

/**
 * Acceptance criteria arrive as plain strings, but Jira and GitHub adapters keep
 * the author's list markers. Normalize to one bullet per criterion so TASK.md
 * never carries a live `- [ ]` box that could be mistaken for a step.
 */
export function renderAcceptanceCriteria(items: ReadonlyArray<string>): string {
  const normalized = items
    .map((item) =>
      item
        .split('\n')
        .map((line) =>
          line
            .trim()
            .replace(/^[-*]\s+/, '')
            .replace(/^\[(?: |x|X)\]\s*/, '')
            .trim(),
        )
        .filter(Boolean),
    )
    .filter((lines) => lines.length > 0)
    // Continuation lines stay with their criterion, indented so they never start a list item.
    .map(([first, ...rest]) => [`- ${first}`, ...rest.map((line) => `  ${line}`)].join('\n'));
  return normalized.length > 0 ? normalized.join('\n') : '_Not specified_';
}

export interface TaskDocumentInput {
  flowType: string;
  modePreamble: string;
  vars: Record<string, string>;
  description: string;
  acceptanceCriteria: ReadonlyArray<string>;
  affectedArea: string;
  screenshotsMarkdown: string;
  commentsMarkdown: string;
  linkedTicketsMarkdown: string;
  linkedDescriptionsMarkdown: string;
  /** pr-complete: gateway pre-fetched PR comment summary. */
  commentSummaryMarkdown?: string;
  /** Rendered project addendum (`templates/task-document.md`), if the project ships one. */
  addendum?: string | null;
  hasTicketData: boolean;
  hasExecutionTemplateInput: boolean;
}

export function buildTaskDocument(input: TaskDocumentInput): string {
  const { vars } = input;
  const taskDir = vars.TASK_DIR;
  const title = vars.TITLE?.trim() || vars.TICKET || input.flowType;
  const taskBlock = TASK_BLOCK_KEYS.filter(({ key, optional }) => !optional || vars[key]?.trim())
    .map(({ key, label }) => `${label ?? key}: ${vars[key] ?? ''}`)
    .join('\n');

  const sections: string[] = [
    `# ${input.flowType}: ${title}`,
    '',
    input.modePreamble,
    '',
    '## Task',
    '',
    '```text',
    taskBlock,
    'STATUS: pending',
    '```',
    '',
    '## Description',
    '',
    input.description || '_No description_',
    '',
    '## Acceptance Criteria',
    '',
    renderAcceptanceCriteria(input.acceptanceCriteria),
  ];

  if (input.affectedArea && input.affectedArea !== '_Not specified_') {
    sections.push('', '## Affected Area', '', input.affectedArea);
  }
  if (input.screenshotsMarkdown && input.screenshotsMarkdown !== '_No screenshots_') {
    sections.push('', '## Screenshots', '', input.screenshotsMarkdown);
  }
  if (input.commentsMarkdown && input.commentsMarkdown !== '_No comments_') {
    sections.push('', '## Comments', '', input.commentsMarkdown);
  }
  if (input.linkedTicketsMarkdown && input.linkedTicketsMarkdown !== '_No linked tickets_') {
    sections.push('', '## Linked Tickets', '', input.linkedTicketsMarkdown);
  }
  if (
    input.linkedDescriptionsMarkdown &&
    input.linkedDescriptionsMarkdown !== '_No linked tickets_'
  ) {
    sections.push('', '## Linked Ticket Descriptions', '', input.linkedDescriptionsMarkdown);
  }
  if (input.commentSummaryMarkdown?.trim()) {
    sections.push('', '## Comment Summary', '', input.commentSummaryMarkdown.trim());
  }
  if (input.addendum?.trim()) {
    sections.push('', input.addendum.trim());
  }

  sections.push(
    '',
    '## Checklist',
    '',
    `Follow \`${taskDir}/${EXECUTION_CHECKLIST_DOCUMENT}\` top to bottom. That file is the only checklist Farmslot counts.`,
    `Marker: \`${taskDir}/mark\`, run from the repo root. \`mark start\` once when work begins, \`mark N\` after each step (visible 1-based number), then \`mark complete --mark-last\`, \`mark no-change --reason "…"\`, or \`mark blocked --reason "…"\`.`,
    'Never hand-write `SIGNAL.json`. Do not add step checkboxes to this document; update `STATUS` above and append notes (for example `## Recipe ACs`) below.',
    '',
    '## Inputs',
    '',
    `Under \`${taskDir}/inputs/\`:`,
    '',
    `- \`${path.basename(HANDOFF_INPUT)}\` — run identity, flow, and terminal report paths`,
  );
  if (input.hasExecutionTemplateInput) {
    sections.push(
      `- \`${path.basename(EXECUTION_TEMPLATE_INPUT)}\` — selected checklist id, source, and digests`,
    );
  }
  sections.push('- `worker-terminal-contract.json` — artifacts required before a terminal mark');
  if (input.hasTicketData) {
    sections.push('- `bug-input.json` — full ticket data as fetched');
  }
  sections.push('');
  return sections.join('\n');
}

export async function readTaskDocumentAddendum(
  projectTemplatesDir: string,
): Promise<{ path: string; content: string } | null> {
  const addendumPath = path.join(projectTemplatesDir, TASK_DOCUMENT_ADDENDUM_TEMPLATE);
  if (!existsSync(addendumPath)) return null;
  return { path: addendumPath, content: await readFile(addendumPath, 'utf-8') };
}

/** Mirrors the object `execution-template materialize --provenance` writes for skill runs. */
export function buildExecutionTemplateInput(
  selectionReason: string,
  executionTemplate: ExecutionTemplateReference,
): { schemaVersion: 1; selectionReason: string; executionTemplate: ExecutionTemplateReference } {
  return { schemaVersion: 1, selectionReason, executionTemplate };
}

export type HandoffSourceKind = 'text' | 'file' | 'github-pr' | 'github-issue' | 'jira';

export interface HandoffMetadata {
  schemaVersion: 1;
  attemptId: string;
  surface: 'farmslot';
  project: string;
  repo?: string;
  /** Effective run domain; empty string when none — the closeout parser requires the key. */
  domain: string;
  flow: string;
  startedAt: string;
  task: { title: string; sourceKind: HandoffSourceKind; ticket?: string; sourceRef?: string };
  taskDocument: 'TASK.md';
  report: string;
  learnings: string;
}

/**
 * Same shape the recipe-cook skill's `init-template` writes, so
 * `@farmslot/handoff closeout` accepts a farm task dir unchanged.
 */
export function buildHandoffMetadata(input: {
  run: Pick<Run, 'id' | 'project' | 'flowType'>;
  repo?: string;
  domain?: string;
  title: string;
  sourceKind: HandoffSourceKind;
  ticket?: string;
  sourceRef?: string;
  terminalContract: Pick<WorkerTerminalContractDocument, 'commands'>;
  startedAt?: string;
}): HandoffMetadata {
  const complete = input.terminalContract.commands.complete;
  const ticket = input.ticket?.trim();
  const sourceRef = input.sourceRef?.trim();
  return {
    schemaVersion: 1,
    attemptId: input.run.id,
    surface: 'farmslot',
    project: input.run.project,
    ...(input.repo ? { repo: input.repo } : {}),
    domain: input.domain ?? '',
    flow: input.run.flowType,
    startedAt: input.startedAt ?? new Date().toISOString(),
    task: {
      title: input.title,
      sourceKind: input.sourceKind,
      ...(ticket ? { ticket } : {}),
      ...(sourceRef ? { sourceRef } : {}),
    },
    taskDocument: 'TASK.md',
    report: complete?.report ?? 'artifacts/report.md',
    learnings: 'artifacts/learnings.md',
  };
}

/**
 * `owner/name` from a project's repository declaration (`repo_url` or `ci.repo`).
 * Returns undefined when the project declares neither or the value is not portable.
 */
export function portableProjectRepo(projectJson: {
  repo_url?: unknown;
  ci?: { repo?: unknown };
}): string | undefined {
  const candidates = [projectJson.repo_url, projectJson.ci?.repo].filter(
    (value): value is string => typeof value === 'string' && value.trim().length > 0,
  );
  for (const candidate of candidates) {
    const identity = repoIdentity(candidate.trim());
    if (identity) return identity;
  }
  return undefined;
}

function repoIdentity(raw: string): string | undefined {
  let pathname: string;
  try {
    const url = new URL(raw);
    if (!['http:', 'https:', 'ssh:', 'git:'].includes(url.protocol)) return undefined;
    pathname = url.pathname;
  } catch {
    const scp = raw.match(/^(?:[^@/\s]+@)?[^:/\s]+:(.+)$/u);
    if (scp) pathname = scp[1];
    else if (/^[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)+$/u.test(raw)) pathname = raw;
    else return undefined;
  }
  const identity = pathname.replace(/^\/+|\/+$/gu, '').replace(/\.git$/iu, '');
  const segments = identity.split('/');
  const portable =
    segments.length > 0 &&
    segments.every(
      (segment) =>
        segment !== '.' && segment !== '..' && /^[A-Za-z0-9][A-Za-z0-9._-]*$/u.test(segment),
    );
  return portable ? identity : undefined;
}

/** Task-dir artifacts the split layout adds, for run step outputs. */
export function taskDocumentArtifacts(
  taskAbsDir: string,
  options: { includeChecklist: boolean },
): ArtifactRef[] {
  const artifacts: ArtifactRef[] = [];
  if (options.includeChecklist && existsSync(path.join(taskAbsDir, EXECUTION_CHECKLIST_DOCUMENT))) {
    artifacts.push({ path: EXECUTION_CHECKLIST_DOCUMENT, purpose: 'execution-checklist' });
  }
  if (existsSync(path.join(taskAbsDir, EXECUTION_TEMPLATE_INPUT))) {
    artifacts.push({ path: EXECUTION_TEMPLATE_INPUT, purpose: 'execution-template' });
  }
  if (existsSync(path.join(taskAbsDir, HANDOFF_INPUT))) {
    artifacts.push({ path: HANDOFF_INPUT, purpose: 'handoff-metadata' });
  }
  return artifacts;
}
