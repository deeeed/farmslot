import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { shellQuote } from './tmux.js';

/**
 * Stand-in ssh, scp and rsync for tests: each records its argv (tool name
 * first) and succeeds, so no test ever reaches a real host. Prefix a bash
 * command with `withFakePath` to make it resolve these three.
 */
export function fakeSshTools(): {
  root: string;
  withFakePath: (cmd: string) => string;
  calls: () => string[][];
  cleanup: () => void;
} {
  const root = mkdtempSync(path.join(os.tmpdir(), 'gw-fake-ssh-'));
  const bin = path.join(root, 'bin');
  const log = path.join(root, 'calls.log');
  mkdirSync(bin);
  for (const tool of ['ssh', 'scp', 'rsync']) {
    // One record per call: NUL-separated words, ended by an RS byte.
    writeFileSync(
      path.join(bin, tool),
      `#!/bin/bash\n{ printf '%s\\0' ${tool} "$@"; printf '\\036'; } >> ${shellQuote(log)}\n`,
      { mode: 0o755 },
    );
  }
  return {
    root,
    withFakePath: (cmd) => `PATH=${shellQuote(bin)}:"$PATH"; ${cmd}`,
    calls: () =>
      existsSync(log)
        ? readFileSync(log, 'utf8')
            .split('\x1e')
            .filter(Boolean)
            .map((record) => record.split('\0').slice(0, -1))
        : [],
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}
