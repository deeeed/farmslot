import { createHash } from 'node:crypto';
import { createReadStream, existsSync } from 'node:fs';
import { lstat, readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';

import {
  type ArtifactRef,
  DEFAULT_TASK_DIR,
  hasLiveRecipeEvidence,
  isRecipeQualityArtifact,
  type LiveRecipeContext,
  type RecipeQualityArtifact,
  type RecipeRunArtifactGroup,
  type RecipeRunArtifactGroupStatus,
  type Run,
  validateArtifactManifestDocument,
} from '@farmslot/protocol';

import {
  getOrchestratorTaskRoot,
  loadProjectVars,
  loadSlotVars,
  resolveProjectTaskDirName,
  resolveTaskRelDir,
} from '../core/config.js';
import {
  inferArtifactPurpose,
  inferTypedArtifactPurpose,
  type LatestValidRecipeRunPointer,
  sanitizeLatestValidRecipeRunPointer,
} from '../core/recipe-artifacts.js';
import { MAX_ARTIFACT_TREE_DEPTH, slotReadFile } from '../core/slot-io.js';
import { getNode } from '../fleet/machine-registry.js';
import { getSlotLocality, sendNodeRequest } from '../fleet/node-rpc.js';
import { loadRecipeQualityEvaluation } from '../quality/recipe-quality.js';

import {
  artifactScanFilters,
  type ArtifactScanOptions,
  extractEvidenceManifestReferencedPaths,
  shouldIncludeArtifactFile,
  shouldSkipArtifactName,
  shouldVisitArtifactDirectory,
} from './artifact-filters.js';

interface ArtifactScanResult {
  refs: ArtifactRef[];
  unavailable: boolean;
}

async function sha256File(filePath: string): Promise<string> {
  const hash = createHash('sha256');
  await new Promise<void>((resolve, reject) => {
    const stream = createReadStream(filePath);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('error', reject);
    stream.on('end', resolve);
  });
  return hash.digest('hex');
}

async function sha256SlotFile(
  node: NonNullable<ReturnType<typeof getNode>>,
  root: string,
  fullPath: string,
): Promise<{ sha256: string; sizeBytes: number }> {
  try {
    const hashResult = (await sendNodeRequest(node, 'fs.hash', {
      root,
      relPath: path.relative(root, fullPath),
    })) as {
      sha256: string;
      size: number;
    };
    return { sha256: hashResult.sha256, sizeBytes: hashResult.size };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (!message.includes('Unknown method: fs.hash') && !message.includes('unexpected method')) {
      throw error;
    }
    const fileResult = (await sendNodeRequest(node, 'fs.readBase64', {
      root,
      relPath: path.relative(root, fullPath),
    })) as { content: string; size?: number };
    const bytes = Buffer.from(fileResult.content, 'base64');
    return {
      sha256: createHash('sha256').update(bytes).digest('hex'),
      sizeBytes: typeof fileResult.size === 'number' ? fileResult.size : bytes.length,
    };
  }
}

interface LoadContextOptions {
  artifactRoot: string;
  run: Run;
  source: LiveRecipeContext['source'];
  selectionReason: LiveRecipeContext['selectionReason'];
  recipeRunId: string | null;
  isStale: boolean;
  scanOptions?: ArtifactScanOptions;
  allowUnavailableAsStale?: boolean;
}

function logJsonParseFailure(context: string, error: unknown): void {
  const message = error instanceof Error ? error.message : String(error);
  console.warn(`[live-recipe-context] failed to parse ${context}: ${message}`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function isRecipeRunArtifactRootForBase(artifactRoot: string, baseRoot: string): boolean {
  const normalizedArtifactRoot = path.resolve(artifactRoot);
  const recipeRunsRoot = path.resolve(baseRoot, 'recipe-runs');
  const relativeRoot = path.relative(recipeRunsRoot, normalizedArtifactRoot);
  return relativeRoot === '' || (!relativeRoot.startsWith('..') && !path.isAbsolute(relativeRoot));
}

function isPathWithinBase(targetPath: string, basePath: string): boolean {
  const relativePath = path.relative(path.resolve(basePath), path.resolve(targetPath));
  return relativePath === '' || (!relativePath.startsWith('..') && !path.isAbsolute(relativePath));
}

async function readSummaryStatusPortable(
  run: Run,
  artifactRoot: string,
): Promise<RecipeRunArtifactGroupStatus> {
  const summaryPath = path.join(artifactRoot, 'summary.json');
  const raw = await readPortableTextIfExists(run, summaryPath);
  if (!raw) return 'unknown';
  try {
    const summary = JSON.parse(raw) as { status?: string };
    if (summary.status === 'pass') return 'pass';
    if (summary.status === 'fail') return 'fail';
    if (typeof summary.status === 'string') {
      console.warn(
        `[live-recipe-context] unexpected summary status in ${summaryPath}: ${summary.status}`,
      );
    }
  } catch (error) {
    logJsonParseFailure(summaryPath, error);
    return 'unknown';
  }
  return 'unknown';
}

async function readTextIfExists(filePath: string): Promise<string | null> {
  try {
    return await readFile(filePath, 'utf-8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') return null;
    return null;
  }
}

// Narrow the per-call context so callers can't accidentally drop fields the
// disk-resolution chain reads (slotId via shouldPreferLocalPortableArtifacts,
// taskFile via resolveRemotePortableArtifactPath, project via resolveWorkerTaskDir
// → loadProjectVars). Without `project`, custom `task_dir` projects silently
// fall back to DEFAULT_TASK_DIR and resolve to the wrong worker subdir — a
// latent bug round-5 review caught on the family-observability cast path.
type LiveRecipeReadCtx = Pick<Run, 'slotId' | 'taskFile' | 'project'>;

async function shouldPreferLocalPortableArtifacts(
  run: LiveRecipeReadCtx,
  filePath: string,
): Promise<boolean> {
  if (!run.slotId) return true;
  const locality = await getSlotLocality(run.slotId).catch(() => null);
  if (!locality) return true;
  const { isLocal } = locality;
  if (isLocal) return true;
  if (!run.taskFile) return false;
  const localArtifactsRoot = path.join(path.dirname(run.taskFile), 'artifacts');
  return isPathWithinBase(filePath, localArtifactsRoot);
}

async function resolveRemotePortableArtifactPath(
  run: LiveRecipeReadCtx,
  filePath: string,
): Promise<string | null> {
  if (!run.slotId || !run.taskFile) return null;
  const locality = await getSlotLocality(run.slotId).catch(() => null);
  if (!locality || locality.isLocal) return filePath;
  const workerTaskDir = await resolveWorkerTaskDir(run);
  if (!workerTaskDir) return null;
  const localArtifactsRoot = path.join(path.dirname(run.taskFile), 'artifacts');
  if (!isPathWithinBase(filePath, localArtifactsRoot)) return filePath;
  return path.join(workerTaskDir, 'artifacts', path.relative(localArtifactsRoot, filePath));
}

// Per-file TTL cache for the live-recipe-context artifact reads. Wraps
// `readPortableTextIfExists` so a slot panel open — which fans out to many
// gateway methods (run.get, runForSlot, runRecipeRunsForSlot, recipeListGroups,
// fsServeRunArtifact), each calling `attachLiveRecipeContext` and each in turn
// reading recipe.json + learnings.md + recipe-quality.json + summary.json —
// only fires one WS round trip per artifact per `ARTIFACT_TEXT_CACHE_TTL_MS`.
// Positives and negatives both cached so a missing file doesn't re-fire either.
// Mirrors the pointer-cache style at line 302; sits alongside it.
//
// Cache keys embed slotId so two remote slots on different machines that share
// a repo/task path (e.g. mini vs runner-a with the same `~/dev/example-app/...`
// checkout) don't poison each other's reads. `slotReadFile` resolves to the
// per-slot node WS, so the same `filePath` returns different content per slot.
const ARTIFACT_TEXT_CACHE_TTL_MS = 5_000;
const artifactTextCache = new Map<string, { value: string | null; at: number }>();

// Use NUL as the separator since neither slotId regex (`[a-z0-9-]+`) nor
// filesystem paths (POSIX rejects NUL) can contain it — guarantees no collision
// even if a slotId convention ever changes. `__null__` sentinel disambiguates
// `slotId === null` from a real slot literally named `'local'`.
const CACHE_KEY_SEPARATOR = '\x00';
const NULL_SLOT_SENTINEL = '__null__';

function cacheKey(slotId: string | null | undefined, filePath: string): string {
  return `${slotId ?? NULL_SLOT_SENTINEL}${CACHE_KEY_SEPARATOR}${filePath}`;
}

function splitCacheKey(key: string): { slotId: string; filePath: string } | null {
  const sep = key.indexOf(CACHE_KEY_SEPARATOR);
  if (sep < 0) return null;
  return { slotId: key.slice(0, sep), filePath: key.slice(sep + 1) };
}

export function invalidateArtifactTextCache(prefix?: string, slotId?: string | null): void {
  if (!prefix && slotId === undefined) {
    artifactTextCache.clear();
    return;
  }
  const slotKey = slotId === undefined ? null : (slotId ?? NULL_SLOT_SENTINEL);
  for (const key of [...artifactTextCache.keys()]) {
    const parts = splitCacheKey(key);
    if (!parts) continue;
    if (slotKey !== null && parts.slotId !== slotKey) continue;
    // Use isPathWithinBase — startsWith would false-positive `/foo/barbaz` against `/foo/bar`.
    if (prefix && !isPathWithinBase(parts.filePath, prefix)) continue;
    artifactTextCache.delete(key);
  }
}

export async function readPortableTextIfExists(
  run: LiveRecipeReadCtx,
  filePath: string,
): Promise<string | null> {
  const key = cacheKey(run.slotId, filePath);
  const cached = artifactTextCache.get(key);
  if (cached && Date.now() - cached.at < ARTIFACT_TEXT_CACHE_TTL_MS) return cached.value;
  const value = await readPortableTextIfExistsUncached(run, filePath);
  artifactTextCache.set(key, { value, at: Date.now() });
  return value;
}

async function readPortableTextIfExistsUncached(
  run: LiveRecipeReadCtx,
  filePath: string,
): Promise<string | null> {
  if (await shouldPreferLocalPortableArtifacts(run, filePath)) {
    const remoteFilePath = await resolveRemotePortableArtifactPath(run, filePath);
    if (run.slotId) {
      const locality = await getSlotLocality(run.slotId).catch(() => null);
      if (locality && !locality.isLocal) {
        const remoteText = await readSlotTextIfExists(run, remoteFilePath ?? filePath);
        if (remoteText !== null) return remoteText;
        return readTextIfExists(filePath);
      }
    }
    const localText = await readTextIfExists(filePath);
    if (localText !== null) return localText;
    return readSlotTextIfExists(run, remoteFilePath ?? filePath);
  }
  return readSlotTextIfExists(run, filePath);
}

function portableWorkerQualityArtifactIsStale(
  artifact: RecipeQualityArtifact | null,
  hasCurrentRecipeSources: boolean,
): boolean {
  return Boolean(artifact?.meta.producer === 'worker' && hasCurrentRecipeSources);
}

async function scanSlotArtifactRoot(
  artifactRoot: string,
  run: Run,
  options: ArtifactScanOptions = {},
): Promise<ArtifactRef[] | null> {
  if (!run.slotId) return null;
  try {
    const vars = await loadSlotVars(run.slotId);
    const node = getNode(vars.machine);
    if (!node) {
      console.warn(
        `[live-recipe-context] no node connected for ${vars.machine} while scanning ${run.id.slice(0, 8)}`,
      );
      return null;
    }
    const connectedNode = node;
    const { excludedTopLevel, includedRelativePaths } = artifactScanFilters(options);
    const refs: ArtifactRef[] = [];

    async function walk(dirPath: string, depth = 0): Promise<void> {
      if (depth > MAX_ARTIFACT_TREE_DEPTH)
        throw new Error(`slot artifact scan exceeded max depth under ${dirPath}`);
      const listResult = (await sendNodeRequest(connectedNode, 'fs.list', {
        root: artifactRoot,
        relPath: path.relative(artifactRoot, dirPath) || '.',
      })) as {
        entries: Array<{ name: string; type: string; size?: number }>;
      };
      for (const entry of listResult.entries) {
        if (shouldSkipArtifactName(entry.name)) continue;
        const fullPath = path.join(dirPath, entry.name);
        const relativePath = path.relative(artifactRoot, fullPath);
        if (entry.type === 'file') {
          if (!shouldIncludeArtifactFile(relativePath, excludedTopLevel, includedRelativePaths)) {
            continue;
          }
          const digest = await sha256SlotFile(connectedNode, artifactRoot, fullPath);
          refs.push({
            path: `artifacts/${relativePath}`,
            purpose: inferArtifactPurpose(relativePath),
            sizeBytes: typeof entry.size === 'number' ? entry.size : digest.sizeBytes,
            sha256: digest.sha256,
          });
          continue;
        }
        if (entry.type === 'directory' || entry.type === 'dir') {
          if (
            !shouldVisitArtifactDirectory(relativePath, excludedTopLevel, includedRelativePaths)
          ) {
            continue;
          }
          await walk(fullPath, depth + 1);
        }
      }
    }

    await walk(artifactRoot);
    return refs.length > 0 ? refs : null;
  } catch (error) {
    console.warn(
      `[live-recipe-context] scanSlotArtifactRoot failed for ${run.id.slice(0, 8)}: ${error instanceof Error ? error.message : String(error)}`,
    );
    return null;
  }
}

async function scanSlotArtifactRootDetailed(
  artifactRoot: string,
  run: Run,
  options: ArtifactScanOptions = {},
): Promise<ArtifactScanResult> {
  const refs = await scanSlotArtifactRoot(artifactRoot, run, options);
  if (refs !== null) return { refs, unavailable: false };
  if (!run.slotId) return { refs: [], unavailable: false };
  const locality = await getSlotLocality(run.slotId).catch(() => null);
  if (!locality || locality.isLocal) return { refs: [], unavailable: false };
  return { refs: [], unavailable: true };
}

async function readSlotTextIfExists(
  run: LiveRecipeReadCtx,
  filePath: string,
): Promise<string | null> {
  if (!run.slotId) return null;
  try {
    const vars = await loadSlotVars(run.slotId);
    return await slotReadFile(vars, filePath);
  } catch {
    return null;
  }
}

async function readRecipeQualityArtifactPortable(
  run: LiveRecipeReadCtx,
  filePath: string,
): Promise<RecipeQualityArtifact | null> {
  const raw = await readPortableTextIfExists(run, filePath);
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!isRecipeQualityArtifact(parsed)) {
      console.warn(`[live-recipe-context] invalid recipe quality artifact at ${filePath}`);
      return null;
    }
    return parsed;
  } catch (error) {
    logJsonParseFailure(filePath, error);
    return null;
  }
}

function normalizeTypedArtifactManifestPath(value: string): string | null {
  const normalizedSeparators = value.replaceAll('\\', '/').trim();
  if (!normalizedSeparators) return null;
  if (normalizedSeparators.startsWith('/') || /^[A-Za-z]:/.test(normalizedSeparators)) return null;
  if (normalizedSeparators === 'artifacts') return null;
  // The v1 protocol defines paths relative to the artifact directory. Accepting
  // a leading `artifacts/` keeps early runner output compatible without ever
  // materializing `artifacts/artifacts/...` paths.
  const withoutArtifactPrefix = normalizedSeparators.startsWith('artifacts/')
    ? normalizedSeparators.slice('artifacts/'.length)
    : normalizedSeparators;
  if (!withoutArtifactPrefix || withoutArtifactPrefix === '.') return null;
  if (withoutArtifactPrefix.split('/').some((segment) => segment === '..')) return null;
  // Explicit relative prefixes like `./screenshots/proof.png` are okay;
  // traversal and absolute paths remain rejected after normalization.
  const normalized = path.posix.normalize(withoutArtifactPrefix);
  if (normalized === '.' || normalized.startsWith('../') || path.posix.isAbsolute(normalized)) {
    return null;
  }
  return `artifacts/${normalized}`;
}

function parseTypedArtifactManifestRefs(
  raw: string | null,
  manifestPath: string,
): ArtifactRef[] | null {
  if (!raw) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    logJsonParseFailure(manifestPath, error);
    return null;
  }
  if (!isRecord(parsed)) {
    console.warn(`[live-recipe-context] invalid artifact-manifest.json at ${manifestPath}`);
    return null;
  }
  const validation = validateArtifactManifestDocument(parsed);
  if (validation.status !== 'valid') {
    const findings = validation.findings
      .filter((finding) => finding.severity === 'error')
      .slice(0, 5)
      .map((finding) => `${finding.code}@${finding.path}`)
      .join('; ');
    console.warn(
      `[live-recipe-context] invalid artifact-manifest.json at ${manifestPath}${findings ? `: ${findings}` : ''}`,
    );
    return null;
  }
  const manifest = parsed as { artifacts: unknown[] };
  const refs: ArtifactRef[] = [];
  for (const [index, entry] of manifest.artifacts.entries()) {
    if (!isRecord(entry)) {
      console.warn(
        `[live-recipe-context] rejecting artifact-manifest.json at ${manifestPath}: entry ${index} is invalid; falling back to scan`,
      );
      return null;
    }
    const entryType = typeof entry.type === 'string' ? entry.type.trim() : '';
    if (typeof entry.path !== 'string' || !entryType) {
      console.warn(
        `[live-recipe-context] rejecting artifact-manifest.json at ${manifestPath}: entry ${index} is incomplete; falling back to scan`,
      );
      return null;
    }
    const artifactPath = normalizeTypedArtifactManifestPath(entry.path);
    if (!artifactPath) {
      console.warn(
        `[live-recipe-context] rejecting artifact-manifest.json at ${manifestPath}: entry ${index} path ${entry.path} is invalid; falling back to scan`,
      );
      return null;
    }
    const relativeArtifactPath = artifactPath.replace(/^artifacts\//, '');
    refs.push({
      path: artifactPath,
      purpose: inferTypedArtifactPurpose(entryType, relativeArtifactPath),
      type: entryType,
      ...(typeof entry.label === 'string' ? { label: entry.label } : {}),
      ...(typeof entry.nodeId === 'string' ? { nodeId: entry.nodeId } : {}),
      ...(typeof entry.mimeType === 'string' ? { mimeType: entry.mimeType } : {}),
      ...(typeof entry.maxFps === 'number' && Number.isFinite(entry.maxFps) && entry.maxFps > 0
        ? { maxFps: entry.maxFps }
        : {}),
    });
  }
  return refs;
}

function mergeTypedArtifactManifestRefs(
  scannedRefs: ArtifactRef[],
  typedRefs: ArtifactRef[] | null,
): ArtifactRef[] {
  if (typedRefs === null) return scannedRefs;
  if (typedRefs.length === 0) return scannedRefs;
  const scannedByPath = new Map<string, ArtifactRef>();
  const emitted = new Set<string>();
  for (const ref of scannedRefs) scannedByPath.set(ref.path, ref);
  const refs: ArtifactRef[] = [];
  for (const typedRef of typedRefs) {
    if (emitted.has(typedRef.path)) continue;
    emitted.add(typedRef.path);
    const scanned = scannedByPath.get(typedRef.path);
    // Keep manifest-declared refs even before the scanner can see the bytes:
    // live/remote runs may publish the typed index first and materialize large
    // artifacts moments later. The existing artifact preview path handles 404s
    // while the next mirror/refresh picks up size/hash metadata. When scanned
    // bytes do exist, the scanner remains the source of truth for hash/size;
    // if artifact-manifest.json later grows hash/size fields, do not let
    // manifest-declared values override scanner-verified filesystem facts.
    refs.push({
      ...scanned,
      ...typedRef,
      ...(scanned?.sha256 ? { sha256: scanned.sha256 } : {}),
      ...(typeof scanned?.sizeBytes === 'number' ? { sizeBytes: scanned.sizeBytes } : {}),
    });
  }
  return refs;
}

async function scanLocalArtifactRoot(
  artifactRoot: string,
  options: ArtifactScanOptions = {},
): Promise<ArtifactRef[]> {
  const refs: ArtifactRef[] = [];
  const { excludedTopLevel, includedRelativePaths } = artifactScanFilters(options);
  async function walk(dir: string, relativeDir = '') {
    let entries: string[] = [];
    try {
      entries = await readdir(dir);
    } catch {
      return;
    }
    for (const name of entries) {
      if (shouldSkipArtifactName(name)) continue;
      const full = path.join(dir, name);
      const relativePath = path.relative(artifactRoot, full);
      try {
        const s = await lstat(full);
        if (s.isSymbolicLink()) {
          continue;
        }
        if (s.isDirectory()) {
          if (
            !shouldVisitArtifactDirectory(relativePath, excludedTopLevel, includedRelativePaths)
          ) {
            continue;
          }
          await walk(full, relativeDir ? path.join(relativeDir, name) : name);
        } else if (s.isFile()) {
          if (!shouldIncludeArtifactFile(relativePath, excludedTopLevel, includedRelativePaths)) {
            continue;
          }
          refs.push({
            path: `artifacts/${relativePath}`,
            purpose: inferArtifactPurpose(relativePath),
            sizeBytes: s.size,
            sha256: await sha256File(full),
          });
        }
      } catch {
        /* skip unreadable */
      }
    }
  }
  await walk(artifactRoot);
  return refs;
}

async function scanArtifactRootPortable(
  artifactRoot: string,
  run: Run,
  options: ArtifactScanOptions = {},
): Promise<ArtifactScanResult> {
  if (await shouldPreferLocalPortableArtifacts(run, artifactRoot)) {
    const remoteArtifactRoot = await resolveRemotePortableArtifactPath(run, artifactRoot);
    if (existsSync(artifactRoot)) {
      const localRefs = await scanLocalArtifactRoot(artifactRoot, options);
      if (!remoteArtifactRoot || remoteArtifactRoot === artifactRoot) {
        return { refs: localRefs, unavailable: false };
      }
      const remoteScan = await scanSlotArtifactRootDetailed(remoteArtifactRoot, run, options);
      if (remoteScan.unavailable) return { refs: localRefs, unavailable: true };
      if (!remoteScan.refs.length) return { refs: localRefs, unavailable: false };
      const merged = new Map<string, ArtifactRef>();
      for (const ref of localRefs) merged.set(ref.path, ref);
      for (const ref of remoteScan.refs) {
        if (!merged.has(ref.path)) merged.set(ref.path, ref);
      }
      return { refs: [...merged.values()], unavailable: false };
    }
    return scanSlotArtifactRootDetailed(remoteArtifactRoot ?? artifactRoot, run, options);
  }
  return scanSlotArtifactRootDetailed(artifactRoot, run, options);
}

function isArtifactRootOwnedByCurrentTask(artifactRoot: string, artifactRoots: string[]): boolean {
  return artifactRoots.some((baseRoot) => isPathWithinBase(artifactRoot, baseRoot));
}

function resolveInheritedRecipeInputsDir(run: Pick<Run, 'taskFile'>): string | null {
  if (!run.taskFile) return null;
  return path.join(path.dirname(run.taskFile), 'inputs', 'inherited');
}

/** Family-chain pr-complete runs often ship recipe.json under inputs/inherited only. */
async function loadContextFromInheritedInputs(run: Run): Promise<LiveRecipeContext | null> {
  const inheritedRoot = resolveInheritedRecipeInputsDir(run);
  if (!inheritedRoot) return null;
  const [recipeJson, recipeCoverage, workerLearnings, storedRecipeQualityArtifact] =
    await Promise.all([
      readPortableTextIfExists(run, path.join(inheritedRoot, 'recipe.json')),
      readPortableTextIfExists(run, path.join(inheritedRoot, 'recipe-coverage.md')),
      readPortableTextIfExists(run, path.join(inheritedRoot, 'learnings.md')),
      readRecipeQualityArtifactPortable(run, path.join(inheritedRoot, 'recipe-quality.json')),
    ]);
  const recipeQualityArtifact =
    recipeJson || recipeCoverage
      ? (
          await loadRecipeQualityEvaluation({
            run,
            recipeJson,
            recipeCoverage,
            recipeQualityArtifact: storedRecipeQualityArtifact,
            recipeQualityArtifactIsStale: portableWorkerQualityArtifactIsStale(
              storedRecipeQualityArtifact,
              Boolean(recipeJson || recipeCoverage),
            ),
          })
        ).artifact
      : storedRecipeQualityArtifact;
  const context: LiveRecipeContext = {
    source: 'recipe-run-artifacts',
    recipeRunId: null,
    artifactRoot: inheritedRoot,
    artifactManifest: null,
    recipeJson,
    recipeQualityArtifact,
    qualityReport: null,
    workerLearnings,
    isStale: false,
    selectionReason: 'latest-run',
  };
  return hasLiveRecipeEvidence(context) ? context : null;
}

async function loadContextFromArtifactRoot({
  artifactRoot,
  run,
  source,
  selectionReason,
  recipeRunId,
  isStale,
  scanOptions = {},
  allowUnavailableAsStale = false,
}: LoadContextOptions): Promise<LiveRecipeContext | null> {
  const evidenceManifestPath = path.join(artifactRoot, 'evidence-manifest.json');
  const evidenceManifestJson = await readPortableTextIfExists(run, evidenceManifestPath);
  const evidenceManifestReferencedPaths = extractEvidenceManifestReferencedPaths(
    evidenceManifestJson,
    evidenceManifestPath,
  );
  const effectiveScanOptions: ArtifactScanOptions = {
    ...scanOptions,
    includeRelativePaths: [
      ...(scanOptions.includeRelativePaths ?? []),
      ...evidenceManifestReferencedPaths,
    ],
  };
  const [
    recipeJson,
    workerLearnings,
    storedRecipeQualityArtifact,
    recipeCoverage,
    typedArtifactManifestJson,
    artifactScan,
  ] = await Promise.all([
    readPortableTextIfExists(run, path.join(artifactRoot, 'recipe.json')),
    readPortableTextIfExists(run, path.join(artifactRoot, 'learnings.md')),
    readRecipeQualityArtifactPortable(run, path.join(artifactRoot, 'recipe-quality.json')),
    readPortableTextIfExists(run, path.join(artifactRoot, 'recipe-coverage.md')),
    readPortableTextIfExists(run, path.join(artifactRoot, 'artifact-manifest.json')),
    scanArtifactRootPortable(artifactRoot, run, effectiveScanOptions),
  ]);
  const recipeQualityArtifact =
    recipeJson || recipeCoverage
      ? (
          await loadRecipeQualityEvaluation({
            run,
            recipeJson,
            recipeCoverage,
            recipeQualityArtifact: storedRecipeQualityArtifact,
            recipeQualityArtifactIsStale: portableWorkerQualityArtifactIsStale(
              storedRecipeQualityArtifact,
              Boolean(recipeJson || recipeCoverage),
            ),
          })
        ).artifact
      : storedRecipeQualityArtifact;
  const typedArtifactRefs = parseTypedArtifactManifestRefs(
    typedArtifactManifestJson,
    path.join(artifactRoot, 'artifact-manifest.json'),
  );
  const artifactRefs = mergeTypedArtifactManifestRefs(artifactScan.refs, typedArtifactRefs);
  const usedTypedArtifactManifest = typedArtifactRefs !== null && typedArtifactRefs.length > 0;
  const effectiveIsStale =
    isStale ||
    (allowUnavailableAsStale && artifactScan.unavailable && artifactScan.refs.length === 0);

  const context: LiveRecipeContext = {
    source,
    recipeRunId,
    artifactRoot,
    artifactManifest: artifactRefs.length > 0 ? artifactRefs : null,
    usedTypedArtifactManifest,
    recipeJson,
    recipeQualityArtifact,
    qualityReport: null,
    workerLearnings,
    isStale: effectiveIsStale,
    selectionReason,
  };

  if (hasLiveRecipeEvidence(context) || effectiveIsStale) return context;
  return null;
}

// Negative + positive cache for the pointer file to avoid re-SSH'ing the
// same artifact every time `attachLiveRecipeContext` runs (which is per
// `run.get`, `run.recipeRunsForSlot`, etc — easily 40+ times during a slot
// panel open). 5s TTL is short enough that a freshly-written pointer
// becomes visible to the next refresh, but long enough to absorb the burst.
const POINTER_CACHE_TTL_MS = 5_000;
const pointerCache = new Map<string, { value: LatestValidRecipeRunPointer | null; at: number }>();
const pointerInvalidWarned = new Set<string>();

async function readLatestValidRecipeRunPointer(
  run: Run,
  taskArtifactsRoot: string | null,
): Promise<LatestValidRecipeRunPointer | null> {
  if (!taskArtifactsRoot) return null;
  const pointerPath = path.join(taskArtifactsRoot, 'latest-valid-recipe-run.json');
  const cached = pointerCache.get(pointerPath);
  if (cached && Date.now() - cached.at < POINTER_CACHE_TTL_MS) return cached.value;
  const raw = await readPortableTextIfExists(run, pointerPath);
  if (!raw) {
    pointerCache.set(pointerPath, { value: null, at: Date.now() });
    return null;
  }
  try {
    const sanitized = sanitizeLatestValidRecipeRunPointer(
      JSON.parse(raw) as LatestValidRecipeRunPointer,
    );
    if (!sanitized && !pointerInvalidWarned.has(pointerPath)) {
      pointerInvalidWarned.add(pointerPath);
      console.warn(
        `[live-recipe-context] invalid latest valid recipe-run pointer for ${run.id.slice(0, 8)} at ${pointerPath}`,
      );
    }
    pointerCache.set(pointerPath, { value: sanitized, at: Date.now() });
    return sanitized;
  } catch (error) {
    logJsonParseFailure(pointerPath, error);
    pointerCache.set(pointerPath, { value: null, at: Date.now() });
    return null;
  }
}

export async function resolveWorkerTaskDir(run: LiveRecipeReadCtx): Promise<string | null> {
  if (!run.slotId || !run.taskFile) return null;
  try {
    const vars = await loadSlotVars(run.slotId);
    const pv = await loadProjectVars(run.project).catch(() => null);
    const orchRoot = getOrchestratorTaskRoot(run.project, pv?.projectJson ?? null);
    const taskRelDir = resolveTaskRelDir(run.taskFile, orchRoot);
    if (taskRelDir === null) return null;
    const taskDirName = pv ? resolveProjectTaskDirName(pv.projectJson) : DEFAULT_TASK_DIR;
    return path.join(vars.remoteRepo, taskDirName, taskRelDir);
  } catch {
    return null;
  }
}

function uniqueArtifactRoots(roots: Array<string | null | undefined>): string[] {
  const seen = new Set<string>();
  const unique: string[] = [];
  for (const root of roots) {
    if (!root) continue;
    const normalizedRoot = path.resolve(root);
    if (seen.has(normalizedRoot)) continue;
    seen.add(normalizedRoot);
    unique.push(root);
  }
  return unique;
}

async function readLatestValidRecipeRunPointerFromRoots(
  run: Run,
  artifactRoots: string[],
): Promise<{
  pointer: LatestValidRecipeRunPointer;
  context: LiveRecipeContext;
} | null> {
  let staleFallback: { pointer: LatestValidRecipeRunPointer; context: LiveRecipeContext } | null =
    null;
  for (const artifactsRoot of artifactRoots) {
    const pointer = await readLatestValidRecipeRunPointer(run, artifactsRoot);
    if (!pointer) continue;
    const context = await loadContextFromArtifactRoot({
      artifactRoot: path.join(artifactsRoot, pointer.relativeArtifactRoot),
      run,
      source: 'recipe-run-artifacts',
      selectionReason: 'latest-run',
      recipeRunId: pointer.runId,
      isStale: false,
      allowUnavailableAsStale: true,
    });
    if (!context) continue;
    if (!context.isStale) return { pointer, context };
    if (!staleFallback) staleFallback = { pointer, context };
  }
  return staleFallback;
}

/**
 * Badge status for the current-artifacts group, derived from the gateway's
 * canonical recipe-quality evaluator — the same single source the family
 * leaderboard reads — so the per-run badge and the leaderboard can never disagree.
 * good/ok map to pass (the recipe proved the feature; ok = warn), bad to fail.
 */
function currentArtifactsGroupStatus(
  context: Pick<LiveRecipeContext, 'recipeQualityArtifact'>,
): RecipeRunArtifactGroupStatus {
  // loadContextFromArtifactRoot already ran the canonical evaluator with files
  // read through the slot-portable API. Reuse that exact result; rereading the
  // same absolute path on the gateway can cross-contaminate remote slots.
  if (
    context.recipeQualityArtifact?.verdict === 'pass' ||
    context.recipeQualityArtifact?.verdict === 'warn'
  )
    return 'pass';
  if (context.recipeQualityArtifact?.verdict === 'fail') return 'fail';
  return 'unknown';
}

export async function listRecipeRunArtifactGroupsForRun(
  run: Run,
): Promise<RecipeRunArtifactGroup[]> {
  const groups: RecipeRunArtifactGroup[] = [];
  const orchestratorTaskDir = run.taskFile ? path.dirname(run.taskFile) : null;
  const workerTaskDir = await resolveWorkerTaskDir(run);
  const artifactRoots = uniqueArtifactRoots([
    workerTaskDir ? path.join(workerTaskDir, 'artifacts') : null,
    orchestratorTaskDir ? path.join(orchestratorTaskDir, 'artifacts') : null,
  ]);
  const latestPointerRef = await readLatestValidRecipeRunPointerFromRoots(run, artifactRoots);
  const candidateBaseRoots = artifactRoots;

  for (const artifactRoot of artifactRoots) {
    const current = await loadContextFromArtifactRoot({
      artifactRoot,
      run,
      source: 'recipe-run-artifacts',
      selectionReason: 'latest-run',
      recipeRunId: null,
      isStale: false,
      scanOptions: { excludeTopLevel: ['recipe-runs', 'screenshots'] },
    });
    if (!current) continue;
    groups.push({
      id: 'current-artifacts',
      label: 'Recipe package',
      groupKind: 'current-artifacts',
      promoted: false,
      status: currentArtifactsGroupStatus(current),
      ...current,
    });
    break;
  }

  if (!groups.some((group) => group.groupKind === 'current-artifacts')) {
    const inherited = await loadContextFromInheritedInputs(run);
    if (inherited) {
      groups.push({
        id: 'current-artifacts',
        label: 'Inherited recipe package',
        groupKind: 'current-artifacts',
        promoted: false,
        status: currentArtifactsGroupStatus(inherited),
        ...inherited,
      });
    }
  }

  const liveRecipeContext = run.liveRecipeContext;
  const explicitArtifactRoot = liveRecipeContext?.artifactRoot;
  const explicitArtifactRootValid = Boolean(
    explicitArtifactRoot &&
    candidateBaseRoots.some((baseRoot) =>
      isRecipeRunArtifactRootForBase(explicitArtifactRoot, baseRoot),
    ),
  );

  if (
    explicitArtifactRoot &&
    liveRecipeContext?.recipeRunId &&
    liveRecipeContext.source === 'recipe-run-live' &&
    explicitArtifactRootValid &&
    !groups.some((group) => group.artifactRoot === explicitArtifactRoot)
  ) {
    const explicitContext = await loadContextFromArtifactRoot({
      artifactRoot: explicitArtifactRoot,
      run,
      source: liveRecipeContext.source,
      selectionReason: liveRecipeContext.selectionReason,
      recipeRunId: liveRecipeContext.recipeRunId,
      isStale: liveRecipeContext.isStale,
      allowUnavailableAsStale: liveRecipeContext.source !== 'recipe-run-live',
    });
    if (explicitContext) {
      groups.push({
        id: `live-run:${liveRecipeContext.recipeRunId}`,
        label: 'Attempted run',
        groupKind: 'live-run',
        promoted: false,
        status: await readSummaryStatusPortable(run, explicitArtifactRoot),
        ...explicitContext,
      });
    } else if (liveRecipeContext.source === 'recipe-run-live') {
      groups.push({
        id: `live-run:${liveRecipeContext.recipeRunId}`,
        label: 'Attempted run',
        groupKind: 'live-run',
        promoted: false,
        status: 'unknown',
        ...liveRecipeContext,
      });
    }
  }

  if (latestPointerRef) {
    groups.push({
      id: latestPointerRef.pointer.runId,
      label: 'Latest passing evidence',
      groupKind: 'latest-valid',
      promoted: true,
      status: 'pass',
      ...latestPointerRef.context,
    });
  }

  return groups;
}

export async function loadLiveRecipeContextForRun(run: Run): Promise<LiveRecipeContext | null> {
  const workerTaskDir = await resolveWorkerTaskDir(run);
  const orchestratorArtifactRoot = run.taskFile
    ? path.join(path.dirname(run.taskFile), 'artifacts')
    : null;
  const artifactRoots = uniqueArtifactRoots([
    workerTaskDir ? path.join(workerTaskDir, 'artifacts') : null,
    orchestratorArtifactRoot,
  ]);
  const latestPointerRef = await readLatestValidRecipeRunPointerFromRoots(run, artifactRoots);

  const persistedArtifactRootValid = Boolean(
    run.liveRecipeContext?.artifactRoot &&
    (artifactRoots.length === 0 ||
      isArtifactRootOwnedByCurrentTask(run.liveRecipeContext.artifactRoot, artifactRoots)),
  );
  const explicitLiveCandidate =
    persistedArtifactRootValid && run.liveRecipeContext?.artifactRoot
      ? {
          artifactRoot: run.liveRecipeContext.artifactRoot,
          run,
          source: run.liveRecipeContext.source,
          selectionReason: run.liveRecipeContext.selectionReason,
          recipeRunId: run.liveRecipeContext.recipeRunId,
          isStale: run.liveRecipeContext.isStale,
          allowUnavailableAsStale: run.liveRecipeContext.source !== 'recipe-run-live',
        }
      : null;

  if (explicitLiveCandidate) {
    const explicitContext = await loadContextFromArtifactRoot(explicitLiveCandidate);
    if (explicitContext) return explicitContext;
    if (run.liveRecipeContext?.source === 'recipe-run-live') {
      return run.liveRecipeContext;
    }
  }
  if (latestPointerRef) {
    return latestPointerRef.context;
  }

  for (const artifactRoot of artifactRoots) {
    const context = await loadContextFromArtifactRoot({
      artifactRoot,
      run,
      source: 'recipe-run-artifacts',
      selectionReason: 'latest-run',
      recipeRunId: null,
      isStale: false,
      scanOptions: { excludeTopLevel: ['recipe-runs', 'screenshots'] },
    });
    if (context) return context;
  }

  const inherited = await loadContextFromInheritedInputs(run);
  if (inherited) return inherited;

  return persistedArtifactRootValid ? (run.liveRecipeContext ?? null) : null;
}

function liveRecipeContextsEqual(
  a: LiveRecipeContext | null | undefined,
  b: LiveRecipeContext | null | undefined,
): boolean {
  if (a === b) return true;
  if (!a || !b) return a === b;
  return (
    a.source === b.source &&
    a.recipeRunId === b.recipeRunId &&
    a.artifactRoot === b.artifactRoot &&
    a.recipeJson === b.recipeJson &&
    (a.usedTypedArtifactManifest ?? false) === (b.usedTypedArtifactManifest ?? false) &&
    a.workerLearnings === b.workerLearnings &&
    a.isStale === b.isStale &&
    a.selectionReason === b.selectionReason &&
    isDeepStrictEqual(a.recipeQualityArtifact ?? null, b.recipeQualityArtifact ?? null) &&
    isDeepStrictEqual(a.qualityReport ?? null, b.qualityReport ?? null) &&
    isDeepStrictEqual(a.artifactManifest ?? [], b.artifactManifest ?? [])
  );
}

// Per-run memo for `attachLiveRecipeContext`. A slot panel open fans out to
// 4-9 gateway methods (run.get, runForSlot, runRecipeRunsForSlot, recipeListGroups,
// fsServeRunArtifact) — each calls this function. The result-cache collapses
// repeat calls within the burst window; the inflight map lets concurrent
// callers share one in-flight load. Both keyed by run.id. Mirrors the dedup
// pattern from `prRawInflight` (methods/pr.ts:107) + the result-TTL pattern
// from `recipeRunGroupCache` (methods/filesystem.ts:83). Per-file caches above
// (artifactTextCache) handle the longer 5s window for individual disk reads.
const LIVE_CONTEXT_MEMO_TTL_MS = 1_000;
const liveContextResultCache = new Map<string, { value: LiveRecipeContext | null; at: number }>();
const liveContextInflight = new Map<string, Promise<LiveRecipeContext | null>>();

export function invalidateLiveRecipeContextMemo(runId?: string): void {
  if (!runId) {
    liveContextResultCache.clear();
    liveContextInflight.clear();
    return;
  }
  liveContextResultCache.delete(runId);
  // Also drop the inflight entry so a caller racing this invalidation
  // (e.g. recipe-completion → next pr-board click) gets a fresh load
  // instead of awaiting the about-to-be-stale promise.
  liveContextInflight.delete(runId);
}

export async function attachLiveRecipeContext(run: Run): Promise<Run> {
  const cached = liveContextResultCache.get(run.id);
  let liveRecipeContext: LiveRecipeContext | null;
  if (cached && Date.now() - cached.at < LIVE_CONTEXT_MEMO_TTL_MS) {
    liveRecipeContext = cached.value;
  } else {
    const inflight = liveContextInflight.get(run.id);
    if (inflight) {
      // Share the in-flight load. On rejection: the inflight entry is cleared
      // by the originating caller's finally block (so the *next* call retries),
      // but every awaiter currently parked on this promise will see the same
      // throw — matches recipeRunGroupCache semantics (methods/filesystem.ts:151).
      liveRecipeContext = await inflight;
    } else {
      const promise = loadLiveRecipeContextForRun(run);
      liveContextInflight.set(run.id, promise);
      try {
        liveRecipeContext = await promise;
        // Invalidation race guard: if invalidateLiveRecipeContextMemo(run.id)
        // ran while we were awaiting (e.g. recipe-completion copyArtifacts
        // wrote new artifacts mid-flight), the inflight slot is no longer
        // ours — writing this stale result back into the memo would re-poison
        // the cache the invalidation just cleared.
        if (liveContextInflight.get(run.id) === promise) {
          liveContextResultCache.set(run.id, { value: liveRecipeContext, at: Date.now() });
        }
      } finally {
        // Only release the inflight slot if it's still ours. invalidate may
        // have cleared it already, in which case a fresh load is in progress
        // and we must not stomp it.
        if (liveContextInflight.get(run.id) === promise) {
          liveContextInflight.delete(run.id);
        }
      }
    }
  }
  if (liveRecipeContextsEqual(liveRecipeContext, run.liveRecipeContext)) return run;
  return {
    ...run,
    liveRecipeContext,
  };
}
