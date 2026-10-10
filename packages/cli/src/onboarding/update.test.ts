import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { CLI_DEPENDENCY_BUILD_ARGS } from './update.js';

const CLI_SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const REPO_ROOT = path.resolve(CLI_SRC, '../../..');

function readJson(file: string): { name?: string } {
  return JSON.parse(readFileSync(file, 'utf-8')) as { name?: string };
}

// The release tooling's workspace enumeration (root `workspaces` globs).
async function workspaceNames(): Promise<Set<string>> {
  const utils = pathToFileURL(path.join(REPO_ROOT, 'scripts/release/lib/workspace-utils.mjs'));
  const { loadWorkspacePackages } = (await import(utils.href)) as {
    loadWorkspacePackages: (repoRoot: string) => Map<string, { name: string }>;
  };
  return new Set([...loadWorkspacePackages(REPO_ROOT).values()].map((pkg) => pkg.name));
}

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return sourceFiles(full);
    return entry.name.endsWith('.ts') && !entry.name.endsWith('.test.ts') ? [full] : [];
  });
}

test('update and install.sh run one build command, which names only the CLI', () => {
  const named = CLI_DEPENDENCY_BUILD_ARGS.filter((arg) => arg.startsWith('@'));
  assert.deepEqual(named, ['@farmslot/cli']);
  assert.equal(readJson(path.join(CLI_SRC, '..', 'package.json')).name, '@farmslot/cli');
  assert.ok(
    readFileSync(path.join(REPO_ROOT, 'install.sh'), 'utf-8').includes(
      `yarn ${CLI_DEPENDENCY_BUILD_ARGS.join(' ')}`,
    ),
    'install.sh must run the same build command as farmslot update',
  );
});

test('every yarn workspace target in CLI source names an existing workspace', async () => {
  const names = await workspaceNames();
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
