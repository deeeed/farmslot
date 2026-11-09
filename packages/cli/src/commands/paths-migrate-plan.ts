import { randomUUID } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import {
  farmPathEntries,
  type GatewayFarmPaths,
  resolveFarmPaths,
  resolveReportedFarmPaths,
} from '@farmslot/protocol/node/farm-paths';
import { expandHome } from '@farmslot/protocol/node/farmslot-home';

import {
  assertMigratedLinks,
  assertUnredirected,
  existingParent,
  info,
  type Inventory,
  inventory,
  movedInventory,
  within,
} from './paths-migrate-io.js';

export interface MigrationOptions {
  home: string;
  data?: string;
  env?: NodeJS.ProcessEnv;
  checkoutRoot?: string;
  userHome?: string;
}
export interface PathMapping {
  source: string;
  target: string;
}
export interface MoveStep extends PathMapping {
  kind: 'move';
  method: 'rename' | 'copy';
  bytes: number;
  expected: Inventory;
  phase?: 'copy-verified';
  rollbackPhase?: 'copy-verified';
}
export interface WriteStep {
  kind: 'write';
  source?: string;
  target: string;
  body: string;
  before?: string;
  mode: number;
  rewrites: PathMapping[];
}
export type MigrationStep = (MoveStep | WriteStep) & {
  status?: 'running' | 'done' | 'undone';
  backup?: string;
};
export interface MigrationPlan {
  version: 1;
  id: string;
  home: string;
  dataRoot: string;
  journal: string;
  legacy: GatewayFarmPaths;
  mappings: PathMapping[];
  stays: { path: string; reason: string }[];
  conflicts: string[];
  steps: MigrationStep[];
  createdDirs: string[];
  status: 'planned' | 'applying' | 'complete' | 'rolling-back' | 'rolled-back';
}
export function record(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}
export async function json(file: string): Promise<unknown> {
  return JSON.parse(await readFile(file, 'utf8'));
}
export async function files(root: string): Promise<string[]> {
  const value = await info(root);
  if (!value || value.isSymbolicLink()) return [];
  if (value.isFile()) return [root];
  if (!value.isDirectory()) return [];
  const result: string[] = [];
  for (const name of (await readdir(root)).sort())
    result.push(...(await files(path.join(root, name))));
  return result;
}
function strings(value: unknown): string[] {
  if (typeof value === 'string') return [value];
  if (Array.isArray(value)) return value.flatMap(strings);
  if (record(value))
    return Object.entries(value).flatMap(([key, child]) => [key, ...strings(child)]);
  return [];
}
export function translate(value: string, mappings: PathMapping[]): string {
  if (value === '~' || value.startsWith('~/')) {
    const expanded = expandHome(value);
    const target = translate(expanded, mappings);
    return target === expanded ? value : target;
  }
  if (value.startsWith('file://')) {
    const changed = translate(fileURLToPath(value), mappings);
    return changed === fileURLToPath(value) ? value : pathToFileURL(changed).href;
  }
  const match = mappings.find(({ source }) => within(source, value));
  return match ? match.target + value.slice(match.source.length) : value;
}
function rewrite(value: unknown, mappings: PathMapping[], changes: PathMapping[]): unknown {
  if (typeof value === 'string') {
    const target = translate(value, mappings);
    if (target !== value) changes.push({ source: value, target });
    return target;
  }
  if (Array.isArray(value)) return value.map((child) => rewrite(child, mappings, changes));
  if (record(value))
    return Object.fromEntries(
      Object.entries(value).map(([key, child]) => [
        rewrite(key, mappings, changes),
        rewrite(child, mappings, changes),
      ]),
    );
  return value;
}

