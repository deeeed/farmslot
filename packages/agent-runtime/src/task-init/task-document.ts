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
  DEFAULT_BRANCH,
  EXECUTION_CHECKLIST_DOCUMENT,
  type ExecutionTemplateReference,
  type TemplateProvenance,
  type WorkerTerminalContractDocument,
} from '@farmslot/protocol';

import { REVIEW_DIFF_SCOPE_RULE } from '../../scripts/review-diff-scope.cjs';

import { normalizeMaintenanceBranch } from './branch-update.js';
import { installedRuntimeScriptCommand, installedTaskCommands } from './runtime-command.js';

export const HANDOFF_INPUT = 'inputs/handoff.json';
export const BUG_INPUT = 'inputs/bug-input.json';
/** Optional project-owned addendum rendered into TASK.md (relative to `templates/`). */
export const TASK_DOCUMENT_ADDENDUM_TEMPLATE = 'task-document.md';

/** Shared instructions for a maintenance task and an inline CI-fix checklist. */
export function buildBranchUpdateInstructions(
  publicationBase: string,
  guardCommand?: string,
  pushCommand?: string,
): string {
  return [
    '## Branch update base',
    '',
    `The publication base is \`${publicationBase}\`. Branch updates target \`origin/${publicationBase}\`; follow the update method in the selected checklist. Follow-up runs use their contribution family's base; after retargeting they use the recorded retarget branch. Keep default-branch freshness checks separate.`,
    'For a rebase, first fetch the PR head and record its exact remote SHA in `artifacts/pre-rebase-remote-sha.txt` under this task. Refuse an update if local HEAD omits remote commits. After conflict resolution and the required checks, push the rebased branch with an explicit lease against that recorded SHA. Never infer the update base from a PR body or replace it with the default branch while the upstream PR remains open.',
    ...(guardCommand
      ? [
          '',
          'Run this shared operation before any rebase or up-to-date shortcut. It performs the verified rebase; do not run an additional rebase:',
          '',
          '```bash',
          guardCommand,
          '```',
        ]
      : []),
    ...(pushCommand
      ? [
          '',
          'After conflict resolution, required checks and any fix commits, use this shared leased push:',
          '',
          '```bash',
          pushCommand,
          '```',
        ]
      : []),
  ].join('\n');
}

/** The supplying runtime executes the captured operation, never a pack-owned ancestry parser. */
export function buildBranchUpdateGuardCommand(
  vars: Record<string, string>,
  phase: 'execute' | 'push' = 'execute',
): string {
  if (
    !vars.BRANCH_UPDATE_CONTEXT &&
    normalizeMaintenanceBranch(vars.PUBLICATION_BASE || '') !==
      normalizeMaintenanceBranch(vars.DEFAULT_BRANCH || DEFAULT_BRANCH)
  )
    return "printf '%s\\n' 'PARENT_BOUNDARY_MISSING' >&2; exit 2";
  const quote = (value: string): string => "'" + value.replaceAll("'", "'\"'\"'") + "'";
  const script = vars.BRANCH_UPDATE_SCRIPT
    ? `node ${quote(vars.BRANCH_UPDATE_SCRIPT)}`
    : installedRuntimeScriptCommand('branch-update.mjs');
  const context =
    vars.BRANCH_UPDATE_CONTEXT ||
    JSON.stringify({
      kind: 'ordinary',
      repo: vars.REPO || '.',
      branch: vars.PR_BRANCH || vars.BRANCH,
      baseRef: vars.PUBLICATION_BASE,
    });
  return `${script} ${phase} ${quote(context)}`;
}

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
  { key: 'PUBLICATION_BASE' },
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
 * author's list markers. Strip them and drop empty entries, so one input entry
 * is one criterion — the position that gives it its `AC-<N>` ledger id (ADR-060)
 * and its bullet in TASK.md. Continuation lines stay with their criterion.
 */
export function normalizeAcceptanceCriteria(items: ReadonlyArray<string>): string[] {
  return items
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
        .filter(Boolean)
        .join('\n'),
    )
    .filter(Boolean);
}

/**
 * The acceptance criteria as TASK.md renders them: one bullet per criterion, so
 * the document never carries a live `- [ ]` box that could be mistaken for a step.
 */
