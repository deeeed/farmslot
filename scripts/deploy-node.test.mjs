import assert from 'node:assert/strict';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// One fixture per test: a checkout copy holding the deploy script, the worker
// prefix it reads, and the workspace packages the node bundles. It is removed
// when the test ends, however the test ends.
const deployFixture = (t, prefix) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const write = (relative, content, executable = false) => {
    const target = path.join(root, relative);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, content, { mode: executable ? 0o755 : 0o644 });
  };
  for (const relative of [
    'scripts/deploy-node.sh',
    'scripts/lib/worker-env-prefix.sh',
    'scripts/lib/tmux-bin.sh',
    'services/node/package.json',
  ])
    write(relative, fs.readFileSync(path.join(repo, relative)));
  for (const name of ['protocol', 'capabilities', 'agent-runtime']) {
    write(
      `packages/${name}/package.json`,
      fs.readFileSync(path.join(repo, 'packages', name, 'package.json')),
    );
    fs.mkdirSync(path.join(root, 'packages', name, 'dist'), { recursive: true });
  }
  write('node-token', 'fixture-node-credential');
  return { root, write };
};

// The deploy installs the node CLI from a committed revision of its checkout.
// Signing and hooks from the user's git config must not reach fixture commits.
const commitFixture = (root) => {
  const git = (...args) =>
    execFileSync(
      'git',
      [
        '-c',
        'user.name=fixture',
        '-c',
        'user.email=fixture@example.com',
        '-c',
        'commit.gpgsign=false',
        '-c',
        'core.hooksPath=/dev/null',
        ...args,
      ],
      { cwd: root, stdio: 'ignore' },
    );
  git('init', '-q');
  git('add', '-A');
  git('commit', '-qm', 'fixture');
};

// Execute the actual deployment script with remote side effects replaced by command stubs.
// This proves generated service documents, not remote installation or runner execution.
for (const platform of ['Darwin', 'Linux']) {
  for (const native of [false, true]) {
    for (const captureMode of platform === 'Darwin'
      ? ['bundled', 'retained', 'override', 'missing-key', 'corrupt']
      : ['bundled']) {
      test(`deploy-node renders ${platform} service with native=${native}, capture=${captureMode}`, (t) => {
        const { root, write } = deployFixture(t, 'node-deploy-render-');
        write(
          'bin/ssh',
          `#!/usr/bin/env python3
import os,sys
from pathlib import Path
args=sys.argv[1:]
while args and args[0]=='-o': args=args[2:]
command=' '.join(args[1:])
body=sys.stdin.read()
if body.startswith('<?xml'): Path(os.environ['RENDER_ROOT'],'service.plist').write_text(body)
elif body.startswith('[Unit]'): Path(os.environ['RENDER_ROOT'],'service.unit').write_text(body)
elif command.endswith('/package.json'): Path(os.environ['RENDER_ROOT'],'standalone-package.json').write_text(body)
if command=='uname -s': print(os.environ['RENDER_OS'])
elif command=='echo $HOME': print('/home/node-validation')
elif command=='id -u': print('501')
elif 'SHELL:-/bin/sh' in command: print('/bin/zsh' if os.environ['RENDER_OS']=='Darwin' else '/bin/bash')
elif 'which yarn' in command: print('no')
elif command.startswith('test -d '): sys.exit(1)
elif command.startswith('test -f ') and '.plist' in command: sys.exit(0 if os.environ.get('RENDER_CAPTURE_MODE') in ['retained','missing-key','corrupt'] else 1)
elif command.startswith('/usr/bin/plutil -lint '): sys.exit(1 if os.environ.get('RENDER_CAPTURE_MODE')=='corrupt' else 0)
elif command.startswith('/usr/bin/plutil -extract '):
  if os.environ.get('RENDER_CAPTURE_MODE')=='retained': print('/opt/homebrew/bin/capture-helper')
  else: sys.exit(1)
`,
          true,
        );
        for (const command of ['rsync', 'yarn', 'sleep'])
          write(`bin/${command}`, '#!/bin/sh\nexit 0\n', true);
        commitFixture(root);
        const env = {
          ...process.env,
          PATH: `${root}/bin:${process.env.PATH}`,
          RENDER_ROOT: root,
          RENDER_OS: platform,
          RENDER_CAPTURE_MODE: captureMode,
          CAPTURE_HELPER_PATH: captureMode === 'override' ? '/opt/qa & helpers/capture-helper' : '',
          FARMSLOT_NODE_PATH: platform === 'Darwin' ? '/opt/homebrew/bin/node' : '/usr/bin/node',
          FARMSLOT_NATIVE_OWNER_PRINCIPAL_ID: native ? 'fixture-owner' : '',
          FARMSLOT_NODE_INSTANCE: 'prod',
        };
        const deploy = () =>
          execFileSync(
            'bash',
            [
              path.join(root, 'scripts/deploy-node.sh'),
              'fixture-machine',
              '127.0.0.1',
              '--node-token-file',
              path.join(root, 'node-token'),
            ],
            {
              env,
              cwd: root,
              encoding: 'utf8',
              stdio: ['ignore', 'pipe', 'pipe'],
              timeout: 30000,
            },
          );
        if (captureMode === 'corrupt') {
          assert.throws(deploy, (error) => {
            assert.match(String(error.stderr), /cannot read a valid service plist/);
            return true;
          });
          assert.equal(fs.existsSync(path.join(root, 'service.plist')), false);
          return;
        }
        deploy();
        let args;
        let servicePath;
        if (platform === 'Darwin') {
          const document = JSON.parse(
            execFileSync(
              'python3',
              [
                '-c',
                'import plistlib,json,sys; print(json.dumps(plistlib.load(open(sys.argv[1],"rb"))))',
                path.join(root, 'service.plist'),
              ],
              { encoding: 'utf8' },
            ),
          );
          assert.equal(
            document.EnvironmentVariables.CAPTURE_HELPER_PATH,
            captureMode === 'override'
              ? '/opt/qa & helpers/capture-helper'
              : captureMode === 'retained'
                ? '/opt/homebrew/bin/capture-helper'
                : '/home/node-validation/farmslot-node/node_modules/@siteed/capture-helper/native/capture-helper',
          );
          args = document.ProgramArguments;
          servicePath = document.EnvironmentVariables.PATH;
          assert.equal(
            document.EnvironmentVariables.FARMSLOT_NATIVE_OWNER_PRINCIPAL_ID,
            native ? 'fixture-owner' : undefined,
          );
        } else {
          const unit = fs.readFileSync(path.join(root, 'service.unit'), 'utf8');
          const command = unit
            .split('\n')
            .find((line) => line.startsWith('ExecStart='))
            .slice(10);
          args = JSON.parse(
            execFileSync(
              'python3',
              ['-c', 'import shlex,json,sys; print(json.dumps(shlex.split(sys.argv[1])))', command],
              { encoding: 'utf8' },
            ),
          );
          servicePath = unit
            .split('\n')
            .find((line) => line.startsWith('Environment=PATH='))
            .slice(17);
          assert.equal(unit.includes('FARMSLOT_NATIVE_OWNER_PRINCIPAL_ID=fixture-owner'), native);
        }
        assert.equal(new Set(servicePath.split(':')).size, servicePath.split(':').length);
        // The bundled capture-helper floor. A deployed lockfile keeps whatever
        // satisfied the previous range (0.2.1 was observed pinned on a live node
        // while the operator binary was 0.2.6), and 0.2.1 rejects the node's
        // `+match <app>\t<window>` probe as a structured error, so screen probes
        // never start. Only a raised range makes a repeated install upgrade.
        const standalone = JSON.parse(
          fs.readFileSync(path.join(root, 'standalone-package.json'), 'utf8'),
        );
        assert.equal(
          standalone.dependencies['@siteed/capture-helper'],
          platform === 'Darwin' ? '^0.2.6' : undefined,
          'macOS nodes bundle capture-helper at the supported floor; Linux nodes bundle none',
        );
        if (native) {
          assert.deepEqual(args.slice(0, 2), [
            platform === 'Darwin' ? '/bin/zsh' : '/bin/bash',
            '-lc',
          ]);
          assert.equal(args.length, 3);
          // Unset after the login shell, so a profile export cannot bring it back.
          assert.ok(
            args[2].startsWith(
              `exec /usr/bin/env -u FARMSLOT_ROOT ${env.FARMSLOT_NODE_PATH} --require `,
            ),
          );
          assert.ok(servicePath.includes('/home/node-validation/.npm-global/bin'));
        } else {
          // The service runs with FARMSLOT_ROOT unset, as the token check does.
          assert.deepEqual(args.slice(0, 5), [
            '/usr/bin/env',
            '-u',
            'FARMSLOT_ROOT',
            env.FARMSLOT_NODE_PATH,
            '--require',
          ]);
          assert.equal(args.length, 9);
        }
      });
    }
  }
}

