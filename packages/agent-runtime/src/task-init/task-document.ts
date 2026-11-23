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
  enumerateChecklistCheckboxes,
  EXECUTION_CHECKLIST_DOCUMENT,
  type ExecutionTemplateReference,
  type FrozenReviewRulePack,
  normalizeAcceptanceCriteria,
  type RequiredSkillSet,
  type TemplateProvenance,
  type WorkerTerminalContractDocument,
} from '@farmslot/protocol';

import { GIT_PUSH_TIMEOUT_SETTING, gitPushTimeoutMs } from '../../scripts/farm-git.cjs';
import { REVIEW_DIFF_SCOPE_RULE } from '../../scripts/review-diff-scope.cjs';

import { normalizeMaintenanceBranch } from './branch-update.js';
import { installedRuntimeScriptCommand, installedTaskCommands } from './runtime-command.js';

export const HANDOFF_INPUT = 'inputs/handoff.json';
export const BUG_INPUT = 'inputs/bug-input.json';
/** Resolved read-only reference checkouts, for a worker or a check that reads them by path. */
export const REFERENCE_CHECKOUTS_INPUT = 'inputs/reference-checkouts.json';
/** Optional project-owned addendum rendered into TASK.md (relative to `templates/`). */
export const TASK_DOCUMENT_ADDENDUM_TEMPLATE = 'task-document.md';
/** The task document itself. Declared here, where it is rendered; `write.ts` re-exports it. */
export const TASK_DOCUMENT = 'TASK.md';

export const OPERATOR_NOTE_HEADING = '## Operator note';

/**
 * The agent-runtime release whose task init renders `operatorNote`.
 *
 * An older node ignores the field and silently drops the note, which is worse
 * than the bug this fixes, so the gateway checks a node's reported runtime
 * against this and falls back to the old end-of-document append below it.
 */
export const OPERATOR_NOTE_RUNTIME_VERSION = '0.51.0';

/**
 * The operator's note, as a section the worker reads before the task it changes.
 *
 * It used to be appended to the end of the document. In run 1b7b8662 that put a
 * repin instruction on line 945 of a 947-line TASK.md, and the worker — following
 * CHECKLIST.md, which never mentioned it — did everything else and not that. A
 * note is an override, so it is read before what it overrides.
 *
 * The heading has to stay clear of CHECKLIST_SKIP_SECTIONS (`task`, `description`,
 * `comments`, …) or the step below would stop counting as a step.
 */
export function operatorNoteSection(note: string | undefined): string {
  const text = note?.trim();
  if (!text) return '';
  return [
    OPERATOR_NOTE_HEADING,
    '',
    'From the operator who dispatched this run. It overrides the defaults below; where it',
    'conflicts with a checklist step, follow the note and record that in the step.',
    '',
    text,
  ].join('\n');
}

/**
 * Put a section under the document's title.
 *
 * A rendered template may open with a frontmatter fence (`dev-interactive.md`
 * does), so matching `^#` against the first line silently inserts nothing and
 * loses the section. Skip the fence, insert after the first ATX heading, and
 * fall back to prepending when the document has no heading at all.
 */
