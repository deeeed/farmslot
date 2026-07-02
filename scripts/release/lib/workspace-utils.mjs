#!/usr/bin/env node
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';

export function readJson(filePath) {
  return JSON.parse(readFileSync(filePath, 'utf8'));
}

export function workspaceDirs(repoRoot) {
  const rootPackage = readJson(path.join(repoRoot, 'package.json'));
  const dirs = [];
  for (const workspace of rootPackage.workspaces ?? []) {
    if (workspace.endsWith('/*')) {
      const root = workspace.slice(0, -2);
      const absoluteRoot = path.join(repoRoot, root);
      if (!existsSync(absoluteRoot)) continue;
      for (const entry of readdirSync(absoluteRoot, { withFileTypes: true })) {
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

export function workspaceForFile(relativePath, repoRoot) {
  const dirs = workspaceDirs(repoRoot);
  let best = null;
  for (const dir of dirs) {
    const prefix = `${dir}/`;
    if (relativePath === dir || relativePath.startsWith(prefix)) {
      if (!best || dir.length > best.length) best = dir;
    }
  }
  return best;
}

export function loadWorkspacePackages(repoRoot) {
  const packages = new Map();
  for (const dir of workspaceDirs(repoRoot)) {
    const pkg = readJson(path.join(repoRoot, dir, 'package.json'));
    if (typeof pkg.name === 'string' && pkg.name.startsWith('@farmslot/')) {
      packages.set(dir, pkg);
    }
  }
  return packages;
}
