import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import type { Run } from '@farmslot/protocol';
import {
  isRunBundleManifest,
  type RunBundleImportRequest,
  type RunBundleImportResult,
  type RunBundleManifest,
} from '@farmslot/protocol';
import { resolveTaskFileAbsolute } from '@farmslot/protocol';

import { readBundleManifestFromDir, unpackFarmrunArchive } from './archive.js';
import { copyDirectoryRecursive } from './copy-tree.js';
import { resolveRunsDir } from './paths.js';

function parseManifest(bundleDir: string): RunBundleManifest {
  const parsed = JSON.parse(readBundleManifestFromDir(bundleDir)) as unknown;
  if (!isRunBundleManifest(parsed)) throw new Error('Invalid farmrun manifest.json');
  return parsed;
}

function verifyEntries(bundleDir: string, manifest: RunBundleManifest): void {
  for (const [key, meta] of Object.entries(manifest.entries)) {
    const filePath = path.join(bundleDir, meta.path ?? key);
    if (!existsSync(filePath)) {
      throw new Error(`Bundle entry missing on disk: ${meta.path ?? key}`);
    }
  }
}

function loadBundledRun(bundleDir: string, runPath: string): Run {
  return JSON.parse(readFileSync(path.join(bundleDir, runPath), 'utf-8')) as Run;
}

function persistRunRecord(runsDir: string, run: Run): void {
  mkdirSync(runsDir, { recursive: true });
  const filePath = path.join(runsDir, `${run.id}.json`);
  const tmpPath = `${filePath}.tmp.${process.pid}.${randomUUID().slice(0, 8)}`;
  writeFileSync(tmpPath, `${JSON.stringify(run, null, 2)}\n`, 'utf-8');
  renameSync(tmpPath, filePath);
}

function restoreTaskTree(input: {
  bundleDir: string;
  farmslotRoot: string;
  taskKey: string;
  taskRelativePath?: string;
}): string | null {
  const sourceTaskDir = path.join(input.bundleDir, 'tasks', input.taskKey);
  if (!existsSync(sourceTaskDir)) return null;
  const taskRelative = input.taskRelativePath?.replace(/\\/g, '/');
  const relativeDir = taskRelative
    ? path.dirname(taskRelative)
    : path.join('.sandbox', 'imported', 'tasks', input.taskKey).replace(/\\/g, '/');
  const destDir = path.join(input.farmslotRoot, relativeDir);
  copyDirectoryRecursive(sourceTaskDir, destDir);
  const taskFileRelative = taskRelative ?? `${relativeDir}/TASK.md`;
  return resolveTaskFileAbsolute(input.farmslotRoot, taskFileRelative);
}

function applyImportMode(
  run: Run,
  mode: RunBundleImportRequest['mode'],
  manifest: RunBundleManifest,
  idMap: Record<string, string>,
): Run {
  const importedAt = new Date().toISOString();
  const sourceRunId = run.id;
  if (mode === 'mirror') {
    return {
      ...run,
      importProvenance: {
        importedFromRunId: sourceRunId,
        importedAt,
        sourceFarmslotRoot: manifest.source.farmslotRoot,
        sourceGatewayUrl: manifest.source.gatewayUrl,
        bundleId: manifest.bundleId,
        mode,
      },
      readOnly: false,
    };
  }
  const nextId = mode === 'seed' ? randomUUID() : `ref-${sourceRunId.slice(0, 8)}-${randomUUID().slice(0, 8)}`;
  idMap[sourceRunId] = nextId;
  return {
    ...run,
    id: nextId,
    importProvenance: {
      importedFromRunId: sourceRunId,
      importedAt,
      sourceFarmslotRoot: manifest.source.farmslotRoot,
      sourceGatewayUrl: manifest.source.gatewayUrl,
      bundleId: manifest.bundleId,
      mode,
    },
    readOnly: mode === 'reference-only',
    monitorState: undefined,
    engineState:
      mode === 'reference-only'
        ? run.engineState?.evalExperiment
          ? { evalExperiment: run.engineState.evalExperiment }
          : undefined
        : run.engineState,
    status: mode === 'reference-only' ? 'done' : run.status,
  };
}

export function importBundle(request: RunBundleImportRequest): RunBundleImportResult {
  const bundleDir = unpackFarmrunArchive(request.bundlePath);
  try {
    const manifest = parseManifest(bundleDir);
    if (
      request.mode === 'mirror' &&
      !request.force &&
      manifest.runs.length > 1
    ) {
      throw new Error(
        'mirror import refuses multi-entry bundles without --force — use seed or reference-only for sandboxes',
      );
    }
    verifyEntries(bundleDir, manifest);
    const runsDir = resolveRunsDir(request.farmslotRoot);
    const idMap: Record<string, string> = {};
    const importedRunIds: string[] = [];
    const packagePaths: string[] = [];

    for (const entry of manifest.runs) {
      const bundled = loadBundledRun(bundleDir, entry.runPath);
      const existingPath = path.join(runsDir, `${bundled.id}.json`);
      if (request.mode === 'mirror' && existsSync(existingPath) && !request.force) {
        throw new Error(
          `mirror import refused: run id ${bundled.id} already exists — pass --force to overwrite`,
        );
      }

      let next = applyImportMode(bundled, request.mode, manifest, idMap);
      if (entry.taskKey) {
        const taskFile = restoreTaskTree({
          bundleDir,
          farmslotRoot: request.farmslotRoot,
          taskKey: entry.taskKey,
          taskRelativePath: entry.taskRelativePath,
        });
        if (taskFile) {
          next = { ...next, taskFile, activeTaskFile: taskFile };
        }
      }
      if (next.taskFile) {
        for (const name of ['reference.result-package.json', 'candidate.result-package.json']) {
          const candidate = path.join(path.dirname(next.taskFile), 'artifacts', 'packages', name);
          if (existsSync(candidate)) packagePaths.push(candidate);
        }
      }
      persistRunRecord(runsDir, next);
      importedRunIds.push(next.id);
    }

    return { manifest, importedRunIds, idMap, packagePaths };
  } finally {
    const parent = path.dirname(bundleDir);
    if (parent.includes('farmrun-unpack-')) rmSync(parent, { recursive: true, force: true });
  }
}

export function listBundle(bundlePath: string): RunBundleManifest {
  const bundleDir = unpackFarmrunArchive(bundlePath);
  try {
    const manifest = parseManifest(bundleDir);
    verifyEntries(bundleDir, manifest);
    return manifest;
  } finally {
    const parent = path.dirname(bundleDir);
    if (parent.includes('farmrun-unpack-')) rmSync(parent, { recursive: true, force: true });
  }
}