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
import { lazyImport } from '../core/lazy-import.js';
import { farmCommandRootsForSlot, farmPathsForSlot } from '../fleet/farm-paths.js';

import { NODE_SUPPORT_COMMAND_CACHE_MS, wrapNodeSupportReadCommand } from './activation.js';
import {
  collectNodeSupportBundle,
  ensureNodeSupportBundle,
  loadProjectVarsIfAny,
  type NodeSupportBundleInputs,
  nodeSupportBundlePaths,
  type NodeSupportBundleState,
  type NodeSupportDeliveryProgress,
  type NodeSupportIo,
} from './ensure.js';
import { nodeSupportBundleBytes } from './files.js';
import { onNodeSupportSelection } from './selection-events.js';

const loadCore = lazyImport(() => import('../core/index.js'));

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
  environment: Record<string, string | undefined>;
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
 * The bundle each slot selected last in this gateway (null: unknown, after a
 * failed activation), and the selecting activations still running per slot. A
 * slot moved to another bundle may have its earlier one pruned, so a selected
 * entry counts only while no selection for its slot is running and it is the
 * slot's latest selection: an entry for an earlier bundle would point commands
 * at a deleted directory (a dev-server shutdown that then left the gateway
 * running). Checked when an entry is written and when it is read, so a delivery
 * that finishes after a newer selection never caches its older bundle.
 * Read-only entries hold their own reader lease on the node, so they stay valid.
 * A selection made by another gateway is not seen here.
 */
const latestSelection = new Map<string, string | null>();
const selectionsRunning = new Map<string, number>();
onNodeSupportSelection({
  started(slotId) {
    selectionsRunning.set(slotId, (selectionsRunning.get(slotId) ?? 0) + 1);
  },
  ended(slotId, supportDir) {
    const running = (selectionsRunning.get(slotId) ?? 1) - 1;
    if (running > 0) selectionsRunning.set(slotId, running);
    else selectionsRunning.delete(slotId);
    latestSelection.set(slotId, supportDir);
  },
});

function selectionCurrent(slotId: string, supportDir: string, selectSlot: boolean): boolean {
  if (!selectSlot) return true;
  if (selectionsRunning.has(slotId)) return false;
  // A selecting ensure records its selection before it returns, so a slot with
  // none recorded has had no selection that could make this entry stale.
  const latest = latestSelection.get(slotId);
  return latest === undefined || latest === supportDir;
}
/**
 * How long one delivery may take, from its start: a re-delivery after a node
 * redeploy re-verifies every file and repoints the slot, which takes seconds to
 * minutes. Longer than the slowest single step (activation, 180 s), so it bounds
 * a delivery that stopped making progress rather than a slow one.
 */
export const NODE_SUPPORT_DELIVERY_DEADLINE_MS = 300_000;

/** One delivery of a bundle to a slot, and how far it got. */
interface Delivery {
  promise: Promise<NodeSupportBundleState | null>;
  slotKey: string;
  machineKey: string;
  slotId: string;
  bundle: string;
  files: number;
  deadlineMs: number;
  /** Counted from the start of this slot's own work: a wait on another slot's upload does not use it up. */
  deadlineAt: number;
  /** This delivery's own progress, or the machine upload's while it waits for that. */
  progress: NodeSupportDeliveryProgress;
}

/**
 * One ensure per slot and bundle at a time. Keyed by the hash too, so a hook
 * expanded after a fast-forward never joins a publish of the older bundle.
 */
const pendingEnsures = new Map<string, Delivery>();
/**
 * The ensure currently uploading a bundle to a machine. Other slots on that
 * machine wait for it and then only verify and record their selection, rather
 * than each uploading the same files.
 */
const machinePublishes = new Map<string, Delivery>();
const localBundles = new Map<string, HeldBundle>();

