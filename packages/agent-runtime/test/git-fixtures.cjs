const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const { cpSync, mkdtempSync, rmSync } = require('node:fs');
const { tmpdir } = require('node:os');
const path = require('node:path');

let emptyRepository;

/** Every case gets its own files and index; only the empty repository setup is shared. */
function initGitFixture(directory) {
  if (!emptyRepository) {
    emptyRepository = mkdtempSync(path.join(tmpdir(), 'agent-runtime-git-template-'));
    process.once('exit', () => rmSync(emptyRepository, { recursive: true, force: true }));
    const root = emptyRepository;
    assert.equal(spawnSync('git', ['init', '-q', '-b', 'main'], { cwd: root }).status, 0);
  }
  cpSync(path.join(emptyRepository, '.git'), path.join(directory, '.git'), { recursive: true });
}

module.exports = { initGitFixture };
