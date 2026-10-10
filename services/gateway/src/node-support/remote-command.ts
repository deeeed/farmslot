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

import type { ProjectVars, RawProjectJson, SlotVars } from '../core/index.js';

import {
  collectNodeSupportBundle,
  ensureNodeSupportBundle,
  loadProjectVarsIfAny,
  nodeSupportBundlePaths,
  type NodeSupportBundleState,
  type NodeSupportIo,
} from './ensure.js';

/**
 * A remote farm reference, as `{{farmslot_dir}}` expands on a node: a file
 * under `projects/` or `scripts/`, or the bare root handed to a farm script
 * that builds those paths itself (mobile preflight takes it as an argument).
 */
const REMOTE_FARM_REF =
  /~\/farmslot-node(?:\/((?:projects|scripts)\/[^\s'"`;&|()<>{},:]+)|(?=$|[\s'"`;&|()<>{},:]))/g;

/**
 * How long a bundle this process verified on a slot is trusted without asking
 * the node again. Bundles are content-addressed and never rewritten in place,
 * so the risk is only a bundle deleted by hand; the local hash is still
 * recomputed on every lookup, so a config change is never masked.
 */
const VERIFIED_TTL_MS = 10 * 60_000;
/** Coalesces the local re-hash across a burst (fleet refresh checks every slot at once). */
const LOCAL_HASH_TTL_MS = 2_000;

type CollectedBundle = Awaited<ReturnType<typeof collectNodeSupportBundle>>;
interface LocalBundle {
  hash: string;
  paths: string[];
  collected: CollectedBundle;
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
const localBundles = new Map<string, { at: number; bundle: Promise<LocalBundle> }>();

/**
 * The caller's time budget ran out while the bundle was still being delivered.
 * The delivery keeps going for the next command. This one did not run: a hook
 * through `execOnSlot` reports a timeout, as it would had the node been slow,
 * and a resource command reports itself unavailable, so a pending delivery is
 * never read as a stopped resource.
 */
export class NodeSupportPendingError extends Error {}

const HAS_REMOTE_FARM_REF = new RegExp(REMOTE_FARM_REF.source);

export function hasRemoteFarmRef(command: string): boolean {
  return HAS_REMOTE_FARM_REF.test(command);
}

/**
 * Point every reference the bundle carries at the bundle; leave the rest alone.
 * The bare root moves only when the bundle carries `scripts`: farm scripts
 * reach `scripts/` and `projects/<name>/` from it, which is what a bundle with
 * project support holds (ADR-035's `{{node_support_dir}}`).
 */
export function remapRemoteFarmRefs(command: string, supportDir: string, paths: string[]): string {
  return command.replace(REMOTE_FARM_REF, (whole, relative: string | undefined) => {
    if (relative === undefined) return paths.includes('scripts') ? supportDir : whole;
    return paths.some((covered) => relative === covered || relative.startsWith(`${covered}/`))
      ? `${supportDir}/${relative}`
      : whole;
  });
}

async function currentLocalBundle(
  projectName: string,
  projectJson: RawProjectJson,
): Promise<LocalBundle> {
  const cached = localBundles.get(projectName);
  if (cached && Date.now() - cached.at < LOCAL_HASH_TTL_MS) return cached.bundle;
  const paths = nodeSupportBundlePaths(projectName, projectJson);
  const bundle = collectNodeSupportBundle(projectName, paths).then((collected) => ({
    hash: collected.manifest.hash,
    paths,
    collected,
  }));
  localBundles.set(projectName, { at: Date.now(), bundle });
  try {
    return await bundle;
  } catch (error) {
    // A failed read must not be served to the next caller from the cache.
    localBundles.delete(projectName);
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
  const slotKey = `${vars.slotId}\0${local.hash}\0${selectSlot}`;
  const existing = pendingEnsures.get(slotKey);
  if (existing) return existing;
  const machineKey = `${vars.machine}\0${local.hash}`;
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
    /** Wall-clock the caller gave the whole command; the delivery wait counts against it. */
    budgetMs?: number;
    /** Preserve the slot support pointer while checking prerequisites. */
    selectSlot?: boolean;
  } = {},
): Promise<string> {
  if (!hasRemoteFarmRef(command)) return command;
  // No project config means no bundle to run from; the command keeps the
  // node's own copy, as it always has.
  const projectVars = await loadProjectVarsIfAny(vars.projectName);
  if (!projectVars) return command;
  const local = await currentLocalBundle(vars.projectName, projectVars.projectJson);
  const selectSlot = options.selectSlot !== false;
  const cacheKey = `${vars.slotId}\0${local.hash}\0${selectSlot}`;
  const verified = verifiedBundles.get(cacheKey);
  if (verified && Date.now() - verified.at < VERIFIED_TTL_MS) {
    return remapRemoteFarmRefs(command, verified.supportDir, local.paths);
  }
  const state = await withinBudget(
    ensureOnce(vars, projectVars, local, options.io, selectSlot),
    options.budgetMs,
    vars.slotId,
  );
  if (!state?.hash) return command;
  verifiedBundles.set(cacheKey, { at: Date.now(), supportDir: state.supportDir });
  return remapRemoteFarmRefs(command, state.supportDir, state.paths);
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
  if (!hasRemoteFarmRef(command)) return command;
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
