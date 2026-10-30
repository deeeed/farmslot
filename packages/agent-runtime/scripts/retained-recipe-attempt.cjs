'use strict';

const { randomUUID } = require('node:crypto');
const {
  existsSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} = require('node:fs');
const path = require('node:path');
const { sanitizeLatestValidRecipeRunPointer } = require('@farmslot/protocol/recipe');

const { transferEngineClaims } = require('./acceptance-ledger.cjs');

/** The selection of a successful attempt, or null when it cannot be selected. */
function successfulAttempt(taskDir, artifactDir) {
  const artifacts = realpathSync(path.join(taskDir, 'artifacts'));
  const attempt = realpathSync(artifactDir);
  const relative = path.relative(artifacts, attempt).split(path.sep).join('/');
  const pointer = sanitizeLatestValidRecipeRunPointer({
    version: 1,
    relativeArtifactRoot: relative,
    updatedAt: new Date().toISOString(),
  });
  if (!pointer) return null;
  const summary = JSON.parse(readFileSync(path.join(attempt, 'summary.json'), 'utf8'));
  if (summary.status !== 'pass') return null;
  return { artifacts, attempt, pointer };
}

function writeSelection({ artifacts, pointer }) {
  const destination = path.join(artifacts, 'latest-valid-recipe-run.json');
  const temporary = `${destination}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temporary, `${JSON.stringify(pointer)}\n`, { flag: 'wx', mode: 0o600 });
    renameSync(temporary, destination);
  } finally {
    rmSync(temporary, { force: true });
  }
}

/** Advance task selection after success without changing any attempt bytes. */
function recordRecipeAttemptSelection(taskDir, artifactDir) {
  const selection = successfulAttempt(taskDir, artifactDir);
  if (!selection) return false;
  writeSelection(selection);
  return true;
}

/**
 * Re-select a retained attempt. The task ledger takes the attempt's
 * engine-selected claims before the pointer moves, so the selection and the
 * verdicts never name different executions.
 */
async function selectRecipeAttempt(taskDir, artifactDir) {
  const selection = successfulAttempt(taskDir, artifactDir);
  if (!selection) return false;
  const { readRecordedEvidencePackage } = await import('@farmslot/adapter-sdk');
  const { selectedRecipeClaims } = await import('@farmslot/adapter-sdk/evidence');
  const { input } = await readRecordedEvidencePackage(selection.attempt);
  if (!input.claims) throw new Error('The selected attempt has no engine claim package.');
  transferEngineClaims(
    taskDir,
    path.join(selection.attempt, 'acceptance-status.json'),
    path.join(selection.attempt, 'trace.json'),
    selectedRecipeClaims(input),
  );
  writeSelection(selection);
  return true;
}

function readRecipeAttemptSelection(taskDir) {
  const file = path.join(taskDir, 'artifacts', 'latest-valid-recipe-run.json');
  if (!existsSync(file)) return null;
  const pointer = sanitizeLatestValidRecipeRunPointer(JSON.parse(readFileSync(file, 'utf8')));
  if (!pointer) throw new Error('Invalid retained recipe attempt selection.');
  return pointer;
}

module.exports = { readRecipeAttemptSelection, recordRecipeAttemptSelection, selectRecipeAttempt };
if (require.main === module)
  selectRecipeAttempt(process.argv[2], process.argv[3]).then(
    (selected) => {
      if (selected) return;
      console.error('Not selected: the attempt is not a successful retained recipe run.');
      process.exitCode = 1;
    },
    (error) => {
      console.error(error instanceof Error ? error.message : String(error));
      process.exitCode = 1;
    },
  );
