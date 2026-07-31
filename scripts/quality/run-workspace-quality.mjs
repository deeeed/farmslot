#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';

import {
  buildTimingArtifact,
  finish,
  isMainModule,
  renderTimingSummary,
  runTimedSteps,
  writeTimingArtifact,
} from './lib/step-timing.mjs';

export const TIMINGS_ARTIFACT_NAME = 'workspace-quality.json';

export const WORKSPACE_ROOTS = ['packages', 'services'];

export function workspaceDirs(rootName, repoRoot) {
  const root = path.join(repoRoot, rootName);
  if (!existsSync(root)) return [];
  return readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => `${rootName}/${entry.name}`)
    .filter((dir) => existsSync(path.join(repoRoot, dir, 'package.json')))
    .sort();
}

export function readWorkspace(relativeDir, repoRoot) {
  const pkg = JSON.parse(readFileSync(path.join(repoRoot, relativeDir, 'package.json'), 'utf8'));
  if (typeof pkg.name !== 'string' || pkg.name.trim() === '') {
    throw new Error(`${relativeDir}/package.json must declare a package name.`);
  }
  if (typeof pkg.scripts?.quality !== 'string' || pkg.scripts.quality.trim() === '') {
    throw new Error(`${relativeDir}/package.json must define a quality script.`);
  }
  return { name: pkg.name, relativeDir };
}

export function discoverWorkspaces(repoRoot) {
  return WORKSPACE_ROOTS.flatMap((root) => workspaceDirs(root, repoRoot))
    .map((dir) => readWorkspace(dir, repoRoot))
    .sort((a, b) => a.name.localeCompare(b.name));
}

/** Each workspace is one labelled step, so durations are reported per name. */
export function workspaceSteps(workspaces) {
  return workspaces.map((workspace) => [
    workspace.name,
    ['yarn', 'workspace', workspace.name, 'quality'],
  ]);
}

export function runWorkspaceQuality(workspaces, options = {}) {
  return runTimedSteps(workspaceSteps(workspaces), {
    prefix: 'workspace-quality',
    spawn: spawnSync,
    ...options,
  });
}

export function workspaceSummaryLines(records, failure) {
  return renderTimingSummary({ prefix: 'workspace-quality', records, failure });
}

export function workspaceTimingArtifact(records, failure) {
  return buildTimingArtifact({ kind: 'workspace-quality', records, failure });
}

function main() {
  const repoRoot = process.cwd();
  const workspaces = discoverWorkspaces(repoRoot);
  const { records, failure } = runWorkspaceQuality(workspaces, { cwd: repoRoot });
  for (const line of workspaceSummaryLines(records, failure)) console.log(line);
  const artifactPath = writeTimingArtifact(
    TIMINGS_ARTIFACT_NAME,
    workspaceTimingArtifact(records, failure),
  );
  if (artifactPath) console.log(`[workspace-quality] timings artifact: ${artifactPath}`);
  if (failure) {
    finish(failure.status);
    return;
  }
  console.log(`\nWorkspace quality passed for ${workspaces.length} package/service workspaces.`);
}

if (isMainModule(import.meta.url)) main();