/**
 * The caller's time budget, or the delivery's own deadline, ran out while the
 * bundle was still being delivered. The message names the bundle, the phase and
 * the bytes left to send. Within its deadline the delivery keeps going for the
 * next command; past it, the next command starts a new one. This one did not run: a hook
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
        : {
            list,
            stamps,
            machines: collected.inputs.machines.join('\0'),
            environment: collected.inputs.environment ?? {},
          };
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
  if (
    inputs !== 'changed' &&
    Object.entries(inputs.environment).some(([name, value]) => process.env[name] !== value)
  )
    return false;
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
): Delivery {
  const slotKey = `${vars.slotId}\0${farmPathsForSlot(vars).code.support}\0${local.hash}\0${selectSlot}`;
  const machineKey = `${vars.machine}\0${farmPathsForSlot(vars).code.support}\0${local.hash}`;
  const existing = current(pendingEnsures.get(slotKey));
  if (existing) return existing;
  const upload = current(machinePublishes.get(machineKey));
  const progress: NodeSupportDeliveryProgress = {
    phase: 'starting',
    sentBytes: 0,
    totalBytes: nodeSupportBundleBytes(local.collected.files),
  };
  const deadlineMs = io?.deliveryDeadlineMs ?? NODE_SUPPORT_DELIVERY_DEADLINE_MS;
  const delivery: Delivery = {
    promise: Promise.resolve(null),
    slotKey,
    machineKey,
    slotId: vars.slotId,
    bundle: local.hash,
    files: local.collected.files.length,
    deadlineMs,
    deadlineAt: Date.now() + deadlineMs,
    progress: upload ? upload.progress : progress,
  };
  delivery.promise = (async () => {
    try {
      if (upload) {
        // That upload's failure is reported to its own caller, and past its
        // deadline it is dropped. This slot then runs its own ensure, which
        // retries the publish if it is still needed.
        let ahead: Delivery | undefined = upload;
        while (ahead) {
          delivery.progress = ahead.progress;
          const published = await settledOrExpired(ahead);
          // Waiting does not use up this slot's own deadline.
          delivery.deadlineAt = Date.now() + deadlineMs;
          // A published bundle: this slot only verifies and repoints, alongside
          // the others. An upload that failed or expired: the first slot to get
          // here takes over as the machine's upload and the rest wait on it.
          if (published) break;
          ahead = current(machinePublishes.get(machineKey));
          if (!ahead) machinePublishes.set(machineKey, delivery);
        }
        delivery.progress = progress;
      }
      return await ensureNodeSupportBundle(vars, projectVars.runtimeDir ?? '.agent', {
        projectVars,
        io,
        collected: local.collected,
        selectSlot,
        progress,
      });
    } finally {
      forgetDelivery(delivery);
    }
  })();
  // Each waiter reports the outcome to its own caller; a delivery that fails
  // after every waiter left must not become an unhandled rejection, which
  // would end the gateway.
  delivery.promise.catch(() => undefined);
  pendingEnsures.set(slotKey, delivery);
  if (!upload) machinePublishes.set(machineKey, delivery);
  return delivery;
}

/**
 * The delivery to join, or undefined when there is none or it is past its
 * deadline. An expired delivery is dropped here, whether or not anyone was
 * waiting when its deadline passed, so the caller starts a fresh one.
 */
function current(delivery: Delivery | undefined): Delivery | undefined {
  if (!delivery || delivery.deadlineAt > Date.now()) return delivery;
  forgetDelivery(delivery);
  return undefined;
}

/**
 * Wait for another slot's upload to settle, at most until that upload's
 * deadline. True when it published the bundle.
 */
async function settledOrExpired(upload: Delivery): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expired = new Promise<boolean>((resolve) => {
    timer = setTimeout(
      () => {
        forgetDelivery(upload);
        resolve(false);
      },
      Math.max(0, upload.deadlineAt - Date.now()),
    );
  });
  try {
    return await Promise.race([
      upload.promise.then(
        () => true,
        () => false,
      ),
      expired,
    ]);
  } finally {
    clearTimeout(timer);
  }
}

/** Drop the entries this delivery registered, never a newer delivery's. */
function forgetDelivery(delivery: Delivery): void {
  if (pendingEnsures.get(delivery.slotKey) === delivery) pendingEnsures.delete(delivery.slotKey);
  if (machinePublishes.get(delivery.machineKey) === delivery)
    machinePublishes.delete(delivery.machineKey);
}

function describeDelivery(delivery: Delivery): string {
  const { phase, sentBytes, totalBytes } = delivery.progress;
  const left = Math.max(0, totalBytes - sentBytes);
  return `${phase}; ${left} of ${totalBytes} bytes left to send, ${delivery.files} files`;
}

