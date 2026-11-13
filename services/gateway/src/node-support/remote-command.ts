import { type Stats } from 'node:fs';
import { lstat, stat } from 'node:fs/promises';

import { isRacyStamp } from '@farmslot/protocol';
import { legacyRemoteFarmPaths } from '@farmslot/protocol/node/farm-paths';
import { packMachineNames } from '@farmslot/protocol/node/pack-portability';
// node-support/remote-command.ts — run remote farm scripts from the bundle that
// matches the config the command was expanded from.
//
// Hook strings come from this gateway's project.json, but a remote node used to
// resolve `~/farmslot-node/projects/...` against whatever `deploy-node.sh` last
// copied there. Fast-forwarding the operator's farm config ahead of a node's
// deploy then sent hooks that call scripts the node does not have (exit 127,
// twice: ledger F15). Prepare already ran its hooks from the content-hashed
// bundle; this does the same for every remote command, so config and scripts
// always travel together and rollout order stops mattering.
import { currentProjectSources, poolDirectory } from '@farmslot/slot-config';

import type { ProjectVars, RawProjectJson, SlotVars } from '../core/index.js';
import { farmCommandRootsForSlot, farmPathsForSlot } from '../fleet/farm-paths.js';

import { NODE_SUPPORT_COMMAND_CACHE_MS, wrapNodeSupportReadCommand } from './activation.js';
import {
  collectNodeSupportBundle,
  ensureNodeSupportBundle,
  loadProjectVarsIfAny,
  type NodeSupportBundleInputs,
  nodeSupportBundlePaths,
  type NodeSupportBundleState,
  type NodeSupportIo,
} from './ensure.js';

/**
 * A remote farm reference, as `{{farmslot_dir}}` expands on a node: a file
 * under `projects/` or `scripts/`, or the bare root handed to a farm script
 * that builds those paths itself (mobile preflight takes it as an argument).
 */
