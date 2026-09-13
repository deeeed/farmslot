// TASK.md, the task document beside the CHECKLIST.md execution checklist.
//
// The execution template renders verbatim into CHECKLIST.md, the only file whose
// checkboxes count as steps. TASK.md carries the task (description, acceptance
// criteria, screenshots, comments), the run facts, the mark instructions, and
// pointers to `inputs/`. One builder serves every surface: a control plane passes
// its slot facts as extra vars; a harness passes only what it knows.

import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import path from 'node:path';

import {
  EXECUTION_CHECKLIST_DOCUMENT,
  type ExecutionTemplateReference,
  type TemplateProvenance,
  type WorkerTerminalContractDocument,
} from '@farmslot/protocol';

export const HANDOFF_INPUT = 'inputs/handoff.json';
export const BUG_INPUT = 'inputs/bug-input.json';
/** Optional project-owned addendum rendered into TASK.md (relative to `templates/`). */
export const TASK_DOCUMENT_ADDENDUM_TEMPLATE = 'task-document.md';

/**
 * Ordered keys of the `## Task` block. A key renders only when the caller set
 * it, except the four every surface knows. Farmslot sets its slot facts; a
 * harness sets FLOW/MODE/TEMPLATE; neither sees blank lines for the other's.
 */
const TASK_BLOCK_KEYS: ReadonlyArray<{ key: string; required?: boolean; label?: string }> = [
  { key: 'TICKET', required: true },
  { key: 'TICKET_URL' },
  { key: 'TITLE', required: true },
  { key: 'FLOW' },
  { key: 'MODE' },
  { key: 'RUN_ID' },
  { key: 'FAMILY_ID' },
  { key: 'BRANCH' },
  { key: 'PR_NUMBER' },
  { key: 'PR_URL' },
  { key: 'PR_BRANCH' },
  { key: 'GH_REPO' },
  { key: 'PR_INTEGRATION_NOTE', label: 'PR_INTEGRATION' },
  { key: 'REVIEW_TIER' },
  { key: 'RECIPE_STRATEGY' },
  { key: 'BRANCH_UPDATE_STRATEGY' },
  { key: 'HAS_RECIPE' },
  { key: 'RECIPE_SOURCE' },
  { key: 'TASK_DIR', required: true },
  { key: 'SESSION' },
  { key: 'REPO' },
  { key: 'PLATFORM' },
  { key: 'DOMAIN' },
  { key: 'TEMPLATE' },
  { key: 'SLOT_ID' },
  { key: 'RUNTIME_DIR' },
  { key: 'WATCHER_PORT' },
  { key: 'CDP_PORT' },
  { key: 'IOS_SIMULATOR' },
  { key: 'ADB_SERIAL' },
];

/**
 * Acceptance criteria arrive as plain strings, but ticket adapters keep the
 * author's list markers. Normalize to one bullet per criterion so TASK.md never
 * carries a live `- [ ]` box that could be mistaken for a step.
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
  /** One blockquote line describing the run mode; empty string for none. */
  modePreamble: string;
  vars: Record<string, string>;
  description: string;
  acceptanceCriteria: ReadonlyArray<string>;
  affectedArea?: string;
  screenshotsMarkdown?: string;
  commentsMarkdown?: string;
  linkedTicketsMarkdown?: string;
  linkedDescriptionsMarkdown?: string;
  /** pr-complete: control-plane pre-fetched PR comment summary. */
  commentSummaryMarkdown?: string;
  /** Rendered project addendum (`templates/task-document.md`), if the project ships one. */
  addendum?: string | null;
  hasTicketData: boolean;
}

