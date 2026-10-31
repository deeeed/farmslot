import { randomUUID } from 'node:crypto';
import {
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';

import {
  isRunBundleManifest,
  type Run,
  type RunBundleEntryMeta,
  type RunBundleImportMode,
  type RunBundleImportRequest,
  type RunBundleImportResult,
  type RunBundleManifest,
} from '@farmslot/protocol';
import { farmslotHome } from '@farmslot/protocol/node/farmslot-home';
import {
  assertApprovedTaskRestoreRelativePath,
  resolveTaskFileAbsolute,
  stripRunnerSessionArchives,
} from '@farmslot/protocol/runs/portable-bundle';

import { readBundleManifestFromDir, unpackFarmrunArchive } from './archive.js';
import { sha256File, sha256Text } from './hashing.js';
import { resolveRunsDir } from './paths.js';
import {
  isRunBundleMedia,
  materializeRunBundle,
  openRunBundleStore,
  type RunBundleStore,
} from './retained.js';
import {
  assertSafeBundleRelativePath,
  assertSafeBundleSegment,
  assertSafeRunId,
  resolvePathInsideRoot,
} from './safe-paths.js';

export function parseManifest(bundleDir: string): RunBundleManifest {
  const parsed = JSON.parse(readBundleManifestFromDir(bundleDir)) as unknown;
  if (!isRunBundleManifest(parsed)) throw new Error('Invalid farmrun manifest.json');
  return parsed;
}

function assertManifestEntryPathMatchesKey(key: string, meta: RunBundleEntryMeta): void {
  assertSafeBundleRelativePath(key);
  if (meta.path !== key) {
    throw new Error(`Bundle entry path alias not allowed: ${key} -> ${meta.path}`);
  }
}

function verifyEntries(bundleDir: string, manifest: RunBundleManifest): void {
  const bundleRoot = path.resolve(bundleDir);
  for (const [key, meta] of Object.entries(manifest.entries)) {
    assertManifestEntryPathMatchesKey(key, meta);
    const relative = key;
    const filePath = resolvePathInsideRoot(bundleRoot, relative);
    if (!existsSync(filePath)) {
      throw new Error(`Bundle entry missing on disk: ${relative}`);
    }
    const stats = statSync(filePath);
    if (!stats.isFile()) {
      throw new Error(`Bundle entry is not a file: ${relative}`);
    }
    if (stats.size !== meta.bytes) {
      throw new Error(`Bundle entry byte mismatch: ${relative}`);
    }
    const actualHash = sha256File(filePath);
    if (actualHash !== meta.sha256) {
      throw new Error(`Bundle entry hash mismatch: ${relative}`);
    }
  }
}

function loadBundledRun(bundleDir: string, runPath: string, manifest: RunBundleManifest): Run {
  assertSafeBundleRelativePath(runPath);
  const meta = manifest.entries[runPath];
  if (!meta) {
    throw new Error(`Bundle runPath not listed in manifest entries: ${runPath}`);
  }
  assertManifestEntryPathMatchesKey(runPath, meta);
  const filePath = resolvePathInsideRoot(path.resolve(bundleDir), runPath);
  const run = JSON.parse(readFileSync(filePath, 'utf-8')) as Run;
  // Imported audit metadata cannot become this gateway's verified override authority.
  delete run.claimOverrideReceipts;
  delete run.beforeAttemptAttestations;
  return run;
}

function assertNoUnlistedFilesInBundleSubtree(
  bundleDir: string,
  manifest: RunBundleManifest,
  relativeDir: string,
): void {
  const bundleRoot = path.resolve(bundleDir);
  const subtreeRoot = resolvePathInsideRoot(bundleRoot, relativeDir);
  if (!existsSync(subtreeRoot)) return;

  const walk = (currentDir: string): void => {
    for (const entry of readdirSync(currentDir)) {
      const sourcePath = path.join(currentDir, entry);
      const stats = statSync(sourcePath);
      if (stats.isDirectory()) {
        walk(sourcePath);
        continue;
      }
      if (!stats.isFile()) continue;
      const relative = path.relative(bundleRoot, sourcePath).replace(/\\/g, '/');
      if (!manifest.entries[relative]) {
        throw new Error(`Bundle contains unlisted file: ${relative}`);
      }
    }
  };
  walk(subtreeRoot);
}

function copyListedTaskTreeFiles(input: {
  bundleDir: string;
  manifest: RunBundleManifest;
  taskKey: string;
  destDir: string;
}): void {
  const prefix = `tasks/${input.taskKey}/`;
  const bundleRoot = path.resolve(input.bundleDir);
  mkdirSync(input.destDir, { recursive: true });
  for (const [key, meta] of Object.entries(input.manifest.entries)) {
    assertManifestEntryPathMatchesKey(key, meta);
    if (!key.startsWith(prefix)) continue;
    const suffix = key.slice(prefix.length);
    const sourcePath = resolvePathInsideRoot(bundleRoot, key);
    const destPath = path.join(input.destDir, suffix);
    mkdirSync(path.dirname(destPath), { recursive: true });
    cpSync(sourcePath, destPath);
  }
}

function persistRunRecord(runsDir: string, run: Run): void {
  assertSafeRunId(run.id);
  mkdirSync(runsDir, { recursive: true });
  const runsRoot = path.resolve(runsDir);
  const filePath = resolvePathInsideRoot(runsRoot, `${run.id}.json`);
  const tmpPath = `${filePath}.tmp.${process.pid}.${randomUUID().slice(0, 8)}`;
  writeFileSync(tmpPath, `${JSON.stringify(run, null, 2)}\n`, 'utf-8');
  renameSync(tmpPath, filePath);
}

function restoreTaskTree(input: {
  bundleDir: string;
  farmslotRoot: string;
  manifest: RunBundleManifest;
  taskKey: string;
  taskRelativePath?: string;
}): string | null {
  assertSafeBundleSegment(input.taskKey, 'task key');
  const taskBundleDir = path.join('tasks', input.taskKey).replace(/\\/g, '/');
  const sourceTaskDir = resolvePathInsideRoot(path.resolve(input.bundleDir), taskBundleDir);
  if (!existsSync(sourceTaskDir)) return null;
  assertNoUnlistedFilesInBundleSubtree(input.bundleDir, input.manifest, taskBundleDir);
  const taskRelative = input.taskRelativePath?.replace(/\\/g, '/');
  if (taskRelative) {
    assertApprovedTaskRestoreRelativePath(taskRelative);
  }
  const relativeDir = taskRelative
    ? path.dirname(taskRelative)
    : path.join('.sandbox', 'imported', 'tasks', input.taskKey).replace(/\\/g, '/');
  const destDir = resolvePathInsideRoot(path.resolve(input.farmslotRoot), relativeDir);
  copyListedTaskTreeFiles({
    bundleDir: input.bundleDir,
    manifest: input.manifest,
    taskKey: input.taskKey,
    destDir,
  });
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
  const nextId =
    mode === 'seed'
      ? randomUUID()
      : `ref-${sourceRunId.slice(0, 8)}-${randomUUID().replace(/-/g, '').slice(0, 12)}`;
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

function remapImportedRunLineage(
  run: Run,
  idMap: Record<string, string>,
  mode: RunBundleImportMode,
): Run {
  if (mode === 'mirror' || Object.keys(idMap).length === 0) return run;
  const next = { ...run };
  if (next.parentRunId && idMap[next.parentRunId]) {
    next.parentRunId = idMap[next.parentRunId];
  }
  if (next.redirectedToRunId && idMap[next.redirectedToRunId]) {
    next.redirectedToRunId = idMap[next.redirectedToRunId];
  }
  if (idMap[next.familyId]) {
    next.familyId = idMap[next.familyId];
  }
  return next;
}

function remapNestedRunIdReferences(run: Run, idMap: Record<string, string>): Run {
  if (Object.keys(idMap).length === 0) return run;
  const next = structuredClone(run);
  if (next.agentContexts) {
    for (const ctx of next.agentContexts) {
      if (idMap[ctx.runId]) ctx.runId = idMap[ctx.runId];
    }
  }
  if (next.liveRecipeContext?.recipeRunId && idMap[next.liveRecipeContext.recipeRunId]) {
    next.liveRecipeContext = {
      ...next.liveRecipeContext,
      recipeRunId: idMap[next.liveRecipeContext.recipeRunId],
    };
  }
  return next;
}

export async function importBundle(
  request: RunBundleImportRequest & { retentionStore?: RunBundleStore },
): Promise<RunBundleImportResult> {
  const bundleDir = unpackFarmrunArchive(request.bundlePath);
  try {
    const manifest = parseManifest(bundleDir);
    if (request.mode === 'mirror' && !request.force && manifest.runs.length > 1) {
      throw new Error(
        'mirror import refuses multi-entry bundles without --force — use seed or reference-only for sandboxes',
      );
    }
    verifyEntries(bundleDir, manifest);
    const runsDir = resolveRunsDir(request.farmslotRoot);
    const idMap: Record<string, string> = {};
    const importedRunIds: string[] = [];
    const packagePaths: string[] = [];
    const stagedRuns: Run[] = [];

    for (const entry of manifest.runs) {
      const bundled = loadBundledRun(bundleDir, entry.runPath, manifest);
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
          manifest,
          taskKey: entry.taskKey,
          taskRelativePath: entry.taskRelativePath,
        });
        if (taskFile) {
          next = { ...next, taskFile, activeTaskFile: taskFile };
        }
      } else if (request.mode === 'seed' || request.mode === 'reference-only') {
        next = { ...next, taskFile: null, activeTaskFile: undefined };
      }
      stagedRuns.push(next);
    }

    for (const staged of stagedRuns) {
      let next = remapNestedRunIdReferences(
        remapImportedRunLineage(staged, idMap, request.mode),
        idMap,
      );
      if (next.taskFile) {
        for (const name of ['reference.result-package.json', 'candidate.result-package.json']) {
          const candidate = path.join(path.dirname(next.taskFile), 'artifacts', 'packages', name);
          if (existsSync(candidate)) packagePaths.push(candidate);
        }
      }
      const entry = manifest.runs.find(
        (entry) => entry.originalRunId === staged.importProvenance?.importedFromRunId,
      );
      if (entry?.taskKey && next.taskFile) {
        const prefix = `tasks/${entry.taskKey}/`;
        const originals = new Map(
          (next.output?.artifactManifest ?? []).map((artifact) => [artifact.path, artifact]),
        );
        const artifacts = Object.entries(manifest.entries)
          .filter(([key]) => key.startsWith(prefix))
          .map(([key, meta]) => {
            const file = key.slice(prefix.length);
            return {
              ...originals.get(file),
              path: file,
              purpose: originals.get(file)?.purpose ?? 'artifact',
              sha256: meta.sha256,
              sizeBytes: meta.bytes,
            };
          });
        const store =
          request.retentionStore ??
          (await openRunBundleStore({
            runsDir,
            home: farmslotHome(),
            create: !process.env.FARMSLOT_RUNS_DIR && !process.env.FARMSLOT_SANDBOX_HOME,
          }));
        await materializeRunBundle({
          store,
          farmslotRoot: request.farmslotRoot,
          run: next,
          taskDir: path.dirname(next.taskFile),
          artifacts,
          stagingBytes: artifacts.reduce((bytes, artifact) => bytes + artifact.sizeBytes, 0) * 2,
          manifestDigest: next.output?.manifestDigest ?? sha256Text(JSON.stringify(artifacts)),
          captureKey: `import:${manifest.bundleId}:${next.id}`,
          commit: async (ref, missingData) => {
            next = {
              ...next,
              artifactBundle: ref,
              ...(next.output
                ? {
                    output: {
                      ...next.output,
                      artifactBundle: ref,
                      retentionMissingData: missingData,
                    },
                  }
                : {}),
              ...(next.importProvenance
                ? {
                    importProvenance: {
                      ...next.importProvenance,
                      artifactBundleRefs: Object.fromEntries(
                        (entry.artifactBundleDigests ?? []).map((source) => [source, ref]),
                      ),
                    },
                  }
                : {}),
            };
            persistRunRecord(runsDir, stripRunnerSessionArchives(next));
            for (const artifact of artifacts) {
              if (isRunBundleMedia(artifact.path))
                rmSync(path.join(path.dirname(next.taskFile!), artifact.path), { force: true });
            }
          },
        });
      } else {
        // Imported missing data stays unavailable; it never points back into the source gateway.
        delete next.artifactBundle;
        if (next.output) delete next.output.artifactBundle;
        persistRunRecord(runsDir, stripRunnerSessionArchives(next));
      }
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
