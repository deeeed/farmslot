import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const repo = fileURLToPath(new URL('../../', import.meta.url));
function fixture(t) {
  const root = mkdtempSync(path.join(os.tmpdir(), 'farm-shell-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}
function run(args, env, input) {
  const result = spawnSync('bash', args, {
    env: { PATH: process.env.PATH, ...env },
    encoding: 'utf8',
    input,
    timeout: 4500,
  });
  assert.ifError(result.error);
  return result;
}

test('relocated shell helpers select the legacy pool through the resolver', (t) => {
  const root = fixture(t);
  const env = {
    HOME: root,
    FARMSLOT_HOME: path.join(root, '.farmslot-dev'),
    FARMSLOT_ROOT: repo,
    FARMSLOT_POOL_DIR: path.join(root, 'farmslot-node-dev/pool'),
    FARMSLOT_CLI: path.join(repo, 'packages/cli/bin/farmslot.mjs'),
  };
  const result = run(
    [
      '-ec',
      'source "$1"; printf "%s\\n" "$POOL_DIR" "$PROJECTS_DIR" "$FARMSLOT_HOME"',
      '_',
      path.join(repo, 'scripts/lib/slot-common.sh'),
    ],
    env,
  );
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(result.stdout.trim().split('\n'), [
    env.FARMSLOT_POOL_DIR,
    path.join(repo, 'projects'),
    env.FARMSLOT_HOME,
  ]);
});

test('shell helpers refuse missing resolved env instead of selecting a production pool', (t) => {
  const root = fixture(t);
  mkdirSync(path.join(root, 'farmslot-node/pool'), { recursive: true });
  const result = run(['-ec', 'source "$1"', '_', path.join(repo, 'scripts/lib/slot-common.sh')], {
    HOME: root,
    FARMSLOT_CLI: '/usr/bin/false',
    POOL_DIR: '/missing-support/pool',
  });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /missing resolved FARMSLOT_POOL_DIR.*Refusing to guess a farm root/);
});

for (const alias of ['prod', 'dev'])
  test(`deploy dry-run preserves ${alias} legacy paths and service identity`, (t) => {
    const root = fixture(t);
    const suffix = alias === 'dev' ? '-dev' : '';
    const result = run(
      [path.join(repo, 'scripts/deploy-node.sh'), 'fixture', '--dry-run', '--instance', alias],
      {
        HOME: root,
        FARMSLOT_HOME: path.join(root, 'source-home'),
        FARMSLOT_POOL_DIR: path.join(root, 'source-pool'),
        FARMSLOT_PROJECTS_DIR: path.join(root, 'source-projects'),
      },
    );
    assert.equal(result.status, 0, result.stderr);
    assert.ok(result.stdout.includes(`REMOTE_DIR='${root}/farmslot-node${suffix}'`));
    assert.ok(result.stdout.includes(`TARGET_HOME='${root}/.farmslot${suffix}'`));
    assert.ok(
      result.stdout.includes(`PLIST_NAME='com.farmslot.node${alias === 'dev' ? '.dev' : ''}'`),
    );
    assert.ok(result.stdout.includes(`GATEWAY_PORT='${alias === 'dev' ? '7801' : '7777'}'`));
    assert.match(result.stdout, /<key>FARMSLOT_HOME<\/key>/);
  });

test('deploy refuses an empty explicit home and accepts a normalized legacy home', (t) => {
  const root = fixture(t);
  const env = {
    HOME: root,
    FARMSLOT_HOME: path.join(root, 'source-home'),
    FARMSLOT_POOL_DIR: path.join(root, 'source-pool'),
    FARMSLOT_PROJECTS_DIR: path.join(root, 'source-projects'),
  };
  const script = path.join(repo, 'scripts/deploy-node.sh');
  const refused = run([script, 'fixture', '--dry-run', '--home='], env);
  assert.equal(refused.status, 1);
  assert.match(refused.stderr, /--home requires a directory/);
  const legacy = run(
    [script, 'fixture', '--dry-run', '--home', path.join(root, '.farmslot-dev') + '/'],
    env,
  );
  assert.equal(legacy.status, 0, legacy.stderr);
  assert.ok(legacy.stdout.includes(`REMOTE_DIR='${root}/farmslot-node-dev'`));
});

test('layout-2 deployment resolves a target marker and prints its own code and service paths', (t) => {
  const root = fixture(t);
  const home = path.join(root, "instance with ' spaces");
  mkdirSync(path.join(home, 'config'), { recursive: true });
  writeFileSync(
    path.join(home, 'config/instance.json'),
    JSON.stringify({ layout: 2, name: 'review', ports: { gateway: 8817 } }),
  );
  const result = run(
    [path.join(repo, 'scripts/deploy-node.sh'), 'fixture', '--dry-run', '--home', home],
    {
      HOME: root,
      FARMSLOT_HOME: path.join(root, 'source-home'),
      FARMSLOT_POOL_DIR: path.join(root, 'source-pool'),
      FARMSLOT_PROJECTS_DIR: path.join(root, 'source-projects'),
    },
  );
  assert.equal(result.status, 0, result.stderr);
  assert.ok(result.stdout.includes(`${home}/code/node`));
  assert.ok(result.stdout.includes(`${home}/code/cli`.replaceAll("'", "'\\''")));
  assert.ok(result.stdout.includes("GATEWAY_PORT='8817'"));
  assert.match(result.stdout, /PLIST_NAME='com.farmslot.node.review-[a-f0-9]{12}'/);
  assert.match(result.stdout, /SCREEN_CONTROL_SOCKET_PATH='.*review-[a-f0-9]{12}\.sock'/);
});

for (const legacyBin of ['.local/bin', '.npm-global/bin'])
  test(`refreshing one layout-2 CLI preserves another instance and the legacy snapshot (${legacyBin})`, (t) => {
    const root = fixture(t);
    const refresh = /<< 'REFRESH'\n([\s\S]*?)\nREFRESH/.exec(
      readFileSync(path.join(repo, 'scripts/lib/node-cli-refresh.sh'), 'utf8'),
    )[1];
    const sha = 'a'.repeat(40),
      nextSha = 'b'.repeat(40);
    const legacy = path.join(root, 'legacy-entry');
    writeFileSync(legacy, '#!/bin/sh\necho legacy\n', { mode: 0o755 });
    mkdirSync(path.join(root, legacyBin), { recursive: true });
    symlinkSync(legacy, path.join(root, legacyBin, 'farmslot'));
    const homes = ['a', 'b'].map((name) => path.join(root, name));
    const seed = (home, revision, output) => {
      const snapshot = path.join(home, 'code/cli', revision);
      mkdirSync(path.join(snapshot, 'packages/cli/bin'), { recursive: true });
      writeFileSync(path.join(snapshot, 'DEPLOYED-REVISION.json'), '{}');
      writeFileSync(
        path.join(snapshot, 'packages/cli/bin/farmslot.mjs'),
        `#!/bin/sh\necho ${output}\n`,
        { mode: 0o755 },
      );
    };
    for (const home of homes) {
      mkdirSync(path.join(home, 'config'), { recursive: true });
      writeFileSync(path.join(home, 'config/instance.json'), '{"layout":2}');
      seed(home, sha, path.basename(home));
      const result = run(
        [
          '-s',
          '--',
          path.join(home, 'code/cli'),
          sha,
          '',
          path.dirname(process.execPath),
          '1',
          home,
          path.join(home, 'code/bin'),
          '2',
        ],
        { HOME: root },
        refresh,
      );
      assert.equal(result.status, 0, result.stderr);
    }
    const other = readlinkSync(path.join(homes[1], 'code/bin/farmslot'));
    seed(homes[0], nextSha, 'updated-a');
    const result = run(
      [
        '-s',
        '--',
        path.join(homes[0], 'code/cli'),
        nextSha,
        '',
        path.dirname(process.execPath),
        '1',
        homes[0],
        path.join(homes[0], 'code/bin'),
        '2',
      ],
      { HOME: root },
      refresh,
    );
    assert.equal(result.status, 0, result.stderr);
    assert.equal(readlinkSync(path.join(homes[1], 'code/bin/farmslot')), other);
    for (const [home, output] of [
      [homes[0], 'updated-a'],
      [homes[1], 'b'],
      [path.join(root, 'unmigrated'), 'legacy'],
    ]) {
      const cli = run([path.join(root, '.local/bin/farmslot')], {
        HOME: root,
        FARMSLOT_HOME: home,
      });
      assert.equal(cli.status, 0, cli.stderr);
      assert.equal(cli.stdout.trim(), output);
    }
    assert.equal(readlinkSync(path.join(root, '.local/share/farmslot-cli/legacy')), legacy);
  });