export function insertUnderTitle(markdown: string, section: string): string {
  if (!section.trim()) return markdown;
  const lines = markdown.split('\n');
  let index = 0;
  if (lines[0]?.trim() === '---') {
    const close = lines.findIndex((line, at) => at > 0 && line.trim() === '---');
    if (close > 0) index = close + 1;
  }
  const heading = lines.findIndex((line, at) => at >= index && /^#\s+\S/.test(line));
  const at = heading === -1 ? index : heading + 1;
  lines.splice(at, 0, '', section);
  return lines.join('\n');
}

/** `- [ ] **12. Label**` and `- [ ] 12. Label` both carry the number the worker reads. */
const CHECKBOX_NUMBER = /^(\s*- \[[ xX]\]\s*(?:\*\*)?)(\d+)\./;

/**
 * One markable step for the note, inserted just before the checklist's last step.
 *
 * Not appended: every farm template ends with its `mark complete --mark-last`
 * row (`pr-complete.md:62`, `fix-bug.md:98`, `review-pr.md:91`, `dev.md:137`,
 * `update-branch.md:41`). A step after that row leaves two boxes open, so
 * `--mark-last` refuses (`mark-checklist-step.cjs:391-403`); and once the worker
 * ticks the completion row to get past that, `--mark-last` ticks the last open
 * box, which is this one (`:639-641`). The note would be claimed without being
 * carried out — the failure this step exists to prevent.
 *
 * Inserting is safe for the frozen contract: `freezeChecklistDeclarations` runs
 * on the final checklist text inside `writeTaskDir`, after this rewrite, so proof,
 * deterministic and optional declarations are keyed off the numbers that ship.
 * The labels of the steps that move are renumbered with them, so what the worker
 * reads matches what `mark N` targets.
 */
export function insertOperatorNoteStep(
  checklist: string,
  taskDir: string,
  note: string | undefined,
): string {
  if (!note?.trim()) return checklist;
  const items = enumerateChecklistCheckboxes(checklist);
  const lines = checklist.split('\n');
  // No steps at all: there is no completion row to sit in front of.
  const at = items.length ? items[items.length - 1].lineIndex : lines.length;
  const stepNumber = items.length || 1;
  lines.splice(
    at,
    0,
    `- [ ] ${stepNumber}. Carry out the operator note`,
    `  Read \`${OPERATOR_NOTE_HEADING}\` at the top of \`${taskDir}/${TASK_DOCUMENT}\` and do what it says.`,
    '  It overrides the steps above. If you cannot, stop with `mark blocked` naming the conflict;',
    '  never mark this step for a note you did not carry out.',
  );
  for (let line = at + 4; line < lines.length; line += 1)
    lines[line] = lines[line].replace(
      CHECKBOX_NUMBER,
      (_match, prefix: string, number: string) => `${prefix}${Number(number) + 1}.`,
    );
  return lines.join('\n');
}

/** Shared instructions for a maintenance task and an inline CI-fix checklist. */
/**
 * The marker instruction every TASK.md carries. One worker (run 9382c8f2) read
 * `mark start` once when work begins as covering step 1 and explored for 230
 * tool calls without marking anything, so the line now names when the first
 * mark is due instead of leaving it to be inferred from "after each step".
 *
 * The trigger is step 1 being done rather than any claim about what step 1 is:
 * the templates keep that row short, but a checklist whose first row is a read
 * would make "before reading anything" self-contradictory.
 *
 * The gateway writes the same line for a hosted task; this is the only copy.
 */
export function checklistMarkerInstruction(taskDir: string): string {
  return (
    `Marker: \`${taskDir}/mark\`, run from the repo root. ` +
    '`mark start`, then `mark 1` as soon as step 1 is done, before any other work; then ' +
    '`mark N` after each step (visible 1-based number), then `mark complete --mark-last`, ' +
    '`mark no-change --reason "…"`, or `mark blocked --reason "…"`.'
  );
}

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
  const scope = phase === 'push' && vars.CI_FIX_SCOPE ? ` ${quote(vars.CI_FIX_SCOPE)}` : '';
  const budget =
    phase === 'push' && vars[GIT_PUSH_TIMEOUT_SETTING] !== undefined
      ? `${GIT_PUSH_TIMEOUT_SETTING}=${quote(String(gitPushTimeoutMs(vars[GIT_PUSH_TIMEOUT_SETTING])))} `
      : '';
  return `${budget}${script} ${phase} ${quote(context)}${scope}`;
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

export { normalizeAcceptanceCriteria } from '@farmslot/protocol';

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
  /** Static review supplies its enforced completion command instead of development guidance. */
  completionInstructions?: string;
  hasTicketData: boolean;
  /** Operator note from dispatch (`--task-note`), rendered ahead of the task it overrides. */
  operatorNote?: string;
  /**
   * Read-only checkouts of other codebases this task compares against, one per
   * `reference_repos` key the project declares. An absent one is listed as absent:
   * a comparison the worker cannot read is blocked, not unchecked.
   */
  referenceCheckouts?: ReadonlyArray<ReferenceCheckout>;
}

/** One `reference_repos` entry, resolved on the machine the task runs on. */
export interface ReferenceCheckout {
  /** The `reference_repos` key: `mobile`, `extension`, `core`. */
  name: string;
  path: string;
  present: boolean;
  /** The revision the worker cites. Absent when the checkout is not there to read. */
  headSha?: string;
  /** Uncommitted changes: the revision below does not describe what is on disk. */
  dirty?: boolean;
}

/**
 * The `## Inputs` lines for read-only reference checkouts, shared by both task
 * documents so a worker reads the same rule on either surface. Empty when the
 * project declares none. An absent checkout is named as absent: a comparison the
 * worker cannot read is blocked, and silence would read as unchecked.
 */
export function renderReferenceCheckoutInputs(
  references: ReadonlyArray<ReferenceCheckout> | undefined,
): string[] {
  if (!references?.length) return [];
  return [
    `- \`${path.basename(REFERENCE_CHECKOUTS_INPUT)}\` — the checkouts below, with the revision to cite`,
    '',
    '### Reference checkouts (read-only)',
    '',
    'Other codebases this task is compared against. Read them; never write, build or install in them, and never run their tooling: they are shared, and another run may be reading the same tree.',
    '',
    ...references.map((reference) =>
      reference.present
        ? `- \`${reference.name}\`: \`${reference.path}\`${reference.headSha ? ` at \`${reference.headSha}\`` : ''}${
            reference.dirty
              ? ' — uncommitted changes are present, so cite what you read, not that revision alone'
              : ''
          }`
        : `- \`${reference.name}\`: not readable from this task — not cloned on this machine, no commit in it, or not bound to it. Record a comparison that needs it as BLOCKED, never NOT_CHECKED, and say so in the report.`,
    ),
  ];
}

