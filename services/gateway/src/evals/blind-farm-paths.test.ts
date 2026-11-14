import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { legacyRemoteFarmPaths, resolveFarmPaths } from '@farmslot/protocol/node/farm-paths';

import { blindHostRoots } from './blind-git.js';

test('blind capsule protects resolved config roots and refuses an unavailable sandbox', (t) => {
  const root = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'blind-farm-roots-')));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const home = path.join(root, 'instance');
  mkdirSync(path.join(home, 'config'), { recursive: true });
  writeFileSync(path.join(home, 'config/instance.json'), '{"layout":2,"name":"blind"}');
  const paths = resolveFarmPaths({ role: 'node', home, env: {} });
  const roots = [paths.pool, paths.state.runs, paths.projects];
  const capsule = path.join(root, 'capsule');
  mkdirSync(capsule);
  writeFileSync(path.join(capsule, 'state.json'), '{"originalIsDirectory":true}');
  const script = fileURLToPath(new URL('./blind-git.py', import.meta.url));
  const result = spawnSync(
    'python3',
    [
      '-c',
      `
import importlib.util,json,os,pathlib,subprocess,sys
module = importlib.util.spec_from_file_location('blind_git', sys.argv[1])
blind = importlib.util.module_from_spec(module)
module.loader.exec_module(blind)
root, capsule = pathlib.Path(sys.argv[2]), pathlib.Path(sys.argv[3])
roots = json.loads(sys.argv[4])
spec = {'repo': str(root / 'product'), 'farmConfigRoots': roots}
pathlib.Path(spec['repo']).mkdir()
profile = capsule / 'sandbox.sb'
profile.write_text(blind.sandbox_profile(spec, capsule))
for index, entry in enumerate(roots):
    target = pathlib.Path(entry)
    target.mkdir(parents=True)
    alias = root / ('alias-' + str(index))
    alias.symlink_to(target)
    for folder in [target, alias]:
        via_alias = blind.sandbox_profile({**spec, 'farmConfigRoots': [str(folder)]}, capsule)
        rule = '(deny file-write* (subpath %s))' % json.dumps(str(target.resolve()))
        assert rule in via_alias, via_alias
        if sys.platform == 'darwin':
            denied = subprocess.run([blind.SANDBOX, '-f', str(profile), '/usr/bin/touch', str(folder / 'forbidden')], capture_output=True)
            assert denied.returncode != 0, str(folder)
            assert not (target / 'forbidden').exists()
if sys.platform == 'darwin':
    allowed = subprocess.run([blind.SANDBOX, '-f', str(profile), '/usr/bin/touch', str(root / 'product/allowed')], capture_output=True)
    assert allowed.returncode == 0, allowed.stderr
    print('direct and symlink writes denied; unrelated write allowed')
else:
    assert not os.access(blind.SANDBOX, os.X_OK)
# Unavailable sandbox must refuse the worker on every platform, including CI.
blind.SANDBOX = str(root / 'missing-sandbox')
try:
    blind.require_sandbox()
except RuntimeError as error:
    assert str(error) == blind.SANDBOX_REQUIRED
else:
    raise AssertionError('accepted a worker without a sandbox')
print('pool, runs, projects: direct and symlink rules pinned; unavailable sandbox refused')
`,
      script,
      root,
      capsule,
      JSON.stringify(roots),
    ],
    { encoding: 'utf8', env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1' }, timeout: 4500 },
  );
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /direct and symlink rules pinned; unavailable sandbox refused/);
  if (process.platform === 'darwin') {
    assert.match(result.stdout, /direct and symlink writes denied; unrelated write allowed/);
  }
});

test('blind host roots cover farm data and archives while pins and installed code stay readable', () => {
  const home = '/blind-host-fixture/instance';
  const layout = resolveFarmPaths({ role: 'node', home, env: {} });
  for (const paths of [layout, legacyRemoteFarmPaths({ FARMSLOT_HOME: home })]) {
    const roots = blindHostRoots(paths);
    assert.ok(roots.hostDeniedRoots?.includes(paths.home));
    assert.ok(roots.hostDeniedRoots?.includes(paths.state.runs));
    assert.ok(roots.hostReadableRoots?.includes(paths.code.cli));
  }
  const roots = blindHostRoots(layout);
  for (const denied of [
    layout.data.root,
    layout.data.runArchive,
    layout.data.runBundles,
    layout.data.taskPinsArchive,
    layout.backups,
  ])
    assert.ok(roots.hostDeniedRoots?.includes(denied), denied);
  assert.ok(roots.hostReadableRoots?.includes(layout.state.taskPins));
});
