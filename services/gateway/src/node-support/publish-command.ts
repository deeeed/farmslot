import path from 'node:path';

import { shellExpressionForRemotePath } from '../core/remote-paths.js';

export interface NodeSupportPublishCommandParams {
  incomingDir: string;
  manifestPath: string;
  supportDir: string;
  supportHash: string;
}

export function buildNodeSupportPublishCommand({
  incomingDir,
  manifestPath,
  supportDir,
  supportHash,
}: NodeSupportPublishCommandParams): string {
  return [
    `mkdir -p ${shellExpressionForRemotePath('~/farmslot-node/support/.locks')}`,
    `mkdir -p ${shellExpressionForRemotePath(path.posix.dirname(supportDir))}`,
    [
      `lock=${shellExpressionForRemotePath(
        path.posix.join('~/farmslot-node/support/.locks', `${supportHash}.lock`),
      )};`,
      `while ! mkdir "$lock" 2>/dev/null; do`,
      `if [ -f ${shellExpressionForRemotePath(manifestPath)} ]; then rm -rf ${shellExpressionForRemotePath(incomingDir)}; exit 0; fi;`,
      'sleep 0.2;',
      'done;',
      'trap \'rmdir "$lock" 2>/dev/null || true\' EXIT;',
      `if [ -f ${shellExpressionForRemotePath(manifestPath)} ]; then`,
      `rm -rf ${shellExpressionForRemotePath(incomingDir)};`,
      `elif [ -e ${shellExpressionForRemotePath(supportDir)} ]; then`,
      `rm -rf ${shellExpressionForRemotePath(incomingDir)};`,
      `echo "node support target exists without manifest: ${supportDir}" >&2;`,
      'exit 1;',
      'else',
      [
        `if mv ${shellExpressionForRemotePath(incomingDir)} ${shellExpressionForRemotePath(supportDir)} && chmod -R u+rwX,go+rX ${shellExpressionForRemotePath(supportDir)}; then`,
        ':;',
        'else',
        'status=$?;',
        `rm -rf ${shellExpressionForRemotePath(incomingDir)};`,
        'exit "$status";',
        'fi;',
      ].join(' '),
      'fi;',
      'rmdir "$lock" 2>/dev/null || true;',
      'trap - EXIT',
    ].join(' '),
  ].join(' && ');
}
