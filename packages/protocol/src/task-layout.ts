import { WORKER_TERMINAL_CONTRACT_INPUT } from './contracts/worker-terminal.js';
import {
  CHECKLIST_TARGET_MANIFEST,
  CI_FIX_CHECKLIST,
  INTERACTIVE_CHECKLIST_MARKDOWN,
  REVIEW_CHECKLIST,
  REVIEW_FIX_CHECKLIST,
  signalFileForChecklist,
  SUBTASK_INDEX_FILE,
  SUBTASKS_DIR,
  TASK_PROGRESS_MARKDOWN,
  WORKER_SIGNAL_FILE,
} from './checklist-target.js';

/** Task-relative paths and their existing file-format authorities. */
export const TASK_DIRECTORY_LAYOUT_VERSION = 1;
export interface TaskFileSchemaReference {
  readonly format: 'markdown' | 'json' | 'executable' | 'artifact' | 'collection';
  readonly reference: string;
}

export const TASK_FILE_SCHEMAS = {
  task: { format: 'markdown', reference: 'docs/reference/task-directory-contract.md' },
  checklist: {
    format: 'markdown',
    reference: '@farmslot/protocol/checklist-target#enumerateChecklistCheckboxes',
  },
  marker: { format: 'executable', reference: 'docs/reference/task-directory-contract.md' },
  signal: { format: 'json', reference: '@farmslot/protocol#WorkerSignal' },
  target: { format: 'json', reference: '@farmslot/protocol/checklist-target#ChecklistTarget' },
  handoff: { format: 'json', reference: '@farmslot/agent-runtime/task-init#HandoffMetadata' },
  terminal: { format: 'json', reference: '@farmslot/protocol#WorkerTerminalContractDocument' },
  provenance: {
    format: 'json',
    reference: '@farmslot/agent-runtime/task-init#TaskExecutionProvenance',
  },
  taskInput: { format: 'json', reference: 'docs/reference/task-directory-contract.md' },
  subtaskIndex: { format: 'json', reference: '@farmslot/protocol/checklist-target#SubtaskIndex' },
  recipe: { format: 'json', reference: 'https://farmslot.io/schemas/recipe-v1.schema.json' },
  actionManifest: {
    format: 'json',
    reference: 'https://farmslot.io/schemas/action-manifest-v1.schema.json',
  },
  recipePackage: {
    format: 'collection',
    reference: '@farmslot/protocol#validateRecipeArtifactPackage',
  },
  acceptance: { format: 'json', reference: '@farmslot/protocol#RecipeClaimLedger' },
  operation: { format: 'json', reference: '@farmslot/protocol#TaskOperation' },
  artifact: { format: 'artifact', reference: '@farmslot/protocol#ArtifactRef' },
  collection: { format: 'collection', reference: 'docs/reference/task-directory-contract.md' },
} as const satisfies Record<string, TaskFileSchemaReference>;

export interface TaskDirectoryEntry<Path extends string = string> {
  readonly relativePath: Path;
  readonly kind: 'file' | 'directory' | 'pattern';
  readonly schema: keyof typeof TASK_FILE_SCHEMAS;
  readonly purpose: string;
}

function entry<const Path extends string>(
  relativePath: Path,
  schema: keyof typeof TASK_FILE_SCHEMAS,
  kind: TaskDirectoryEntry['kind'],
  purpose: string,
): TaskDirectoryEntry<Path> {
  return Object.freeze({ relativePath, kind, schema, purpose });
}

