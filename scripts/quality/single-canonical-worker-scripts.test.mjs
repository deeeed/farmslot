import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

// Worker lifecycle scripts must live once, in @farmslot/agent-runtime. They were
// previously copied 2-3× (scripts/quality, packages/skills, agent-runtime) and
// drifted. Every non-canonical copy must be a thin delegate that resolves the
// canonical, never a second full implementation. This guard fails if a full copy
// returns anywhere in the repo. (The consensys-skills wrapper lives in a separate
// repo and is out of this guard's scope.)
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

const CANONICAL = {
  'mark-checklist-step.cjs': 'packages/agent-runtime/scripts/mark-checklist-step.cjs',
  'check-task-artifact-contract.mjs':
    'packages/agent-runtime/scripts/check-task-artifact-contract.mjs',
};
const DELEGATE_MAX_LINES = 40;
const CANONICAL_MIN_LINES = 80;

function trackedCopies(basename) {
  const out = execFileSync('git', ['ls-files'], { cwd: repoRoot, encoding: 'utf8' });
  return out
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => path.basename(line) === basename);
}

function lineCount(relativePath) {
  return readFileSync(path.join(repoRoot, relativePath), 'utf8').split('\n').length;
}

for (const [basename, canonicalRel] of Object.entries(CANONICAL)) {
  test(`${basename}: one canonical impl in @farmslot/agent-runtime, others delegate`, () => {
    const copies = trackedCopies(basename);
    assert.ok(
      copies.includes(canonicalRel),
      `expected canonical ${canonicalRel}; tracked copies: ${copies.join(', ') || '(none)'}`,
    );
    assert.ok(
      lineCount(canonicalRel) >= CANONICAL_MIN_LINES,
      `${canonicalRel} should hold the real implementation (>= ${CANONICAL_MIN_LINES} lines)`,
    );
    for (const copy of copies) {
      if (copy === canonicalRel) continue;
      const lines = lineCount(copy);
      assert.ok(
        lines <= DELEGATE_MAX_LINES,
        `${copy} must be a thin delegate (<= ${DELEGATE_MAX_LINES} lines, got ${lines}) — collapse it into ${canonicalRel}`,
      );
      const src = readFileSync(path.join(repoRoot, copy), 'utf8');
      assert.match(
        src,
        /@farmslot\/agent-runtime|agent-runtime\/scripts/,
        `${copy} must delegate to @farmslot/agent-runtime, not reimplement it`,
      );
    }
  });
}
