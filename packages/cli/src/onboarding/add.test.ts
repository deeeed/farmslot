import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  assertProjectOwnership,
  findMissingState,
  operatorAddedFiles,
  projectAdd,
  registerProject,
} from './add.js';
import type { PackJson, PackProject } from './pack.js';
import { type Workspace, workspaceAt, type WorkspaceState } from './workspace.js';

/** Init a git repo with a .gitignore so check-ignore reports operator files. */
function gitPack(dir: string, gitignore: string): void {
  mkdirSync(dir, { recursive: true });
  spawnSync('git', ['init', '-q', dir]);
  writeFileSync(join(dir, '.gitignore'), gitignore);
}

function stateWith(packs: WorkspaceState['packs']): WorkspaceState {
  return {
    schema_version: 1,
    source: { mode: 'local', path: '/src' },
    machine: 'm',
    pool_file: 'pool/m.json',
    packs,
    pool_migrations: { applied: [] },
  };
}

test('assertProjectOwnership guards cross-pack and unowned project dirs (pre-claim state)', () => {
  const root = mkdtempSync(join(tmpdir(), 'fs-own-'));
  const dest = join(root, 'projects', 'app-farm');

  // Owned by another pack → always rejected, even before the dir exists.
  assert.throws(
    () =>
      assertProjectOwnership(
        'app-farm',
        'pack-b',
        stateWith({ 'pack-a': { source: '/a', hash: 'x', projects: ['app-farm'], slots: [] } }),
        dest,
      ),
    /owned by pack 'pack-a'/,
  );

  // Not on disk, not owned → fine (fresh add).
  assert.doesNotThrow(() => assertProjectOwnership('app-farm', 'pack-b', stateWith({}), dest));

  // On disk but unowned (hand-created or lost state) → rejected, never deleted.
  mkdirSync(dest, { recursive: true });
  assert.throws(
    () => assertProjectOwnership('app-farm', 'pack-b', stateWith({}), dest),
    /not registered to any pack/,
  );

  // Owned by this pack → re-add/repair allowed.
  assert.doesNotThrow(() =>
    assertProjectOwnership(
      'app-farm',
      'pack-b',
      stateWith({ 'pack-b': { source: '/b', hash: 'x', projects: ['app-farm'], slots: [] } }),
      dest,
    ),
  );
});

test('findMissingState: complete state is a true no-op, missing pieces escalate', () => {
  const root = mkdtempSync(join(tmpdir(), 'fs-noop-'));
  const ws = { farmslotDir: join(root, 'farmslot'), reposDir: join(root, 'repos') };
  const pack: PackJson = {
    name: 'p',
    projects: [{ dir: 'projects/app-farm', platform: 'cli', slots: 1 }],
  };
  const pool = { machine: 'm', slots: [{ id: 'm-app-1' }] };

  mkdirSync(join(ws.farmslotDir, 'projects', 'app-farm'), { recursive: true });
  writeFileSync(join(ws.farmslotDir, 'projects', 'app-farm', 'project.json'), '{}');
  mkdirSync(join(ws.reposDir, 'app-1', '.git'), { recursive: true });

  // Everything in place → verify-only no-op: no lifecycle steps would rerun.
  assert.deepEqual(findMissingState(pack, pool, ws), []);

  // Missing slot repo → escalates to repair.
  rmSync(join(ws.reposDir, 'app-1'), { recursive: true });
  assert.deepEqual(findMissingState(pack, pool, ws), ['repo app-1 missing']);

  // Missing pool slot and project registration are reported too.
  assert.equal(findMissingState(pack, { machine: 'm', slots: [] }, ws).length, 2);
});

