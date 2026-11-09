import { execFile } from 'node:child_process';
import { mkdir, open, readdir, readFile, rename, rm, rmdir } from 'node:fs/promises';
import net from 'node:net';
import path from 'node:path';
import { promisify } from 'node:util';

import { TERMINAL_RUN_STATUSES } from '@farmslot/protocol';
import { expandHome } from '@farmslot/protocol/node/farmslot-home';

import {
  assertIdentity,
  assertMigratedLinks,
  assertUnredirected,
  atomicFile,
  availableBytes,
  copyTree,
  hasCode,
  info,
  inventory,
  movedInventory,
  removeVerifiedSource,
  syncDirectory,
  within,
} from './paths-migrate-io.js';
import {
  files,
  json,
  type MigrationOptions,
  type MigrationPlan,
  type MigrationStep,
  type MoveStep,
  planMigration,
  record,
  translate,
} from './paths-migrate-plan.js';

export type { MigrationOptions, MigrationPlan } from './paths-migrate-plan.js';
export { planMigration } from './paths-migrate-plan.js';
export interface MigrationHooks {
  /** Fault injection at persisted boundaries; production callers do not supply hooks. */
  checkpoint?(plan: MigrationPlan, step: number): Promise<void>;
  availableBytes?(directory: string): Promise<number>;
}
function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (hasCode(error, 'ESRCH')) return false;
    throw error;
  }
}
async function portOpen(port: number): Promise<boolean> {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection({ host: '127.0.0.1', port });
    socket.setTimeout(500);
    socket.once('connect', () => {
      socket.destroy();
      resolve(true);
    });
    socket.once('timeout', () => {
      socket.destroy();
      reject(new Error(`Cannot establish offline state on port ${port}`));
    });
    socket.once('error', (error) => {
      if (hasCode(error, 'ECONNREFUSED')) resolve(false);
      else reject(error);
    });
  });
}
async function assertOffline(plan: MigrationPlan, env: NodeJS.ProcessEnv): Promise<void> {
  const roots = new Set([
    plan.home,
    plan.legacy.state.gatewayLock,
    plan.legacy.data.runBundles,
    translate(plan.legacy.data.runBundles, plan.mappings),
    plan.legacy.data.runArchive,
    translate(plan.legacy.data.runArchive, plan.mappings),
    plan.legacy.state.runs,
    translate(plan.legacy.state.runs, plan.mappings),
  ]);
  for (const root of roots)
    for (const file of await files(root)) {
      if (within(path.join(plan.home, 'backups'), file)) continue;
      if (/\.(?:pid|lock)$/.test(file)) {
        const raw = (await readFile(file, 'utf8')).trim();
        const pid = Number(raw);
        if (!Number.isInteger(pid) || pid <= 0)
          throw new Error(`Cannot establish offline state from lock: ${file}`);
        if (alive(pid))
          throw new Error(`Instance gateway or node is running (pid ${pid}): ${file}`);
      }
      if (
        /\.json$/.test(file) &&
        (within(plan.legacy.state.runs, file) ||
          within(translate(plan.legacy.state.runs, plan.mappings), file))
      ) {
        const value = await json(file);
        if (
          record(value) &&
          typeof value.id === 'string' &&
          path.basename(file) === `${value.id}.json` &&
          !TERMINAL_RUN_STATUSES.some((status) => status === value.status)
        )
          throw new Error(`Non-terminal run ${value.id}: ${String(value.status)}`);
      }
      if (file.endsWith('.json') && file.includes(`${path.sep}gateways.live${path.sep}`)) {
        const presence = await json(file);
        if (record(presence) && typeof presence.pid === 'number' && alive(presence.pid))
          throw new Error(`Instance gateway is running (pid ${presence.pid}): ${file}`);
      }
      if (path.basename(file) === 'manifest.json') {
        const value = await json(file);
        if (
          record(value) &&
          Array.isArray(value.entries) &&
          value.entries.some(
            (entry) =>
              record(entry) &&
              (entry.state === 'staged' ||
                (typeof entry.staged === 'string' &&
                  !entry.completedAt &&
                  entry.state !== 'archived')),
          )
        ) {
          // An unstarted planned entry is harmless only when no staged payload exists.
          for (const entry of value.entries)
            if (
              record(entry) &&
              (entry.state === 'staged' ||
                (typeof entry.staged === 'string' && (await info(entry.staged))))
            )
              throw new Error(`Staged storage-archive entry: ${file}`);
        }
      }
    }
  // Deployments can start the node directly, without the CLI's node.pid.
  // Check its structured process argv as well as durable PID/lock files.
  const entrypoints = [
    path.join(plan.legacy.code.node, 'dist/index.js'),
    ...['gateway', 'node'].flatMap((service) => [
      path.join(plan.legacy.code.checkout, 'services', service, 'src/index.ts'),
      path.join(plan.legacy.code.checkout, 'services', service, 'dist/index.js'),
    ]),
  ];
  const processes = await promisify(execFile)('ps', ['-ax', '-o', 'pid=', '-o', 'command=']);
  for (const line of processes.stdout.split('\n')) {
    const match = /^\s*(\d+)\s+(.*)$/.exec(line);
    if (
      match &&
      Number(match[1]) !== process.pid &&
      entrypoints.some((entry) => match[2].includes(entry))
    )
      throw new Error(
        `Instance gateway or node is running (pid ${match[1]}): instance code entrypoint`,
      );
  }
  const gatewayPort = Number(env.GATEWAY_PORT) || 7777;
  if (await portOpen(gatewayPort))
    throw new Error(`Instance gateway port is listening: ${gatewayPort}`);
}
async function assertSafe(
  plan: MigrationPlan,
  env: NodeJS.ProcessEnv,
  hooks: MigrationHooks,
): Promise<void> {
  if (plan.conflicts.length) throw new Error(`Migration conflicts:\n${plan.conflicts.join('\n')}`);
  await assertOffline(plan, env);
  await assertMigratedLinks(plan.steps.filter((step) => step.kind === 'move'));
  for (const mapping of plan.mappings) {
    await assertUnredirected(mapping.source);
    await assertUnredirected(mapping.target);
  }
  for (const step of plan.steps) {
    await assertUnredirected(
      step.kind === 'move' && step.expected['']?.kind === 'link'
        ? path.dirname(step.target)
        : step.target,
    );
    if (step.kind === 'move' && (await info(step.source))) {
      for (const name of Object.keys(await inventory(step.source)))
        if (name.split(path.sep).some((part) => part.startsWith('.retention-')))
          throw new Error(`Staged bundle retention entry: ${step.source}/${name}`);
    }
  }
  for (const root of new Set([
    plan.legacy.data.runBundles,
    translate(plan.legacy.data.runBundles, plan.mappings),
  ]))
    if (await info(root))
      for (const name of Object.keys(await inventory(root)))
        if (name.split(path.sep).some((part) => part.startsWith('.retention-')))
          throw new Error(`Staged bundle retention entry: ${root}/${name}`);
  // Include archive roots outside home/runs in the staged-entry refusal.
  for (const step of plan.steps)
    if (
      step.kind === 'move' &&
      path.basename(step.source) === 'manifest.json' &&
      (await info(step.source))
    ) {
      const value = await json(step.source);
      if (record(value) && Array.isArray(value.entries))
        for (const entry of value.entries)
          if (
            record(entry) &&
            (entry.state === 'staged' ||
              (typeof entry.staged === 'string' && (await info(entry.staged))))
          )
            throw new Error(`Staged storage-archive entry: ${step.source}`);
    }
  const required = new Map<string, { directory: string; bytes: number }>();
  const charge = async (file: string, bytes: number) => {
    let directory = path.dirname(file);
    while (!(await info(directory))) directory = path.dirname(directory);
    const device = String((await info(directory))!.dev);
    const prior = required.get(device);
    required.set(device, { directory, bytes: (prior?.bytes ?? 0) + bytes });
  };
  // Atomic journal replacement briefly holds both generations on the home volume.
  await charge(plan.journal, 2 * Buffer.byteLength(JSON.stringify(plan)) + plan.steps.length * 512);
  for (const step of plan.steps) {
    if (step.status === 'done') continue;
    if (step.kind === 'move') {
      if (step.method === 'copy' && !(await info(step.target)))
        await charge(step.target, step.bytes);
    } else {
      await charge(step.target, Buffer.byteLength(step.body));
      if (!step.backup) await charge(plan.journal, Buffer.byteLength(step.before ?? ''));
    }
  }
  for (const { directory, bytes } of required.values())
    if ((await (hooks.availableBytes ?? availableBytes)(directory)) < bytes)
      throw new Error(`Insufficient free space for migration on ${directory}: need ${bytes} bytes`);
}
async function save(plan: MigrationPlan): Promise<void> {
  await atomicFile(plan.journal, JSON.stringify(plan, null, 2) + '\n');
}
async function ensureDirectory(plan: MigrationPlan, directory: string): Promise<void> {
  if (await info(directory)) {
    await assertUnredirected(directory);
    return;
  }
  await ensureDirectory(plan, path.dirname(directory));
  if (!plan.createdDirs.includes(directory)) {
    plan.createdDirs.push(directory);
    await save(plan);
  }
  await mkdir(directory, { recursive: true });
}
async function moveStep(plan: MigrationPlan, step: MoveStep): Promise<void> {
  await ensureDirectory(plan, path.dirname(step.target));
  const source = await info(step.source);
  const target = await info(step.target);
  const destination = await movedInventory(step);
  if (target) {
    await assertIdentity(step.target, destination);
    if (source) {
      if (step.method !== 'copy' || step.phase !== 'copy-verified')
        throw new Error(`Migration target exists with source: ${step.target}`);
      await removeVerifiedSource(step.source, step.target, step.expected, destination);
    }
    return;
  }
  if (!source) throw new Error(`Migration source and target missing: ${step.source}`);
  await assertIdentity(step.source, step.expected);
  if (step.method === 'rename') {
    await rename(step.source, step.target);
    await syncDirectory(path.dirname(step.source));
    await syncDirectory(path.dirname(step.target));
  } else {
    const partial = `${step.target}.migrate-${plan.id}.partial`;
    await assertUnredirected(partial);
    await copyTree(step.source, partial, destination);
    await assertIdentity(partial, destination);
    await assertIdentity(step.source, step.expected);
    step.phase = 'copy-verified';
    await save(plan);
    await rename(partial, step.target);
    await syncDirectory(path.dirname(step.target));
    await removeVerifiedSource(step.source, step.target, step.expected, destination);
  }
}
async function writeStep(
  plan: MigrationPlan,
  step: Extract<MigrationStep, { kind: 'write' }>,
  index: number,
): Promise<void> {
  await ensureDirectory(plan, path.dirname(step.target));
  if (step.before !== undefined && !step.backup) {
    const backup = path.join(plan.journal.slice(0, -5), 'rewrites', `${index}.before`);
    await ensureDirectory(plan, path.dirname(backup));
    await atomicFile(backup, step.before, step.mode);
    step.backup = backup;
    await save(plan);
  }
  if (await info(step.target)) {
    const body = await readFile(step.target, 'utf8');
    if (body === step.body) return;
    if (body !== step.before) throw new Error(`Rewrite target changed: ${step.target}`);
  } else if (step.before !== undefined) throw new Error(`Rewrite target missing: ${step.target}`);
  await atomicFile(step.target, step.body, step.mode);
}
function assertJournal(value: unknown): asserts value is MigrationPlan {
  if (
    !record(value) ||
    value.version !== 1 ||
    typeof value.home !== 'string' ||
    typeof value.journal !== 'string' ||
    typeof value.dataRoot !== 'string' ||
    typeof value.id !== 'string' ||
    !record(value.legacy) ||
    !Array.isArray(value.mappings) ||
    !Array.isArray(value.conflicts) ||
    !Array.isArray(value.createdDirs) ||
    !Array.isArray(value.steps) ||
    !['planned', 'applying', 'complete', 'rolling-back', 'rolled-back'].includes(
      String(value.status),
    )
  )
    throw new Error('Invalid migration journal');
  for (const mapping of value.mappings)
    if (
      !record(mapping) ||
      typeof mapping.source !== 'string' ||
      typeof mapping.target !== 'string'
    )
      throw new Error('Invalid migration mapping');
  for (const step of value.steps) {
    if (!record(step) || typeof step.target !== 'string' || !path.isAbsolute(step.target))
      throw new Error('Invalid migration step');
    if (step.kind === 'write') {
      if (
        typeof step.body !== 'string' ||
        typeof step.mode !== 'number' ||
        (step.before !== undefined && typeof step.before !== 'string')
      )
        throw new Error('Invalid migration rewrite');
    } else if (step.kind === 'move') {
      if (
        typeof step.source !== 'string' ||
        !path.isAbsolute(step.source) ||
        !['copy', 'rename'].includes(String(step.method)) ||
        !record(step.expected)
      )
        throw new Error('Invalid migration move');
    } else throw new Error('Invalid migration step kind');
  }
}
async function latestJournal(home: string): Promise<MigrationPlan | undefined> {
  const directory = path.join(home, 'backups');
  if (!(await info(directory))) return undefined;
  const names = (await readdir(directory))
    .filter((name) => /^migrate-.*\.json$/.test(name))
    .sort()
    .reverse();
  for (const name of names) {
    await assertUnredirected(path.join(directory, name));
    const value = await json(path.join(directory, name));
    if (
      !record(value) ||
      value.version !== 1 ||
      value.home !== home ||
      !Array.isArray(value.steps) ||
      !Array.isArray(value.createdDirs)
    )
      throw new Error(`Invalid migration journal: ${name}`);
    // The journal is produced by this module. Reject unknown steps before performing any I/O from it.
    if (
      !value.steps.every(
        (step) =>
          record(step) &&
          ['move', 'write'].includes(String(step.kind)) &&
          typeof step.target === 'string',
      )
    )
      throw new Error(`Invalid migration steps: ${name}`);
    assertJournal(value);
    const plan = value;
    if (plan.journal !== path.join(directory, name))
      throw new Error(`Migration journal location differs: ${name}`);
    return plan;
  }
  return undefined;
}
export async function migratePaths(
  options: MigrationOptions,
  mode: 'plan' | 'apply' | 'rollback',
  hooks: MigrationHooks = {},
): Promise<MigrationPlan> {
  const home = path.resolve(expandHome(options.home));
  await assertUnredirected(home);
  const latest = await latestJournal(home);
  if (mode === 'rollback' && latest?.status === 'rolled-back') return latest;
  const existing = latest?.status === 'rolled-back' ? undefined : latest;
  if (
    existing &&
    options.data &&
    path.resolve(home, expandHome(options.data)) !== existing.dataRoot
  )
    throw new Error('Data root differs from the migration journal');
  if (mode === 'plan') {
    if (existing) return existing;
    return planMigration(options);
  }
  if (mode === 'rollback' && !existing) throw new Error('No migration journal to roll back');
  const plan = existing ?? (await planMigration(options));
  if (!existing && (await info(path.join(home, 'config/instance.json'))))
    throw new Error('Layout 2 already configured without a migration journal');
  await assertSafe(plan, options.env ?? process.env, hooks);
  await mkdir(path.dirname(plan.journal), { recursive: true });
  const lock = path.join(home, 'backups', 'migrate.lock');
  try {
    const holder = await open(lock, 'wx', 0o600);
    try {
      await holder.writeFile(String(process.pid));
      await holder.sync();
    } finally {
      await holder.close();
    }
  } catch (error) {
    if (!hasCode(error, 'EEXIST')) throw error;
    const pid = Number(await readFile(lock, 'utf8'));
    if (!Number.isInteger(pid) || pid <= 0 || alive(pid))
      throw new Error(`Migration is locked: ${lock}`);
    await rm(lock);
    return migratePaths(options, mode, hooks);
  }
  try {
    if (mode === 'apply') {
      if (plan.status === 'rolling-back')
        throw new Error('Rollback is in progress; finish --rollback first');
      if (plan.status === 'complete') return plan;
      plan.status = 'applying';
      await save(plan);
      for (const [index, step] of plan.steps.entries()) {
        if (step.status === 'done') continue;
        step.status = 'running';
        await save(plan);
        await hooks.checkpoint?.(plan, index);
        await assertUnredirected(
          step.kind === 'move' && step.expected['']?.kind === 'link'
            ? path.dirname(step.target)
            : step.target,
        );
        if (step.kind === 'move') await moveStep(plan, step);
        else await writeStep(plan, step, index);
        step.status = 'done';
        await save(plan);
        await hooks.checkpoint?.(plan, index);
      }
      plan.status = 'complete';
      await save(plan);
      return plan;
    }
    plan.status = 'rolling-back';
    await save(plan);
    for (const step of [...plan.steps].reverse()) {
      if (!step.status || step.status === 'undone') continue;
      await save(plan);
      await assertUnredirected(
        step.kind === 'move' && step.expected['']?.kind === 'link'
          ? path.dirname(step.target)
          : step.target,
      );
      if (step.kind === 'write') {
        if (step.before === undefined) {
          if (await info(step.target)) {
            if ((await readFile(step.target, 'utf8')) !== step.body)
              throw new Error(`Rollback target changed: ${step.target}`);
            await rm(step.target);
          }
        } else if (step.backup) {
          const current = await readFile(step.target, 'utf8');
          if (current !== step.body && current !== step.before)
            throw new Error(`Rollback rewrite changed: ${step.target}`);
          await atomicFile(step.target, await readFile(step.backup), step.mode);
        }
      } else {
        const destination = await movedInventory(step);
        await assertUnredirected(
          step.expected['']?.kind === 'link' ? path.dirname(step.source) : step.source,
        );
        if (await info(step.target)) {
          if (step.rollbackPhase !== 'copy-verified')
            await assertIdentity(step.target, destination);
          await mkdir(path.dirname(step.source), { recursive: true });
          if (step.method === 'rename') {
            if (await info(step.source)) throw new Error(`Rollback source exists: ${step.source}`);
            await rename(step.target, step.source);
          } else {
            if (step.rollbackPhase !== 'copy-verified') {
              // A forward copy may have been killed during source unlink. Refill its remainder.
              if (await info(step.source)) await assertIdentity(step.source, step.expected, true);
              await copyTree(step.target, step.source, step.expected);
              await assertIdentity(step.source, step.expected);
              step.rollbackPhase = 'copy-verified';
              await save(plan);
            }
            await removeVerifiedSource(step.target, step.source, destination, step.expected);
          }
        }
        await syncDirectory(path.dirname(step.source));
        if (await info(path.dirname(step.target))) await syncDirectory(path.dirname(step.target));
        const partial = `${step.target}.migrate-${plan.id}.partial`;
        if (await info(partial)) {
          await assertIdentity(step.source, step.expected);
          await rm(partial, { recursive: true });
        }
      }
      step.status = 'undone';
      await save(plan);
    }
    for (const directory of [...plan.createdDirs].reverse()) {
      try {
        await rmdir(directory);
      } catch (error) {
        if (!hasCode(error, 'ENOTEMPTY') && !hasCode(error, 'ENOENT')) throw error;
      }
    }
    plan.status = 'rolled-back';
    await save(plan);
    return plan;
  } finally {
    await rm(lock);
  }
}
