import path from 'node:path';

import { resolveReportedFarmPaths } from '@farmslot/protocol/node/farm-paths';

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
  return resolveReportedFarmPaths({ role: 'node', env, checkoutRoot, agentRuntimeScripts });
}