// The node imports agent-runtime's dist, and dist/native/review-sandbox.js
// requires ../../scripts/review-filesystem.cjs, so a dist-only copy crashes every
// deployed node at boot with MODULE_NOT_FOUND. The stub captures rsync argv
// instead of exiting 0 silently, which is the only way to see what a deploy ships.
test("deploy-node syncs a bundled package's scripts/ and bin/ beside dist/ and skips packages without them", (t) => {
  const { root, write } = deployFixture(t, 'node-deploy-rsync-');
  // Only agent-runtime publishes scripts/ and bin/; protocol publishes neither,
  // so it must issue no such rsync.
  write('packages/agent-runtime/scripts/review-filesystem.cjs', 'module.exports = {};\n');
  write('packages/agent-runtime/bin/farmslot-agent.mjs', '#!/usr/bin/env node\n', true);
  write(
    'bin/ssh',
    `#!/usr/bin/env python3
import os,sys
with open(os.environ['SSH_LOG'],'a') as log: log.write(' '.join(sys.argv[1:3])+'\\n')
args=sys.argv[1:]
while args and args[0]=='-o': args=args[2:]
command=' '.join(args[1:])
sys.stdin.read()
if command=='uname -s': print(os.environ['RENDER_OS'])
elif command=='echo $HOME': print('/home/node-validation')
elif command=='id -u': print('501')
elif 'SHELL:-/bin/sh' in command: print('/bin/zsh')
elif 'which yarn' in command: print('no')
elif command.startswith('test -d '): sys.exit(1)
`,
    true,
  );
  // Record argv per invocation; one line per rsync the deploy runs.
  // The remote shell rsync uses (RSYNC_RSH) leads each line.
  write(
    'bin/rsync',
    '#!/bin/sh\nprintf \'%s | %s\\n\' "$RSYNC_RSH" "$*" >> "$RSYNC_LOG"\nexit 0\n',
    true,
  );
  for (const command of ['yarn', 'sleep']) write(`bin/${command}`, '#!/bin/sh\nexit 0\n', true);

  commitFixture(root);
  const rsyncLog = path.join(root, 'rsync.log');
  const sshLog = path.join(root, 'ssh.log');
  execFileSync(
    'bash',
    [
      path.join(root, 'scripts/deploy-node.sh'),
      'fixture-machine',
      '127.0.0.1',
      '--node-token-file',
      path.join(root, 'node-token'),
    ],
    {
      env: {
        ...process.env,
        PATH: `${root}/bin:${process.env.PATH}`,
        RENDER_ROOT: root,
        RENDER_OS: 'Darwin',
        RSYNC_LOG: rsyncLog,
        SSH_LOG: sshLog,
        FARMSLOT_NODE_PATH: '/opt/homebrew/bin/node',
        FARMSLOT_NATIVE_OWNER_PRINCIPAL_ID: '',
        FARMSLOT_NODE_INSTANCE: 'prod',
      },
      cwd: root,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 30000,
    },
  );

  const invocations = fs.readFileSync(rsyncLog, 'utf8').split('\n').filter(Boolean);
  // F56: a host name whose first address does not answer must not fail the
  // deploy, so every ssh and rsync to the node bounds its connect.
  const sshCalls = fs.readFileSync(sshLog, 'utf8').split('\n').filter(Boolean);
  assert.ok(sshCalls.length > 0);
  for (const call of sshCalls) assert.equal(call, '-o ConnectTimeout=10');
  for (const line of invocations) assert.ok(line.startsWith('ssh -o ConnectTimeout=10 | '), line);
  const remote = 'fixture-machine.local:/home/node-validation/farmslot-node';
  const syncOf = (source, destination) =>
    invocations.find(
      (line) =>
        line.includes('--delete') &&
        line.includes(`${path.join(root, source)}/`) &&
        line.includes(`${remote}/${destination}/`),
    );

  // What the fix ships: the package's own scripts/ and bin/ under node_modules,
  // beside the dist/ that requires them.
  assert.ok(
    syncOf('packages/agent-runtime/dist', 'node_modules/@farmslot/agent-runtime/dist'),
    `no dist sync for agent-runtime in:\n${invocations.join('\n')}`,
  );
  assert.ok(
    syncOf('packages/agent-runtime/scripts', 'node_modules/@farmslot/agent-runtime/scripts'),
    `agent-runtime scripts/ is not synced under node_modules — dist/native/review-sandbox.js will fail to require ../../scripts/review-filesystem.cjs. rsync invocations:\n${invocations.join('\n')}`,
  );
  assert.ok(
    syncOf('packages/agent-runtime/bin', 'node_modules/@farmslot/agent-runtime/bin'),
    `agent-runtime bin/ is not synced under node_modules. rsync invocations:\n${invocations.join('\n')}`,
  );

  // A package that publishes neither directory issues no such rsync: the sync
  // is conditional on the source existing, not unconditional.
  for (const directory of ['scripts', 'bin']) {
    assert.equal(
      invocations.find((line) =>
        line.includes(`${remote}/node_modules/@farmslot/protocol/${directory}/`),
      ),
      undefined,
      `protocol has no ${directory}/ in the fixture, so the deploy must not sync one`,
    );
  }
});

