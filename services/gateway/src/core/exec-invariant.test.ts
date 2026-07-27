import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';

const INVENTORIED_FILES = [
  '../methods/git.ts',
  '../methods/dispatch/ticket-ref.ts',
  '../methods/dispatch/match-project.ts',
  '../run-engine/remote-probes.ts',
];

test('caller-derived command sites use argv and do not use JSON.stringify as shell quoting', async () => {
  for (const relativeFile of INVENTORIED_FILES) {
    const source = await readFile(path.resolve(import.meta.dirname, relativeFile), 'utf-8');
    assert.doesNotMatch(source, /execLocal\s*\(\s*`[^`]*\$\{/s, relativeFile);
    assert.doesNotMatch(source, /JSON\.stringify\([^)]*\)[^`]*`/s, relativeFile);
  }
});
