// What a run executed, bound at its start and compared before and after it
// runs: the recipe, the product checkout, the runner (the host package), the
// recipe libraries and any command helper scripts. Drift invalidates the run.
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs, { constants as fsConstants } from 'node:fs';
import path from 'node:path';

import { digestRecipeDocument, type RecipeConformanceSource } from '@farmslot/protocol';
import type { RecipeLibrarySource } from '@farmslot/recipe-runner';

import { harnessAdapter } from './adapters.js';
import { indexArtifactManifest } from './artifact-files.js';
import { harnessHost } from './host.js';
import { isPathWithin } from './paths.js';

const DIRECTORY_IGNORED_ROOTS = new Set(['.git', 'node_modules', 'temp']);

const gitContexts = new Map<string, { topLevel: string; pathspec: string } | null>();

export type ExecutionProvenancePhase = 'start' | 'pre-execute' | 'end';

export type SourceProvenanceSnapshot = RecipeConformanceSource;

export interface ExecutionProvenanceSnapshot {
  phase: ExecutionProvenancePhase;
  capturedAt: string;
  recipeDigest: string;
  product: SourceProvenanceSnapshot;
  runner: SourceProvenanceSnapshot;
  libraries: Array<SourceProvenanceSnapshot & { name: string }>;
  helpers: Array<{ path: string; sourceFingerprint: string }>;
}

export interface ExecutionProvenanceDrift {
  phase: Exclude<ExecutionProvenancePhase, 'start'>;
  field: string;
  start: string | null;
  current: string | null;
}

export interface ExecutionProvenanceRecord {
  schemaVersion: 1;
  valid: boolean;
  snapshots: ExecutionProvenanceSnapshot[];
  drift: ExecutionProvenanceDrift[];
}

export interface ExecutionProvenanceInput {
  adapter: string;
  projectRoot: string;
  recipeDocument: unknown;
  recipePath?: string;
  librarySources?: RecipeLibrarySource[];
  excludedProductRoots?: string[];
  helperPaths?: string[];
  // The runner checkout; the host package root by default.
  runnerRoot?: string;
  // The runner paths (relative to its root) whose bytes the run depends on;
  // empty fingerprints the whole root.
  runnerIncludes: readonly string[];
}

export class ProvenanceDriftError extends Error {
  readonly code = 'PROVENANCE_DRIFT';
  readonly exitCode = 5;
  readonly userAction: string;
  readonly provenancePath: string;
  readonly drift: ExecutionProvenanceDrift[];

  constructor(provenancePath: string, drift: ExecutionProvenanceDrift[], cause?: unknown) {
    const fields = [...new Set(drift.map((entry) => entry.field))].join(', ');
    super(
      `Execution inputs changed after preparation (${fields}); evidence is invalid.`,
      cause === undefined ? undefined : { cause },
    );
    this.name = 'ProvenanceDriftError';
    this.provenancePath = provenancePath;
    this.drift = drift;
    this.userAction = `restore the prepared recipe, library, and product source, then rerun; inspect ${provenancePath}`;
  }
}

export async function captureExecutionProvenance(
  input: ExecutionProvenanceInput,
  phase: ExecutionProvenancePhase,
): Promise<ExecutionProvenanceSnapshot> {
  const recipeDigest = input.recipePath
    ? recipeFileDigest(input.recipePath)
    : digestRecipeDocument(input.recipeDocument);
  const libraries = (input.librarySources ?? []).map((source, index) => ({
    name: source.name ?? `library-${index + 1}`,
    ...sourceSnapshot(source.root),
  }));
  const runnerRoot = input.runnerRoot ?? harnessHost().packageRoot;
  return {
    phase,
    capturedAt: new Date().toISOString(),
    recipeDigest,
    product: sourceSnapshot(input.projectRoot, input.adapter, input.excludedProductRoots),
    runner: sourceSnapshot(runnerRoot, undefined, [], [...input.runnerIncludes]),
    libraries,
    helpers: (input.helperPaths ?? []).map((helperPath) => ({
      path: displayPath(input.projectRoot, helperPath),
      sourceFingerprint: fileFingerprint(helperPath),
    })),
  };
}