/** There is one active task-action root; inherited copies are context, not fallback roots. */
export const TASK_DIRECTORY_LAYOUT = Object.freeze({
  // Documented task-local files. Purposes describe existing producers, not new workflow steps.
  harnessShim: entry(
    'mm-harness',
    'marker',
    'file',
    'Task-retained harness command; preserves the selected executable on resume.',
  ),
  approvedPlan: entry(
    'inputs/plan.md',
    'task',
    'file',
    'Engineer-supplied approved plan, retained with its supplied hash.',
  ),
  qaInput: entry(
    'inputs/qa.json',
    'taskInput',
    'file',
    'Admitted QA preset and effective task inputs.',
  ),
  qaCases: entry(
    'inputs/qa-cases.md',
    'task',
    'file',
    'Authored QA cases attached to the frozen QA scope.',
  ),
  qaScopeRequest: entry(
    'inputs/qa-scope-request.json',
    'taskInput',
    'file',
    'Requested source revisions and change scope before QA admission.',
  ),
  historicalTemplateProvenance: entry(
    'inputs/template-provenance.json',
    'taskInput',
    'file',
    'Historical template provenance, now folded into handoff.json; retained history only.',
  ),
  advisorPlan: entry(
    'artifacts/advisor-plan.json',
    'taskInput',
    'file',
    'Recorded recipe-quality advisor plan; does not establish proof.',
  ),
  advisorPolicy: entry(
    'artifacts/advisor-policy.json',
    'taskInput',
    'file',
    'Effective advisor policy and availability for this task.',
  ),
  advisorTask: entry(
    'artifacts/advisor-task.json',
    'taskInput',
    'file',
    'Task and acceptance criteria supplied to the recipe-quality advisor.',
  ),
  approach: entry(
    'artifacts/approach.md',
    'task',
    'file',
    'Authored implementation approach and affected files.',
  ),
  lineComments: entry(
    'artifacts/line-comments.json',
    'taskInput',
    'file',
    'Prepared file and line review comments; not automatically posted.',
  ),
  noChangeReport: entry(
    'artifacts/no-change-report.md',
    'task',
    'file',
    'Outcome and proof limitations when no product change is made.',
  ),
  orderingViolation: entry(
    'artifacts/ordering-violation.md',
    'task',
    'file',
    'Recorded departure from the required baseline and implementation order.',
  ),
  prBody: entry(
    'artifacts/pr-body.md',
    'task',
    'file',
    'Worker-authored PR body consumed by publication rendering.',
  ),
  prVerdicts: entry(
    'artifacts/pr-verdicts.json',
    'taskInput',
    'file',
    'Per-PR verdicts supplied to the QA report renderer.',
  ),
  qaProof: entry(
    'artifacts/qa-proof.json',
    'taskInput',
    'file',
    'Portable finalized QA proof references.',
  ),
  qaScope: entry(
    'artifacts/qa-scope.json',
    'taskInput',
    'file',
    'Frozen admitted QA change scope and source revisions.',
  ),
  recipeBaselineRun: entry(
    'artifacts/recipe-baseline-run',
    'recipePackage',
    'directory',
    'Explicit diagnostic baseline attempt; not the default attempt directory.',
  ),
  recipeBaselineRun2: entry(
    'artifacts/recipe-baseline-run-2',
    'recipePackage',
    'directory',
    'Explicit second baseline attempt after an invalid setup; requires fresh validation.',
  ),
  recipeBaseline: entry(
    'artifacts/recipe-baseline.json',
    'taskInput',
    'file',
    'Baseline execution record for the recipe decision.',
  ),
  recipeDecision: entry(
    'artifacts/recipe-decision.json',
    'taskInput',
    'file',
    'Recorded decision to author, reuse or omit a recipe, with limitations.',
  ),
  recipeLibraryRecipes: entry(
    'artifacts/recipe-library/recipes',
    'collection',
    'directory',
    'Recipe documents within the task recipe library.',
  ),
  recipePlan: entry(
    'artifacts/recipe-plan.json',
    'taskInput',
    'file',
    'Retained harness run --plan output before recipe execution.',
  ),
  recipeQualityInput: entry(
    'artifacts/recipe-quality-input.json',
    'taskInput',
    'file',
    'Authored input to the recipe-quality artifact builder.',
  ),
  htmlReport: entry(
    'artifacts/report.html',
    'artifact',
    'file',
    'Human-readable QA report rendered from structured report data.',
  ),
  reportData: entry(
    'artifacts/report-data.json',
    'taskInput',
    'file',
    'Structured input to the QA HTML report renderer.',
  ),
  retrospective: entry(
    'artifacts/retrospective.md',
    'task',
    'file',
    'Task QA lessons and follow-up observations.',
  ),
  reviewReply: entry(
    'artifacts/review-reply.md',
    'task',
    'file',
    'Prepared review reply in the selected review format; not automatically posted.',
  ),
  review: entry(
    'artifacts/review.md',
    'task',
    'file',
    'Recorded implementation and proof review with reference revisions.',
  ),
  runtimeArtifact: entry(
    'artifacts/runtime-artifact.json',
    'taskInput',
    'file',
    'Pinned runtime build identity used by domain QA.',
  ),
  subtaskMirror: entry(
    'subtasks/{name}.worker',
    'artifact',
    'pattern',
    'Gateway-owned mirror of a child task file; never sent back as worker input.',
  ),
  task: entry(
    TASK_PROGRESS_MARKDOWN,
    'task',
    'file',
    'Task request, acceptance criteria and evidence pointers.',
  ),
  checklist: entry(
    INTERACTIVE_CHECKLIST_MARKDOWN,
    'checklist',
    'file',
    'Selected execution steps and their recorded progress.',
  ),
  marker: entry(
    'mark',
    'marker',
    'file',
    'Task-local command shim for the retained checklist marker.',
  ),
  signal: entry(
    WORKER_SIGNAL_FILE,
    'signal',
    'file',
    'Worker execution status written by the marker.',
  ),
  checklistTarget: entry(
    CHECKLIST_TARGET_MANIFEST,
    'target',
    'file',
    'Selected checklist and signal pairing after a role switch.',
  ),
  reviewChecklist: entry(
    REVIEW_CHECKLIST,
    'checklist',
    'file',
    'Self-review checklist selected by the control plane.',
  ),
  reviewSignal: entry(
    signalFileForChecklist(REVIEW_CHECKLIST),
    'signal',
    'file',
    'Execution signal for the review checklist.',
  ),
  reviewFixChecklist: entry(
    REVIEW_FIX_CHECKLIST,
    'checklist',
    'file',
    'Checklist for addressing review findings.',
  ),
  reviewFixSignal: entry(
    signalFileForChecklist(REVIEW_FIX_CHECKLIST),
    'signal',
    'file',
    'Execution signal for review fixes.',
  ),
  ciFixChecklist: entry(
    CI_FIX_CHECKLIST,
    'checklist',
    'file',
    'Checklist for addressing CI failures.',
  ),
  ciFixSignal: entry(
    signalFileForChecklist(CI_FIX_CHECKLIST),
    'signal',
    'file',
    'Execution signal for CI fixes.',
  ),
  inputs: entry('inputs', 'collection', 'directory', 'Frozen task inputs and inherited context.'),
  handoff: entry(
    'inputs/handoff.json',
    'handoff',
    'file',
    'Task identity, selected tooling and report paths.',
  ),
  bugInput: entry(
    'inputs/bug-input.json',
    'taskInput',
    'file',
    'Fetched ticket details and comments.',
  ),
  terminalContract: entry(
    WORKER_TERMINAL_CONTRACT_INPUT,
    'terminal',
    'file',
    'Artifacts and deterministic checks required before a terminal mark.',
  ),
  roleTerminalContract: entry(
    'inputs/worker-terminal-contract.{role}.json',
    'terminal',
    'pattern',
    'Frozen terminal obligations for the selected role.',
  ),
  recipeBinding: entry(
    'inputs/recipe-binding.json',
    'taskInput',
    'file',
    'Retained checkout, provider and recipe-library binding.',
  ),
  inheritedContext: entry(
    'inputs/inherited-context.json',
    'taskInput',
    'file',
    'Materialized family context and canonical-input gaps.',
  ),
  inheritedAcceptance: entry(
    'inputs/inherited-acceptance.json',
    'taskInput',
    'file',
    'Provisional acceptance inherited from qualified parent evidence.',
  ),
  inherited: entry(
    'inputs/inherited',
    'collection',
    'directory',
    'Read-only family context copied into the child task.',
  ),
  inheritedTaskActions: entry(
    'inputs/inherited/task-actions',
    'collection',
    'directory',
    'Qualified parent task actions copied as child context.',
  ),
  inheritedEvidenceManifest: entry(
    'inputs/inherited/evidence-manifest.json',
    'taskInput',
    'file',
    'Qualified parent visual evidence selection.',
  ),
  assets: entry('assets', 'artifact', 'directory', 'Ticket attachments retained with the task.'),
  artifacts: entry(
    'artifacts',
    'collection',
    'directory',
    'Task outputs, recorded evidence and control-plane records.',
  ),
  recipe: entry(
    'artifacts/recipe.json',
    'recipe',
    'file',
    'Authored recipe document for validation.',
  ),
  recipeLibrary: entry(
    'artifacts/recipe-library',
    'collection',
    'directory',
    'Task-local recipe documents and their executable closure.',
  ),
  recipeRuns: entry(
    'artifacts/recipe-runs',
    'recipePackage',
    'directory',
    'Default directory of immutable recipe execution attempts.',
  ),
  recipeAttempt: entry(
    'artifacts/recipe-runs/{attempt}',
    'recipePackage',
    'pattern',
    'One immutable recipe execution package identified by attempt.',
  ),
  recipeCalls: entry(
    'artifacts/calls/{attempt}',
    'recipePackage',
    'pattern',
    'One recorded harness call package identified by attempt.',
  ),
  selectedRecipeRun: entry(
    'artifacts/latest-valid-recipe-run.json',
    'taskInput',
    'file',
    'Pointer to the selected passing recipe attempt.',
  ),
  acceptance: entry(
    'artifacts/acceptance-status.json',
    'acceptance',
    'file',
    'Recorded acceptance-criteria claim ledger.',
  ),
  taskActions: entry(
    'artifacts/task-actions',
    'collection',
    'directory',
    'Canonical task-local action library retained with its proof.',
  ),
  taskActionManifests: entry(
    'artifacts/task-actions/manifests',
    'collection',
    'directory',
    'Action manifest declarations in the canonical task library.',
  ),
  taskActionManifest: entry(
    'artifacts/task-actions/manifests/{manifest}.json',
    'actionManifest',
    'pattern',
    'One action-manifest-v1 declaration.',
  ),
  taskActionImplementations: entry(
    'artifacts/task-actions/actions',
    'collection',
    'directory',
    'Contained action implementations and helpers.',
  ),
  taskActionImplementation: entry(
    'artifacts/task-actions/actions/{path}',
    'artifact',
    'pattern',
    'An implementation or helper inside the canonical action library.',
  ),
  harnessProvenance: entry(
    'artifacts/harness-provenance.json',
    'provenance',
    'file',
    'Locked harness executable and source provenance.',
  ),
  sandbox: entry(
    'artifacts/sandbox.json',
    'taskInput',
    'file',
    'Preparation and readiness result for the target checkout.',
  ),
  recipeOwnership: entry(
    'artifacts/recipe-ownership/{recipeRunId}.json',
    'taskInput',
    'pattern',
    'Recipe attempt ownership and author identity.',
  ),
  deterministicChecks: entry(
    'artifacts/deterministic-checks/{checklist}/{step}.json',
    'taskInput',
    'pattern',
    'Immutable deterministic command completion receipt.',
  ),
  operationRecords: entry(
    'artifacts/operations',
    'collection',
    'directory',
    'Recorded task operations and their logs.',
  ),
  operations: entry(
    'artifacts/operations/{operation}.json',
    'operation',
    'pattern',
    'Structured task operation record.',
  ),
  operationLog: entry(
    'artifacts/operations/{operation}.log',
    'artifact',
    'pattern',
    'Recorded output of a task operation.',
  ),
  report: entry('artifacts/report.md', 'task', 'file', 'Worker outcome or review report.'),
  prDescription: entry(
    'artifacts/pr-description.md',
    'task',
    'file',
    'Worker PR description in the repository template format.',
  ),
  learnings: entry(
    'artifacts/learnings.md',
    'task',
    'file',
    'Task observations and lessons for follow-up work.',
  ),
  recipeQuality: entry(
    'artifacts/recipe-quality.json',
    'taskInput',
    'file',
    'Built recipe-quality assessment.',
  ),
  recipeCoverage: entry(
    'artifacts/recipe-coverage.md',
    'task',
    'file',
    'Acceptance criterion to recipe node and evidence mapping.',
  ),
  evidenceManifest: entry(
    'artifacts/evidence-manifest.json',
    'taskInput',
    'file',
    'Explicit visual evidence selection for publication.',
  ),
  subtasks: entry(
    SUBTASKS_DIR,
    'collection',
    'directory',
    'Registered child checklist units and their signals.',
  ),
  subtaskIndex: entry(
    `${SUBTASKS_DIR}/${SUBTASK_INDEX_FILE}`,
    'subtaskIndex',
    'file',
    'Registry of child units and their source identities.',
  ),
  subtaskChecklist: entry(
    `${SUBTASKS_DIR}/{id}.md`,
    'checklist',
    'pattern',
    'Child checklist selected by its registered id.',
  ),
  subtaskSignal: entry(
    `${SUBTASKS_DIR}/{id}-SIGNAL.json`,
    'signal',
    'pattern',
    'Child execution signal linked to its parent.',
  ),
});

export type TaskDirectoryLayout = typeof TASK_DIRECTORY_LAYOUT;
export type TaskDirectoryFileId = keyof TaskDirectoryLayout;

export interface TaskActionInputLibrary {
  actionNames: string[];
  expectedLibraryDigest: string | null;
}

/** Missing canonical inputs permit fresh work, not reuse of the original proof. */
export interface TaskActionInputGap {
  sourceRunId: string;
  canonicalPath: typeof TASK_DIRECTORY_LAYOUT.taskActions.relativePath;
  libraries: TaskActionInputLibrary[];
  reason: 'not-retained-at-canonical-path';
  requiredAction: 'reauthor-and-revalidate';
  proofReuseEligible: false;
}
