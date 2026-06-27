import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import {
  isRunBundleManifest,
  RUN_BUNDLE_VERSION,
  type RunBundleEntryMeta,
  type RunBundleExportRequest,
  type RunBundleExportResult,
  type RunBundleManifest,
  type RunBundleProfile,
  type RunBundleRunEntry,
  sanitizeRunForBundleExport,
  taskRelativePathFromAbsolute,
} from '@farmslot/protocol';

import { packFarmrunDirectory, writeBundleManifest } from './archive.js';
import { selectRunsForExport } from './collect.js';
import { copyDirectoryRecursive, registerDirectoryEntries } from './copy-tree.js';
import { sha256File, sha256Text } from './hashing.js';
import { resolveRunsDir, sanitizeBundleRunId } from './paths.js';

const PACKAGE_FILENAMES = [
  'reference.result-package.json',
  'candidate.result-package.json',
  'experiment-manifest.json',
];

function inferProfile(
  runCount: number,
  requested: RunBundleProfile | undefined,
  family: boolean,
): RunBundleProfile {
  if (requested) return requested;
  if (family) return 'family';
  return runCount > 1 ? 'family' : 'reference';
}

function collectPackagePaths(taskDir: string): string[] {
  const found: string[] = [];
  for (const name of PACKAGE_FILENAMES) {
    const direct = path.join(taskDir, 'artifacts', 'packages', name);
    if (existsSync(direct)) found.push(direct);
    const flat = path.join(taskDir, 'artifacts', name);
    if (existsSync(flat)) found.push(flat);
  }
  const experiment = path.join(taskDir, 'artifacts', 'experiment-manifest.json');
  if (existsSync(experiment)) found.push(experiment);
  return [...new Set(found)];
}

function addFileEntry(
  bundleDir: string,
  relativePath: string,
  sourcePath: string,
  entries: Record<string, RunBundleEntryMeta>,
): void {
  const destPath = path.join(bundleDir, relativePath);
  mkdirSync(path.dirname(destPath), { recursive: true });
  const content = readFileSync(sourcePath);
  writeFileSync(destPath, content);
  entries[relativePath] = {
    sha256: sha256File(destPath),
    bytes: content.byteLength,
    path: relativePath,
  };
}

export function exportRunsToBundle(
  request: RunBundleExportRequest & {
    outputPath: string;
    familyId?: string;
    positionalRunId?: string;
    runIds?: string[];
  },
): RunBundleExportResult {
  const runs = selectRunsForExport({
    farmslotRoot: request.farmslotRoot,
    runIds: request.runIds,
    familyId: request.familyId,
    positionalRunId: request.positionalRunId,
  });
  const profile = inferProfile(runs.length, request.profile, Boolean(request.familyId));
  const bundleDir = mkdtempSync(path.join(tmpdir(), 'farmrun-pack-'));
  const entries: Record<string, RunBundleEntryMeta> = {};
  const runEntries: RunBundleRunEntry[] = [];
  const missingData: string[] = [];

  try {
    mkdirSync(path.join(bundleDir, 'runs'), { recursive: true });
    mkdirSync(path.join(bundleDir, 'tasks'), { recursive: true });
    mkdirSync(path.join(bundleDir, 'packages'), { recursive: true });

    for (const run of runs) {
      const sanitized = sanitizeRunForBundleExport(run, profile);
      const runFile = `runs/${sanitizeBundleRunId(run.id)}.json`;
      const runJson = JSON.stringify(sanitized, null, 2);
      writeFileSync(path.join(bundleDir, runFile), runJson, 'utf-8');
      entries[runFile] = {
        sha256: sha256Text(runJson),
        bytes: Buffer.byteLength(runJson, 'utf-8'),
        path: runFile,
      };

      const entry: RunBundleRunEntry = {
        originalRunId: run.id,
        runPath: runFile,
      };

      const taskRelative = taskRelativePathFromAbsolute(request.farmslotRoot, run.taskFile);
      if (run.taskFile && existsSync(run.taskFile)) {
        const taskKey = sanitizeBundleRunId(run.id);
        const taskBundleDir = `tasks/${taskKey}`;
        copyDirectoryRecursive(path.dirname(run.taskFile), path.join(bundleDir, taskBundleDir));
        registerDirectoryEntries(bundleDir, taskBundleDir, entries);
        entry.taskKey = taskKey;
        entry.taskRelativePath = taskRelative ?? undefined;
        if (!taskRelative) missingData.push(`task-path-unrelocatable:${run.id}`);
        const packagePaths = collectPackagePaths(path.dirname(run.taskFile));
        if (packagePaths.length) {
          entry.packagePaths = packagePaths.map((packagePath) => {
            const rel = path.relative(path.dirname(run.taskFile!), packagePath).replace(/\\/g, '/');
            return `${taskBundleDir}/${rel}`;
          });
        }
      } else if (run.taskFile) {
        missingData.push(`task-dir-missing:${run.id}`);
      }

      if (profile === 'full') {
        const analyticsDir = path.join(resolveRunsDir(request.farmslotRoot), 'analytics');
        const analyticsFile = path.join(analyticsDir, `${run.id}.json`);
        if (existsSync(analyticsFile)) {
          const rel = `analytics/${sanitizeBundleRunId(run.id)}.json`;
          addFileEntry(bundleDir, rel, analyticsFile, entries);
        }
      }

      runEntries.push(entry);
    }

    const manifest: RunBundleManifest = {
      version: RUN_BUNDLE_VERSION,
      profile,
      exportedAt: new Date().toISOString(),
      bundleId: randomUUID(),
      source: {
        gatewayUrl: request.gatewayUrl,
        farmslotRoot: request.farmslotRoot,
        runIds: runs.map((run) => run.id),
      },
      remapPolicy: request.remapPolicy ?? 'remap-ids',
      runs: runEntries,
      entries,
      ...(missingData.length ? { missingData } : {}),
    };
    if (!isRunBundleManifest(manifest))
      throw new Error('Refusing to write invalid farmrun manifest');
    writeBundleManifest(bundleDir, `${JSON.stringify(manifest, null, 2)}\n`);
    packFarmrunDirectory(bundleDir, request.outputPath);
    return { manifest, outputPath: request.outputPath, runCount: runs.length };
  } finally {
    rmSync(bundleDir, { recursive: true, force: true });
  }
}

export function exportRunAsPackage(input: {
  farmslotRoot: string;
  runId: string;
  outputPath: string;
}): string {
  const runs = selectRunsForExport({
    farmslotRoot: input.farmslotRoot,
    positionalRunId: input.runId,
  });
  const run = runs[0];
  if (!run.taskFile || !existsSync(run.taskFile)) {
    throw new Error(`Run ${run.id} has no task directory to export a package from`);
  }
  const packagePaths = collectPackagePaths(path.dirname(run.taskFile));
  const candidate = packagePaths.find((candidatePath) => candidatePath.includes('result-package'));
  if (!candidate) {
    throw new Error(`Run ${run.id} has no result package artifact to export`);
  }
  const content = readFileSync(candidate, 'utf-8');
  writeFileSync(input.outputPath, content, 'utf-8');
  return input.outputPath;
}
