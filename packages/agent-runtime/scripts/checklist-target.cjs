const fs = require('node:fs');
const path = require('node:path');

// Canonical filename registry lives in @farmslot/protocol/checklist-target — keep in sync (see test/checklist-target-sync.test.mjs).

const CHECKLIST_TARGET_MANIFEST = 'checklist-target.json';
const TASK_PROGRESS_MARKDOWN = 'TASK.md';
const INTERACTIVE_CHECKLIST_MARKDOWN = 'CHECKLIST.md';
const WORKER_SIGNAL_FILE = 'SIGNAL.json';
const ROLE_SIGNAL_SUFFIX = '-SIGNAL.json';

const SELF_REVIEW_CHECKLIST = 'SELF-REVIEW.md';
const SELF_REVIEW_FIX_CHECKLIST = 'SELF-REVIEW-FIX.md';
const CI_FIX_CHECKLIST = 'CI-FIX.md';

function signalFileForChecklist(checklistBasename) {
  if (
    checklistBasename === TASK_PROGRESS_MARKDOWN ||
    checklistBasename === INTERACTIVE_CHECKLIST_MARKDOWN
  ) {
    return WORKER_SIGNAL_FILE;
  }
  const base = checklistBasename.replace(/\.md$/i, '');
  return `${base}${ROLE_SIGNAL_SUFFIX}`;
}

function taskDirRelPath(taskDir, basename) {
  const normalized = String(taskDir).replace(/\/+$/, '');
  return `${normalized}/${basename}`;
}

function targetForChecklistBasename(checklistBasename) {
  return {
    checklist: checklistBasename,
    signal: signalFileForChecklist(checklistBasename),
  };
}

function defaultWorkerTarget(taskDir) {
  const checklist = fs.existsSync(path.join(taskDir, INTERACTIVE_CHECKLIST_MARKDOWN))
    ? INTERACTIVE_CHECKLIST_MARKDOWN
    : TASK_PROGRESS_MARKDOWN;
  return targetForChecklistBasename(checklist);
}

const SELF_REVIEW_CHECKLIST_TARGET = targetForChecklistBasename(SELF_REVIEW_CHECKLIST);
const SELF_REVIEW_FIX_CHECKLIST_TARGET = targetForChecklistBasename(SELF_REVIEW_FIX_CHECKLIST);
const CI_FIX_CHECKLIST_TARGET = targetForChecklistBasename(CI_FIX_CHECKLIST);

const CHECKLIST_TARGET_BY_AGENT_ROLE = {
  'self-review': SELF_REVIEW_CHECKLIST_TARGET,
  'self-review-fix': SELF_REVIEW_FIX_CHECKLIST_TARGET,
  'ci-fix': CI_FIX_CHECKLIST_TARGET,
};

const DEFAULT_CHECKLIST_TARGET_REGISTRY = {
  manifest: CHECKLIST_TARGET_MANIFEST,
  workerTask: TASK_PROGRESS_MARKDOWN,
  interactiveChecklist: INTERACTIVE_CHECKLIST_MARKDOWN,
  workerSignal: WORKER_SIGNAL_FILE,
  roleSignalSuffix: ROLE_SIGNAL_SUFFIX,
  roles: CHECKLIST_TARGET_BY_AGENT_ROLE,
};

function checklistTargetForAgentRole(role, registry = DEFAULT_CHECKLIST_TARGET_REGISTRY) {
  return registry.roles[role] ?? null;
}

function readManifest(taskDir) {
  const manifestPath = path.join(taskDir, CHECKLIST_TARGET_MANIFEST);
  if (!fs.existsSync(manifestPath)) return null;
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object') return null;
  const checklist = typeof parsed.checklist === 'string' ? parsed.checklist.trim() : '';
  if (!checklist || path.basename(checklist) !== checklist) return null;
  const signalRaw = typeof parsed.signal === 'string' ? parsed.signal.trim() : '';
  const signal =
    signalRaw && path.basename(signalRaw) === signalRaw
      ? signalRaw
      : signalFileForChecklist(checklist);
  return { checklist, signal };
}

function manifestModeTeachingError(taskDir, reason) {
  const manifestPath = path.join(path.resolve(taskDir), CHECKLIST_TARGET_MANIFEST);
  return (
    `Missing or invalid ${CHECKLIST_TARGET_MANIFEST} at ${manifestPath} (${reason}). ` +
    'The gateway writes this file at task creation and on every role switch — re-run dispatch/prepare for this run, or write the manifest manually. ' +
    'Escape hatch: farmslot-agent mark <task-dir> --checklist FILE.md <step> [--signal FILE.json], ' +
    'or explicit paths: farmslot-agent mark <task.md> <signal.json> <step>.'
  );
}