// Workers run the `farmslot` on their PATH, so a node deploy that skipped the CLI
// left worker-side fixes on whatever revision the CLI was last installed at. The
// ssh stub runs each remote command locally with HOME at a temp directory, so the
// snapshot, its links and the worker-shell verify are real files and processes.
// The tmux stub stands in for the node user's server: it runs a new session's
// command in the foreground. Each test runs one deploy.
const FAKE_CLI = `#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
const home = process.env.HOME;
fs.appendFileSync(path.join(home, 'cli-calls.jsonl'), JSON.stringify({
  argv: process.argv.slice(2),
  script: fs.realpathSync(process.argv[1]),
  gwUrl: process.env.GW_URL ?? null,
  farmslotHome: process.env.FARMSLOT_HOME ?? null,
  credentials: ['FARMSLOT_NODE_TOKEN', 'FARMSLOT_GATEWAY_TOKEN', 'FARMSLOT_GATEWAY_PASSWORD'].filter((name) => process.env[name]),
}) + '\\n');
if (fs.existsSync(path.join(home, 'cli-hangs'))) {
  fs.writeFileSync(path.join(home, 'cli-hang.pid'), String(process.pid));
  setInterval(() => {}, 1000);
} else if (process.argv[2] === '--version') console.log('0.0.0-fixture');
else if (fs.existsSync(path.join(home, 'gateway-down'))) { console.error('gateway unreachable'); process.exit(1); }
else console.log('{}');
`;

const cliFixture = (t, { tmuxServer = true } = {}) => {
  const { root, write } = deployFixture(t, 'node-deploy-cli-');
  const home = path.join(root, 'home');
  write('packages/cli/bin/farmslot.mjs', FAKE_CLI, true);
  write('yarn.lock', '# fixture lockfile\n');
  commitFixture(root);
  write(
    'bin/ssh',
    '#!/bin/sh\nwhile [ "$1" = -o ]; do shift 2; done\nshift\nexec bash -c "$*"\n',
    true,
  );
  write('bin/uname', '#!/bin/sh\necho Linux\n', true);
  write(
    'bin/yarn',
    '#!/bin/sh\n[ "$1" != --version ] || { echo 4.5.3; exit 0; }\n' +
      'echo "$PWD $* immutable=$YARN_ENABLE_IMMUTABLE_INSTALLS via=${YARN_VIA:-path}" >> "$HOME/yarn.log"\n' +
      'case "$*" in workspaces\\ focus*)\n' +
      '  [ ! -f "$HOME/yarn-fails" ] || { echo "fixture yarn failure"; exit 1; }\n' +
      '  [ ! -f "$HOME/yarn-edits-lock" ] || echo "# resolved anew" >> yarn.lock ;;\nesac\n',
    true,
  );
  write(
    'bin/tmux',
    `#!/bin/sh
case "$1" in
  list-sessions) [ -f "$HOME/tmux-server" ] ;;
  new-session)
    for arg; do command=$arg; done
    echo "$command" >> "$HOME/tmux.log"
    [ -f "$HOME/tmux-hangs" ] || bash -c "$command" ;;
  kill-session) echo "$*" >> "$HOME/tmux-kills.log" ;;
esac
`,
    true,
  );
  // sleep returns at once; in a verify poll it first waits for a hung CLI to start.
  write(
    'bin/sleep',
    '#!/bin/sh\n[ "$1" = 0.5 ] && [ -f "$HOME/cli-hangs" ] || exit 0\n' +
      'for _ in $(seq 1 100); do [ -s "$HOME/cli-hang.pid" ] && exit 0; /bin/sleep 0.05; done\n',
    true,
  );
  write('bin/rsync', '#!/bin/sh\nexit 0\n', true);
  write('bin/systemctl', '#!/bin/sh\necho "$*" >> "$HOME/systemctl.log"\n', true);
  // No bash login profile, as on macpro and mini: the worker prefix alone must
  // put the deployed CLI on PATH.
  if (tmuxServer) write('home/tmux-server', '');
  // The node's own node dir, as the service runs it: node plus corepack, which
  // hands `yarn` to the stub as the repo's pinned Yarn. PATH below holds nothing
  // else from the machine, so a real yarn or corepack can never be picked up.
  const nodeBin = path.join(root, 'node-bin');
  fs.mkdirSync(nodeBin);
  fs.symlinkSync(process.execPath, path.join(nodeBin, 'node'));
  write(
    'node-bin/corepack',
    `#!/bin/sh\n[ "$1" = yarn ] || exit 1\nshift\nYARN_VIA=corepack exec ${path.join(root, 'bin/yarn')} "$@"\n`,
    true,
  );
  const sha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
  const cliRoot = path.join(home, '.local/share/farmslot-cli');
  const snapshot = path.join(cliRoot, sha);
  const read = (name) => {
    const file = path.join(home, name);
    return fs.existsSync(file) ? fs.readFileSync(file, 'utf8').split('\n').filter(Boolean) : [];
  };
  return {
    root,
    home,
    write,
    sha,
    cliRoot,
    snapshot,
    entry: path.join(snapshot, 'packages/cli/bin/farmslot.mjs'),
    deploy: ({
      instance = 'prod',
      machine = 'fixture-machine',
      args = [],
      shell = '/bin/bash',
      nodeTokenFile = true,
      env: extraEnv = {},
    } = {}) => {
      // rsync is stubbed, so stand in for the synced node: the token check the
      // deploy runs there, with tsx as the install provides it.
      const install = path.join(home, `farmslot-node${instance === 'dev' ? '-dev' : ''}`);
      for (const name of ['check-node-token.ts', 'gateway-credential.ts'])
        write(
          path.relative(root, path.join(install, 'src', name)),
          fs.readFileSync(path.join(repo, 'services/node/src', name)),
        );
      if (!fs.existsSync(path.join(install, 'node_modules/tsx'))) {
        fs.mkdirSync(path.join(install, 'node_modules'), { recursive: true });
        fs.symlinkSync(path.join(repo, 'node_modules/tsx'), path.join(install, 'node_modules/tsx'));
      }
      const env = {
        ...process.env,
        // Only the fixture's stubs, node and the system tools: nothing from the
        // developer's own PATH, such as an installed farmslot.
        PATH: `${root}/bin:${nodeBin}:/usr/bin:/bin:/usr/sbin:/sbin`,
        HOME: home,
        SHELL: shell,
        ASDF_DATA_DIR: '',
        GATEWAY_PORT: '',
        FARMSLOT_NODE_PATH: path.join(nodeBin, 'node'),
        FARMSLOT_NATIVE_OWNER_PRINCIPAL_ID: '',
        FARMSLOT_GATEWAY_TOKEN: 'fixture-operator-secret',
        FARMSLOT_NODE_TOKEN: '',
        FARMSLOT_GATEWAY_PASSWORD: '',
        ...extraEnv,
      };
      for (const name of ['FARMSLOT_HOME', 'BASH_ENV', 'ZDOTDIR', 'TMUX', 'TMUX_PANE'])
        delete env[name];
      return execFileSync(
        'bash',
        [
          path.join(root, 'scripts/deploy-node.sh'),
          machine,
          '127.0.0.1',
          '--instance',
          instance,
          ...(nodeTokenFile ? ['--node-token-file', path.join(root, 'node-token')] : []),
          ...args,
        ],
        { env, cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 60000 },
      );
    },
    calls: () => read('cli-calls.jsonl').map((line) => JSON.parse(line)),
    systemctl: () => read('systemctl.log'),
    tmuxLaunches: () => read('tmux.log'),
    tmuxKills: () => read('tmux-kills.log'),
    snapshotInstalls: () => read('yarn.log').filter((line) => line.includes(' workspaces focus ')),
  };
};

