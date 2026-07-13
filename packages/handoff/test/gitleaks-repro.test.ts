import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

// Reproducibility gate: re-running the generator against the PINNED gitleaks
// input must reproduce the committed data file byte-for-byte. Kills silent
// drift between the ruleset source and what ships.
test('the committed gitleaks-rules.ts reproduces from the pinned ruleset byte-for-byte', () => {
  const pkgRoot = fileURLToPath(new URL('..', import.meta.url));
  const pinned = path.join(pkgRoot, 'test/fixtures/gitleaks.toml.pinned');
  const commit = readFileSync(
    path.join(pkgRoot, 'test/fixtures/gitleaks-commit.txt'),
    'utf8',
  ).trim();
  const committed = readFileSync(path.join(pkgRoot, 'src/scrub/data/gitleaks-rules.ts'), 'utf8');

  const outDir = mkdtempSync(path.join(os.tmpdir(), 'handoff-gitleaks-repro-'));
  const outPath = path.join(outDir, 'gitleaks-rules.ts');
  try {
    execFileSync('node', ['scripts/generate-gitleaks-rules.mjs', pinned, commit, outPath], {
      cwd: pkgRoot,
      stdio: 'ignore',
    });
    const regenerated = readFileSync(outPath, 'utf8');
    assert.equal(
      regenerated,
      committed,
      'gitleaks-rules.ts is out of sync with the pinned ruleset - regenerate it',
    );
  } finally {
    rmSync(outDir, { recursive: true, force: true });
  }
});