/**
 * Wait for the delivery to finish or fail, at most until the caller's budget or
 * the delivery's own deadline, whichever comes first.
 */
async function awaitDelivery(
  delivery: Delivery,
  budgetMs: number | undefined,
  signal: AbortSignal | undefined,
): Promise<NodeSupportBundleState | null> {
  const budgetEndsAt = budgetMs === undefined ? Infinity : Date.now() + budgetMs;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let onAbort: (() => void) | undefined;
  const expired = new Promise<never>((_, reject) => {
    // A cancelled caller stops waiting; the delivery keeps going for the next command.
    onAbort = () => reject(signal?.reason ?? new Error('node support wait cancelled'));
    if (signal?.aborted) onAbort();
    else signal?.addEventListener('abort', onAbort, { once: true });
    const arm = () => {
      const byBudget = budgetEndsAt < delivery.deadlineAt;
      timer = setTimeout(
        () => {
          // A joiner's deadline restarts when its own work begins: keep waiting.
          if (!byBudget && delivery.deadlineAt > Date.now()) return arm();
          const bundle = `node support bundle ${delivery.bundle.slice(0, 8)} for ${delivery.slotId}`;
          if (!byBudget) {
            // Past its deadline the delivery no longer holds the slot: the next
            // command starts a fresh one instead of joining a stalled one.
            forgetDelivery(delivery);
          }
          reject(
            new NodeSupportPendingError(
              byBudget
                ? `${bundle} still being delivered after ${budgetMs}ms (${describeDelivery(delivery)})`
                : `${bundle} was not delivered within its ${delivery.deadlineMs}ms deadline (${describeDelivery(delivery)})`,
            ),
          );
        },
        Math.max(0, Math.min(budgetEndsAt, delivery.deadlineAt) - Date.now()),
      );
    };
    arm();
  });
  try {
    // A delivery that fails after the wait ended is not lost: the pending
    // entry clears and the next command on the slot runs it again and gets
    // the error.
    return await Promise.race([delivery.promise, expired]);
  } finally {
    clearTimeout(timer);
    if (onAbort) signal?.removeEventListener('abort', onAbort);
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
    /**
     * Longest wait for the bundle delivery before the configured command timeout
     * starts. Without one, the wait lasts until the delivery finishes or fails,
     * bounded by the delivery's own deadline.
     */
    budgetMs?: number;
    /** Preserve the slot support pointer while checking prerequisites. */
    selectSlot?: boolean;
    /** Stop waiting when this aborts; the delivery itself continues. */
    signal?: AbortSignal;
    /** Resolve a support directory itself, independently of hook script coverage. */
    supportRoot?: boolean;
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
    options.supportRoot && roots.includes(command)
      ? supportDir
      : roots.reduce((cmd, root) => remapRemoteFarmRefs(cmd, supportDir, paths, root), command);
  const selectSlot = options.selectSlot !== false;
  const cacheKey = `${vars.slotId}\0${farmPathsForSlot(vars).code.support}\0${local.hash}\0${selectSlot}`;
  const verified = verifiedBundles.get(cacheKey);
  if (
    verified &&
    Date.now() - verified.at < VERIFIED_TTL_MS &&
    selectionCurrent(vars.slotId, verified.supportDir, selectSlot)
  ) {
    const mapped = remap(verified.supportDir, local.paths);
    return selectSlot ? mapped : wrapNodeSupportReadCommand(mapped, verified.supportDir);
  }
  // A caller cancelled while the bundle was being read starts no delivery.
  options.signal?.throwIfAborted();
  const state = await awaitDelivery(
    ensureOnce(vars, projectVars, local, options.io, selectSlot),
    options.budgetMs,
    options.signal,
  );
  if (!state?.hash) return command;
  if (selectionCurrent(vars.slotId, state.supportDir, selectSlot))
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
  const { loadSlotVars } = await loadCore();
  return resolveRemoteFarmCommand(await loadSlotVars(slotId), command, { budgetMs });
}

/** Test seam: forget what this process verified. */
export function resetRemoteFarmCommandCache(): void {
  verifiedBundles.clear();
  latestSelection.clear();
  selectionsRunning.clear();
  localBundles.clear();
  pendingEnsures.clear();
  machinePublishes.clear();
}