export function renderAcceptanceCriteria(items: ReadonlyArray<string>): string {
  const normalized = normalizeAcceptanceCriteria(items).map((criterion) => {
    const [first, ...rest] = criterion.split('\n');
    // Continuation lines are indented so they never start a list item.
    return [`- ${first}`, ...rest.map((line) => `  ${line}`)].join('\n');
  });
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
  if (vars.PUBLICATION_BASE?.trim()) {
    sections.push(
      '',
      buildBranchUpdateInstructions(
        vars.PUBLICATION_BASE,
        vars.BRANCH_UPDATE_GUARD_CMD || buildBranchUpdateGuardCommand(vars),
        vars.BRANCH_UPDATE_PUSH_CMD || buildBranchUpdateGuardCommand(vars, 'push'),
      ),
    );
  }
  if (normalizeAcceptanceCriteria(input.acceptanceCriteria).length > 0) {
    const defaults = installedTaskCommands();
    const acceptance = vars.AC_CMD?.trim() || defaults.AC_CMD;
    const artifactCheck = vars.ARTIFACT_CHECK_CMD?.trim() || defaults.ARTIFACT_CHECK_CMD;
    sections.push(
      '',
      '## Recipe proof + acceptance review',
      '',
      `Prefix every task proof invocation with \`RECIPE_TASK_DIR="$(cd "${taskDir}" && pwd)"\` in the same shell call as the configured recipe command. A separate export does not survive a later shell call. Direct host invocations must use a fresh directory under \`${taskDir}/artifacts/recipe-runs/\`; fixed or diagnostic output directories do not select task proof. Independent diagnostics must omit task binding.`,
      `Inspect registered criteria with \`${acceptance} list --task-dir "${taskDir}"\`. Declare their IDs and claims in the recipe's \`proofTargets\` and bind qualifying assertion nodes through \`proves\`. Run the recipe through the configured command and inspect its retained results. Recipe execution produces normal verdicts; never set a proven verdict by hand or edit acceptance ledger rows. Retain unresolved results. When the captured completion contract permits human review, present them at the run gate and ask an authorized person for an untestable override with a reason. Without that gate, completion still refuses.`,
      `Inspect the criteria again. When recipe.json exists, render coverage with \`${acceptance} render --task-dir "${taskDir}"\` to a temporary file, then replace \`artifacts/recipe-coverage.md\` only after a successful render. Run \`${artifactCheck} "${taskDir}" --contract "${taskDir}/inputs/worker-terminal-contract.json" --terminal complete --require-recipe-coverage-if-recipe --require-acceptance-status\` before \`mark complete\`. Missing ledgers, unrecorded criterion rows and integrity failures refuse completion. Valid selected unresolved verdicts can reach the configured human gate; they do not grant approval. Checked checklist items alone do not assess an AC.`,
    );
  }

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

  sections.push('', REVIEW_DIFF_SCOPE_RULE);

  sections.push(
    '',
    '## Checklist',
    '',
    `Follow \`${taskDir}/${EXECUTION_CHECKLIST_DOCUMENT}\` top to bottom. That file is the only checklist that counts.`,
    `Marker: \`${taskDir}/mark\`, run from the repo root. \`mark start\` once when work begins, \`mark N\` after each step (visible 1-based number), then \`mark complete --mark-last\`, \`mark no-change --reason "…"\`, or \`mark blocked --reason "…"\`.`,
    'Never hand-write `SIGNAL.json`. Do not add step checkboxes to this document; append notes (for example `## Recipe ACs`) below.',
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
  task: {
    title: string;
    sourceKind: HandoffSourceKind;
    ticket?: string;
    sourceRef?: string;
    /**
     * Normalized acceptance criteria, in the order TASK.md renders them. Position
     * N (1-based) is the `AC-<N>` id of the acceptance ledger (ADR-060); task init
     * is the only id producer. Absent when the task has no criteria.
     */
    acceptanceCriteria?: string[];
  };
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
  /** Raw criteria as the caller received them; normalized here, ids are positional. */
  acceptanceCriteria?: ReadonlyArray<string>;
  terminalContract: Pick<WorkerTerminalContractDocument, 'commands'>;
  startedAt?: string;
  executionTemplate?: HandoffExecutionTemplate;
  templateProvenance?: Omit<TemplateProvenance, 'executionTemplate'>;
}): HandoffMetadata {
  const complete = input.terminalContract.commands.complete;
  const ticket = input.ticket?.trim();
  const sourceRef = input.sourceRef?.trim();
  const acceptanceCriteria = normalizeAcceptanceCriteria(input.acceptanceCriteria ?? []);
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
      ...(acceptanceCriteria.length > 0 ? { acceptanceCriteria } : {}),
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
