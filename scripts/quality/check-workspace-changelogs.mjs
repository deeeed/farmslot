#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';

import { workspaceForFile } from '../release/lib/workspace-utils.mjs';
import { isPlaceholderBullet } from '../release/parse-changelog.mjs';

const repoRoot = process.cwd();
const failures = [];
const prDiff = process.argv.includes('--pr-diff');

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

function isTestOnlyChange(relativePath) {
  return (
    relativePath.includes('/test/') ||
    relativePath.includes('/tests/') ||
    /\.test\.[cm]?[jt]sx?$/.test(relativePath) ||
    /\.spec\.[cm]?[jt]sx?$/.test(relativePath) ||
    relativePath.endsWith('.snap')
  );
}

function gitLines(args) {
  const result = spawnSync('git', args, { cwd: repoRoot, encoding: 'utf8' });
  if (result.status !== 0) return [];
  return result.stdout
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
}

function resolveMergeBase() {
  const eventPath = process.env.GITHUB_EVENT_PATH;
  if (eventPath && existsSync(eventPath)) {
    try {
      const event = JSON.parse(readFileSync(eventPath, 'utf8'));
      const baseSha = event.pull_request?.base?.sha;
      if (baseSha) return baseSha;
    } catch {
      // fall through
    }
  }
  const originMain = gitLines(['rev-parse', '--verify', 'origin/main'])[0];
  if (originMain) {
    const mergeBase = gitLines(['merge-base', 'HEAD', originMain])[0];
    if (mergeBase) return mergeBase;
  }
  return gitLines(['rev-parse', 'HEAD~1'])[0] ?? 'HEAD~1';
}

function checkStructure() {
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
}

function addedMeaningfulBullets(changelogDiff) {
  return changelogDiff
    .split('\n')
    .filter((line) => line.startsWith('+') && !line.startsWith('+++'))
    .map((line) => line.slice(1).trim())
    .filter((line) => line.startsWith('-'))
    .filter((line) => !isPlaceholderBullet(line));
}

function checkPrDiff() {
  const mergeBase = resolveMergeBase();
  const changedFiles = gitLines(['diff', '--name-only', `${mergeBase}...HEAD`]);
  if (changedFiles.length === 0) return;

  const releaseOnly = changedFiles.every(
    (file) =>
      file.startsWith('.release-cut/') ||
      file.endsWith('/release-notes.json') ||
      file.endsWith('/CHANGELOG.md') ||
      file.endsWith('/package.json') ||
      file.startsWith('scripts/release/') ||
      file.startsWith('.agents/skills/fs-release-cut/') ||
      file === 'docs/operations/release-process.md',
  );
  const commitSubjects = gitLines(['log', '--pretty=%s', `${mergeBase}..HEAD`]);
  if (releaseOnly || commitSubjects.every((subject) => /^chore\(release\):/i.test(subject))) return;

  const touchedWorkspaces = new Map();
  for (const file of changedFiles) {
    if (file.endsWith('/CHANGELOG.md')) continue;
    if (isTestOnlyChange(file)) continue;
    const workspace = workspaceForFile(file, repoRoot);
    if (!workspace) continue;
    const bucket = touchedWorkspaces.get(workspace) ?? { codeChanges: [], changelogTouched: false };
    bucket.codeChanges.push(file);
    touchedWorkspaces.set(workspace, bucket);
  }

  for (const file of changedFiles) {
    if (!file.endsWith('/CHANGELOG.md')) continue;
    const workspace = workspaceForFile(file, repoRoot);
    if (!workspace || !touchedWorkspaces.has(workspace)) continue;
    touchedWorkspaces.get(workspace).changelogTouched = true;
  }

  for (const [workspace, bucket] of touchedWorkspaces.entries()) {
    const changelogPath = `${workspace}/CHANGELOG.md`;
    if (!bucket.changelogTouched) {
      fail(
        `${workspace} code changed (${bucket.codeChanges.slice(0, 3).join(', ')}${bucket.codeChanges.length > 3 ? ', …' : ''}) but ${changelogPath} was not updated.`,
      );
      continue;
    }
    const diff = spawnSync('git', ['diff', `${mergeBase}...HEAD`, '--', changelogPath], {
      cwd: repoRoot,
      encoding: 'utf8',
    }).stdout;
    const bullets = addedMeaningfulBullets(diff);
    if (bullets.length === 0) {
      fail(
        `${changelogPath} must add at least one non-placeholder bullet under ## Unreleased for this PR.`,
      );
    }
  }
}

checkStructure();
if (prDiff) checkPrDiff();

if (failures.length > 0) {
  console.error(`Workspace changelog guard failed${prDiff ? ' (PR diff)' : ''}:`);
  for (const failure of failures) console.error(`- ${failure}`);
  process.exit(1);
}

console.log(`Workspace changelog guard passed${prDiff ? ' (PR diff)' : ''}.`);