export function executionProvenanceDrift(
  start: ExecutionProvenanceSnapshot,
  current: ExecutionProvenanceSnapshot,
): ExecutionProvenanceDrift[] {
  const drift: ExecutionProvenanceDrift[] = [];
  if (current.phase === 'start') return drift;
  const phase = current.phase;
  compare(drift, phase, 'recipeDigest', start.recipeDigest, current.recipeDigest);
  compareSource(drift, phase, 'product', start.product, current.product);
  compareSource(drift, phase, 'runner', start.runner, current.runner);
  if (start.libraries.length !== current.libraries.length) {
    compare(
      drift,
      phase,
      'libraries.length',
      String(start.libraries.length),
      String(current.libraries.length),
    );
  }
  const count = Math.min(start.libraries.length, current.libraries.length);
  for (let index = 0; index < count; index += 1) {
    const expected = start.libraries[index];
    const actual = current.libraries[index];
    const prefix = `libraries[${index}]`;
    compare(drift, phase, `${prefix}.name`, expected.name, actual.name);
    compareSource(drift, phase, prefix, expected, actual);
  }
  if (start.helpers.length !== current.helpers.length) {
    compare(
      drift,
      phase,
      'helpers.length',
      String(start.helpers.length),
      String(current.helpers.length),
    );
  }
  const helperCount = Math.min(start.helpers.length, current.helpers.length);
  for (let index = 0; index < helperCount; index += 1) {
    compare(
      drift,
      phase,
      `helpers[${index}].path`,
      start.helpers[index].path,
      current.helpers[index].path,
    );
    compare(
      drift,
      phase,
      `helpers[${index}].sourceFingerprint`,
      start.helpers[index].sourceFingerprint,
      current.helpers[index].sourceFingerprint,
    );
  }
  return drift;
}

export async function writeExecutionProvenance(
  artifactsDir: string,
  snapshots: ExecutionProvenanceSnapshot[],
  drift: ExecutionProvenanceDrift[],
  artifactManifestPath?: string,
): Promise<string> {
  const provenancePath = path.join(path.resolve(artifactsDir), 'execution-provenance.json');
  const record: ExecutionProvenanceRecord = {
    schemaVersion: 1,
    valid: drift.length === 0,
    snapshots,
    drift,
  };
  fs.mkdirSync(path.dirname(provenancePath), { recursive: true });
  fs.writeFileSync(provenancePath, `${JSON.stringify(record, null, 2)}\n`);
  if (artifactManifestPath) {
    // The one manifest upsert the harness has; a missing or unreadable
    // manifest is the caller's error, not something to skip past.
    await indexArtifactManifest(artifactManifestPath, [
      {
        path: 'execution-provenance.json',
        type: 'json',
        label: 'Execution provenance',
        category: 'system',
        metadata: {
          valid: record.valid,
          errorCode: record.valid ? null : 'PROVENANCE_DRIFT',
        },
      },
    ]);
  }
  return provenancePath;
}

function recipeFileDigest(recipePath: string): string {
  const source = readRegularFileNoFollow(recipePath);
  try {
    return digestRecipeDocument(JSON.parse(source.toString('utf8')));
  } catch {
    return `invalid:sha256:${createHash('sha256').update(source).digest('hex')}`;
  }
}

/** Include the imported delivery bytes when a checkout's generated modules are ignored by Git. */
export function providerSourceSnapshot(
  root: string,
  module: string,
  excludedRoots: string[] = [],
): SourceProvenanceSnapshot {
  const exclusions = inputSourceExclusions(root, excludedRoots);
  const source = sourceSnapshot(root, undefined, exclusions);
  const fullDirectory = source.head === null || gitContext(root)?.pathspec !== '.';
  const topDirectory =
    path.relative(path.resolve(root), path.resolve(module)).split(path.sep)[0] ?? '';
  if (
    fullDirectory &&
    isPathWithin(root, module) &&
    !DIRECTORY_IGNORED_ROOTS.has(topDirectory) &&
    !exclusions.some((excluded) => isPathWithin(excluded, module))
  ) {
    // Nested/installed package snapshots already hash delivery bytes, including ignored builds.
    return source;
  }
  const deliveryRoot = path.dirname(module);
  const delivery =
    path.resolve(deliveryRoot) === path.resolve(root)
      ? fileFingerprint(module)
      : inputSourceSnapshot(deliveryRoot, excludedRoots).sourceFingerprint;
  return {
    ...source,
    sourceFingerprint: createHash('sha256')
      .update(source.sourceFingerprint)
      .update('\0provider-delivery\0')
      .update(delivery)
      .digest('hex'),
  };
}

export function sourceIsDirty(source: SourceProvenanceSnapshot): boolean {
  return source.status !== 'not-a-git-checkout' && source.status.trim().length > 0;
}