test('findMissingState escalates platform slots missing their device/browser resource', () => {
  const root = mkdtempSync(join(tmpdir(), 'fs-res-'));
  const ws = { farmslotDir: join(root, 'farmslot'), reposDir: join(root, 'repos') };
  const pack: PackJson = {
    name: 'p',
    projects: [{ dir: 'projects/app-farm', platform: 'ios', slots: 1 }],
  };
  mkdirSync(join(ws.farmslotDir, 'projects', 'app-farm'), { recursive: true });
  writeFileSync(join(ws.farmslotDir, 'projects', 'app-farm', 'project.json'), '{}');
  mkdirSync(join(ws.reposDir, 'app-1', '.git'), { recursive: true });

  // Slot created by pre-defaultResources code: no ios-sim → repair escalation.
  const bare = { machine: 'm', slots: [{ id: 'm-app-1' }] };
  assert.deepEqual(findMissingState(pack, bare, ws), ['slot m-app-1 missing ios-sim resource']);

  // With the resource present the state is complete.
  const complete = {
    machine: 'm',
    slots: [{ id: 'm-app-1', resources: { 'ios-sim': { simulator: 'app-1' } } }],
  };
  assert.deepEqual(findMissingState(pack, complete, ws), []);
});

test('operatorAddedFiles preserves only pack-ignored operator files', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'fs-op-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const src = join(root, 'src');
  const dest = join(root, 'dest');
  // Pack source is a git repo whose .gitignore covers the operator secrets.
  gitPack(src, '.js.env\nwallet-fixture.json\n');
  mkdirSync(join(src, 'fixtures'), { recursive: true });
  mkdirSync(join(dest, 'fixtures'), { recursive: true });
  // Pack ships the .sample template + project.json (tracked, not ignored).
  writeFileSync(join(src, 'project.json'), '{}');
  writeFileSync(join(src, 'fixtures', '.js.env.sample'), 'KEY=');
  // Operator copy: tracked files PLUS filled secrets the pack gitignores.
  writeFileSync(join(dest, 'project.json'), '{}');
  writeFileSync(join(dest, 'fixtures', '.js.env.sample'), 'KEY=');
  writeFileSync(join(dest, 'fixtures', '.js.env'), 'KEY=secret');
  mkdirSync(join(dest, 'fixtures', 'runtime'), { recursive: true });
  writeFileSync(join(dest, 'fixtures', 'runtime', 'wallet-fixture.json'), '{"k":1}');
  // A pack-tracked file the pack later DELETED (dest-only, NOT gitignored):
  // must NOT be preserved — full-replace removes stale pack files.
  writeFileSync(join(dest, 'fixtures', 'legacy-hook.sh'), 'echo old');
  // A dir-symlink must be skipped, not treated as a file (would EISDIR on read).
  symlinkSync(join(dest, 'fixtures', 'runtime'), join(dest, 'linked-runtime'));

  assert.deepEqual(operatorAddedFiles(dest, src).sort(), [
    join('fixtures', '.js.env'),
    join('fixtures', 'runtime', 'wallet-fixture.json'),
  ]);
  // Fresh dest (first add) has nothing to preserve.
  assert.deepEqual(operatorAddedFiles(join(root, 'missing'), src), []);
});

test('registerProject re-add preserves operator secrets, refreshes pack files', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'fs-reg-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const ws: Workspace = workspaceAt(join(root, 'ws'));
  const packDir = join(root, 'pack');
  const proj: PackProject = { dir: 'projects/app-farm', platform: 'cli', slots: 1 };
  const noop = { step: () => {}, info: () => {} };

  // Pack source: git repo (so check-ignore works) with project.json (repo_url),
  // a .sample template, a soon-to-be-removed pack file, and a .gitignore that
  // marks .js.env as operator-owned.
  const projSrc = join(packDir, 'projects', 'app-farm');
  gitPack(packDir, 'projects/app-farm/fixtures/.js.env\n');
  mkdirSync(join(projSrc, 'fixtures'), { recursive: true });
  writeFileSync(
    join(projSrc, 'project.json'),
    JSON.stringify({ name: 'app-farm', repo_url: 'https://example.invalid/app.git' }),
  );
  writeFileSync(join(projSrc, 'fixtures', '.js.env.sample'), 'KEY=\n');
  writeFileSync(join(projSrc, 'fixtures', 'legacy-hook.sh'), 'echo old\n');

  const state: WorkspaceState = {
    schema_version: 1,
    source: { mode: 'local', path: packDir },
    machine: 'm',
    pool_file: 'pool/m.json',
    packs: { p: { source: packDir, hash: '', projects: ['app-farm'], slots: [] } },
    pool_migrations: { applied: [] },
  };

  const destFix = join(ws.farmslotDir, 'projects', 'app-farm', 'fixtures');

  // First add lays down the pack (incl. legacy-hook.sh).
  registerProject(proj, packDir, ws, state, 'p', noop);
  const secret = join(destFix, '.js.env');
  writeFileSync(secret, 'KEY=filled-by-operator\n', { mode: 0o600 });

  // Pack update: change a tracked file AND delete a previously-shipped one.
  writeFileSync(join(projSrc, 'fixtures', '.js.env.sample'), 'KEY=\nNEW=\n');
  rmSync(join(projSrc, 'fixtures', 'legacy-hook.sh'));

  registerProject(proj, packDir, ws, state, 'p', noop);
  // Operator secret survives with its mode.
  assert.equal(readFileSync(secret, 'utf-8'), 'KEY=filled-by-operator\n');
  assert.equal(statSync(secret).mode & 0o777, 0o600);
  // Pack-tracked file is refreshed from the pack.
  assert.equal(readFileSync(join(destFix, '.js.env.sample'), 'utf-8'), 'KEY=\nNEW=\n');
  // Pack-deleted file is NOT resurrected (it was tracked, not gitignored).
  assert.equal(existsSync(join(destFix, 'legacy-hook.sh')), false);
});