/** Shared by split task documents and the gateway's lightweight raw templates. */
export function buildOperatorWaitInstructions(taskDir: string): string {
  return [
    '## Waiting for an operator',
    '',
    `When an approach or decision needs operator input, run \`${taskDir}/mark wait --who "<operator>" --reason "<pending decision>"\` from the repository root, then wait for the reply. Keep unchecked rows unchanged.`,
    `Run \`${taskDir}/mark resume\` when the reply arrives, then continue the existing checklist. Resuming grants no approval or completion.`,
  ].join('\n');
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
  if (vars.MODE === 'interactive') {
    sections.push(buildOperatorWaitInstructions(taskDir), '');
  }
  const operatorNote = operatorNoteSection(input.operatorNote);
  if (operatorNote) sections.push(operatorNote, '');
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
  const shapeFeedbackEnabled =
    vars.FARM_RECIPE_SHAPE_FEEDBACK === '1' && ['dev', 'fix-bug', 'qa'].includes(input.flowType);
  if (normalizeAcceptanceCriteria(input.acceptanceCriteria).length > 0) {
    const defaults = installedTaskCommands();
    const acceptance = vars.AC_CMD?.trim() || defaults.AC_CMD;
    const artifactCheck = vars.ARTIFACT_CHECK_CMD?.trim() || defaults.ARTIFACT_CHECK_CMD;
    sections.push(
      '',
      '## Recipe proof + acceptance review',
      '',
      'The rules the checklist steps for proof and acceptance follow, in the order those steps reach them.',
      `Prefix every task proof invocation with \`RECIPE_TASK_DIR="$(cd "${taskDir}" && pwd)"\` in the same shell call as the configured recipe command. A separate export does not survive a later shell call. Direct host invocations must use a fresh directory under \`${taskDir}/artifacts/recipe-runs/\`; fixed or diagnostic output directories do not select task proof. Independent diagnostics must omit task binding.`,
      `Inspect registered criteria with \`${acceptance} list --task-dir "${taskDir}"\`. Declare their IDs and claims in the recipe's \`proofTargets\` and bind qualifying assertion nodes through \`proves\`. Run the recipe through the configured command and inspect its retained results. Recipe execution produces normal verdicts; never set a proven verdict by hand or edit acceptance ledger rows. Retain unresolved results. When the captured completion contract permits human review, mark complete with them: the run gate presents them to an authorized person, who may record an untestable override with a reason. Without that gate, completion still refuses.`,
      'A criterion about the change itself (diff size, revertability, commits, branch, or PR title or labels) gets proof mode `review` and no `proves` node: the code review checks it, and only a new commit clears a review finding. Anything observable in the running product keeps `state`, `visual` or `mixed`.',
      ...(shapeFeedbackEnabled
        ? [
            `After the task recipe passes, run \`${vars.RECIPE_QUALITY_FEEDBACK_CMD || defaults.RECIPE_QUALITY_FEEDBACK_CMD} --task "${taskDir}"\`. Read the advisory shape/AC feedback before completion: short ≥0.6, composed ≥0.8, parameterized ≥0.7 and registered worker ACs covered. Improve and rerun proof, or record which target cannot be reached and why. Review-only claims stay separate; never add invalid proves nodes or edit quality scores by hand.`,
          ]
        : []),
      `Inspect the criteria again. When recipe.json exists, render coverage with \`${acceptance} render --task-dir "${taskDir}"\` to a temporary file, then replace \`artifacts/recipe-coverage.md\` only after a successful render. Run \`${artifactCheck} "${taskDir}" --contract "${taskDir}/inputs/worker-terminal-contract.json" --terminal complete --require-recipe-coverage-if-recipe --require-acceptance-status\` before \`mark complete\`. Missing ledgers, unrecorded criterion rows and integrity failures refuse completion. An AC awaiting review after recorded proof, and a review-mode AC, may reach the gate and still do not grant approval; a missing AC is incomplete, so run it, and only the authorized person records UNTESTABLE at the gate. Checked checklist items alone do not assess an AC.`,
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
    ...(input.completionInstructions
      ? [input.completionInstructions]
      : [
          checklistMarkerInstruction(taskDir),
          'Never hand-write `SIGNAL.json`. Do not add step checkboxes to this document; append notes (for example `## Recipe ACs`) below.',
        ]),
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
  sections.push(...renderReferenceCheckoutInputs(input.referenceCheckouts));
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
  /** ADR-049 Amendment 3: the one required skill set, frozen at task init; dev and review read it. */
  requiredSkills?: RequiredSkillSet;
  /** A static review's rule pack from the project installation, frozen with its digest. */
  reviewRulePack?: FrozenReviewRulePack;
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