const seedSnapshot = (fixture, sha) => {
  const dir = path.join(fixture.cliRoot, sha);
  fs.mkdirSync(path.join(dir, 'packages/cli/bin'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'packages/cli/bin/farmslot.mjs'), FAKE_CLI, { mode: 0o755 });
  fs.writeFileSync(path.join(dir, 'DEPLOYED-REVISION.json'), JSON.stringify({ sha }));
  return path.join(dir, 'packages/cli/bin/farmslot.mjs');
};

const link = (fixture, relative, target) => {
  fs.mkdirSync(path.dirname(path.join(fixture.home, relative)), { recursive: true });
  fs.symlinkSync(target, path.join(fixture.home, relative));
};

for (const instance of ['prod', 'dev']) {
  test(`deploy-node installs the deployed revision as the node CLI and verifies it in a worker session (${instance})`, (t) => {
    const fixture = cliFixture(t);
    // mini-style: ~/.local/bin points at an older snapshot, and one older still
    // is unreferenced. macpro-style: ~/.npm-global/bin points into a checkout.
    const previous = 'a'.repeat(40);
    const stale = 'b'.repeat(40);
    link(fixture, '.local/bin/farmslot', seedSnapshot(fixture, previous));
    seedSnapshot(fixture, stale);
    const checkoutCli = path.join(fixture.home, 'dev/farmslot/packages/cli/bin/farmslot.mjs');
    fixture.write('home/dev/farmslot/packages/cli/bin/farmslot.mjs', '// operator checkout\n');
    link(fixture, '.npm-global/bin/farmslot', checkoutCli);

    const output = fixture.deploy({ instance });

    const archive = execFileSync('git', ['archive', '--format=tar', fixture.sha], {
      cwd: fixture.root,
      maxBuffer: 64 * 1024 * 1024,
    });
    assert.deepEqual(
      JSON.parse(fs.readFileSync(path.join(fixture.snapshot, 'DEPLOYED-REVISION.json'), 'utf8')),
      { sha: fixture.sha, sha256: crypto.createHash('sha256').update(archive).digest('hex') },
    );
    // Only the CLI's workspaces are installed, in a partial directory renamed into place.
    const installs = fixture.snapshotInstalls();
    assert.equal(installs.length, 1);
    assert.match(
      installs[0],
      new RegExp(
        `^${fixture.snapshot}\\.partial\\.\\w+ workspaces focus @farmslot/cli immutable=1 via=corepack$`,
      ),
    );
    assert.deepEqual(fs.readdirSync(fixture.cliRoot).sort(), [previous, fixture.sha].sort());
    assert.match(output, new RegExp(`pruned .*/${stale}`));
    for (const relative of ['.local/bin/farmslot', '.npm-global/bin/farmslot'])
      assert.equal(fs.readlinkSync(path.join(fixture.home, relative)), fixture.entry, relative);
    assert.match(
      output,
      new RegExp(`\\.local/bin/farmslot \\(was .*/${previous}/packages/cli/bin/farmslot\\.mjs\\)`),
    );
    assert.match(
      output,
      /\.npm-global\/bin\/farmslot \(was .*dev\/farmslot\/packages\/cli\/bin\/farmslot\.mjs\)/,
    );
    assert.equal(fs.readFileSync(checkoutCli, 'utf8'), '// operator checkout\n');

    const gwUrl = `ws://127.0.0.1:${instance === 'dev' ? 7801 : 7777}`;
    const launches = fixture.tmuxLaunches();
    assert.equal(launches.length, 1);
    assert.ok(launches[0].startsWith('exec bash -lc '), launches[0]);
    assert.ok(launches[0].includes('DISABLE_OMC=1'), launches[0]);
    assert.ok(launches[0].includes(`GW_URL=${gwUrl}`), launches[0]);
    const expected = {
      script: fs.realpathSync(fixture.entry),
      gwUrl,
      // Tmux workers keep the login shell's FARMSLOT_HOME for both instances.
      farmslotHome: null,
      credentials: [],
    };
    assert.deepEqual(fixture.calls(), [
      { argv: ['--version'], ...expected },
      { argv: ['rpc', 'gateway.status'], ...expected },
    ]);
  });
}

