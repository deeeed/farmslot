#!/usr/bin/env node
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';

const repoRoot = process.cwd();
const failures = [];

function fail(message) {
  failures.push(message);
}

function readJson(relativePath) {
  return JSON.parse(readFileSync(path.join(repoRoot, relativePath), 'utf8'));
}

function workspaceDirs() {
  const rootPackage = readJson('package.json');
  const dirs = [];
  for (const workspace of rootPackage.workspaces ?? []) {
    if (workspace.endsWith('/*')) {
      const root = workspace.slice(0, -2);
      if (!existsSync(path.join(repoRoot, root))) continue;
      for (const entry of readdirSync(path.join(repoRoot, root), { withFileTypes: true })) {
        if (!entry.isDirectory()) continue;
        const relativeDir = `${root}/${entry.name}`;
        if (existsSync(path.join(repoRoot, relativeDir, 'package.json'))) dirs.push(relativeDir);
      }
    } else if (existsSync(path.join(repoRoot, workspace, 'package.json'))) {
      dirs.push(workspace);
    }
  }
  return [...new Set(dirs)].sort();
}

for (const relativeDir of workspaceDirs()) {
  const packageJsonPath = `${relativeDir}/package.json`;
  const changelogPath = `${relativeDir}/CHANGELOG.md`;
  const pkg = readJson(packageJsonPath);
  if (typeof pkg.name !== 'string' || !pkg.name.startsWith('@farmslot/')) {
    fail(`${packageJsonPath} must declare an @farmslot/* package name.`);
  }
  const absoluteChangelogPath = path.join(repoRoot, changelogPath);
  if (!existsSync(absoluteChangelogPath)) {
    fail(`${changelogPath} is required for workspace release notes.`);
    continue;
  }
  const content = readFileSync(absoluteChangelogPath, 'utf8');
  if (!content.startsWith('# Changelog\n')) {
    fail(`${changelogPath} must start with '# Changelog'.`);
  }
  if (!content.includes('## Unreleased')) {
    fail(`${changelogPath} must include an '## Unreleased' section.`);
  }
}

if (failures.length > 0) {
  console.error('Workspace changelog guard failed:');
  for (const failure of failures) console.error(`- ${failure}`);
  process.exit(1);
}

console.log('Workspace changelog guard passed.');
