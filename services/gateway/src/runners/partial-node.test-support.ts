import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { TestContext } from 'node:test';

/** A partial .nvmrc that fails unless the worker's actual project policy reaches its shim. */
export function partialNodeFixture(t: TestContext) {
  const home = mkdtempSync(path.join(tmpdir(), 'relaunch-partial-node-'));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const repo = path.join(home, 'repo');
  const data = path.join(home, '.asdf');
  const shims = path.join(data, 'shims');
  mkdirSync(repo);
  mkdirSync(shims, { recursive: true });
  writeFileSync(path.join(repo, '.nvmrc'), 'v22');
  writeFileSync(
    path.join(shims, 'node'),
    `#!/bin/sh
[ "$(cat .nvmrc)" = v22 ] || exit 99
[ "$ASDF_NODEJS_LEGACY_FILE_DYNAMIC_STRATEGY" = latest_installed ] || exit 126
[ -z "\${ASDF_NODEJS_VERSION+x}" ] || exit 125
[ "$RELAUNCH_NOTE" = "space'quote" ] || exit 124
printf 'v22.22.1\\n'
`,
  );
  chmodSync(path.join(shims, 'node'), 0o755);
  const commandEnv = {
    set: {
      ASDF_DATA_DIR: data,
      ASDF_NODEJS_LEGACY_FILE_DYNAMIC_STRATEGY: 'latest_installed',
      RELAUNCH_NOTE: "space'quote",
    },
    unset: ['ASDF_NODEJS_VERSION'],
  };
  const quote = (value: string) => "'" + value.replaceAll("'", "'\"'\"'") + "'";
  const command = `cd ${quote(repo)} && node --version`;
  const execute = (shell: string) =>
    spawnSync('/bin/sh', ['-c', shell], {
      cwd: repo,
      env: {
        HOME: home,
        PATH: `${shims}:/usr/bin:/bin`,
        ASDF_NODEJS_VERSION: 'stale-host-version',
      },
      encoding: 'utf8',
    });
  return { home, repo, commandEnv, command, execute };
}