test('deploy-node reuses an installed snapshot and moves nothing when the revision is redeployed', (t) => {
  const fixture = cliFixture(t);
  const older = 'c'.repeat(40);
  seedSnapshot(fixture, older);
  link(fixture, '.local/bin/farmslot', seedSnapshot(fixture, fixture.sha));

  const output = fixture.deploy();

  assert.match(output, /node CLI snapshot [0-9a-f]+ already installed/);
  assert.equal(fixture.snapshotInstalls().length, 0);
  assert.doesNotMatch(output, / → .*\/bin\/farmslot|pruned/);
  assert.ok(fs.existsSync(path.join(fixture.cliRoot, older)), 'a redeploy prunes nothing');
  assert.equal(fixture.calls().length, 2);
});

// On a local deploy the CLI on PATH is the operator's own. MACHINE matching
// `hostname -s` selects local mode.
const localMachine = () => execFileSync('hostname', ['-s'], { encoding: 'utf8' }).trim();

test('deploy-node leaves the CLI as is on a local deploy by default', (t) => {
  const fixture = cliFixture(t);
  const operatorCli = path.join(fixture.home, 'farmslot/packages/cli/bin/farmslot.mjs');
  fixture.write('home/farmslot/packages/cli/bin/farmslot.mjs', '// operator checkout\n');
  link(fixture, '.local/bin/farmslot', operatorCli);

  const output = fixture.deploy({ machine: localMachine() });

  assert.match(
    output,
    /local deploy: node CLI left as is; pass --refresh-cli to install the deployed revision/,
  );
  assert.equal(fs.readlinkSync(path.join(fixture.home, '.local/bin/farmslot')), operatorCli);
  assert.equal(fs.existsSync(fixture.cliRoot), false);
  assert.deepEqual(fixture.calls(), []);
});

test('deploy-node installs the CLI on a local deploy with --refresh-cli', (t) => {
  const fixture = cliFixture(t);
  link(
    fixture,
    '.local/bin/farmslot',
    path.join(fixture.home, 'farmslot/packages/cli/bin/farmslot.mjs'),
  );

  const output = fixture.deploy({ machine: localMachine(), args: ['--refresh-cli'] });

  assert.match(output, /installing node CLI snapshot/);
  assert.equal(fs.readlinkSync(path.join(fixture.home, '.local/bin/farmslot')), fixture.entry);
  assert.deepEqual(
    fixture.calls().map((call) => call.argv),
    [['--version'], ['rpc', 'gateway.status']],
  );
});

test('deploy-node verifies in bash -lc without a tmux server, whatever the zsh dotfiles say', (t) => {
  const fixture = cliFixture(t, { tmuxServer: false });
  // A stale CLI first on zsh's PATH must not matter: workers never start in zsh.
  fixture.write('home/stale/farmslot', '#!/bin/sh\necho stale\n', true);
  for (const file of ['.zshrc', '.zprofile'])
    fixture.write(`home/${file}`, 'export PATH="$HOME/stale:$PATH"\n');

  const output = fixture.deploy({ shell: '/bin/zsh' });

  assert.match(output, /no tmux server running; probing in bash -lc/);
  assert.deepEqual(fixture.tmuxLaunches(), []);
  assert.deepEqual(
    fixture.calls().map((call) => call.argv),
    [['--version'], ['rpc', 'gateway.status']],
  );
});

test('deploy-node verifies when the bash login profile never adds ~/.local/bin', (t) => {
  const fixture = cliFixture(t);
  fixture.write('home/.bash_profile', 'export PATH="/usr/local/bin:$PATH"\n');

  fixture.deploy();

  assert.deepEqual(
    fixture.calls().map((call) => [call.argv, call.script]),
    [
      [['--version'], fs.realpathSync(fixture.entry)],
      [['rpc', 'gateway.status'], fs.realpathSync(fixture.entry)],
    ],
  );
});

// The node reads FARMSLOT_NODE_TOKEN from an env file in or above its install
// dir ahead of the service's own: a stale one there (mini and macwork kept an
// old ~/farmslot-node/.env.local-auth) left nodes failing auth after a deploy
// that reported success.
test('deploy-node fails before the service is reloaded when an env file shadows the node token', (t) => {
  const fixture = cliFixture(t);
  const file = path.join(fixture.home, 'farmslot-node/.env.local-auth');
  fixture.write(
    'home/farmslot-node/.env.local-auth',
    'FARMSLOT_NODE_TOKEN=stale-file-credential\n',
  );
  assert.throws(fixture.deploy, (error) => {
    assert.equal(error.status, 1);
    const stderr = String(error.stderr);
    assert.ok(
      stderr.includes(
        `[deploy] ERROR: ${fs.realpathSync(file)} sets FARMSLOT_NODE_TOKEN, which the node reads instead of the deployed token\n` +
          '  fix: remove that line (or move the file aside), then redeploy\n',
      ),
      stderr,
    );
    assert.match(
      stderr,
      /node token check failed on fixture-machine; the service was not reloaded/,
    );
    assert.doesNotMatch(
      `${error.stdout}${stderr}`,
      /stale-file-credential|fixture-node-credential|fixture-operator-secret/,
    );
    return true;
  });
  assert.deepEqual(fixture.systemctl(), []);
  assert.equal(
    fs.existsSync(path.join(fixture.home, '.config/systemd/user/farmslot-node.service')),
    false,
  );
  assert.deepEqual(fixture.calls(), []);
});