export function buildTaskDocument(input: TaskDocumentInput): string {
  const { vars } = input;
  const taskDir = vars.TASK_DIR;
  const title = vars.TITLE?.trim() || vars.TICKET || input.flowType;
  const taskBlock = TASK_BLOCK_KEYS.filter(({ key, required }) => required || vars[key]?.trim())
    .map(({ key, label }) => `${label ?? key}: ${vars[key] ?? ''}`)
    .join('\n');

  const sections: string[] = [`# ${input.flowType}: ${title}`, ''];
  if (input.modePreamble.trim()) sections.push(input.modePreamble, '');
  sections.push(
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
  );

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
    `Follow \`${taskDir}/${EXECUTION_CHECKLIST_DOCUMENT}\` top to bottom. That file is the only checklist that counts.`,
    `Marker: \`${taskDir}/mark\`, run from the repo root. \`mark start\` once when work begins, \`mark N\` after each step (visible 1-based number), then \`mark complete --mark-last\`, \`mark no-change --reason "…"\`, or \`mark blocked --reason "…"\`.`,
    'Never hand-write `SIGNAL.json`. Do not add step checkboxes to this document; update `STATUS` above and append notes (for example `## Recipe ACs`) below.',
    '',
    '## Inputs',
    '',
    `Under \`${taskDir}/inputs/\`:`,
    '',
    `- \`${path.basename(HANDOFF_INPUT)}\` — run identity, selected checklist provenance, and terminal report paths`,
    '- `worker-terminal-contract.json` — artifacts required before a terminal mark',
  );
  if (input.hasTicketData) {
    sections.push(`- \`${path.basename(BUG_INPUT)}\` — full ticket data as fetched`);
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

export type HandoffSourceKind = 'text' | 'file' | 'github-pr' | 'github-issue' | 'jira';

/** Selected checklist, as `execution-template materialize --provenance` reports it. */
export interface HandoffExecutionTemplate extends ExecutionTemplateReference {
  selectionReason: string;
}

/**
 * The one task record. `@farmslot/handoff closeout` reads the identity keys;
 * replay and eval read `executionTemplate` / `templateProvenance`; everything
 * else ignores keys it does not know.
 */
export interface HandoffMetadata {
  schemaVersion: 1;
  attemptId: string;
  surface: string;
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
  executionTemplate?: HandoffExecutionTemplate;
  /** Control-plane provenance (repo revisions, selection source); never carries the reference twice. */
  templateProvenance?: Omit<TemplateProvenance, 'executionTemplate'>;
}

export function buildHandoffMetadata(input: {
  attemptId: string;
  surface: string;
  project: string;
  flow: string;
  repo?: string;
  domain?: string;
  title: string;
  sourceKind: HandoffSourceKind;
  ticket?: string;
  sourceRef?: string;
  terminalContract: Pick<WorkerTerminalContractDocument, 'commands'>;
  startedAt?: string;
  executionTemplate?: HandoffExecutionTemplate;
  templateProvenance?: Omit<TemplateProvenance, 'executionTemplate'>;
}): HandoffMetadata {
  const complete = input.terminalContract.commands.complete;
  const ticket = input.ticket?.trim();
  const sourceRef = input.sourceRef?.trim();
  return {
    schemaVersion: 1,
    attemptId: input.attemptId,
    surface: input.surface,
    project: input.project,
    ...(input.repo ? { repo: input.repo } : {}),
    domain: input.domain ?? '',
    flow: input.flow,
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
    ...(input.executionTemplate ? { executionTemplate: input.executionTemplate } : {}),
    ...(input.templateProvenance ? { templateProvenance: input.templateProvenance } : {}),
  };
}

/**
 * `owner/name` from a repository URL or scp-style remote. Undefined when the
 * value is not portable (local path, credentialed URL, odd segments).
 */
export function portableRepoIdentity(raw: string): string | undefined {
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

/**
 * `owner/name` from a project's repository declaration (`repo_url` or `ci.repo`).
 */
export function portableProjectRepo(projectJson: {
  repo_url?: unknown;
  ci?: { repo?: unknown };
}): string | undefined {
  const candidates = [projectJson.repo_url, projectJson.ci?.repo].filter(
    (value): value is string => typeof value === 'string' && value.trim().length > 0,
  );
  for (const candidate of candidates) {
    const identity = portableRepoIdentity(candidate.trim());
    if (identity) return identity;
  }
  return undefined;
}
