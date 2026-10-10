// Run by scripts/deploy-node.sh on the target, from the install dir and before
// the service is reloaded, with the deployed node token on stdin. An env file's
// FARMSLOT_NODE_TOKEN wins over the one the service definition carries, so a
// differing one would keep the node on a stale credential. Prints only the file
// and the fix, never a token.
import { createHash, timingSafeEqual } from 'node:crypto';
import { readFileSync } from 'node:fs';

import { findNodeTokenEnvFile } from './gateway-credential.js';

const digest = (token: string) => createHash('sha256').update(token).digest();

const deployed = readFileSync(0, 'utf8').trim();
const file = findNodeTokenEnvFile();
if (file && !timingSafeEqual(digest(file.token), digest(deployed))) {
  console.error(
    `[deploy] ERROR: ${file.path} sets FARMSLOT_NODE_TOKEN, which the node reads instead of the deployed token`,
  );
  console.error('  fix: remove that line (or move the file aside), then redeploy');
  process.exit(1);
}