function remoteFarmRef(root: string, global = false): RegExp {
  const escaped = [...new Set([root, root.replaceAll("'", "'\\''")])]
    .map((value) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
    .join('|');
  return new RegExp(
    `(?:${escaped})` +
      String.raw`(?:/((?:projects|scripts)/[^\s'"\x60;&|()<>{},:]+)|(?=$|[\s'"\x60;&|()<>{},:]))`,
    global ? 'g' : '',
  );
}

/**
 * How long a bundle this process verified on a slot is trusted without asking
 * the node again. Bundles are content-addressed and never rewritten in place,
 * and read-only cache entries retain a bounded reader reference on the node.
 * Each read also holds the activation lock through execution. The local bundle
 * is checked against its inputs on every lookup, so a config change is never masked.
 */
const VERIFIED_TTL_MS = NODE_SUPPORT_COMMAND_CACHE_MS;
/**
 * How often a held bundle's inputs are checked for a change. A burst of commands (a prepare runs
 * hundreds, a fleet refresh checks every slot at once) shares one check; a change reaches the next
 * command after it at most this late.
 */
const LOCAL_CHECK_INTERVAL_MS = 2_000;
/**
 * How long a held bundle is trusted at most: a change its inputs cannot show (a global excludes
 * file, Git config, a nested repository's index) is picked up within this. One collection per
 * project per period.
 */
const LOCAL_MAX_AGE_MS = 10 * 60_000;
/** Concurrent stats while stamping a bundle's inputs. */
const STAMP_CONCURRENCY = 16;

type CollectedBundle = Awaited<ReturnType<typeof collectNodeSupportBundle>>;
interface LocalBundle {
  hash: string;
  paths: string[];
  collected: CollectedBundle;
}

/**
 * What a path looked like: modification and change times, size, inode and mode, or `missing`.
 * Any write, rename over it or mode change gives another stamp.
 */
type InputStamp = string;

/** A path a bundle was built from, and how it is stamped. */
interface BundleInput {
  path: string;
  /** Through links, as the support collection reads it; otherwise the path itself. */
  follow: boolean;
  /** Absent is a state, not a change: an ignore file or Git index that may appear. */
  optional: boolean;
}

/** The inputs of a collection and their stamps when it finished, in the same order. */
interface HeldInputs {
  list: BundleInput[];
  stamps: InputStamp[];
  machines: string;
}

/**
 * A collected bundle, kept until something it was built from changes (collecting it walks, hashes
 * and checks every support file and pack: seconds of work).
 */
interface HeldBundle {
  pathsKey: string;
  bundle: Promise<LocalBundle>;
  /**
   * Set when the collection finished: its inputs, or `changed` when one changed too close to the
   * collection for its stamp to be trusted (collect again next time).
   */
  inputs?: HeldInputs | 'changed';
  /** When the collection started. */
  startedAt: number;
  checkedAt: number;
  check?: Promise<boolean>;
}

const verifiedBundles = new Map<string, { at: number; supportDir: string }>();
/**
 * One ensure per slot and bundle at a time. Keyed by the hash too, so a hook
 * expanded after a fast-forward never joins a publish of the older bundle.
 */
const pendingEnsures = new Map<string, Promise<NodeSupportBundleState | null>>();
/**
 * The ensure currently uploading a bundle to a machine. Other slots on that
 * machine wait for it and then only verify and record their selection, rather
 * than each uploading the same files.
 */
const machinePublishes = new Map<string, Promise<NodeSupportBundleState | null>>();
const localBundles = new Map<string, HeldBundle>();

/**
 * The caller's time budget ran out while the bundle was still being delivered.
 * The delivery keeps going for the next command. This one did not run: a hook
 * through `execOnSlot` reports a timeout, as it would had the node been slow,
 * and a resource command reports itself unavailable, so a pending delivery is
 * never read as a stopped resource.
 */
export class NodeSupportPendingError extends Error {}

export function hasRemoteFarmRef(
  command: string,
  root = legacyRemoteFarmPaths().code.node,
): boolean {
  return remoteFarmRef(root).test(command);
}

/**
 * Point every reference the bundle carries at the bundle; leave the rest alone.
 * The bare root moves only when the bundle carries `scripts`: farm scripts
 * reach `scripts/` and `projects/<name>/` from it, which is what a bundle with
 * project support holds (ADR-035's `{{node_support_dir}}`).
 */
export function remapRemoteFarmRefs(
  command: string,
  supportDir: string,
  paths: string[],
  root = legacyRemoteFarmPaths().code.node,
): string {
  return command.replace(
    remoteFarmRef(root, true),
    (whole, relative: string | undefined, offset: number) => {
      const selected =
        command[offset - 1] === "'" ? supportDir.replaceAll("'", "'\\''") : supportDir;
      if (relative === undefined) return paths.includes('scripts') ? selected : whole;
      return paths.some((covered) => relative === covered || relative.startsWith(`${covered}/`))
        ? `${selected}/${relative}`
        : whole;
    },
  );
}

/** The path, or a directory on the way to it, is gone: replaced by a file counts too. */
function isMissing(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException).code;
  return code === 'ENOENT' || code === 'ENOTDIR';
}

/** Stamps of these inputs, a few at a time, in the same order. */
async function stampInputs(inputs: readonly BundleInput[]): Promise<InputStamp[]> {
  const stamps: InputStamp[] = [];
  let next = 0;
  const worker = async () => {
    while (next < inputs.length) {
      const index = next++;
      const input = inputs[index];
      let info: Stats;
      try {
        info = await (input.follow ? stat : lstat)(input.path);
      } catch (error) {
        // Any failure but a missing path is not a stamp.
        if (!isMissing(error)) throw error;
        stamps[index] = 'missing';
        continue;
      }
      stamps[index] = `${info.mtimeMs}:${info.ctimeMs}:${info.size}:${info.ino}:${info.mode}`;
    }
  };
  await Promise.all(Array.from({ length: Math.min(STAMP_CONCURRENCY, inputs.length) }, worker));
  return stamps;
}

/**
 * Whether an input's stamp cannot vouch for the bytes collected: it vanished, or it changed too
 * close to the collection's start for a later write to be sure to change the stamp (isRacyStamp:
 * coarse timestamps).
 */
function unsettled(input: BundleInput, stamp: InputStamp, startedAt: number): boolean {
  if (stamp === 'missing') return !input.optional;
  const [mtimeMs, ctimeMs] = stamp.split(':').map(Number);
  return isRacyStamp(Math.max(mtimeMs, ctimeMs), startedAt);
}