// A local deploy (no ssh, no CLI refresh) runs the same check in the operator's shell.
test('deploy-node deploys when the env file holds the deployed node token', (t) => {
  const fixture = cliFixture(t);
  fixture.write(
    'home/farmslot-node/.env.local-auth',
    'FARMSLOT_NODE_TOKEN=fixture-node-credential\n',
  );

  const output = fixture.deploy({ machine: localMachine() });

  assert.match(output, /checking for an env file that shadows the node token/);
  assert.ok(
    fixture.systemctl().some((line) => line.includes('restart farmslot-node')),
    fixture.systemctl().join('\n'),
  );
});

// A native node runs as `$SHELL -lc 'exec …'`, and so does its check. The login
// profile may print and may export FARMSLOT_ROOT: here at a decoy whose env file
// holds the deployed token and, searched first, would hide the stale one.
test('deploy-node runs the native check through the login shell and still refuses a shadowing file', (t) => {
  const fixture = cliFixture(t);
  fixture.write('home/decoy/.env.local-auth', 'FARMSLOT_NODE_TOKEN=fixture-node-credential\n');
  fixture.write(
    'home/.bash_profile',
    'echo "login banner from the profile"\nexport FARMSLOT_ROOT="$HOME/decoy"\n',
  );
  fixture.write(
    'home/farmslot-node/.env.local-auth',
    'FARMSLOT_NODE_TOKEN=stale-file-credential\n',
  );
  assert.throws(
    () => fixture.deploy({ env: { FARMSLOT_NATIVE_OWNER_PRINCIPAL_ID: 'fixture-owner' } }),
    (error) => {
      assert.equal(error.status, 1);
      assert.match(String(error.stdout), /login banner from the profile/);
      const stderr = String(error.stderr);
      assert.ok(
        stderr.includes(
          `[deploy] ERROR: ${fs.realpathSync(path.join(fixture.home, 'farmslot-node/.env.local-auth'))} sets FARMSLOT_NODE_TOKEN`,
        ),
        stderr,
      );
      assert.match(
        stderr,
        /node token check failed on fixture-machine; the service was not reloaded/,
      );
      assert.doesNotMatch(
        `${error.stdout}${stderr}`,
        /stale-file-credential|fixture-node-credential/,
      );
      return true;
    },
  );
  assert.deepEqual(fixture.systemctl(), []);
});

// Without --node-token-file the service carries FARMSLOT_GATEWAY_TOKEN as its
// node token, so that is what an env file must match.
for (const [held, deploys] of [
  ['fixture-operator-secret', true],
  ['fixture-node-credential', false],
]) {
  test(`deploy-node checks a gateway-token-only deploy against that token (${deploys ? 'matching' : 'differing'} file)`, (t) => {
    const fixture = cliFixture(t);
    fixture.write('home/farmslot-node/.env.local-auth', `FARMSLOT_NODE_TOKEN=${held}\n`);
    const deploy = () => fixture.deploy({ machine: localMachine(), nodeTokenFile: false });
    if (deploys) {
      assert.match(deploy(), /checking for an env file that shadows the node token/);
      assert.ok(fixture.systemctl().some((line) => line.includes('restart farmslot-node')));
      return;
    }
    assert.throws(deploy, (error) => {
      assert.match(String(error.stderr), /sets FARMSLOT_NODE_TOKEN, which the node reads instead/);
      assert.doesNotMatch(
        `${error.stdout}${error.stderr}`,
        /fixture-operator-secret|fixture-node-credential/,
      );
      return true;
    });
    assert.deepEqual(fixture.systemctl(), []);
  });
}

// With no token the service carries none for an env file to shadow.
test('deploy-node skips the token check when it deploys no token', (t) => {
  const fixture = cliFixture(t);
  fixture.write('home/farmslot-node/.env.local-auth', 'FARMSLOT_NODE_TOKEN=file-credential\n');

  const output = fixture.deploy({
    machine: localMachine(),
    nodeTokenFile: false,
    env: { FARMSLOT_GATEWAY_TOKEN: '' },
  });

  assert.doesNotMatch(output, /shadows the node token/);
  assert.ok(fixture.systemctl().some((line) => line.includes('restart farmslot-node')));
});

// A port on loopback: listening (until the test ends) or, once closed, free.
const loopbackPort = async (t, { listening }) => {
  const server = net.createServer((socket) => socket.destroy());
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  if (listening) t.after(() => server.close());
  else await new Promise((resolve) => server.close(resolve));
  return String(port);
};

test('deploy-node fails loudly with the fix when the gateway answers but the RPC fails', async (t) => {
  const fixture = cliFixture(t);
  fixture.write('home/gateway-down', '');
  const port = await loopbackPort(t, { listening: true });
  assert.throws(
    () => fixture.deploy({ env: { GATEWAY_PORT: port } }),
    (error) => {
      assert.notEqual(error.status, 0);
      const stderr = String(error.stderr);
      assert.match(
        stderr,
        new RegExp(`rpc gateway\\.status failed against ws://127\\.0\\.0\\.1:${port}`),
      );
      assert.match(
        stderr,
        new RegExp(
          `farmslot gateway add <name> ws://127\\.0\\.0\\.1:${port} && farmslot login <name>`,
        ),
      );
      assert.doesNotMatch(`${error.stdout}${stderr}`, /WARNING/);
      assert.match(stderr, /workers on fixture-machine cannot use the deployed farmslot CLI/);
      assert.doesNotMatch(
        `${error.stdout}${stderr}`,
        /fixture-operator-secret|fixture-node-credential/,
      );
      return true;
    },
  );
});

test('deploy-node warns and succeeds when nothing listens on the gateway port', async (t) => {
  const fixture = cliFixture(t);
  fixture.write('home/gateway-down', '');
  const port = await loopbackPort(t, { listening: false });

  const output = fixture.deploy({ env: { GATEWAY_PORT: port } });

  assert.match(output, /farmslot 0\.0\.0-fixture/);
  assert.match(
    output,
    new RegExp(
      `\\[deploy\\] WARNING: prod gateway unreachable at ws://127\\.0\\.0\\.1:${port}; CLI installed and verified; rerun the deploy to verify when it is up$`,
      'm',
    ),
  );
  assert.doesNotMatch(output, /cannot use the deployed farmslot CLI/);
  assert.deepEqual(
    fixture.calls().map((call) => call.argv),
    [['--version'], ['rpc', 'gateway.status']],
  );
});

