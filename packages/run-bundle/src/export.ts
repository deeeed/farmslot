import { randomUUID } from 'node:crypto';
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import {
  canonicalRecipeJson,
  isRunBundleManifest,
  isTaskDebrief,
  type Run,
  RUN_BUNDLE_VERSION,
  type RunArtifactBundleRef,
  type RunBundleEntryMeta,
  type RunBundleExportRequest,
  type RunBundleExportResult,
  type RunBundleManifest,
  type RunBundleProfile,
  type RunBundleRunEntry,
  TASK_DIRECTORY_LAYOUT,
} from '@farmslot/protocol';
import { farmslotHome } from '@farmslot/protocol/node/farmslot-home';
import {
  sanitizeRunForBundleExport,
  strictTaskRelativePathFromFarmslotRoot,
} from '@farmslot/protocol/runs/portable-bundle';

import { packFarmrunDirectory, writeBundleManifest } from './archive.js';
import { selectRunsForExport } from './collect.js';
import { copyDirectoryRecursive, registerDirectoryEntries } from './copy-tree.js';
import { captureDecisionHistoryPrefix, decisionHistoryFile } from './decision-history.js';
import { sha256File, sha256Text } from './hashing.js';
import { resolveRunsDir, sanitizeBundleRunId } from './paths.js';
import {
  openRunBundleStore,
  readRetainedRunBundle,
  resolveRunBundleEntry,
  runBundleDebriefDirectory,
} from './retained.js';

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
  content: Buffer = readFileSync(sourcePath),
): void {
  const destPath = path.join(bundleDir, relativePath);
  mkdirSync(path.dirname(destPath), { recursive: true });
  writeFileSync(destPath, content);
  entries[relativePath] = {
    sha256: sha256File(destPath),
    bytes: content.byteLength,
    path: relativePath,
  };
}

function currentDebriefBytes(
  storeRoot: string,
  run: Run,
  ref: RunArtifactBundleRef,
): { file: string; bytes: Buffer } | undefined {
  const journal = run.taskDebrief;
  if (
    journal?.status !== 'settled' ||
    journal.bundle.bundleDigest !== ref.bundleDigest ||
    !run.agentContexts?.some(
      ({ id, signalAttemptId }) =>
        id === journal.contextId && signalAttemptId === journal.attemptId,
    )
  )
    return undefined;
  const file = path.join(
    runBundleDebriefDirectory(storeRoot, run.id, ref.bundleDigest),
    TASK_DIRECTORY_LAYOUT.debrief.relativePath,
  );
  if (!existsSync(file)) return undefined;
  const stat = lstatSync(file);
  if (
    !stat.isFile() ||
    stat.size > 4 * 1024 * 1024 ||
    !realpathSync(file).startsWith(realpathSync(storeRoot) + path.sep)
  )
    throw new Error('Retained debrief lies outside its bundle or exceeds its size limit.');
  const bytes = readFileSync(file);
  const value: unknown = JSON.parse(bytes.toString('utf8'));
  if (
    !isTaskDebrief(value) ||
    value.debriefId !== journal.debriefId ||
    value.identity.runId !== run.id ||
    value.identity.attemptId !== journal.attemptId
  )
    throw new Error('Retained debrief does not match the exported attempt.');
  const { recordDigest, ...body } = value;
  if (sha256Text(canonicalRecipeJson(body)) !== recordDigest)
    throw new Error('Retained debrief failed its recorded digest.');
  return { file, bytes };
}

