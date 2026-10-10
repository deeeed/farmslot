import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { hashPackDir } from './pack.js';
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

test('update refuses an installed nonportable pack whose hash is unchanged', (t) => {
  const root = mkdtempSync(path.join(tmpdir(), 'pack-update-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const source = path.join(root, 'source');
  execFileSync('git', ['init', '--quiet', '--initial-branch=main', source]);
  mkdirSync(path.join(source, 'pool'));
  writeFileSync(
    path.join(source, 'pool/worker.json'),
    JSON.stringify({
      schema_version: 1,
      machine: 'worker-a',
      host: 'localhost',
      ssh_user: 'test',
      slots: [],
    }),
  );
  execFileSync('git', ['-C', source, 'add', '.']);
  execFileSync('git', [
    '-C',
    source,
    '-c',
    'commit.gpgsign=false',
    '-c',
    'user.name=Test',
    '-c',
    'user.email=test@example.invalid',
    'commit',
    '--quiet',
    '-m',
    'test: fixture',
  ]);
  const ws = path.join(root, 'workspace');
  mkdirSync(ws);
  execFileSync('git', ['clone', '--quiet', source, path.join(ws, 'farmslot')]);
  const pack = path.join(root, 'pack');
  const project = path.join(pack, 'projects/example-farm');
  mkdirSync(path.join(project, 'setup'), { recursive: true });
  mkdirSync(path.join(project, 'templates'));
  writeFileSync(
    path.join(pack, 'pack.json'),
    JSON.stringify({
      name: 'example',
      projects: [{ dir: 'projects/example-farm', platform: 'cli', slots: 1 }],
    }),
  );
  writeFileSync(path.join(project, 'project.json'), ' {"name":"example-farm"}');
  writeFileSync(path.join(project, 'setup/cli.sh'), '#!/bin/sh\n');
  writeFileSync(path.join(project, 'templates/task.md'), 'Run checks\n~/xreview/private\n');
  writeFileSync(
    path.join(ws, 'state.json'),
    JSON.stringify({
      schema_version: 1,
      source: { mode: 'local', path: source },
      machine: 'worker-a',
      pool_file: 'pool/worker.json',
      packs: { example: { source: pack, hash: hashPackDir(pack) } },
      pool_migrations: { applied: [] },
    }),
  );
  const bin = path.join(root, 'bin');
  mkdirSync(bin);
  writeFileSync(path.join(bin, 'yarn'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    PATH: bin + path.delimiter + process.env.PATH,
    FARMSLOT_WORKSPACE: ws,
    FARMSLOT_HOME: path.join(root, 'home'),
  };
  delete env.FARMSLOT_POOL_DIR;
  assert.throws(
    () =>
      execFileSync(
        process.execPath,
        [path.join(CLI_SRC, '../bin/farmslot.mjs'), 'update', '--json'],
        { env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
      ),
    (error: unknown) => {
      const result = error as { stdout: string; stderr: string };
      return /templates\/task.md:2:.*nonportable/.test(result.stdout + result.stderr);
    },
  );
});
