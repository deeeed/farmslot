const fs = require('node:fs');
const path = require('node:path');

const CHECKLIST_TARGET_MANIFEST = 'checklist-target.json';
const TASK_PROGRESS_MARKDOWN = 'TASK.md';
const INTERACTIVE_CHECKLIST_MARKDOWN = 'CHECKLIST.md';
const WORKER_SIGNAL_FILE = 'SIGNAL.json';

function signalFileForChecklist(checklistBasename) {
  if (
    checklistBasename === TASK_PROGRESS_MARKDOWN ||
    checklistBasename === INTERACTIVE_CHECKLIST_MARKDOWN
  ) {
    return WORKER_SIGNAL_FILE;
  }
  const base = checklistBasename.replace(/\.md$/i, '');
  return `${base}-SIGNAL.json`;
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
  const fromManifest = readManifest(normalizedDir);
  if (fromManifest) return fromManifest;
  return defaultWorkerTarget(normalizedDir);
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
  signalFileForChecklist,
  targetForChecklistBasename,
  defaultWorkerTarget,
  readManifest,
  resolveChecklistTarget,
  resolveChecklistTargetWithOverrides,
  resolveChecklistPaths,
  parseTaskDirMarkArgs,
};