/** Explicit code inputs remain bound even when stored under the task artifact directory. */
export function inputSourceSnapshot(
  root: string,
  excludedRoots: string[] = [],
): SourceProvenanceSnapshot {
  return sourceSnapshot(root, undefined, inputSourceExclusions(root, excludedRoots));
}

function inputSourceExclusions(root: string, excludedRoots: string[]): string[] {
  return excludedRoots.filter((excluded) => !isPathWithin(excluded, root));
}

export function sourceSnapshot(
  root: string,
  adapter?: string,
  excludedRoots: string[] = [],
  includedRoots: string[] = [],
): SourceProvenanceSnapshot {
  const git = gitContext(root);
  if (!git) {
    return {
      head: null,
      status: 'not-a-git-checkout',
      sourceFingerprint: directoryFingerprint(root, excludedRoots, includedRoots),
    };
  }
  const pathspecs = sourcePathspecs(git, excludedRoots, includedRoots);
  const status = gitText(git.topLevel, [
    'status',
    '--porcelain=v1',
    '--untracked-files=normal',
    '--',
    ...pathspecs,
  ]);
  let head: Buffer;
  try {
    head = gitBuffer(git.topLevel, ['rev-parse', '--verify', 'HEAD']);
  } catch (error) {
    // A new checkout has no commit yet; its current bytes still bind the report.
    if ((error as { status?: number }).status !== 128) throw error;
    return {
      head: null,
      status,
      sourceFingerprint: directoryFingerprint(root, excludedRoots, includedRoots),
    };
  }
  const platformFingerprint = adapter ? harnessAdapter(adapter).sourceFingerprint : undefined;
  return {
    head: head.toString('utf8').trim() || null,
    status,
    sourceFingerprint:
      platformFingerprint && path.resolve(root) === git.topLevel
        ? platformFingerprint(root)
        : nestedGitSourceFingerprint(root, git, pathspecs, excludedRoots, includedRoots, head),
  };
}

function nestedGitSourceFingerprint(
  root: string,
  git: { topLevel: string; pathspec: string },
  pathspecs: string[],
  excludedRoots: string[],
  includedRoots: string[],
  head: Buffer,
): string {
  const gitFingerprint = gitSourceFingerprint(git.topLevel, pathspecs, head);
  if (git.pathspec === '.' && includedRoots.length === 0) return gitFingerprint;
  return createHash('sha256')
    .update(gitFingerprint)
    .update('\0nested-source\0')
    .update(directoryFingerprint(root, excludedRoots, includedRoots))
    .digest('hex');
}

function gitContext(root: string): { topLevel: string; pathspec: string } | null {
  const cacheKey = path.resolve(root);
  if (gitContexts.has(cacheKey)) return gitContexts.get(cacheKey) ?? null;
  try {
    const resolved = cacheKey;
    const topLevel = fs.realpathSync(gitText(resolved, ['rev-parse', '--show-toplevel']).trim());
    const relative = path.relative(topLevel, fs.realpathSync(resolved));
    const context =
      relative === '..' || relative.startsWith(`..${path.sep}`)
        ? null
        : { topLevel, pathspec: relative || '.' };
    gitContexts.set(cacheKey, context);
    return context;
  } catch {
    gitContexts.set(cacheKey, null);
    return null;
  }
}

function gitSourceFingerprint(topLevel: string, pathspecs: string[], head: Buffer): string {
  const hash = createHash('sha256');
  hash.update(head);
  hash.update('\0diff\0');
  hash.update(
    gitBuffer(topLevel, [
      'diff',
      '--no-ext-diff',
      '--binary',
      head.toString('utf8').trim(),
      '--',
      ...pathspecs,
    ]),
  );
  const untracked = gitText(topLevel, [
    'ls-files',
    '--others',
    '--exclude-standard',
    '-z',
    '--',
    ...pathspecs,
  ])
    .split('\0')
    .filter(Boolean)
    .sort();
  for (const relative of untracked) {
    hash.update(`\0untracked\0${relative}\0`);
    const absolute = path.join(topLevel, relative);
    hash.update(readPathIdentity(absolute));
  }
  return hash.digest('hex');
}