export async function exportRunsToBundle(
  request: RunBundleExportRequest & {
    outputPath: string;
    familyId?: string;
    positionalRunId?: string;
    runIds?: string[];
  },
): Promise<RunBundleExportResult> {
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
      const runsDir = resolveRunsDir(request.farmslotRoot);
      const record = path.join(runsDir, `${run.id}.json`);
      const history = decisionHistoryFile(
        existsSync(record) ? record : path.join(runsDir, 'archive', `${run.id}.json`),
      );
      if (run.decisionHistoryCount && !existsSync(history))
        throw new Error(`Decision history missing for run ${run.id}`);
      if (existsSync(history)) {
        const prefix = captureDecisionHistoryPrefix(history);
        addFileEntry(bundleDir, decisionHistoryFile(runFile), history, entries, prefix);
        sanitized.decisionHistoryCount = prefix.toString('utf8').split('\n').length - 1;
      }
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

      const taskRelative = strictTaskRelativePathFromFarmslotRoot(
        request.farmslotRoot,
        run.taskFile,
      );
      const ref = run.artifactBundle ?? run.output?.artifactBundle;
      if (ref) {
        const store = await openRunBundleStore({
          runsDir: resolveRunsDir(request.farmslotRoot),
          home: farmslotHome(),
        });
        const retained = await readRetainedRunBundle(store, ref, run.id);
        const taskKey = sanitizeBundleRunId(run.id);
        const taskBundleDir = `tasks/${taskKey}`;
        copyDirectoryRecursive(retained.taskDir, path.join(bundleDir, taskBundleDir));
        registerDirectoryEntries(bundleDir, taskBundleDir, entries);
        const debrief = currentDebriefBytes(store.root, run, ref);
        if (debrief) {
          const relative = `${taskBundleDir}/${TASK_DIRECTORY_LAYOUT.debrief.relativePath}`;
          addFileEntry(bundleDir, relative, debrief.file, entries, debrief.bytes);
        }
        entry.taskKey = taskKey;
        entry.artifactBundleDigests = [
          ref.bundleDigest,
          ...Object.entries(run.importProvenance?.artifactBundleRefs ?? {})
            .filter(([, target]) => target.bundleDigest === ref.bundleDigest)
            .map(([source]) => source),
        ];
        entry.taskRelativePath = taskRelative ?? undefined;
        const packagePaths = collectPackagePaths(retained.taskDir);
        if (packagePaths.length)
          entry.packagePaths = packagePaths.map(
            (file) =>
              `${taskBundleDir}/${path.relative(retained.taskDir, file).replaceAll('\\', '/')}`,
          );
        missingData.push(
          ...(retained.manifest.missingData ?? []).map((item) => `${run.id}:${item}`),
        );
        for (const [key] of Object.entries(retained.manifest.entries)) {
          const prefix = `tasks/${ref.taskKey}/`;
          if (!key.startsWith(prefix)) continue;
          const relative = key.slice(prefix.length);
          const targetKey = `${taskBundleDir}/${relative}`;
          if (entries[targetKey]) continue;
          try {
            const archived = await retained.resolveEntry(relative);
            addFileEntry(bundleDir, targetKey, archived.path, entries);
          } catch (error) {
            if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT'))
              throw error;
            missingData.push(`retained-payload-missing:${run.id}:${relative}`);
          }
        }
        for (const decision of run.decisions) {
          const pinned =
            decision.payload?.kind === 'ready'
              ? decision.payload.prPackage?.artifactBundle
              : decision.payload?.kind === 'output-review'
                ? decision.payload.artifactBundle
                : undefined;
          if (pinned && !entry.artifactBundleDigests.includes(pinned.bundleDigest))
            missingData.push(`historical-capture-not-exported:${run.id}:${pinned.bundleDigest}`);
        }
      } else {
        missingData.push(`retention-missing:${run.id}`);
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

export async function exportRunAsPackage(input: {
  farmslotRoot: string;
  runId: string;
  outputPath: string;
}): Promise<string> {
  const runs = selectRunsForExport({
    farmslotRoot: input.farmslotRoot,
    positionalRunId: input.runId,
  });
  const run = runs[0];
  const ref = run.artifactBundle ?? run.output?.artifactBundle;
  if (!ref)
    throw new Error(
      `Run ${run.id} has no retained bundle. Run farmslot runs bundle retain ${run.id}.`,
    );
  const store = await openRunBundleStore({
    runsDir: resolveRunsDir(input.farmslotRoot),
    home: farmslotHome(),
  });
  const retained = await readRetainedRunBundle(store, ref, run.id);
  const packagePaths = collectPackagePaths(retained.taskDir);
  const candidate = packagePaths.find((candidatePath) => candidatePath.includes('result-package'));
  if (!candidate) {
    throw new Error(`Run ${run.id} has no result package artifact to export`);
  }
  await resolveRunBundleEntry({
    store,
    ref,
    runId: run.id,
    path: path.relative(retained.taskDir, candidate).replaceAll('\\', '/'),
  });
  const content = readFileSync(candidate, 'utf-8');
  writeFileSync(input.outputPath, content, 'utf-8');
  return input.outputPath;
}