test('deploy-node verifies the deployed CLI ahead of an asdf-installed farmslot', (t) => {
  const fixture = cliFixture(t);
  fixture.write('home/.asdf/shims/farmslot', '#!/bin/sh\necho stale; exit 1\n', true);

  const output = fixture.deploy();

  assert.match(output, /farmslot 0\.0\.0-fixture/);
  assert.equal(fixture.calls()[0].script, fs.realpathSync(fixture.entry));
});

test('deploy-node keeps the yarn log and installs nothing when the CLI install fails', (t) => {
  const fixture = cliFixture(t);
  fixture.write('home/yarn-fails', '');
  assert.throws(fixture.deploy, (error) => {
    assert.match(
      String(error.stderr),
      /yarn workspaces focus @farmslot\/cli failed for the node CLI; full log: .*\.yarn-install\.log/,
    );
    return true;
  });
  assert.deepEqual(fs.readdirSync(fixture.cliRoot), [`${fixture.sha}.yarn-install.log`]);
  assert.match(
    fs.readFileSync(path.join(fixture.cliRoot, `${fixture.sha}.yarn-install.log`), 'utf8'),
    /fixture yarn failure/,
  );
  assert.equal(fs.existsSync(path.join(fixture.home, '.local/bin/farmslot')), false);
});

// Overlapping deploys on one machine serialize on the node: a deploy waits for a
// live holder, takes over a lock whose holder is gone, and releases it after.
test('deploy-node takes over a stale CLI lock, clears its partial install and releases the lock', (t) => {
  const fixture = cliFixture(t);
  const lock = path.join(fixture.cliRoot, '.lock');
  fixture.write(`home/.local/share/farmslot-cli/${'d'.repeat(40)}.partial.killed/yarn.lock`, '');
  // A holder killed before it wrote its pid: stale once a minute old.
  fs.mkdirSync(lock);
  const twoMinutesAgo = new Date(Date.now() - 120_000);
  fs.utimesSync(lock, twoMinutesAgo, twoMinutesAgo);

  const output = fixture.deploy();

  assert.match(output, new RegExp(`removing stale lock ${lock}\\n`));
  assert.match(output, /removed stale .*\.partial\.killed/);
  assert.deepEqual(fs.readdirSync(fixture.cliRoot), [fixture.sha]);
  assert.equal(fixture.calls().length, 2);
});

test('deploy-node fails with the fix while another live deploy holds the CLI lock', (t) => {
  const fixture = cliFixture(t);
  fixture.write('home/.local/share/farmslot-cli/.lock/pid', `${process.pid}\n`);
  assert.throws(
    () => fixture.deploy({ env: { CLI_LOCK_WAIT_SECONDS: '3' } }),
    (error) => {
      assert.match(
        String(error.stderr),
        new RegExp(`another deploy has held .*/\\.lock for 3 s \\(pid ${process.pid}\\)`),
      );
      return true;
    },
  );
  assert.equal(fs.existsSync(fixture.snapshot), false);
  assert.equal(
    fs.readFileSync(path.join(fixture.cliRoot, '.lock/pid'), 'utf8'),
    `${process.pid}\n`,
    "the holder's lock is left alone",
  );
});

test('deploy-node refuses a CLI install that rewrites the committed yarn.lock', (t) => {
  const fixture = cliFixture(t);
  fixture.write('home/yarn-edits-lock', '');
  assert.throws(fixture.deploy, (error) => {
    assert.match(String(error.stderr), /installing the node CLI changed yarn\.lock/);
    return true;
  });
  assert.deepEqual(fs.readdirSync(fixture.cliRoot), [`${fixture.sha}.yarn-install.log`]);
  assert.equal(fs.existsSync(path.join(fixture.home, '.local/bin/farmslot')), false);
});

test('deploy-node gives up on a verify session that never finishes and kills only that session', (t) => {
  const fixture = cliFixture(t);
  fixture.write('home/tmux-hangs', '');
  assert.throws(
    () => fixture.deploy({ env: { CLI_VERIFY_TIMEOUT_SECONDS: '2' } }),
    (error) => {
      assert.match(String(error.stderr), /the worker-shell verify did not finish within 2 s/);
      return true;
    },
  );
  assert.equal(fixture.tmuxLaunches().length, 1);
  const kills = fixture.tmuxKills();
  assert.equal(kills.length, 1);
  assert.match(kills[0], /^kill-session -t =farmslot-cli-verify-\d+$/);
});

