const fs = require('node:fs');
const path = require('node:path');

const { checklistStepName, enumerateChecklistCheckboxes } = require('./checklist-target.cjs');

// One definition of how the mark engine reads and writes task-dir files, shared
// by the parent mark path and the child-unit (`sub`) verbs so both write the
// same bytes the same way.

function atomicWrite(file, content, mode) {
  const dir = path.dirname(file);
  fs.mkdirSync(dir, { recursive: true });
  const tmp = path.join(dir, `.${path.basename(file)}.${process.pid}.tmp`);
  fs.writeFileSync(tmp, content, mode ? { mode } : undefined);
  fs.renameSync(tmp, file);
}

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (err) {
    if (err && err.code === 'ENOENT') return {};
    throw err;
  }
}

/** Signal JSON with a trailing newline and the mode every signal file carries. */
function writeSignal(signalPath, signal) {
  atomicWrite(signalPath, `${JSON.stringify(signal, null, 2)}\n`, 0o644);
}

const SIGNAL_PASSTHROUGH_KEYS = ['role', 'contextId', 'attemptId', 'prNumber'];

function pickSignalPassthrough(signal) {
  const out = {};
  for (const key of SIGNAL_PASSTHROUGH_KEYS) {
    if (signal[key] !== undefined) out[key] = signal[key];
  }
  return out;
}

// Step enumeration is shared with the gateway parsers (generateTaskSchema in
// tasks/writer.ts and parseCheckboxStates in methods/task.ts) via the
// checklist-target enumerator: same skip sections, <details> handling, and
// checkbox shape. Any divergence makes `mark N` check a different box than
// the one progress reporting counts as step N (checkbox-formatted Acceptance
// Criteria used to shift every step by the AC count).
function parseChecklist(markdown) {
  const lines = markdown.split(/\n/);
  const items = enumerateChecklistCheckboxes(markdown).map((item) => ({
    ...item,
    label: checklistStepName(item.rawLabel),
  }));
  return { lines, items };
}

function markStepInLines(lines, item) {
  if (item.checked) return false;
  const before = lines[item.lineIndex];
  lines[item.lineIndex] = before.replace(/^(\s*- \[)( |x|X)(\])/, '$1x$3');
  return lines[item.lineIndex] !== before;
}

/** Tick one enumerated row in a checklist file. Returns true when the file changed. */
function markStepInFile(filePath, item) {
  const original = fs.readFileSync(filePath, 'utf8');
  const parsed = parseChecklist(original);
  const lines = [...parsed.lines];
  markStepInLines(lines, item);
  const updated = lines.join('\n');
  if (updated === original) return false;
  atomicWrite(filePath, updated);
  return true;
}

module.exports = {
  atomicWrite,
  readJson,
  writeSignal,
  SIGNAL_PASSTHROUGH_KEYS,
  pickSignalPassthrough,
  parseChecklist,
  markStepInLines,
  markStepInFile,
};
