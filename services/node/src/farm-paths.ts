import path from 'node:path';

import {
  readLegacyStorageFacts,
  resolveFarmPaths,
  resolveReportedFarmPaths,
} from '@farmslot/protocol/node/farm-paths';

/** deploy-node.sh installs services/node directly under the installation directory. */
export function nodeReportedFarmPaths(
  installDir: string,
  agentRuntimeScripts: string,
  env: NodeJS.ProcessEnv = process.env,
) {
  const checkoutRoot =
    env.FARMSLOT_ROOT ||
    (path.basename(installDir) === 'node' && path.basename(path.dirname(installDir)) === 'services'
      ? path.resolve(installDir, '../..')
      : installDir);
  const options = { role: 'node' as const, env, checkoutRoot, agentRuntimeScripts };
  const reported = resolveReportedFarmPaths(options);
  // A store on an unmounted volume is reported, not fatal: say so once at start.
  const base = resolveFarmPaths(options);
  if (base.layout !== 2) {
    const { unavailable } = readLegacyStorageFacts(base);
    if (unavailable) console.warn(`[farm-paths] ${unavailable}; starting anyway`);
  }
  return reported;
}