// The node-side refresh script, run straight from deploy-node.sh: contenders
// started together over a lock left by a dead holder must take it one at a
// time. Each installs its own revision; the fake yarn brackets the install.
test('node CLI refreshes started together over a stale lock never overlap', async (t) => {
  const refresh = /CLI_REFRESH=\$\(cat << 'REFRESH'\n([\s\S]*?)\nREFRESH\n/.exec(
    fs.readFileSync(path.join(repo, 'scripts/deploy-node.sh'), 'utf8'),
  )[1];
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'node-deploy-lock-'));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const bin = path.join(base, 'bin');
  fs.mkdirSync(bin);
  fs.writeFileSync(
    path.join(bin, 'yarn'),
    '#!/bin/sh\n[ "$1" != --version ] || { echo 4.5.3; exit 0; }\n' +
      'sha=$(basename "$PWD"); sha=${sha%%.partial.*}\n' +
      'echo "start $sha" >> "$HOME/yarn.log"; /bin/sleep 0.05; echo "end $sha" >> "$HOME/yarn.log"\n',
    { mode: 0o755 },
  );
  fs.writeFileSync(path.join(bin, 'sleep'), '#!/bin/sh\nexec /bin/sleep 0.01\n', { mode: 0o755 });
  const source = path.join(base, 'source');
  fs.mkdirSync(path.join(source, 'packages/cli/bin'), { recursive: true });
  fs.writeFileSync(path.join(source, 'yarn.lock'), '# fixture lockfile\n');
  fs.writeFileSync(path.join(source, 'packages/cli/bin/farmslot.mjs'), FAKE_CLI);
  const archive = path.join(base, 'cli.tar');
  execFileSync('tar', ['-cf', archive, '-C', source, '.']);

  // Each contender runs in its own process group; whatever happens, kill any
  // group still running and wait for it before the test ends.
  const children = [];
  t.after(async () => {
    for (const child of children) {
      if (child.exitCode !== null || child.signalCode !== null) continue;
      const closed = new Promise((resolve) => child.once('close', resolve));
      try {
        process.kill(-child.pid, 'SIGKILL');
      } catch {
        // already gone
      }
      await closed;
    }
  });

  for (let iteration = 0; iteration < 3; iteration += 1) {
    const home = path.join(base, `home-${iteration}`);
    const root = path.join(home, '.local/share/farmslot-cli');
    fs.mkdirSync(path.join(root, '.lock'), { recursive: true });
    fs.writeFileSync(path.join(root, '.lock/pid'), `${spawnSync('true').pid}\n`);
    const runs = ['1', '2', '3'].map((digit) => {
      const sha = `${digit}${iteration}`.padEnd(40, '0');
      const input = fs.openSync(archive, 'r');
      const child = spawn('bash', ['-c', refresh, '_', root, sha, 'f'.repeat(64), bin, '30'], {
        env: { PATH: `${bin}:/usr/bin:/bin:/usr/sbin:/sbin`, HOME: home },
        stdio: [input, 'pipe', 'pipe'],
        detached: true,
      });
      fs.closeSync(input);
      children.push(child);
      let output = '';
      child.stdout.on('data', (chunk) => (output += chunk));
      child.stderr.on('data', (chunk) => (output += chunk));
      return new Promise((resolve) => child.on('close', (code) => resolve({ code, output })));
    });
    const results = await Promise.all(runs);
    for (const { code, output } of results) assert.equal(code, 0, output);
    const reaps = results.filter(({ output }) => output.includes('removing stale lock'));
    assert.equal(reaps.length, 1, 'exactly one contender takes over the stale lock');
    const installs = fs.readFileSync(path.join(home, 'yarn.log'), 'utf8').trim().split('\n');
    assert.equal(installs.length, 6);
    for (let index = 0; index < installs.length; index += 2) {
      const [start, end] = installs.slice(index, index + 2);
      assert.match(start, /^start /, installs.join('\n'));
      assert.equal(end, start.replace('start', 'end'), installs.join('\n'));
    }
    const live = fs.readlinkSync(path.join(home, '.local/bin/farmslot'));
    assert.ok(fs.existsSync(live), `the farmslot link dangles: ${live}`);
    assert.deepEqual(
      fs.readdirSync(root).filter((name) => name.startsWith('.lock')),
      [],
      'the lock and the reap mutex are released',
    );
  }
});

test('deploy-node stops the hung CLI when the bash -lc verify times out', async (t) => {
  const fixture = cliFixture(t, { tmuxServer: false });
  fixture.write('home/cli-hangs', '');
  const pidFile = path.join(fixture.home, 'cli-hang.pid');
  let pid = 0;
  const alive = () => {
    if (!pid) return false;
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  };
  const waitForExit = async (ms) => {
    for (let waited = 0; alive() && waited < ms; waited += 50)
      await new Promise((resolve) => setTimeout(resolve, 50));
  };
  // The test owns the fake CLI it starts: should the deploy's cleanup regress,
  // stop it here (TERM, then KILL) rather than leave it running past the runner.
  t.after(async () => {
    if (!alive()) return;
    process.kill(pid, 'SIGTERM');
    await waitForExit(500);
    if (alive()) process.kill(pid, 'SIGKILL');
  });
  try {
    assert.throws(
      () => fixture.deploy({ env: { CLI_VERIFY_TIMEOUT_SECONDS: '1' } }),
      (error) => {
        assert.match(String(error.stderr), /the worker-shell verify did not finish within 1 s/);
        return true;
      },
    );
  } finally {
    // Read before any after hook removes the fixture.
    if (fs.existsSync(pidFile)) pid = Number(fs.readFileSync(pidFile, 'utf8'));
  }
  assert.ok(pid > 0, 'the fake CLI started and recorded its pid');
  await waitForExit(2000);
  assert.equal(alive(), false, `the probe's CLI (pid ${pid}) outlived the deploy`);
});

// A global Yarn 1 first on the node's PATH (asdf or `npm -g yarn`, setup-node on
// CI) has no `workspaces focus`. The install must reach the repo's pinned Yarn
// through corepack, or stop with the fix.
const YARN_CLASSIC =
  '#!/bin/sh\n[ "$1" != --version ] || { echo 1.22.22; exit 0; }\n' +
  '[ "$1" = workspaces ] || exit 0\n' +
  'echo "yarn workspaces v1.22.22"; echo \'error Invalid subcommand. Try "info, run"\'; exit 1\n';

test('deploy-node installs with the pinned Yarn through corepack when a Yarn 1 comes first', (t) => {
  const fixture = cliFixture(t);
  fixture.write('node-bin/yarn', YARN_CLASSIC, true);

  fixture.deploy();

  assert.match(fixture.snapshotInstalls().join('\n'), / via=corepack$/);
  assert.ok(fs.existsSync(path.join(fixture.snapshot, 'DEPLOYED-REVISION.json')));
});

test('deploy-node fails with the fix when the node has only a Yarn 1 and no corepack', (t) => {
  const fixture = cliFixture(t);
  fixture.write('node-bin/yarn', YARN_CLASSIC, true);
  fs.rmSync(path.join(fixture.root, 'node-bin/corepack'));
  assert.throws(fixture.deploy, (error) => {
    const stderr = String(error.stderr);
    assert.match(stderr, /needs the repo's pinned Yarn, but 'yarn --version' .* gives '1\.22\.22'/);
    assert.match(
      stderr,
      /fix: run 'corepack enable' with the node the service uses \(.*node-bin\/node\)/,
    );
    assert.doesNotMatch(`${error.stdout}${stderr}`, /Invalid subcommand/);
    return true;
  });
  assert.equal(fs.existsSync(fixture.snapshot), false);
  assert.deepEqual(fixture.snapshotInstalls(), []);
});
