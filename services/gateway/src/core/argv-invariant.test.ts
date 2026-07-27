import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';

const GATEWAY_SRC = path.resolve(import.meta.dirname, '..');

const INVENTORIED_SOURCES = [
  'methods/git.ts',
  'methods/dispatch/ticket-ref.ts',
  'methods/dispatch/match-project.ts',
  'run-engine/remote-probes.ts',
] as const;

test('caller-derived exec inventory uses argv and no JSON serialization as shell quoting', async () => {
  for (const relativePath of INVENTORIED_SOURCES) {
    const source = await readFile(path.join(GATEWAY_SRC, relativePath), 'utf-8');
    assert.doesNotMatch(
      source,
      /exec(?:Local|OnSlot)\s*\(\s*`[^`]*\$\{/s,
      `${relativePath} interpolates a value into shell text`,
    );
    assert.doesNotMatch(
      source,
      /`[^`]*\$\{JSON\.stringify\([^)]*\)\}[^`]*`/s,
      `${relativePath} uses JSON.stringify as shell quoting`,
    );
  }
});
