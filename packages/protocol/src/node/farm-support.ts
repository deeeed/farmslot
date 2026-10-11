// Pure support reference rules shared by Gateway and gateway-free lifecycle commands.
export const NODE_SUPPORT_ROOT = '~/farmslot-node/support';
export const NODE_SUPPORT_HASH_FILENAME = 'node-support-hash';

export function nodeSupportDir(hash: string, home?: string): string {
  if (!/^[a-f0-9]{64}$/.test(hash)) throw new Error('Invalid selected node support hash');
  const root = home === undefined ? NODE_SUPPORT_ROOT : NODE_SUPPORT_ROOT.replace(/^~/, home);
  return `${root}/${hash}`;
}

/**
 * A remote farm reference, as `{{farmslot_dir}}` expands on a node: a file
 * under `projects/` or `scripts/`, or the bare root handed to a farm script
 * that builds those paths itself (mobile preflight takes it as an argument).
 */
const REMOTE_FARM_REF =
  /~\/farmslot-node(?:\/((?:projects|scripts)\/[^\s'"`;&|()<>{},:]+)|(?=$|[\s'"`;&|()<>{},:]))/g;

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