export async function planMigration(options: MigrationOptions): Promise<MigrationPlan> {
  if (!options.home.trim() || (options.data !== undefined && !options.data.trim()))
    throw new Error('Migration home and data root must be nonempty');
  const home = path.resolve(expandHome(options.home));
  await assertUnredirected(home);
  if (!(await info(home))?.isDirectory()) throw new Error(`Migration home must exist: ${home}`);
  const env = options.env ?? process.env;
  const legacy = resolveReportedFarmPaths({
    ...options,
    home,
    role: 'gateway',
    instanceConfig: null,
  });
  const next = resolveFarmPaths({
    ...options,
    home,
    role: 'gateway',
    instanceConfig: {
      layout: 2,
      dataRoot: options.data ?? (env.FARMSLOT_DATA?.trim() || path.join(home, 'data')),
    },
  });
  const id = `${new Date().toISOString().replaceAll(/[:.]/g, '-')}-${randomUUID().slice(0, 8)}`;
  const journal = path.join(next.backups, `migrate-${id}.json`);
  const plan: MigrationPlan = {
    version: 1,
    id,
    home,
    dataRoot: next.data.root,
    journal,
    legacy,
    mappings: [],
    stays: [],
    conflicts: [],
    steps: [],
    createdDirs: [],
    status: 'planned',
  };
  const documentRoots = new Set<string>();
  const add = (source: string, target: string) => {
    source = path.resolve(source);
    target = path.resolve(target);
    documentRoots.add(source);
    if (source === target) {
      plan.stays.push({ path: source, reason: 'Already at the layout-2 path' });
      return;
    }
    const prior = plan.mappings.find((entry) => entry.source === source);
    if (prior) {
      if (prior.target !== target) plan.conflicts.push(`Source has two targets: ${source}`);
      return;
    }
    plan.mappings.push({ source, target });
  };
  const skip = new Set([
    'home',
    'config',
    'backups',
    'templateProjects',
    'code.checkout',
    'code.node',
    'code.templateNode',
    'code.agentRuntimeScripts',
    'code.bin',
    'data.root',
    'state.backlog',
    'state.assessmentArtifacts',
    'state.extraLogDirs',
    'state.gatewayLock',
    'state.tmp',
  ]);
  const targetEntries = new Map(farmPathEntries(next));
  for (const [key, source] of farmPathEntries(legacy)) {
    const target = targetEntries.get(key);
    if (!skip.has(key) && target) add(source, target);
  }
  for (const kind of ['reports', 'evaluations', 'inputs'])
    add(
      path.join(home, `assessment-${kind}`),
      path.join(next.state.assessmentArtifacts, `assessment-${kind}`),
    );
  for (const name of ['gateway.pid', 'node.pid'])
    add(path.join(home, name), path.join(next.state.nodeLink, name));
  for (const name of ['gateway.log', 'node.log'])
    add(path.join(home, name), path.join(next.state.logs, name));
  // Additional logs have no indexed layout-2 counterpart; retain every root separately.
  legacy.state.extraLogDirs.forEach((source, index) =>
    add(source, path.join(next.state.logs, `legacy-${index}`)),
  );
  add(legacy.backups, next.backups);
  // Config/credentials were loose files in the selected home. Never move the home itself.
  const reserved = new Set(['config', 'state', 'data', 'code', 'backups']);
  for (const name of await readdir(home)) {
    const source = path.join(home, name);
    if (reserved.has(name) || plan.mappings.some((entry) => within(source, entry.source))) continue;
    add(source, path.join(next.config, name));
  }
  plan.stays.push({
    path: legacy.code.checkout,
    reason:
      'Operator and slot checkouts, including their .farmslot-runtime, stay in place; deploy code separately',
  });
  plan.stays.push({
    path: legacy.state.tmp,
    reason: 'Shared legacy prepare scratch is not owned by one instance',
  });

  const slotRoots: string[] = [];
  for (const file of await files(legacy.pool)) {
    if (!file.endsWith('.json')) continue;
    const pool = await json(file);
    if (!record(pool) || !Array.isArray(pool.slots)) continue;
    for (const slot of pool.slots)
      if (record(slot) && typeof slot.repo === 'string') {
        const repo = expandHome(slot.repo);
        if (path.isAbsolute(repo)) {
          slotRoots.push(repo);
          plan.stays.push({ path: repo, reason: 'Slot checkout and its runtime stay in place' });
        }
      }
  }
  const documents = new Map<string, { value: unknown; raw: string }>();
  const readDocuments = async (root: string) => {
    for (const file of await files(root)) {
      if (!/\.(?:json|jsonl)$/.test(file) || documents.has(file)) continue;
      // Content-addressed bundles are immutable. Only their availability sidecar carries local paths.
      if (
        within(legacy.data.runBundles, file) &&
        file.includes(`${path.sep}sha256${path.sep}`) &&
        path.basename(file) !== 'availability.json'
      )
        continue;
      const raw = await readFile(file, 'utf8');
      if (file.endsWith('.jsonl'))
        documents.set(file, {
          raw,
          value: raw
            .trim()
            .split('\n')
            .filter(Boolean)
            .map((line) => JSON.parse(line)),
        });
      else documents.set(file, { raw, value: JSON.parse(raw) });
    }
  };
  for (const source of documentRoots)
    if (!within(legacy.data.runArchive, source)) await readDocuments(source);
  const archives = new Set([
    path.resolve(legacy.data.runArchive),
    resolveFarmPaths({
      ...options,
      home,
      role: 'gateway',
      instanceConfig: null,
      env: { ...env, FARMSLOT_RUN_ARCHIVE_ROOT: undefined },
    }).data.runArchive,
  ]);
  for (const { value } of documents.values())
    for (let location of strings(value)) {
      if (location.startsWith('file://')) location = fileURLToPath(location);
      if (!path.isAbsolute(location)) continue;
      if (location.endsWith('/manifest.json')) {
        const candidate = await info(location);
        if (candidate?.isFile()) {
          const manifest = await json(location);
          if (
            record(manifest) &&
            typeof manifest.runId === 'string' &&
            Array.isArray(manifest.entries)
          )
            archives.add(path.dirname(path.dirname(location)));
        }
      }
      const media = location.indexOf('/run-bundle-media/');
      if (media >= 0) archives.add(location.slice(0, media));
    }
  for (const archive of archives) {
    add(archive, next.data.runArchive);
    await readDocuments(archive);
  }
  // Task receipts live with their tasks, outside the pin root. Rewrite those exact files only.
  for (const [file, { value }] of [...documents]) {
    if (
      within(legacy.state.taskPins, file) &&
      path.basename(file) === 'provenance.json' &&
      record(value) &&
      typeof value.taskDir === 'string'
    )
      await readDocuments(path.join(value.taskDir, 'artifacts', 'harness-provenance.json'));
  }
  for (const source of slotRoots) plan.mappings.push({ source, target: source });
  plan.mappings.sort((a, b) => b.source.length - a.source.length);
  // Drop descendants whose parent move already preserves the relative destination.
  const roots = plan.mappings.filter(
    (entry) =>
      !plan.mappings.some(
        (parent) =>
          parent !== entry &&
          within(parent.source, entry.source) &&
          parent.target + entry.source.slice(parent.source.length) === entry.target,
      ),
  );
  const moveTargets = new Set<string>();
  const manifests = new Map<string, { source: string; value: Record<string, unknown> }[]>();
  const move = async (source: string, target: string): Promise<void> => {
    if (slotRoots.some((root) => within(root, source))) return;
    const value = await info(source);
    if (!value) return;
    if (source === target) return;
    if (within(source, target) || within(target, source)) {
      plan.conflicts.push(`Overlapping move: ${source} -> ${target}`);
      return;
    }
    try {
      await assertUnredirected(value.isSymbolicLink() ? path.dirname(source) : source);
      await assertUnredirected(target);
    } catch (error) {
      plan.conflicts.push(String(error));
      return;
    }
    // Inspect both archive roots before planning whole-tree moves, so overlapping
    // directories merge by child and payload collisions are refused before mutation.
    const archiveRoot = [...archives].find((root) => within(root, source));
    const sharedArchiveDir =
      value.isDirectory() &&
      archiveRoot &&
      (
        await Promise.all(
          [...archives]
            .filter((root) => root !== archiveRoot)
            .map((root) => info(path.join(root, path.relative(archiveRoot, source)))),
        )
      ).some(Boolean);
    // Split trees around independently mapped children and merged manifests.
    const split =
      sharedArchiveDir ||
      roots.some((entry) => entry.source !== source && within(source, entry.source)) ||
      target === next.backups ||
      slotRoots.some((root) => within(source, root)) ||
      !!(await info(target)) ||
      moveTargets.has(target) ||
      [...manifestSources].some((file) => within(source, file));
    if (value.isDirectory() && split) {
      const children = (await readdir(source)).sort();
      if (!children.length && sharedArchiveDir) {
        plan.conflicts.push(`Target exists: ${source} -> ${target}`);
        return;
      }
      for (const name of children) {
        const child = path.join(source, name);
        if (roots.some((entry) => entry.source === child)) continue;
        if (!manifestSources.has(child)) await move(child, path.join(target, name));
      }
      return;
    }
    if ((await info(target)) || moveTargets.has(target)) {
      plan.conflicts.push(`Target exists: ${source} -> ${target}`);
      return;
    }
    const expected = await inventory(source);
    const method: MoveStep['method'] =
      value.dev === (await info(await existingParent(path.dirname(target))))?.dev
        ? 'rename'
        : 'copy';
    plan.steps.push({
      kind: 'move',
      source,
      target,
      method,
      bytes: Object.values(expected).reduce((sum, entry) => sum + entry.bytes, 0),
      expected,
    });
    moveTargets.add(target);
  };
  // Archive manifests are moved to the journal directory, then combined without deduplication.
  for (const archive of archives)
    for (const [file, { value }] of documents) {
      if (
        within(archive, file) &&
        path.basename(file) === 'manifest.json' &&
        record(value) &&
        typeof value.runId === 'string' &&
        Array.isArray(value.entries)
      ) {
        if (
          !/^[A-Za-z0-9_-]+$/.test(value.runId) ||
          path.basename(path.dirname(file)) !== value.runId
        ) {
          plan.conflicts.push(`Invalid archive manifest: ${file}`);
          continue;
        }
        const target = path.join(next.data.runArchive, value.runId, 'manifest.json');
        const group = manifests.get(target) ?? [];
        if (!group.some((entry) => entry.source === file)) group.push({ source: file, value });
        manifests.set(target, group);
      }
    }
  const manifestSources = new Set(
    [...manifests.values()].flatMap((group) => group.map((entry) => entry.source)),
  );
  // Handle all leaves of archive roots; ordinary roots can use whole-tree renames.
  for (const entry of roots) {
    if (archives.has(entry.source)) {
      if (entry.source === entry.target) {
        plan.stays.push({
          path: entry.source,
          reason: 'External volume already under the data root',
        });
        continue;
      }
      if (await info(entry.source))
        for (const name of (await readdir(entry.source)).sort()) {
          const child = path.join(entry.source, name);
          if (!manifestSources.has(child)) await move(child, path.join(entry.target, name));
        }
    } else await move(entry.source, entry.target);
  }
  let manifestIndex = 0;
  for (const [target, group] of manifests) {
    for (const entry of group)
      if (entry.source !== target)
        await move(
          entry.source,
          path.join(journal.slice(0, -5), 'archive-manifests', `${manifestIndex++}.json`),
        );
    const changes: PathMapping[] = [];
    const value = rewrite(
      {
        ...group[0].value,
        entries: group.flatMap((entry) =>
          Array.isArray(entry.value.entries) ? entry.value.entries : [],
        ),
      },
      plan.mappings,
      changes,
    );
    const before = (await info(target)) ? await readFile(target, 'utf8') : undefined;
    plan.steps.push({
      kind: 'write',
      source: group.map((entry) => entry.source).join(', '),
      target,
      before,
      body: JSON.stringify(value, null, 2) + '\n',
      mode: 0o600,
      rewrites: changes,
    });
  }
  for (const [source, { value, raw }] of documents) {
    if (manifestSources.has(source)) continue;
    const changes: PathMapping[] = [];
    const updated = rewrite(value, plan.mappings, changes);
    const target = translate(source, plan.mappings);
    if (!changes.length) continue;
    plan.steps.push({
      kind: 'write',
      source,
      target,
      before: raw,
      body:
        source.endsWith('.jsonl') && Array.isArray(updated)
          ? updated.map((entry) => JSON.stringify(entry)).join('\n') + '\n'
          : JSON.stringify(updated, null, 2) + '\n',
      mode: (await info(source))!.mode & 0o777,
      rewrites: changes,
    });
  }
  // Commit the layout only after all durable references point to their new owners.
  plan.steps.push({
    kind: 'write',
    target: path.join(next.config, 'instance.json'),
    body:
      JSON.stringify({ layout: 2, name: next.instance, dataRoot: next.data.root }, null, 2) + '\n',
    mode: 0o600,
    rewrites: [],
  });
  for (const entry of plan.mappings)
    if (entry.source === entry.target || within(next.data.root, entry.source))
      plan.stays.push({ path: entry.source, reason: 'External data already under the data root' });
  try {
    const moves = plan.steps.filter((step) => step.kind === 'move');
    await assertMigratedLinks(moves);
    for (const step of moves)
      if (
        Object.entries(await movedInventory(step, moves)).some(
          ([key, entry]) => entry.digest !== step.expected[key].digest,
        )
      )
        step.method = 'copy';
  } catch (error) {
    plan.conflicts.push(String(error));
  }
  return plan;
}
