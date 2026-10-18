import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

// Runner-validation proofs build fixture repositories and start disposable
// gateways. An inherited GIT_DIR or GIT_INDEX_FILE (a hook, `rebase --exec`)
// points that git, and a gateway's slot git, at the operator's repository, so
// every proof that spawns git or a gateway imports the guard that drops them,
// ahead of its local modules.
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const proofsRoot = path.join(repoRoot, 'scripts/runner-validation');
const guard = path.join(proofsRoot, 'lib/no-inherited-git-location.mjs');

const SPAWN_GIT =
  /\b(?:spawn|spawnSync|execFile|execFileSync|execFileAsync|exec|execSync|execa)\(\s*['"`]git\b|\[\s*['"`]git['"`]\s*,/u;
const SPAWN_GATEWAY = /services\/gateway\/src\/index\.ts/u;
const GUARD_IMPORT = /^import '(?:\.\.?\/)+(?:lib\/)?no-inherited-git-location\.mjs';$/mu;
const LOCAL_IMPORT = /^import\s[^;]*?from\s+'\.\.?\//mu;

const walk = (dir) =>
  readdirSync(dir).flatMap((name) => {
    const entry = path.join(dir, name);
    return statSync(entry).isDirectory() ? walk(entry) : [entry];
  });

/** Every proof script that spawns git or a gateway without the guard first. */
export function unguardedProofs(files) {
  return files.flatMap(([rel, source]) => {
    if (!SPAWN_GIT.test(source) && !SPAWN_GATEWAY.test(source)) return [];
    const guardAt = source.search(GUARD_IMPORT);
    if (guardAt < 0) return [`${rel}: does not import lib/no-inherited-git-location.mjs`];
    const localAt = source.search(LOCAL_IMPORT);
    return localAt >= 0 && localAt < guardAt
      ? [`${rel}: imports a local module before lib/no-inherited-git-location.mjs`]
      : [];
  });
}

test('the guard drops inherited git locations and keeps other git settings', () => {
  const out = execFileSync(
    process.execPath,
    [
      '--input-type=module',
      '-e',
      `await import(${JSON.stringify(guard)}); console.log(JSON.stringify(Object.keys(process.env).filter((k) => k.startsWith('GIT_')).sort()));`,
    ],
    {
      env: {
        PATH: process.env.PATH,
        GIT_DIR: '/operator/.git',
        GIT_INDEX_FILE: '/operator/.git/index',
        GIT_WORK_TREE: '/operator',
        GIT_AUTHOR_NAME: 'Fixture',
      },
      encoding: 'utf8',
    },
  );
  assert.deepEqual(JSON.parse(out), ['GIT_AUTHOR_NAME']);
});

test('every proof that spawns git or a gateway imports the guard first', () => {
  const files = walk(proofsRoot)
    .filter((file) => /\.[cm]?[jt]s$/u.test(file) && !/\.test\./u.test(file))
    .map((file) => [path.relative(repoRoot, file), readFileSync(file, 'utf8')]);
  assert.ok(files.length > 0);
  assert.deepEqual(unguardedProofs(files), []);
});

test('the scan reports a proof without the guard or behind a local import', () => {
  const spawn = "execFileSync('git', ['init']);";
  assert.deepEqual(
    unguardedProofs([
      ['a.mjs', `import x from 'node:fs';\n${spawn}`],
      [
        'b.mjs',
        `import { y } from '../lib/common.mjs';\nimport '../lib/no-inherited-git-location.mjs';\n${spawn}`,
      ],
      [
        'c.mjs',
        `import '../lib/no-inherited-git-location.mjs';\n\nimport { y } from '../lib/common.mjs';\n${spawn}`,
      ],
      ['d.mjs', "console.log('no git here');"],
    ]),
    [
      'a.mjs: does not import lib/no-inherited-git-location.mjs',
      'b.mjs: imports a local module before lib/no-inherited-git-location.mjs',
    ],
  );
});
