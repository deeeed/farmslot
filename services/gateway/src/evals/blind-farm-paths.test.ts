import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { resolveFarmPaths } from '@farmslot/protocol/node/farm-paths';

test('blind capsule denies writes to the resolved pool, runs and projects through aliases', (t) => {
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
import importlib.util,json,pathlib,subprocess,sys
module = importlib.util.spec_from_file_location('blind_git', sys.argv[1])
blind = importlib.util.module_from_spec(module)
module.loader.exec_module(blind)
root, capsule = pathlib.Path(sys.argv[2]), pathlib.Path(sys.argv[3])
roots = json.loads(sys.argv[4])
spec = {'repo': str(root / 'product'), 'farmConfigRoots': roots}
profile = capsule / 'sandbox.sb'
profile.write_text(blind.sandbox_profile(spec, capsule))
for index, entry in enumerate(roots):
    target = pathlib.Path(entry)
    target.mkdir(parents=True)
    alias = root / ('alias-' + str(index))
    alias.symlink_to(target)
    for folder in [target, alias]:
        denied = subprocess.run([blind.SANDBOX, '-f', str(profile), '/usr/bin/touch', str(folder / 'forbidden')], capture_output=True)
        assert denied.returncode != 0, str(folder)
        assert not (target / 'forbidden').exists()
allowed = subprocess.run([blind.SANDBOX, '-f', str(profile), '/usr/bin/touch', str(root / 'allowed')], capture_output=True)
assert allowed.returncode == 0, allowed.stderr
print('pool, runs, projects: direct and symlink writes denied; unrelated write allowed')
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
  assert.match(result.stdout, /direct and symlink writes denied; unrelated write allowed/);
});
