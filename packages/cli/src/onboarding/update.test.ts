import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { CLI_DEPENDENCY_BUILD_ARGS } from './update.js';

const CLI_SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const REPO_ROOT = path.resolve(CLI_SRC, '../../..');

function readJson(file: string): { name?: string; workspaces?: string[] } {
  return JSON.parse(readFileSync(file, 'utf-8')) as { name?: string; workspaces?: string[] };
}

// Root workspace globs are either `dir/*` or a literal workspace path.
function workspaceNames(): Set<string> {
  const names = new Set<string>();
  for (const pattern of readJson(path.join(REPO_ROOT, 'package.json')).workspaces ?? []) {
    const dirs = pattern.endsWith('/*')
      ? readdirSync(path.join(REPO_ROOT, pattern.slice(0, -2)), { withFileTypes: true })
          .filter((entry) => entry.isDirectory())
          .map((entry) => path.join(REPO_ROOT, pattern.slice(0, -2), entry.name))
      : [path.join(REPO_ROOT, pattern)];
    for (const dir of dirs) {
      const manifest = path.join(dir, 'package.json');
      const name = existsSync(manifest) ? readJson(manifest).name : undefined;
      if (name) names.add(name);
    }
  }
  return names;
}

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return sourceFiles(full);
    return entry.name.endsWith('.ts') && !entry.name.endsWith('.test.ts') ? [full] : [];
  });
}

test('dependency build names no workspace but the CLI itself', () => {
  const named = CLI_DEPENDENCY_BUILD_ARGS.filter((arg) => arg.startsWith('@'));
  assert.deepEqual(named, ['@farmslot/cli']);
  assert.equal(readJson(path.join(CLI_SRC, '..', 'package.json')).name, '@farmslot/cli');
});

test('every yarn workspace target in CLI source names an existing workspace', () => {
  const names = workspaceNames();
  const targets = /workspace @farmslot\/([\w.-]+)|'workspace',\s*'@farmslot\/([\w.-]+)'/g;
  const found: string[] = [];
  for (const file of sourceFiles(CLI_SRC)) {
    for (const match of readFileSync(file, 'utf-8').matchAll(targets)) {
      const name = `@farmslot/${match[1] ?? match[2]}`;
      found.push(name);
      assert.ok(names.has(name), `${path.relative(REPO_ROOT, file)} targets unknown ${name}`);
    }
  }
  assert.ok(found.includes('@farmslot/agent-runtime'), 'scan found no workspace targets');
});
