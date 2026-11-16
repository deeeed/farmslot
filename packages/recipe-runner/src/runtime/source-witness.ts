// Prepared source records are reused only after a fresh filesystem witness.
// Each invocation owns its checkpoints; no process or observation survives it.
import { AsyncLocalStorage } from 'node:async_hooks';
import { execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

interface PreparedRootRecord {
  schemaVersion: 1;
  root: string;
  metadata: string;
  paths: string[];
  ignored: string[];
  protectedIgnored: string[];
  configFiles: string[];
  witness: string;
  cacheable?: boolean;
  values: Record<string, unknown>;
}

export interface SourceWitnessMeasurement {
  root: string;
  checkpoint: number;
  phase: SourceWitnessPhase;
  wallMs: number;
  cpuMs: number;
  files: number;
  directories: number;
  refreshed: boolean;
}

export type SourceWitnessPhase =
  | 'prepare'
  | 'provider-source'
  | 'start'
  | 'pre-execute'
  | 'end'
  | 'capture-source'
  | 'observation';

const sessions = new AsyncLocalStorage<PreparedSourceWitness>();
const implementation = createHash('sha256')
  .update(optionalFile(fileURLToPath(import.meta.url)))
  .update(optionalFile(fileURLToPath(new URL('../../package.json', import.meta.url))))
  .digest('hex');

/** One fresh source view per physical root at each execution boundary. */
export class PreparedSourceWitness {
  readonly measurements: SourceWitnessMeasurement[] = [];
  readonly #roots = new Map<string, PreparedRootRecord>();
  #generation = 0;
  #phase: SourceWitnessPhase = 'prepare';

  get generation(): number {
    return this.#generation;
  }

  checkpoint(phase: SourceWitnessPhase = 'observation'): void {
    this.#generation++;
    this.#phase = phase;
    this.#roots.clear();
  }

  root(directory: string): PreparedRootRecord {
    return this.#readRoot(physicalSourceRoot(directory));
  }

  #readRoot(root: string): PreparedRootRecord {
    const known = this.#roots.get(root);
    if (known) return known;
    const wall = performance.now();
    const cpu = process.cpuUsage();
    const measurementStart = this.measurements.length;
    const stored = readRecord(root);
    const metadata = sourceMetadata(root, stored?.configFiles);
    let current = stored?.metadata === metadata ? stored : undefined;
    if (!current) current = prepareRoot(root);
    const observed = fileWitness(current, (nested) => this.#readRoot(nested));
    current.cacheable = observed.cacheable;
    const refreshed = Boolean(current.witness) && observed.digest !== current.witness;
    if (!current.witness) current.witness = observed.digest;
    if (refreshed) {
      // Changed membership may include new ignore rules: prepare a fresh input set.
      current = prepareRoot(root);
      const refreshedView = fileWitness(current, (nested) => this.#readRoot(nested));
      current.witness = refreshedView.digest;
      current.cacheable = refreshedView.cacheable;
      observed.files += refreshedView.files;
      observed.directories += refreshedView.directories;
      current.values = {};
    }
    this.#roots.set(root, current);
    if (refreshed || stored?.metadata !== metadata) writeRecord(current);
    const usage = process.cpuUsage(cpu);
    const nested = this.measurements.slice(measurementStart);
    this.measurements.push({
      root,
      checkpoint: this.#generation,
      phase: this.#phase,
      wallMs: performance.now() - wall - nested.reduce((sum, item) => sum + item.wallMs, 0),
      cpuMs: (usage.user + usage.system) / 1000 - nested.reduce((sum, item) => sum + item.cpuMs, 0),
      files: observed.files,
      directories: observed.directories,
      refreshed: refreshed || stored?.metadata !== metadata,
    });
    return current;
  }
}

export function currentSourceWitness(): PreparedSourceWitness | undefined {
  return sessions.getStore();
}

export function sourceWitnessTotals():
  | {
      wallMs: number;
      cpuMs: number;
      rootReads: number;
      files: number;
      directories: number;
      refreshes: number;
      measurements: SourceWitnessMeasurement[];
    }
  | undefined {
  const view = sessions.getStore();
  if (!view) return undefined;
  const totals = view.measurements.reduce(
    (total, row) => ({
      wallMs: total.wallMs + row.wallMs,
      cpuMs: total.cpuMs + row.cpuMs,
      rootReads: total.rootReads + 1,
      files: total.files + row.files,
      directories: total.directories + row.directories,
      refreshes: total.refreshes + Number(row.refreshed),
    }),
    { wallMs: 0, cpuMs: 0, rootReads: 0, files: 0, directories: 0, refreshes: 0 },
  );
  return { ...totals, measurements: [...view.measurements] };
}

export function withPreparedSourceWitness<T>(
  body: () => Promise<T>,
  witness: PreparedSourceWitness = sessions.getStore() ?? new PreparedSourceWitness(),
): Promise<T> {
  return sessions.getStore() === witness ? body() : sessions.run(witness, body);
}

/** The parser is the boundary between a rebuildable record and typed inputs. */
export function preparedSourceValue<T>(
  directory: string,
  key: unknown,
  compute: () => T,
  decode: (value: unknown) => T | undefined,
  extraFiles: readonly string[] = [],
): T {
  const view = sessions.getStore();
  if (
    !view ||
    process.env.GIT_DIR ||
    process.env.GIT_WORK_TREE ||
    process.env.GIT_CONFIG_PARAMETERS
  )
    return compute();
  const record = view.root(directory);
  if (record.cacheable === false) return compute();
  const identity = createHash('sha256')
    .update(JSON.stringify([path.relative(record.root, fs.realpathSync(directory)), key]))
    .digest('hex');
  const extras = createHash('sha256');
  for (const file of extraFiles) {
    extras.update(file);
    extras.update(optionalFile(path.resolve(directory, file)));
  }
  const extraIdentity = extras.digest('hex');
  const entry = record.values[identity];
  if (
    typeof entry === 'object' &&
    entry !== null &&
    'extraIdentity' in entry &&
    entry.extraIdentity === extraIdentity &&
    'value' in entry
  ) {
    const previous = decode(entry.value);
    if (previous !== undefined) return previous;
  }
  const value = compute();
  // A record never grows with the number of old calls or artifact destinations.
  if (Object.keys(record.values).length >= 32) record.values = {};
  record.values[identity] = { extraIdentity, value };
  writeRecord(record);
  return value;
}

/** Ignore an exclusion in an identity only if it affects no prepared input. */
export function sourceWitnessExclusions(root: string, exclusions: readonly string[]): string[] {
  const view = sessions.getStore();
  if (!view) return [...exclusions];
  const record = view.root(root);
  const git = gitDirectory(record.root);
  const affectsInput = (excluded: string): boolean => {
    const relative = Buffer.from(path.relative(record.root, excluded)).toString('latin1');
    if (relative === '') return true;
    if (relative === '..' || relative.startsWith('..' + path.sep))
      return record.root.startsWith(excluded + path.sep);
    if (!git)
      return !record.ignored.some(
        (ignored) => relative === ignored || relative.startsWith(ignored + path.sep),
      );
    return record.paths.some((file) => file === relative || file.startsWith(relative + path.sep));
  };
  return [
    ...new Set(
      exclusions.flatMap((excluded) => {
        const lexical = path.resolve(excluded);
        const resolved = fs.existsSync(lexical) ? fs.realpathSync(lexical) : lexical;
        // Git resolves existing exclusions; directory fingerprints retain lexical paths.
        return affectsInput(lexical) || affectsInput(resolved) ? [lexical, resolved] : [];
      }),
    ),
  ].sort();
}

/** Find normal and linked worktrees without starting Git. Overrides keep Git's path. */
export function sourceGitRoot(directory: string): string | undefined {
  if (process.env.GIT_DIR || process.env.GIT_WORK_TREE) return undefined;
  const ceiling = new Set((process.env.GIT_CEILING_DIRECTORIES ?? '').split(path.delimiter));
  let current: string;
  try {
    current = fs.realpathSync(directory);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
  for (;;) {
    if (fs.existsSync(path.join(current, '.git'))) return current;
    if (ceiling.has(current)) return undefined;
    const parent = path.dirname(current);
    if (parent === current) return undefined;
    current = parent;
  }
}

function physicalSourceRoot(directory: string): string {
  const real = fs.realpathSync(directory);
  if (real.includes(path.sep + 'node_modules' + path.sep)) {
    for (let p = real; p !== path.dirname(p); p = path.dirname(p)) {
      if (fs.existsSync(path.join(p, 'package.json'))) return p;
    }
  }
  return real;
}

export async function preparedSourceValueAsync<T>(
  root: string,
  key: unknown,
  compute: () => Promise<T>,
  decode: (value: unknown) => T | undefined,
): Promise<T> {
  const missing = Symbol('missing');
  const view = sessions.getStore();
  const generation = view?.generation;
  const cached = preparedSourceValue<T | typeof missing>(root, key, () => missing, decode);
  if (cached !== missing) return cached;
  const value = await compute();
  if (view && view.generation !== generation) return value;
  return preparedSourceValue(root, key, () => value, decode);
}

function gitDirectory(root: string): string | undefined {
  const marker = path.join(root, '.git');
  if (!fs.existsSync(marker)) return undefined;
  if (fs.statSync(marker).isDirectory()) return marker;
  const pointer = fs.readFileSync(marker, 'utf8').match(/^gitdir: (.+)$/mu)?.[1];
  return pointer ? path.resolve(root, pointer.trim()) : undefined;
}

function optionalFile(file: string): Buffer {
  try {
    return fs.readFileSync(file);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT' || code === 'ENOTDIR') return Buffer.from('<absent>');
    throw error;
  }
}

function statIdentity(file: string): string {
  try {
    const s = fs.lstatSync(file, { bigint: true });
    const identity = [s.dev, s.ino, s.mode, s.size, s.mtimeNs, s.ctimeNs].join(':');
    return s.isSymbolicLink()
      ? identity + ':' + fs.readlinkSync(file) + ':' + statIdentity(fs.realpathSync(file))
      : identity;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return '<absent>';
    throw error;
  }
}

function sourceMetadata(root: string, configFiles: readonly string[] = []): string {
  const hash = createHash('sha256');
  hash.update(implementation);
  hash.update(
    JSON.stringify(Object.entries(process.env).filter(([key]) => key.startsWith('GIT_'))),
  );
  const configs = [
    process.env.GIT_CONFIG_GLOBAL || path.join(os.homedir(), '.gitconfig'),
    ...(process.env.GIT_CONFIG_GLOBAL
      ? []
      : [
          path.join(
            process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'),
            'git/config',
          ),
        ]),
    process.env.GIT_CONFIG_SYSTEM || '/etc/gitconfig',
    ...(process.env.GIT_CONFIG_SYSTEM ? [] : ['/opt/homebrew/etc/gitconfig']),
    ...(process.env.GIT_CONFIG ? [process.env.GIT_CONFIG] : []),
    ...configFiles,
  ];

  const rootOwner = fs.statSync(root);
  hash.update(
    [rootOwner.dev, rootOwner.ino, rootOwner.mode, rootOwner.uid, rootOwner.gid].join(':'),
  );
  const repositoryRoot = sourceGitRoot(root);
  const git = gitDirectory(repositoryRoot ?? root);
  if (git) {
    const commonText = optionalFile(path.join(git, 'commondir')).toString().trim();
    const common = process.env.GIT_COMMON_DIR
      ? path.resolve(root, process.env.GIT_COMMON_DIR)
      : commonText === '<absent>'
        ? git
        : path.resolve(git, commonText);
    const directories = [...new Set([git, common])];
    const pending = ['HEAD'];
    const observed = new Set<string>();
    for (let n = 0; n < pending.length && n < 32; n++) {
      const ref = pending[n];
      if (observed.has(ref)) continue;
      observed.add(ref);
      for (const dir of directories) {
        const file = path.join(dir, ref);
        const bytes = optionalFile(file);
        hash.update(file);
        hash.update(bytes);
        const next = bytes
          .toString()
          .trim()
          .match(/^ref: (refs\/[^\0\r\n]+)$/u)?.[1];
        if (next && !next.split('/').includes('..')) pending.push(next);
      }
    }
    for (const dir of directories) {
      const owner = fs.statSync(dir);
      hash.update([owner.dev, owner.ino, owner.mode, owner.uid, owner.gid].join(':'));
      for (const name of [
        'packed-refs',
        'config',
        'config.worktree',
        'info/exclude',
        'info/attributes',
      ]) {
        const file = path.join(dir, name);
        hash.update(file);
        hash.update(name === 'packed-refs' ? statIdentity(file) : optionalFile(file));
        if (name === 'config' || name === 'config.worktree') configs.push(file);
      }
    }
    const index = process.env.GIT_INDEX_FILE
      ? path.resolve(root, process.env.GIT_INDEX_FILE)
      : path.join(git, 'index');
    hash.update(index);
    hash.update(statIdentity(index));
    // Reftable generations are named by this small file, not the object history.
    hash.update(optionalFile(path.join(common, 'reftable/tables.list')));
  }

  const seen = new Set<string>();
  for (const file of configs) {
    if (seen.has(file)) continue;
    seen.add(file);
    const contents = optionalFile(file).toString();
    hash.update(file);
    hash.update(contents);
  }
  return hash.digest('hex');
}

function prepareRoot(root: string): PreparedRootRecord {
  let paths: string[] = [];
  let ignored = ['.git', 'node_modules', 'temp'];
  const configFiles = new Set<string>();
  if (sourceGitRoot(root)) {
    const run = (args: string[]) =>
      execFileSync(
        'git',
        [
          '-c',
          'gc.auto=0',
          '-c',
          'maintenance.auto=false',
          '-c',
          'core.hooksPath=/dev/null',
          '-c',
          'core.fsmonitor=false',
          ...args,
        ],
        {
          cwd: root,
          env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' },
          maxBuffer: 128 * 1024 * 1024,
          stdio: ['ignore', 'pipe', 'ignore'],
        },
      );
    let configuration: Buffer = Buffer.alloc(0);
    try {
      configuration = run([
        'config',
        '--null',
        '--show-origin',
        '--includes',
        '--type=path',
        '--get-regexp',
        '^(include.*\\.path|core\\.(excludesfile|attributesfile))$',
      ]);
    } catch (error) {
      // No matching path settings is Git's documented exit status 1.
      if (!(error instanceof Error && 'status' in error && error.status === 1)) throw error;
    }
    const entries = configuration.toString('utf8').split('\0');
    for (let n = 0; n + 1 < entries.length; n += 2) {
      const origin = entries[n]!;
      const setting = entries[n + 1]!;
      const newline = setting.indexOf('\n');
      const key = setting.slice(0, newline);
      const value = setting.slice(newline + 1);
      const config = origin.startsWith('file:') ? path.resolve(root, origin.slice(5)) : undefined;
      if (config) configFiles.add(config);
      configFiles.add(
        path.resolve(key.startsWith('include') && config ? path.dirname(config) : root, value),
      );
    }
    paths = run(['ls-files', '--cached', '--others', '--exclude-standard', '-z'])
      .toString('latin1')
      .split('\0')
      .filter(Boolean);
    if (gitDirectory(root)) {
      ignored = run([
        'ls-files',
        '--others',
        '--ignored',
        '--exclude-standard',
        '--directory',
        '-z',
      ])
        .toString('latin1')
        .split('\0')
        .filter(Boolean)
        .map((p) => p.replace(/\/$/u, ''));
    }
    ignored.push('.git');
  }
  const ignoredSet = new Set(ignored);
  const protectedIgnored = new Set<string>();
  for (const file of paths) {
    for (let p = file; p !== '.'; p = path.dirname(p))
      if (ignoredSet.has(p)) protectedIgnored.add(p);
  }
  return {
    schemaVersion: 1,
    root,
    metadata: sourceMetadata(root, [...configFiles]),
    paths,
    ignored,
    protectedIgnored: [...protectedIgnored],
    configFiles: [...configFiles],
    witness: '',
    values: {},
  };
}

function fileWitness(
  record: PreparedRootRecord,
  readRoot: (root: string) => PreparedRootRecord,
): {
  digest: string;
  files: number;
  directories: number;
  cacheable: boolean;
} {
  const hash = createHash('sha256');
  const ignored = new Set(record.ignored);
  const protectedPaths = new Set(record.protectedIgnored);
  const rootBytes = Buffer.from(record.root + path.sep);
  const slash = Buffer.from(path.sep);
  let files = 0;
  let directories = 0;
  let cacheable = true;
  function walk(relative: Buffer, isDirectory?: boolean): void {
    const label = relative.toString('latin1');
    if (ignored.has(label) && !protectedPaths.has(label)) return;
    const file = relative.length ? Buffer.concat([rootBytes, relative]) : Buffer.from(record.root);
    const directory = isDirectory ?? fs.statSync(file).isDirectory();
    hash.update(relative);
    hash.update('\0');
    if (directory) {
      directories++;
      const entries = fs
        .readdirSync(file, { withFileTypes: true, encoding: 'buffer' })
        .sort((a, b) => Buffer.compare(a.name, b.name));
      if (relative.length && entries.some((entry) => entry.name.equals(Buffer.from('.git')))) {
        const nestedPath = file.toString('utf8');
        if (!Buffer.from(nestedPath).equals(file)) {
          // Unsupported path encodings retain Git's uncached validation.
          cacheable = false;
          return;
        }
        const nested = readRoot(nestedPath);
        hash.update(nested.metadata);
        hash.update(nested.witness);
        cacheable &&= nested.cacheable !== false;
        return;
      }
      for (const child of entries)
        walk(
          relative.length ? Buffer.concat([relative, slash, child.name]) : child.name,
          child.isDirectory(),
        );
    } else {
      const stat = fs.lstatSync(file, { bigint: true });
      files++;
      hash.update([stat.dev, stat.ino, stat.mode, stat.size, stat.mtimeNs, stat.ctimeNs].join(':'));
      if (stat.isSymbolicLink()) {
        hash.update(fs.readlinkSync(file, { encoding: 'buffer' }));
        const target = fs.statSync(file, { throwIfNoEntry: false });
        if (target?.isFile()) hash.update(fs.readFileSync(file));
      }
      // Coarse filesystem timestamps cannot establish unchanged content.
      if (stat.isFile() && stat.mtimeNs % 1000000000n === 0n && stat.ctimeNs % 1000000000n === 0n)
        hash.update(fs.readFileSync(file));
    }
  }
  walk(Buffer.alloc(0));
  return { digest: hash.digest('hex'), files, directories, cacheable };
}

function recordFile(root: string): string {
  const home =
    process.env.FARMSLOT_RECIPE_CACHE_DIR ||
    path.join(
      process.env.XDG_CACHE_HOME || path.join(os.homedir(), '.cache'),
      'farmslot/recipe-cli',
    );
  return path.join(
    home,
    'prepared-sources',
    createHash('sha256').update(root).digest('hex') + '.json',
  );
}

function readRecord(root: string): PreparedRootRecord | undefined {
  const text = optionalFile(recordFile(root)).toString();
  if (text === '<absent>') return undefined;
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch (error) {
    if (error instanceof SyntaxError) return undefined;
    throw error;
  }
  if (typeof value !== 'object' || value === null) return undefined;
  const v = value as Partial<PreparedRootRecord>;
  return v.schemaVersion === 1 &&
    v.root === root &&
    typeof v.metadata === 'string' &&
    typeof v.witness === 'string' &&
    Array.isArray(v.paths) &&
    v.paths.every((p) => typeof p === 'string') &&
    Array.isArray(v.configFiles) &&
    v.configFiles.every((p) => typeof p === 'string') &&
    Array.isArray(v.protectedIgnored) &&
    v.protectedIgnored.every((p) => typeof p === 'string') &&
    Array.isArray(v.ignored) &&
    v.ignored.every((p) => typeof p === 'string') &&
    typeof v.values === 'object' &&
    v.values !== null &&
    !Array.isArray(v.values)
    ? (v as PreparedRootRecord)
    : undefined;
}

function writeRecord(record: PreparedRootRecord): void {
  const file = recordFile(record.root);
  const temporary = `${file}.${randomUUID()}.tmp`;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  try {
    fs.writeFileSync(temporary, JSON.stringify(record), { mode: 0o600 });
    fs.renameSync(temporary, file);
  } finally {
    fs.rmSync(temporary, { force: true });
  }
}