test('projectAdd --no-setup --project registers selected slots without setup/preflight', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'fs-add-deferred-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));

  const ws: Workspace = workspaceAt(join(root, 'ws'));
  mkdirSync(ws.root, { recursive: true });
  mkdirSync(join(ws.farmslotDir, 'pool'), { recursive: true });
  mkdirSync(ws.reposDir, { recursive: true });
  writeFileSync(
    join(ws.farmslotDir, 'pool', 'm.json'),
    JSON.stringify({ machine: 'm', host: 'localhost', ssh_user: 'me', slots: [] }, null, 2),
  );
  writeFileSync(ws.statePath, JSON.stringify(stateWith({}), null, 2));

  const scriptsDir = join(ws.farmslotDir, 'scripts');
  mkdirSync(scriptsDir, { recursive: true });
  writeFileSync(
    join(scriptsDir, 'sync-fixtures.sh'),
    '#!/usr/bin/env bash\ntouch "$PWD/synced-$2"\n',
  );
  writeFileSync(
    join(scriptsDir, 'write-runtime-context.sh'),
    `#!/usr/bin/env bash
repo=""
runtime_dir="temp/runtime"
args="$*"
while [ "$#" -gt 0 ]; do
  case "$1" in
    --repo) repo="$2"; shift 2 ;;
    --runtime-dir) runtime_dir="$2"; shift 2 ;;
    *) shift ;;
  esac
done
mkdir -p "$repo/$runtime_dir"
printf '%s\\n' "$args" > "$repo/$runtime_dir/context.args"
printf '{}\\n' > "$repo/$runtime_dir/agentic-runtime.json"
`,
  );
  writeFileSync(
    join(scriptsDir, 'setup-slot.sh'),
    '#!/usr/bin/env bash\necho setup should not run >&2\nexit 42\n',
  );
  writeFileSync(
    join(scriptsDir, 'preflight-slot.sh'),
    '#!/usr/bin/env bash\necho preflight should not run >&2\nexit 43\n',
  );
  chmodSync(join(scriptsDir, 'sync-fixtures.sh'), 0o755);
  chmodSync(join(scriptsDir, 'write-runtime-context.sh'), 0o755);
  chmodSync(join(scriptsDir, 'setup-slot.sh'), 0o755);
  chmodSync(join(scriptsDir, 'preflight-slot.sh'), 0o755);

  const repo = join(root, 'repo');
  mkdirSync(repo, { recursive: true });
  spawnSync('git', ['init', '-q'], { cwd: repo });
  writeFileSync(join(repo, 'README.md'), 'fixture repo\n');
  spawnSync('git', ['add', '.'], { cwd: repo });
  spawnSync(
    'git',
    ['-c', 'user.email=a@example.com', '-c', 'user.name=A', 'commit', '-qm', 'init'],
    { cwd: repo },
  );

  const pack = join(root, 'pack');
  for (const name of ['app-farm', 'other-farm']) {
    const projectDir = join(pack, 'projects', name);
    mkdirSync(join(projectDir, 'setup'), { recursive: true });
    writeFileSync(
      join(projectDir, 'project.json'),
      JSON.stringify(
        {
          name,
          repo_url: repo,
          default_branch: 'master',
          paths: { runtime_dir: 'temp/recipe/runtime' },
        },
        null,
        2,
      ),
    );
    writeFileSync(join(projectDir, 'setup', 'cli.sh'), '#!/usr/bin/env bash\n');
  }
  writeFileSync(
    join(pack, 'pack.json'),
    JSON.stringify(
      {
        name: 'team-pack',
        projects: [
          { dir: 'projects/app-farm', platform: 'cli', slots: 1, short: 'app' },
          { dir: 'projects/other-farm', platform: 'cli', slots: 1, short: 'other' },
        ],
      },
      null,
      2,
    ),
  );

  const result = projectAdd(
    pack,
    ws,
    { step: () => {}, info: () => {} },
    { noSetup: true, projects: ['app-farm'] },
  );
  assert.equal(result.deferredSetup, true);
  assert.deepEqual(result.slots, ['m-app-1']);
  assert.equal(existsSync(join(ws.reposDir, 'app-1', '.git')), true);
  assert.equal(existsSync(join(ws.reposDir, 'other-1', '.git')), false);
  assert.equal(existsSync(join(ws.farmslotDir, 'synced-m-app-1')), true);
  assert.equal(
    existsSync(join(ws.reposDir, 'app-1', 'temp/recipe/runtime/agentic-runtime.json')),
    true,
  );
  const contextArgs = readFileSync(
    join(ws.reposDir, 'app-1', 'temp/recipe/runtime/context.args'),
    'utf-8',
  );
  assert.match(contextArgs, /--slot-id m-app-1/);
  assert.match(contextArgs, /--machine m/);
  assert.match(contextArgs, /--project app-farm/);
  assert.match(contextArgs, /--watcher-port 9300/);
  assert.match(contextArgs, /--runtime-dir temp\/recipe\/runtime/);
  assert.doesNotMatch(contextArgs, /--simulator/);
  assert.doesNotMatch(contextArgs, /--adb-serial/);

  let state = JSON.parse(readFileSync(ws.statePath, 'utf-8')) as WorkspaceState;
  assert.deepEqual(state.packs['team-pack'].projects, ['app-farm']);
  assert.deepEqual(state.packs['team-pack'].slots, ['m-app-1']);
  assert.equal(state.packs['team-pack'].hash, '');

  writeFileSync(join(scriptsDir, 'setup-slot.sh'), '#!/usr/bin/env bash\ntouch "$PWD/setup-$1"\n');
  writeFileSync(
    join(scriptsDir, 'preflight-slot.sh'),
    '#!/usr/bin/env bash\ntouch "$PWD/preflight-$1"\n',
  );
  chmodSync(join(scriptsDir, 'setup-slot.sh'), 0o755);
  chmodSync(join(scriptsDir, 'preflight-slot.sh'), 0o755);

  const fullSubset = projectAdd(
    pack,
    ws,
    { step: () => {}, info: () => {} },
    { projects: ['app-farm'] },
  );
  assert.equal(fullSubset.deferredSetup, false);
  assert.equal(existsSync(join(ws.farmslotDir, 'setup-m-app-1')), true);
  assert.equal(existsSync(join(ws.farmslotDir, 'preflight-m-app-1')), true);
  state = JSON.parse(readFileSync(ws.statePath, 'utf-8')) as WorkspaceState;
  assert.equal(state.packs['team-pack'].hash, '');

  const fullPack = projectAdd(pack, ws, { step: () => {}, info: () => {} });
  assert.deepEqual(fullPack.slots, ['m-app-1', 'm-other-1']);
  state = JSON.parse(readFileSync(ws.statePath, 'utf-8')) as WorkspaceState;
  const completedHash = state.packs['team-pack'].hash;
  assert.notEqual(completedHash, '');

  rmSync(join(ws.reposDir, 'other-1'), { recursive: true });
  const subsetNoop = projectAdd(
    pack,
    ws,
    { step: () => {}, info: () => {} },
    { projects: ['app'] },
  );
  assert.equal(subsetNoop.action, 'noop');
  state = JSON.parse(readFileSync(ws.statePath, 'utf-8')) as WorkspaceState;
  assert.equal(state.packs['team-pack'].hash, completedHash);
});
