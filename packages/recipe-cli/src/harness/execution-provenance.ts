// What a run executed, bound at its start and compared before and after it
// runs: the recipe, the product checkout, the runner (the host package), the
// recipe libraries and any command helper scripts. Drift invalidates the run.
import { AsyncLocalStorage } from 'node:async_hooks';
import { createHash } from 'node:crypto';
import fs, { constants as fsConstants } from 'node:fs';
import path from 'node:path';

import { gitDiffArgs } from '@farmslot/agent-runtime/scripts/git-diff.cjs';
import { digestRecipeDocument, type RecipeConformanceSource } from '@farmslot/protocol';
import type { RecipeArtifactFinalization, RecipeLibrarySource } from '@farmslot/recipe-runner';

import { harnessAdapter } from './adapters.js';
import { cacheRecordPath, readCacheRecord, writeCacheRecord } from './cache.js';
import { countCallWork } from './call-timings.js';
import { gitTopLevel, readGit, readHeadCommit } from './git-read.js';
import { harnessHost } from './host.js';
import { isPathWithin } from './paths.js';

const DIRECTORY_IGNORED_ROOTS = new Set(['.git', 'node_modules', 'temp']);

const retainedSourceRoot = new AsyncLocalStorage<string | undefined>();

/** Only the receipt-verified task host permits file aliases inside its immutable pin. */
export function withRetainedSourceProvenance<T>(
  root: string | undefined,
  invoke: () => Promise<T>,
): Promise<T> {
  return retainedSourceRoot.run(root ? fs.realpathSync(root) : undefined, invoke);
}

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
  countCallWork('provenanceSnapshot');
  const recipeDigest = input.recipePath
    ? recipeFileDigest(input.recipePath)
    : digestRecipeDocument(input.recipeDocument);
  const libraries = (input.librarySources ?? []).map((source, index) => ({
    name: source.name ?? `library-${index + 1}`,
    ...inputSourceSnapshot(source.root, input.excludedProductRoots ?? []),
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
  context?: RecipeArtifactFinalization,
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
  if (context) {
    context.register({
      path: 'execution-provenance.json',
      type: 'json',
      label: 'Execution provenance',
      category: 'system',
      metadata: {
        valid: record.valid,
        errorCode: record.valid ? null : 'PROVENANCE_DRIFT',
      },
    });
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
  // Structured (v2, NUL-separated) so renames, copies and submodules parse without guessing,
  // with every submodule's state whatever its `ignore` setting.
  const listingBytes = gitBuffer(git.topLevel, [
    'status',
    '--porcelain=v2',
    '-z',
    '--untracked-files=normal',
    '--ignore-submodules=none',
    '--',
    ...pathspecs,
  ]);
  // Paths are read back only when they are exact UTF-8; otherwise the diff decides.
  const listing = statusListing(listingBytes);
  // The record keeps one entry per line.
  const status = listingBytes
    .toString('utf8')
    .split('\0')
    .filter(Boolean)
    .map((entry) => `${entry}\n`)
    .join('');
  let head = readHeadCommit(git.topLevel);
  if (!head) {
    try {
      head = gitText(git.topLevel, ['rev-parse', '--verify', 'HEAD']).trim();
    } catch (error) {
      // A new checkout has no commit yet; its current bytes still bind the report.
      if ((error as { status?: number }).status !== 128) throw error;
      return {
        head: null,
        status,
        sourceFingerprint: directoryFingerprint(root, excludedRoots, includedRoots),
      };
    }
  }
  // Product snapshots follow Git source selection; code inputs also bind ignored delivery bytes.
  const platformFingerprint = adapter ? harnessAdapter(adapter).sourceFingerprint : undefined;
  return {
    head: head || null,
    status,
    sourceFingerprint:
      platformFingerprint && path.resolve(root) === git.topLevel
        ? platformFingerprint(root)
        : adapter
          ? gitSourceFingerprint(git.topLevel, pathspecs, head, listing)
          : nestedGitSourceFingerprint(
              root,
              git,
              pathspecs,
              excludedRoots,
              includedRoots,
              head,
              listing,
            ),
  };
}

function nestedGitSourceFingerprint(
  root: string,
  git: { topLevel: string; pathspec: string },
  pathspecs: string[],
  excludedRoots: string[],
  includedRoots: string[],
  head: string,
  status: string | undefined,
): string {
  const gitFingerprint = gitSourceFingerprint(git.topLevel, pathspecs, head, status);
  if (git.pathspec === '.' && includedRoots.length === 0) return gitFingerprint;
  return createHash('sha256')
    .update(gitFingerprint)
    .update('\0nested-source\0')
    .update(directoryFingerprint(root, excludedRoots, includedRoots))
    .digest('hex');
}

function gitContext(root: string): { topLevel: string; pathspec: string } | null {
  const topLevel = gitTopLevel(root);
  if (!topLevel) return null;
  const relative = path.relative(topLevel, fs.realpathSync(path.resolve(root)));
  return relative === '..' || relative.startsWith(`..${path.sep}`)
    ? null
    : { topLevel, pathspec: relative || '.' };
}

// The source's bytes from its status: HEAD, the status listing, and the mode and
// bytes of every path it names (a missing one as deleted). A path absent from the
// listing matches HEAD, so this binds what the full diff and untracked listing bind.
// When the listing names a submodule, a symbolic link or an untracked directory, the diff decides.
function gitSourceFingerprint(
  topLevel: string,
  pathspecs: string[],
  head: string,
  status: string | undefined,
): string {
  return (
    (status === undefined ? undefined : statusSourceFingerprint(topLevel, head, status)) ??
    diffSourceFingerprint(topLevel, pathspecs, head)
  );
}

function statusSourceFingerprint(
  topLevel: string,
  head: string,
  status: string,
): string | undefined {
  const paths = statusPaths(status);
  if (!paths) return undefined;
  const hash = createHash('sha256');
  hash.update(`${head}\0status\0`);
  hash.update(status);
  for (const relative of paths) {
    hash.update(`\0path\0${relative}\0`);
    const absolute = path.join(topLevel, relative);
    let stat: fs.Stats;
    try {
      stat = fs.lstatSync(absolute);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      hash.update('deleted');
      continue;
    }
    // A submodule's change is its commit, which only the diff reports, and a symbolic
    // link keeps the diff's rules (an untracked one is refused there).
    if (stat.isDirectory() || stat.isSymbolicLink()) return undefined;
    hash.update(`${stat.mode}\0`);
    hash.update(readRegularFileNoFollow(absolute));
  }
  return hash.digest('hex');
}

/** A status listing as text, or undefined when a path in it is not valid UTF-8. */
export function statusListing(bytes: Buffer): string | undefined {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch (error) {
    // A name that does not decode cannot be found again on disk by that name.
    if (error instanceof TypeError) return undefined;
    throw error;
  }
}

// Every path a `status --porcelain=v2 -z` listing names, or undefined when the diff must
// decide: an untracked directory, a submodule, or a record this parser does not know.
function statusPaths(listing: string): string[] | undefined {
  const paths = new Set<string>();
  const fields = listing.split('\0');
  for (let index = 0; index < fields.length; index += 1) {
    const field = fields[index]!;
    if (!field) continue;
    const parts = field.split(' ');
    switch (field[0]) {
      case '1': // 1 XY sub mH mI mW hH hI path
        if (parts[2]?.startsWith('S')) return undefined;
        paths.add(parts.slice(8).join(' '));
        break;
      case '2': {
        // 2 XY sub mH mI mW hH hI Xscore path, then the original path as its own field
        if (parts[2]?.startsWith('S')) return undefined;
        paths.add(parts.slice(9).join(' '));
        index += 1;
        const original = fields[index];
        if (!original) return undefined;
        paths.add(original);
        break;
      }
      case 'u': // u XY sub m1 m2 m3 mW h1 h2 h3 path
        if (parts[2]?.startsWith('S')) return undefined;
        paths.add(parts.slice(10).join(' '));
        break;
      case '?': {
        const untracked = field.slice(2);
        if (untracked.endsWith('/')) return undefined;
        paths.add(untracked);
        break;
      }
      default:
        return undefined;
    }
  }
  return [...paths].sort();
}

function diffSourceFingerprint(topLevel: string, pathspecs: string[], head: string): string {
  const hash = createHash('sha256');
  hash.update(`${head}\n`);
  hash.update('\0diff\0');
  hash.update(
    gitBuffer(
      topLevel,
      gitDiffArgs(['--binary', '--ignore-submodules=none', head, '--', ...pathspecs]),
    ),
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
  const installed = installedPackage(root);
  if (!installed) return walkDirectory(root, excludedRoots, includedRoots, true);
  // An installed package changes with its version, so its bytes are hashed once per version.
  // The sizes and modification times, far cheaper to read, still catch an edit in place.
  const shape = walkDirectory(root, excludedRoots, includedRoots, false);
  const record = cacheRecordPath('provenance', {
    installed,
    root: path.resolve(root),
    excludedRoots,
    includedRoots,
  });
  const cached = readCacheRecord(record);
  if (
    typeof cached === 'object' &&
    cached !== null &&
    'shape' in cached &&
    cached.shape === shape &&
    'fingerprint' in cached &&
    typeof cached.fingerprint === 'string'
  ) {
    return cached.fingerprint;
  }
  const fingerprint = walkDirectory(root, excludedRoots, includedRoots, true);
  writeCacheRecord(record, { shape, fingerprint });
  return fingerprint;
}

// `<package dir>@<version>` when `root` lies in a package installed under node_modules.
function installedPackage(root: string): string | undefined {
  const resolved = path.resolve(root);
  const marker = `${path.sep}node_modules${path.sep}`;
  const index = resolved.lastIndexOf(marker);
  if (index < 0) return undefined;
  const nodeModules = resolved.slice(0, index + marker.length - 1);
  for (let dir = resolved; dir.startsWith(`${nodeModules}${path.sep}`); dir = path.dirname(dir)) {
    const manifest = path.join(dir, 'package.json');
    if (!fs.existsSync(manifest)) continue;
    const { version } = JSON.parse(fs.readFileSync(manifest, 'utf8')) as { version?: unknown };
    return typeof version === 'string' ? `${dir}@${version}` : undefined;
  }
  return undefined;
}

// The files under `root`: their bytes (`content`), or only their sizes and modification times.
function walkDirectory(
  root: string,
  excludedRoots: string[],
  includedRoots: string[],
  content: boolean,
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
      content,
    );
  }
  return hash.digest('hex');
}

function hashDirectory(
  hash: ReturnType<typeof createHash>,
  root: string,
  relative: string,
  excludedRoots: Set<string>,
  content: boolean,
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
      hashDirectory(hash, root, path.join(relative, name), excludedRoots, content);
    }
    return;
  }
  if (stat.isSymbolicLink()) {
    const pin = retainedSourceRoot.getStore();
    if (pin && isPathWithin(pin, absolute)) {
      const target = fs.realpathSync(absolute);
      if (isPathWithin(pin, target) && fs.statSync(target).isFile()) {
        hash.update(`link\0${relative}\0${fs.readlinkSync(absolute)}\0`);
        hash.update(content ? readRegularFileNoFollow(target) : fileShape(fs.statSync(target)));
        hash.update('\0');
        return;
      }
    }
    throw new Error(`Execution provenance source must not be a symbolic link: ${absolute}`);
  }
  hash.update(`file\0${relative}\0`);
  hash.update(content ? readRegularFileNoFollow(absolute) : fileShape(stat));
  hash.update('\0');
}

function fileShape(stat: fs.Stats): string {
  return `${stat.size}\0${stat.mtimeMs}`;
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
  return readGit(cwd, args);
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
