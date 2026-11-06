import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmod, cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const scripts = fileURLToPath(new URL('../../scripts/', import.meta.url));

test('a scripts-only frozen terminal bundle refuses a Grok terminal review before launch and trusts nothing', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'frozen-terminal-trust-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const staged = path.join(root, 'inputs/runtime/node_modules/@farmslot/agent-runtime/scripts');
  await cp(scripts, staged, { recursive: true });
  await assert.rejects(readFile(path.join(staged, '../dist/native/registry.js')), /ENOENT/);
  // The OS sandbox has its own enforcement proofs; this case tests frozen dependency closure.
  await writeFile(
    path.join(staged, 'review-filesystem.cjs'),
    "module.exports={sandbox:async()=>({temporaryDirectory:process.env.FIXTURE_OUTPUT,sandbox:{executable:'/usr/bin/env',args:[]}})};\n",
  );
  const owner = 'fixture-owner';
  const workspaceId = 'fixture-review';
  const workspace = path.join(
    root,
    'review-workspaces',
    createHash('sha256').update(owner).digest('hex'),
    'runs',
    workspaceId,
  );
  const source = path.join(workspace, 'source');
  const task = path.join(workspace, 'task');
  const account = path.join(root, 'account');
  const bin = path.join(root, 'bin');
  for (const directory of [source, task, account, bin]) await mkdir(directory, { recursive: true });
  await writeFile(
    path.join(workspace, 'identity.json'),
    JSON.stringify({ owner, workspaceId, runId: workspaceId }),
    { mode: 0o600 },
  );
  const git = path.join(bin, 'git');
  await writeFile(git, '#!/bin/sh\nprintf "%s\\n" "$FIXTURE_SOURCE"\n');
  await chmod(git, 0o700);
  const tmux = path.join(bin, 'tmux');
  await writeFile(
    tmux,
    `#!${process.execPath}\nconst fs=require('node:fs'),path=require('node:path');const action=process.argv[2];if(action==='has-session')process.exit(1);if(action!=='new-session')throw Error('Unexpected terminal operation');if(fs.existsSync(path.join(process.env.GROK_HOME,'trusted_folders.toml')))throw Error('A review checkout stays untrusted');fs.writeFileSync(process.env.FIXTURE_LAUNCH,'verified');\n`,
  );
  await chmod(tmux, 0o700);
  const executable = path.join(root, 'configured-grok');
  await writeFile(
    path.join(bin, 'grok'),
    '#!/bin/sh\necho "Wrong executable on PATH" >&2\nexit 23\n',
    { mode: 0o700 },
  );
  await writeFile(
    executable,
    `#!${process.execPath}\nif(!process.argv.includes('inspect')||!process.argv.includes('--json'))throw Error('Expected account inspection');process.stdout.write(process.env.FIXTURE_INSPECTION);\n`,
    { mode: 0o700 },
  );
  const launched = path.join(root, 'launch');
  const launch = (inspection: object) =>
    spawnSync(
      process.execPath,
      [
        path.join(staged, 'review-terminal.cjs'),
        JSON.stringify({
          action: 'launch',
          runner: 'grok',
          executable,
          model: 'fixture-model',
          runId: workspaceId,
          workspaceId,
          session: 'fixture-review',
          cwd: source,
          task,
          runtimeRoots: [],
          environment: { set: { GROK_HOME: account }, unset: [] },
          prompt: 'Read-only review',
          command: 'true',
        }),
      ],
      {
        env: {
          ...process.env,
          PATH: bin + path.delimiter + process.env.PATH,
          GROK_HOME: account,
          FIXTURE_OUTPUT: task,
          FIXTURE_SOURCE: source,
          FIXTURE_LAUNCH: launched,
          FIXTURE_INSPECTION: JSON.stringify(inspection),
        },
        encoding: 'utf8',
        timeout: 5000,
      },
    );
  // Even a hook-free account does not launch: the untrusted checkout would stop at Grok's
  // folder-trust prompt. The frozen bundle still loads the trust helpers before refusing.
  const refused = launch({
    grokVersion: '1.0.52',
    hooks: [],
    permissions: { enforced: [{ setting: 'nonManagedHooks', enabled: false }] },
  });
  assert.equal(refused.status, 1);
  assert.match(refused.stderr, /Grok terminal reviews are unavailable.*native Grok transport/);
  for (const file of [
    launched,
    path.join(account, 'trusted_folders.toml'),
    path.join(task, '.terminal-launch.json'),
  ])
    await assert.rejects(readFile(file), /ENOENT/);
});

for (const runner of ['pi', 'opencode'])
  test(`${runner} terminal review resolves profile roots from the final execution environment`, async (t) => {
    const root = await mkdtemp(path.join(tmpdir(), 'terminal-profile-roots-'));
    t.after(() => rm(root, { recursive: true, force: true }));
    const staged = path.join(root, 'scripts');
    await cp(scripts, staged, { recursive: true });
    const source = path.join(root, 'source');
    const task = path.join(root, 'task');
    const bin = path.join(root, 'bin');
    for (const directory of [source, task, bin]) await mkdir(directory);
    const captured = path.join(root, 'roots.json');
    await writeFile(
      path.join(staged, 'review-filesystem.cjs'),
      `module.exports={sandbox:async(_policy,roots)=>{require('node:fs').writeFileSync(${JSON.stringify(captured)},JSON.stringify(roots));return {temporaryDirectory:${JSON.stringify(task)},sandbox:{executable:'/usr/bin/env',args:[]}}}};`,
    );
    await writeFile(path.join(bin, 'git'), `#!/bin/sh\nprintf '%s\\n' '${source}'\n`, {
      mode: 0o700,
    });
    await writeFile(
      path.join(bin, 'tmux'),
      '#!/bin/sh\nif [ "$1" = has-session ]; then exit 1; fi\n',
      { mode: 0o700 },
    );
    const selected = {
      PI_CODING_AGENT_DIR: path.join(root, 'selected-pi'),
      XDG_DATA_HOME: path.join(root, 'data'),
      XDG_CACHE_HOME: path.join(root, 'cache'),
      XDG_STATE_HOME: path.join(root, 'state'),
      XDG_CONFIG_HOME: path.join(root, 'config'),
    };
    const result = spawnSync(
      process.execPath,
      [
        path.join(staged, 'review-terminal.cjs'),
        JSON.stringify({
          action: 'launch',
          runner,
          model: 'fixture',
          runId: 'fixture',
          workspaceId: 'fixture',
          session: 'fixture',
          cwd: source,
          task,
          runtimeRoots: ['~/.wrong-profile'],
          environment: { set: selected, unset: ['XDG_CACHE_HOME'] },
          prompt: 'Review only',
          command: 'true',
        }),
      ],
      {
        env: {
          ...process.env,
          PATH: bin + path.delimiter + process.env.PATH,
          HOME: root,
          XDG_CACHE_HOME: path.join(root, 'ambient-cache'),
        },
        encoding: 'utf8',
      },
    );
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(
      JSON.parse(await readFile(captured, 'utf8')),
      runner === 'pi'
        ? [selected.PI_CODING_AGENT_DIR]
        : [
            path.join(selected.XDG_DATA_HOME, 'opencode'),
            path.join(root, '.cache/opencode'),
            path.join(selected.XDG_STATE_HOME, 'opencode'),
            path.join(selected.XDG_CONFIG_HOME, 'opencode'),
          ],
    );
  });
