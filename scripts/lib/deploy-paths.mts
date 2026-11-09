import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  legacyCliBinDirs,
  parseFarmInstanceConfig,
  resolveFarmPaths,
} from '../../packages/protocol/src/node/farm-paths.js';

// The target reads its marker. No path on the deploying machine stands in for it.
const [inputHome, userHome, uid, port] = process.argv.slice(2);
const home = path.posix.resolve(inputHome);
const marker = readFileSync(0, 'utf8').trim();
const config = marker
  ? parseFarmInstanceConfig(JSON.parse(marker), `${home}/config/instance.json`)
  : null;
const legacy = home === path.posix.join(userHome, '.farmslot-dev') ? 'dev' : 'prod';
if (
  !config &&
  ![path.posix.join(userHome, '.farmslot'), path.posix.join(userHome, '.farmslot-dev')].includes(
    home,
  )
)
  throw new Error(`Custom home ${home} needs config/instance.json with layout 2`);
const checkout = path.posix.join(
  userHome,
  legacy === 'dev' ? 'farmslot-node-dev' : 'farmslot-node',
);
const paths = resolveFarmPaths({
  role: 'node',
  home,
  userHome,
  checkoutRoot: checkout,
  env: {},
  instanceConfig: config,
});
// Legacy names, ports and sockets are compatibility policy. Layout 2 uses the
// instance name plus home identity so equal display names cannot share a service.

const identity = config
  ? `${paths.instance.replace(/[^A-Za-z0-9_-]/g, '-')}-${createHash('sha256').update(home).digest('hex').slice(0, 12)}`
  : legacy;
const label = config
  ? `com.farmslot.node.${identity}`
  : `com.farmslot.node${legacy === 'dev' ? '.dev' : ''}`;
const socket = config
  ? `/tmp/farmslot-screen-control-${uid}-${identity}.sock`
  : `/tmp/farmslot-screen-control-${uid}${legacy === 'dev' ? '-dev' : ''}.sock`;
const gatewayPort = Number(
  port || config?.ports?.gateway || (config ? 7777 : legacy === 'dev' ? 7801 : 7777),
);
if (!Number.isInteger(gatewayPort) || gatewayPort < 1 || gatewayPort > 65535)
  throw new Error('Invalid gateway port');
const source = resolveFarmPaths({
  role: 'gateway',
  checkoutRoot: process.env.FARMSLOT_ROOT || fileURLToPath(new URL('../../', import.meta.url)),
});
const values = {
  SOURCE_POOL_DIR: source.pool,
  SOURCE_PROJECTS_DIR: source.projects,
  SOURCE_HOME: source.home,
  INSTANCE: config ? paths.instance : legacy,
  FARM_LAYOUT: String(paths.layout),
  REMOTE_DIR: paths.code.node,
  TARGET_HOME: paths.home,
  TARGET_POOL_DIR: paths.pool,
  TARGET_PROJECTS_DIR: paths.projects,
  CLI_ROOT: paths.code.cli,
  CLI_BIN: paths.code.bin,
  PLIST_NAME: label,
  UNIT_NAME: config
    ? `farmslot-node-${identity}`
    : `farmslot-node${legacy === 'dev' ? '-dev' : ''}`,
  SCREEN_CONTROL_SOCKET_PATH: socket,
  GATEWAY_PORT: String(gatewayPort),
};
function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}
for (const [key, value] of Object.entries(values)) console.log(`${key}=${shellQuote(value)}`);
// Keep the array intact across local/SSH argument quoting, including spaces in homes.
console.log(`CLI_USER_BINS=(${legacyCliBinDirs(userHome).map(shellQuote).join(' ')})`);
