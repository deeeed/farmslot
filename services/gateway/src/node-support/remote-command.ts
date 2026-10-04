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

import type { RawProjectJson, SlotVars } from '../core/index.js';

import {
  collectNodeSupportBundle,
  ensureNodeSupportBundle,
  loadProjectVarsIfAny,
  nodeSupportBundlePaths,
  type NodeSupportBundleState,
  nodeSupportDir,
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

const verifiedBundles = new Map<string, number>();
/** One publish per slot at a time; concurrent hooks wait on the same one. */
const pendingEnsures = new Map<string, Promise<NodeSupportBundleState | null>>();
const localBundles = new Map<
  string,
  { at: number; bundle: Promise<{ hash: string; paths: string[] }> }
>();

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
): Promise<{ hash: string; paths: string[] }> {
  const cached = localBundles.get(projectName);
  if (cached && Date.now() - cached.at < LOCAL_HASH_TTL_MS) return cached.bundle;
  const paths = nodeSupportBundlePaths(projectName, projectJson);
  const bundle = collectNodeSupportBundle(projectName, paths).then(({ manifest }) => ({
    hash: manifest.hash,
    paths,
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

/**
 * The command a remote slot should run. Commands that reference no farm file
 * pass through untouched; ones that do get the current bundle ensured on the
 * node first. A bundle that cannot be ensured throws: running the hook anyway
 * is exactly the half-deployed state this exists to rule out.
 */
export async function resolveRemoteFarmCommand(
  vars: SlotVars,
  command: string,
  options: { io?: NodeSupportIo } = {},
): Promise<string> {
  if (!hasRemoteFarmRef(command)) return command;
  // No project config means no bundle to run from; the command keeps the
  // node's own copy, as it always has.
  const projectVars = await loadProjectVarsIfAny(vars.projectName);
  if (!projectVars) return command;
  const local = await currentLocalBundle(vars.projectName, projectVars.projectJson);
  const key = `${vars.slotId}\0${local.hash}`;
  const verifiedAt = verifiedBundles.get(key);
  if (verifiedAt !== undefined && Date.now() - verifiedAt < VERIFIED_TTL_MS) {
    return remapRemoteFarmRefs(command, nodeSupportDir(local.hash), local.paths);
  }
  let pending = pendingEnsures.get(vars.slotId);
  if (!pending) {
    pending = ensureNodeSupportBundle(vars, projectVars.runtimeDir ?? '.agent', {
      projectVars,
      io: options.io,
    }).finally(() => pendingEnsures.delete(vars.slotId));
    pendingEnsures.set(vars.slotId, pending);
  }
  const state = await pending;
  if (!state?.hash) return command;
  verifiedBundles.set(`${vars.slotId}\0${state.hash}`, Date.now());
  return remapRemoteFarmRefs(command, state.supportDir, state.paths);
}

/** Test seam: forget what this process verified. */
export function resetRemoteFarmCommandCache(): void {
  verifiedBundles.clear();
  localBundles.clear();
  pendingEnsures.clear();
}
