import path from 'node:path';

import { shellExpressionForRemotePath } from '../core/remote-paths.js';

export interface NodeSupportPublishCommandParams {
  incomingDir: string;
  manifestPath: string;
  supportDir: string;
  supportHash: string;
}

export interface NodeSupportVerifyFile {
  relativePath: string;
  sha256: string;
  mode: number;
  size: number;
}

export interface NodeSupportVerifyCommandParams {
  manifestPath: string;
  supportDir: string;
  files: NodeSupportVerifyFile[];
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
      'waited=0;',
      `while ! mkdir "$lock" 2>/dev/null; do`,
      `if [ -f ${shellExpressionForRemotePath(manifestPath)} ]; then rm -rf ${shellExpressionForRemotePath(incomingDir)}; exit 0; fi;`,
      // A live holder never re-touches its lock, so an mtime older than 5min means
      // the owning prepare died (SIGKILL/ssh drop) before cleanup. Reclaim it.
      'if [ -n "$(find "$lock" -maxdepth 0 -mmin +5 2>/dev/null)" ]; then rm -rf "$lock" 2>/dev/null || true; continue; fi;',
      // Hard cap so a fresh, genuinely-held lock can never hang prepare forever.
      // 600 * 0.2s = 120s — ample for a concurrent publish (an mv plus verify).
      'waited=$((waited + 1));',
      `if [ "$waited" -gt 600 ]; then echo "node support lock timeout for ${supportHash}" >&2; rm -rf ${shellExpressionForRemotePath(incomingDir)}; exit 1; fi;`,
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
        `if mv ${shellExpressionForRemotePath(incomingDir)} ${shellExpressionForRemotePath(supportDir)}; then`,
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

export function buildNodeSupportVerifyCommand({
  manifestPath,
  supportDir,
  files,
}: NodeSupportVerifyCommandParams): string {
  const commands = [
    `[ -f ${shellExpressionForRemotePath(manifestPath)} ]`,
    'count=0',
    'hash_file() { if command -v shasum >/dev/null 2>&1; then shasum -a 256 "$1"; else sha256sum "$1"; fi | awk \'{print $1}\'; }',
    'stat_mode() { stat -f %Lp "$1" 2>/dev/null || stat -c %a "$1"; }',
    'stat_size() { stat -f %z "$1" 2>/dev/null || stat -c %s "$1"; }',
  ];
  for (const file of files) {
    const filePath = path.posix.join(supportDir, file.relativePath);
    const quotedPath = shellExpressionForRemotePath(filePath);
    commands.push(
      `[ -f ${quotedPath} ]`,
      `actual_sha="$(hash_file ${quotedPath})"`,
      `[ "$actual_sha" = '${file.sha256}' ]`,
      `actual_mode="$(stat_mode ${quotedPath})"`,
      `[ "$actual_mode" = '${file.mode.toString(8)}' ]`,
      `actual_size="$(stat_size ${quotedPath})"`,
      `[ "$actual_size" = '${file.size}' ]`,
      'count=$((count + 1))',
    );
  }
  commands.push(`[ "$count" -eq ${files.length} ]`);
  return commands.join(' && ');
}
