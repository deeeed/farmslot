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

/** Advance task selection after success without changing any attempt bytes. */
function recordRecipeAttemptSelection(taskDir, artifactDir) {
  const artifacts = realpathSync(path.join(taskDir, 'artifacts'));
  const attempt = realpathSync(artifactDir);
  const relative = path.relative(artifacts, attempt).split(path.sep).join('/');
  const pointer = sanitizeLatestValidRecipeRunPointer({
    version: 1,
    relativeArtifactRoot: relative,
    updatedAt: new Date().toISOString(),
  });
  if (!pointer) return false;
  const summary = JSON.parse(readFileSync(path.join(attempt, 'summary.json'), 'utf8'));
  if (summary.status !== 'pass') return false;
  const destination = path.join(artifacts, 'latest-valid-recipe-run.json');
  const temporary = `${destination}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temporary, `${JSON.stringify(pointer)}\n`, { flag: 'wx', mode: 0o600 });
    renameSync(temporary, destination);
  } finally {
    rmSync(temporary, { force: true });
  }
  return true;
}

function readRecipeAttemptSelection(taskDir) {
  const file = path.join(taskDir, 'artifacts', 'latest-valid-recipe-run.json');
  if (!existsSync(file)) return null;
  const pointer = sanitizeLatestValidRecipeRunPointer(JSON.parse(readFileSync(file, 'utf8')));
  if (!pointer) throw new Error('Invalid retained recipe attempt selection.');
  return pointer;
}

module.exports = { readRecipeAttemptSelection, recordRecipeAttemptSelection };
if (require.main === module) recordRecipeAttemptSelection(process.argv[2], process.argv[3]);