function bundleInputs(inputs: NodeSupportBundleInputs): BundleInput[] {
  const seen = new Set<string>();
  const list: BundleInput[] = [];
  const add = (paths: string[], follow: boolean, optional: boolean) => {
    for (const file of paths) {
      const key = `${follow}:${file}`;
      if (seen.has(key)) continue;
      seen.add(key);
      list.push({ path: file, follow, optional });
    }
  };
  add(inputs.followed, true, false);
  add(inputs.exact, false, false);
  add(inputs.optional, false, true);
  return list;
}

function collectLocalBundle(projectName: string, paths: string[], pathsKey: string): HeldBundle {
  const startedAt = Date.now();
  let held: HeldBundle | undefined;
  const bundle = (async (): Promise<LocalBundle> => {
    const collected = await collectNodeSupportBundle(projectName, paths);
    const list = bundleInputs(collected.inputs);
    const stamps = await stampInputs(list);
    if (held) {
      held.inputs = list.some((input, index) => unsettled(input, stamps[index], startedAt))
        ? 'changed'
        : { list, stamps, machines: collected.inputs.machines.join('\0') };
      held.checkedAt = Date.now();
    }
    return { hash: collected.manifest.hash, paths, collected };
  })();
  held = { pathsKey, bundle, startedAt, checkedAt: startedAt };
  localBundles.set(projectName, held);
  return held;
}

/** Whether the pool machine names and every input's stamp are as the collection left them. */
async function inputsUnchanged(held: HeldBundle, inputs: HeldInputs): Promise<boolean> {
  if (packMachineNames(poolDirectory()).join('\0') !== inputs.machines) return false;
  const now = await stampInputs(inputs.list);
  if (now.some((stamp, index) => stamp !== inputs.stamps[index])) return false;
  held.checkedAt = Date.now();
  return true;
}

/** Whether nothing the held bundle was built from has changed; one check at a time. */
async function heldBundleCurrent(held: HeldBundle): Promise<boolean> {
  const inputs = held.inputs;
  // Still collecting: callers share the collection.
  if (inputs === undefined) return true;
  if (Date.now() - held.startedAt >= LOCAL_MAX_AGE_MS) return false;
  // An input that stays unsettled (a future timestamp, a directory rewritten every second) is
  // collected again at most this often, as a held one is checked.
  if (Date.now() - held.checkedAt < LOCAL_CHECK_INTERVAL_MS) return true;
  if (inputs === 'changed') return false;
  // Cleared once settled, after it is stored: a failed check never stays for the next command.
  held.check ??= inputsUnchanged(held, inputs).finally(() => {
    held.check = undefined;
  });
  return held.check;
}

async function currentLocalBundle(
  projectName: string,
  projectJson: RawProjectJson,
): Promise<LocalBundle> {
  const paths = nodeSupportBundlePaths(projectName, projectJson);
  const pathsKey = paths.join('\0');
  let held = localBundles.get(projectName);
  if (!held || held.pathsKey !== pathsKey || !(await heldBundleCurrent(held))) {
    // Concurrent callers that found the same change share the one collection the first starts.
    const latest = localBundles.get(projectName);
    held =
      latest && latest !== held && latest.pathsKey === pathsKey
        ? latest
        : collectLocalBundle(projectName, paths, pathsKey);
  }
  try {
    return await held.bundle;
  } catch (error) {
    // A failed read must not be served to the next caller from the cache.
    if (localBundles.get(projectName) === held) localBundles.delete(projectName);
    throw error;
  }
}

function ensureOnce(
  vars: SlotVars,
  projectVars: ProjectVars,
  local: LocalBundle,
  io: NodeSupportIo | undefined,
  selectSlot: boolean,
): Promise<NodeSupportBundleState | null> {
  const slotKey = `${vars.slotId}\0${farmPathsForSlot(vars).code.support}\0${local.hash}\0${selectSlot}`;
  const existing = pendingEnsures.get(slotKey);
  if (existing) return existing;
  const machineKey = `${vars.machine}\0${farmPathsForSlot(vars).code.support}\0${local.hash}`;
  const upload = machinePublishes.get(machineKey);
  const pending: Promise<NodeSupportBundleState | null> = (async () => {
    try {
      if (upload) {
        // That upload's failure is reported to its own caller. This slot then
        // runs its own ensure, which retries the publish if it is still needed.
        await upload.then(
          () => undefined,
          () => undefined,
        );
      }
      return await ensureNodeSupportBundle(vars, projectVars.runtimeDir ?? '.agent', {
        projectVars,
        io,
        collected: local.collected,
        selectSlot,
      });
    } finally {
      pendingEnsures.delete(slotKey);
      // Only the slot that found no upload registered one, and nothing else
      // replaces an entry while it stands.
      if (!upload) machinePublishes.delete(machineKey);
    }
  })();
  pendingEnsures.set(slotKey, pending);
  if (!upload) machinePublishes.set(machineKey, pending);
  return pending;
}

