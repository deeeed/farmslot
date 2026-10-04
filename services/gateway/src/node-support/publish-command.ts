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

const shellSingleQuote = (value: string): string => `'${value.replaceAll("'", `'\\''`)}'`;

/**
 * One `shasum` and one `stat` over the whole file set, compared against the
 * manifest's expected lines. A per-file loop spawned four processes per file
 * (shasum is a perl script on macOS), which made a 500-file bundle take about
 * a minute to verify, twice per publish.
 */
export function buildNodeSupportVerifyCommand({
  manifestPath,
  supportDir,
  files,
}: NodeSupportVerifyCommandParams): string {
  const manifestCheck = `[ -f ${shellExpressionForRemotePath(manifestPath)} ]`;
  // shasum with no file operands would read stdin and hang.
  if (files.length === 0) return manifestCheck;
  const operands = files.map((file) => shellSingleQuote(file.relativePath)).join(' ');
  const expectedSha = files.map((file) => `${file.sha256}  ${file.relativePath}`).join('\n');
  const expectedStat = files.map((file) => `${file.mode.toString(8)} ${file.size}`).join('\n');
  return [
    manifestCheck,
    `cd ${shellExpressionForRemotePath(supportDir)}`,
    `if command -v shasum >/dev/null 2>&1; then actual_sha="$(shasum -a 256 -- ${operands})"; else actual_sha="$(sha256sum -- ${operands})"; fi`,
    `[ "$actual_sha" = ${shellSingleQuote(expectedSha)} ]`,
    // GNU stat takes -c; BSD stat has no -c and takes -f.
    `if stat -c %s / >/dev/null 2>&1; then actual_stat="$(stat -c '%a %s' -- ${operands})"; else actual_stat="$(stat -f '%Lp %z' -- ${operands})"; fi`,
    `[ "$actual_stat" = ${shellSingleQuote(expectedStat)} ]`,
  ].join(' && ');
}