function taskLocalBasenameOrThrow(value, label, expectedExt) {
  if (!value || typeof value !== 'string') {
    throw new Error(`${label} is required`);
  }
  const trimmed = value.trim();
  if (trimmed.includes('/') || trimmed.includes('\\')) {
    throw new Error(`${label} must be a task-local basename (got ${value})`);
  }
  if (!trimmed.endsWith(expectedExt)) {
    throw new Error(`${label} must end with ${expectedExt} (got ${trimmed})`);
  }
  return trimmed;
}

function resolveChecklistTargetWithOverrides(taskDir, overrides = {}) {
  const normalizedDir = path.resolve(taskDir);
  if (overrides.checklist) {
    const checklist = taskLocalBasenameOrThrow(overrides.checklist, '--checklist', '.md');
    const signal = overrides.signal
      ? taskLocalBasenameOrThrow(overrides.signal, '--signal', '.json')
      : signalFileForChecklist(checklist);
    return { checklist, signal };
  }
  return resolveChecklistTarget(normalizedDir);
}

function parseTaskDirMarkArgs(taskDir, rawArgs, { isMarkStepToken, usage }) {
  const overrides = {};
  const positional = [];
  for (let i = 0; i < rawArgs.length; i += 1) {
    const token = rawArgs[i];
    if (token === '--checklist') {
      overrides.checklist = rawArgs[++i];
      if (!overrides.checklist) usage();
      continue;
    }
    if (token === '--signal') {
      overrides.signal = rawArgs[++i];
      if (!overrides.signal) usage();
      continue;
    }
    positional.push(token);
  }
  if (positional.length === 0) usage();
  const stepRaw = positional[0];
  if (stepRaw === '--help' || stepRaw === '-h') {
    return { help: true };
  }
  if (!isMarkStepToken(stepRaw)) usage();
  let target;
  try {
    target = resolveChecklistTargetWithOverrides(taskDir, overrides);
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(2);
  }
  const normalizedDir = path.resolve(taskDir);
  return {
    taskPath: path.join(normalizedDir, target.checklist),
    signalPath: path.join(normalizedDir, target.signal),
    stepRaw,
    rest: positional.slice(1),
  };
}

function resolveChecklistTarget(taskDir) {
  const normalizedDir = path.resolve(taskDir);
  const manifestPath = path.join(normalizedDir, CHECKLIST_TARGET_MANIFEST);
  if (!fs.existsSync(manifestPath)) {
    throw new Error(manifestModeTeachingError(taskDir, 'file not found'));
  }
  const fromManifest = readManifest(normalizedDir);
  if (!fromManifest) {
    throw new Error(manifestModeTeachingError(taskDir, 'invalid JSON or checklist basename'));
  }
  return fromManifest;
}

function resolveChecklistPaths(taskDir) {
  const target = resolveChecklistTarget(taskDir);
  const normalizedDir = path.resolve(taskDir);
  return {
    taskPath: path.join(normalizedDir, target.checklist),
    signalPath: path.join(normalizedDir, target.signal),
    target,
  };
}

module.exports = {
  CHECKLIST_TARGET_MANIFEST,
  TASK_PROGRESS_MARKDOWN,
  INTERACTIVE_CHECKLIST_MARKDOWN,
  WORKER_SIGNAL_FILE,
  ROLE_SIGNAL_SUFFIX,
  SELF_REVIEW_CHECKLIST,
  SELF_REVIEW_FIX_CHECKLIST,
  CI_FIX_CHECKLIST,
  SELF_REVIEW_CHECKLIST_TARGET,
  SELF_REVIEW_FIX_CHECKLIST_TARGET,
  CI_FIX_CHECKLIST_TARGET,
  CHECKLIST_TARGET_BY_AGENT_ROLE,
  DEFAULT_CHECKLIST_TARGET_REGISTRY,
  checklistTargetForAgentRole,
  taskDirRelPath,
  signalFileForChecklist,
  targetForChecklistBasename,
  defaultWorkerTarget,
  manifestModeTeachingError,
  readManifest,
  resolveChecklistTarget,
  resolveChecklistTargetWithOverrides,
  resolveChecklistPaths,
  parseTaskDirMarkArgs,
};