async function withinBudget<T>(
  work: Promise<T>,
  budgetMs: number | undefined,
  slotId: string,
): Promise<T> {
  if (budgetMs === undefined) return work;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expired = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () =>
        reject(
          new NodeSupportPendingError(
            `node support bundle for ${slotId} still being delivered after ${budgetMs}ms`,
          ),
        ),
      budgetMs,
    );
  });
  try {
    // A delivery that fails after the budget ran out is not lost: the pending
    // entry clears and the next command on the slot runs it again and gets
    // the error.
    return await Promise.race([work, expired]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * The command a remote slot should run. Commands that reference no farm file
 * pass through untouched; ones that do get the current bundle ensured on the
 * node first. A bundle that cannot be ensured throws: running the hook anyway
 * is exactly the half-deployed state this exists to rule out.
 */
export async function resolveRemoteFarmCommand(
  vars: SlotVars,
  command: string,
  options: {
    io?: NodeSupportIo;
    /** Maximum bundle delivery wait before the configured command timeout starts. */
    budgetMs?: number;
    /** Preserve the slot support pointer while checking prerequisites. */
    selectSlot?: boolean;
  } = {},
): Promise<string> {
  const roots = farmCommandRootsForSlot(vars);
  const sources = currentProjectSources();
  if (sources) {
    // Project hooks already resolve to exact read-only source roots. Framework scripts
    // remain part of node service deployment, separate from pack synchronization.
    if (roots.some((root) => command.includes(`${root}/projects/`)))
      throw new Error('Loose node pack reference is refused for locked execution');
    return command;
  }
  if (!roots.some((root) => hasRemoteFarmRef(command, root))) return command;
  // No project config means no bundle to run from; the command keeps the
  // node's own copy, as it always has.
  const projectVars = await loadProjectVarsIfAny(vars.projectName);
  if (!projectVars) return command;
  const local = await currentLocalBundle(vars.projectName, projectVars.projectJson);
  const remap = (supportDir: string, paths: string[]) =>
    roots.reduce((cmd, root) => remapRemoteFarmRefs(cmd, supportDir, paths, root), command);
  const selectSlot = options.selectSlot !== false;
  const cacheKey = `${vars.slotId}\0${farmPathsForSlot(vars).code.support}\0${local.hash}\0${selectSlot}`;
  const verified = verifiedBundles.get(cacheKey);
  if (verified && Date.now() - verified.at < VERIFIED_TTL_MS) {
    const mapped = remap(verified.supportDir, local.paths);
    return selectSlot ? mapped : wrapNodeSupportReadCommand(mapped, verified.supportDir);
  }
  const state = await withinBudget(
    ensureOnce(vars, projectVars, local, options.io, selectSlot),
    options.budgetMs,
    vars.slotId,
  );
  if (!state?.hash) return command;
  verifiedBundles.set(cacheKey, { at: Date.now(), supportDir: state.supportDir });
  const mapped = remap(state.supportDir, state.paths);
  return selectSlot ? mapped : wrapNodeSupportReadCommand(mapped, state.supportDir);
}

/**
 * Slot-id entry point for the call sites that send `exec` to a node directly
 * instead of through `execOnSlot` (resource commands, slot actions).
 */
export async function resolveSlotFarmCommand(
  slotId: string,
  command: string,
  budgetMs?: number,
): Promise<string> {
  const { loadSlotVars } = await import('../core/index.js');
  return resolveRemoteFarmCommand(await loadSlotVars(slotId), command, { budgetMs });
}

/** Test seam: forget what this process verified. */
export function resetRemoteFarmCommandCache(): void {
  verifiedBundles.clear();
  localBundles.clear();
  pendingEnsures.clear();
  machinePublishes.clear();
}
