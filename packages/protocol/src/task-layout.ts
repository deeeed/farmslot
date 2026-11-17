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
}

function entry<const Path extends string>(
  relativePath: Path,
  schema: keyof typeof TASK_FILE_SCHEMAS,
  kind: TaskDirectoryEntry['kind'] = 'file',
): TaskDirectoryEntry<Path> {
  return Object.freeze({ relativePath, kind, schema });
}

/** There is one active task-action root; inherited copies are context, not fallback roots. */
export const TASK_DIRECTORY_LAYOUT = Object.freeze({
  task: entry(TASK_PROGRESS_MARKDOWN, 'task'),
  checklist: entry(INTERACTIVE_CHECKLIST_MARKDOWN, 'checklist'),
  marker: entry('mark', 'marker'),
  signal: entry(WORKER_SIGNAL_FILE, 'signal'),
  checklistTarget: entry(CHECKLIST_TARGET_MANIFEST, 'target'),
  reviewChecklist: entry(REVIEW_CHECKLIST, 'checklist'),
  reviewSignal: entry(signalFileForChecklist(REVIEW_CHECKLIST), 'signal'),
  reviewFixChecklist: entry(REVIEW_FIX_CHECKLIST, 'checklist'),
  reviewFixSignal: entry(signalFileForChecklist(REVIEW_FIX_CHECKLIST), 'signal'),
  ciFixChecklist: entry(CI_FIX_CHECKLIST, 'checklist'),
  ciFixSignal: entry(signalFileForChecklist(CI_FIX_CHECKLIST), 'signal'),
  inputs: entry('inputs', 'collection', 'directory'),
  handoff: entry('inputs/handoff.json', 'handoff'),
  bugInput: entry('inputs/bug-input.json', 'taskInput'),
  terminalContract: entry(WORKER_TERMINAL_CONTRACT_INPUT, 'terminal'),
  roleTerminalContract: entry('inputs/worker-terminal-contract.{role}.json', 'terminal', 'pattern'),
  recipeBinding: entry('inputs/recipe-binding.json', 'taskInput'),
  inheritedContext: entry('inputs/inherited-context.json', 'taskInput'),
  inheritedAcceptance: entry('inputs/inherited-acceptance.json', 'taskInput'),
  inherited: entry('inputs/inherited', 'collection', 'directory'),
  inheritedTaskActions: entry('inputs/inherited/task-actions', 'collection', 'directory'),
  inheritedEvidenceManifest: entry('inputs/inherited/evidence-manifest.json', 'taskInput'),
  assets: entry('assets', 'artifact', 'directory'),
  artifacts: entry('artifacts', 'collection', 'directory'),
  recipe: entry('artifacts/recipe.json', 'recipe'),
  recipeLibrary: entry('artifacts/recipe-library', 'collection', 'directory'),
  recipeRuns: entry('artifacts/recipe-runs', 'recipePackage', 'directory'),
  recipeAttempt: entry('artifacts/recipe-runs/{attempt}', 'recipePackage', 'pattern'),
  recipeCalls: entry('artifacts/calls/{attempt}', 'recipePackage', 'pattern'),
  selectedRecipeRun: entry('artifacts/latest-valid-recipe-run.json', 'taskInput'),
  acceptance: entry('artifacts/acceptance-status.json', 'acceptance'),
  taskActions: entry('artifacts/task-actions', 'collection', 'directory'),
  taskActionManifests: entry('artifacts/task-actions/manifests', 'collection', 'directory'),
  taskActionManifest: entry(
    'artifacts/task-actions/manifests/{manifest}.json',
    'actionManifest',
    'pattern',
  ),
  taskActionImplementations: entry('artifacts/task-actions/actions', 'collection', 'directory'),
  taskActionImplementation: entry('artifacts/task-actions/actions/{path}', 'artifact', 'pattern'),
  harnessProvenance: entry('artifacts/harness-provenance.json', 'provenance'),
  sandbox: entry('artifacts/sandbox.json', 'taskInput'),
  recipeOwnership: entry('artifacts/recipe-ownership/{recipeRunId}.json', 'taskInput', 'pattern'),
  deterministicChecks: entry(
    'artifacts/deterministic-checks/{checklist}/{step}.json',
    'taskInput',
    'pattern',
  ),
  operations: entry('artifacts/operations/{operation}.json', 'operation', 'pattern'),
  operationLog: entry('artifacts/operations/{operation}.log', 'artifact', 'pattern'),
  report: entry('artifacts/report.md', 'task'),
  prDescription: entry('artifacts/pr-description.md', 'task'),
  learnings: entry('artifacts/learnings.md', 'task'),
  recipeQuality: entry('artifacts/recipe-quality.json', 'taskInput'),
  recipeCoverage: entry('artifacts/recipe-coverage.md', 'task'),
  evidenceManifest: entry('artifacts/evidence-manifest.json', 'taskInput'),
  subtasks: entry(SUBTASKS_DIR, 'collection', 'directory'),
  subtaskIndex: entry(`${SUBTASKS_DIR}/${SUBTASK_INDEX_FILE}`, 'subtaskIndex'),
  subtaskChecklist: entry(`${SUBTASKS_DIR}/{id}.md`, 'checklist', 'pattern'),
  subtaskSignal: entry(`${SUBTASKS_DIR}/{id}-SIGNAL.json`, 'signal', 'pattern'),
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