function sourcePathspecs(
  git: { topLevel: string; pathspec: string },
  excludedRoots: string[],
  includedRoots: string[],
): string[] {
  const exclusions = excludedRoots.flatMap((root) => {
    const relative = path.relative(
      git.topLevel,
      fs.existsSync(root) ? fs.realpathSync(root) : path.resolve(root),
    );
    return relative !== '..' && !relative.startsWith(`..${path.sep}`)
      ? [`:(exclude)${relative}`]
      : [];
  });
  const inclusions =
    includedRoots.length > 0
      ? includedRoots.map((root) => path.join(git.pathspec === '.' ? '' : git.pathspec, root))
      : [git.pathspec];
  return [...inclusions, ...exclusions];
}

function directoryFingerprint(
  root: string,
  excludedRoots: string[],
  includedRoots: string[],
): string {
  const hash = createHash('sha256');
  const resolvedRoot = path.resolve(root);
  const roots = includedRoots.length > 0 ? includedRoots : [''];
  for (const included of roots) {
    hashDirectory(
      hash,
      resolvedRoot,
      included,
      new Set(excludedRoots.map((entry) => path.resolve(entry))),
    );
  }
  return hash.digest('hex');
}

function hashDirectory(
  hash: ReturnType<typeof createHash>,
  root: string,
  relative: string,
  excludedRoots: Set<string>,
): void {
  const absolute = path.join(root, relative);
  if (
    [...excludedRoots].some(
      (excluded) => absolute === excluded || absolute.startsWith(`${excluded}${path.sep}`),
    )
  )
    return;
  let stat: fs.Stats;
  try {
    stat = fs.lstatSync(absolute);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      hash.update(`absent\0${relative}\0`);
      return;
    }
    throw error;
  }
  if (stat.isDirectory()) {
    // Directories carry no source bytes; files bind their relative path.
    for (const name of fs.readdirSync(absolute).sort()) {
      if (relative === '' && DIRECTORY_IGNORED_ROOTS.has(name)) continue;
      hashDirectory(hash, root, path.join(relative, name), excludedRoots);
    }
    return;
  }
  if (stat.isSymbolicLink()) {
    throw new Error(`Execution provenance source must not be a symbolic link: ${absolute}`);
  }
  hash.update(`file\0${relative}\0`);
  hash.update(readRegularFileNoFollow(absolute));
  hash.update('\0');
}

export function fileFingerprint(filePath: string): string {
  return createHash('sha256').update(readRegularFileNoFollow(filePath)).digest('hex');
}

function readPathIdentity(filePath: string): Buffer {
  const stat = fs.lstatSync(filePath);
  if (stat.isSymbolicLink()) {
    throw new Error(`Execution provenance source must not be a symbolic link: ${filePath}`);
  }
  return readRegularFileNoFollow(filePath);
}

function readRegularFileNoFollow(filePath: string): Buffer {
  let fd: number;
  try {
    fd = fs.openSync(filePath, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ELOOP') {
      throw new Error(`Execution provenance source must not be a symbolic link: ${filePath}`);
    }
    throw error;
  }
  try {
    if (!fs.fstatSync(fd).isFile()) {
      throw new Error(`Execution provenance source is not a regular file: ${filePath}`);
    }
    return fs.readFileSync(fd);
  } finally {
    fs.closeSync(fd);
  }
}

function displayPath(projectRoot: string, filePath: string): string {
  const relative = path.relative(path.resolve(projectRoot), path.resolve(filePath));
  return relative !== '..' && !relative.startsWith(`..${path.sep}`)
    ? relative || '.'
    : path.resolve(filePath);
}

function gitText(cwd: string, args: string[]): string {
  return gitBuffer(cwd, args).toString('utf8');
}

function gitBuffer(cwd: string, args: string[]): Buffer {
  return execFileSync('git', args, {
    cwd,
    encoding: 'buffer',
    maxBuffer: 128 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'ignore'],
  });
}

function compareSource(
  drift: ExecutionProvenanceDrift[],
  phase: Exclude<ExecutionProvenancePhase, 'start'>,
  prefix: string,
  start: SourceProvenanceSnapshot,
  current: SourceProvenanceSnapshot,
): void {
  compare(drift, phase, `${prefix}.head`, start.head, current.head);
  compare(drift, phase, `${prefix}.status`, start.status, current.status);
  compare(
    drift,
    phase,
    `${prefix}.sourceFingerprint`,
    start.sourceFingerprint,
    current.sourceFingerprint,
  );
}

function compare(
  drift: ExecutionProvenanceDrift[],
  phase: Exclude<ExecutionProvenancePhase, 'start'>,
  field: string,
  start: string | null,
  current: string | null,
): void {
  if (start !== current) drift.push({ phase, field, start, current });
}
