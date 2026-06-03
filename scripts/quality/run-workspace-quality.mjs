#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';

const repoRoot = process.cwd();

function workspaceDirs(rootName) {
  const root = path.join(repoRoot, rootName);
  if (!existsSync(root)) return [];
  return readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => `${rootName}/${entry.name}`)
    .filter((dir) => existsSync(path.join(repoRoot, dir, 'package.json')))
    .sort();
}

function readWorkspace(relativeDir) {
  const pkg = JSON.parse(readFileSync(path.join(repoRoot, relativeDir, 'package.json'), 'utf8'));
  if (typeof pkg.name !== 'string' || pkg.name.trim() === '') {
    throw new Error(`${relativeDir}/package.json must declare a package name.`);
  }
  if (typeof pkg.scripts?.quality !== 'string' || pkg.scripts.quality.trim() === '') {
    throw new Error(`${relativeDir}/package.json must define a quality script.`);
  }
  return { name: pkg.name, relativeDir };
}

const workspaces = [...workspaceDirs('packages'), ...workspaceDirs('services')]
  .map(readWorkspace)
  .sort((a, b) => a.name.localeCompare(b.name));

for (const workspace of workspaces) {
  console.log(`\n[workspace-quality] ${workspace.name}: yarn workspace ${workspace.name} quality`);
  const result = spawnSync('yarn', ['workspace', workspace.name, 'quality'], {
    cwd: repoRoot,
    stdio: 'inherit',
  });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}

console.log(`\nWorkspace quality passed for ${workspaces.length} package/service workspaces.`);
