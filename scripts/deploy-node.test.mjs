import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// The deploy installs the node CLI from a committed revision of its checkout.
const commitFixture = (root) => {
  const git = (...args) =>
    execFileSync(
      'git',
      ['-c', 'user.name=fixture', '-c', 'user.email=fixture@example.com', ...args],
      {
        cwd: root,
        stdio: 'ignore',
      },
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
      test(`deploy-node renders ${platform} service with native=${native}, capture=${captureMode}`, () => {
        const root = fs.mkdtempSync(path.join(os.tmpdir(), 'node-deploy-render-'));
        try {
          const write = (relative, content, executable = false) => {
            const target = path.join(root, relative);
            fs.mkdirSync(path.dirname(target), { recursive: true });
            fs.writeFileSync(target, content, { mode: executable ? 0o700 : 0o600 });
          };
          write(
            'scripts/deploy-node.sh',
            fs.readFileSync(path.join(repo, 'scripts/deploy-node.sh')),
          );
          write(
            'services/node/package.json',
            fs.readFileSync(path.join(repo, 'services/node/package.json')),
          );
          for (const name of ['protocol', 'capabilities', 'agent-runtime']) {
            write(
              `packages/${name}/package.json`,
              fs.readFileSync(path.join(repo, 'packages', name, 'package.json')),
            );
            fs.mkdirSync(path.join(root, 'packages', name, 'dist'));
          }
          write('node-token', 'fixture-node-credential');
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
            CAPTURE_HELPER_PATH:
              captureMode === 'override' ? '/opt/qa & helpers/capture-helper' : '',
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
                [
                  '-c',
                  'import shlex,json,sys; print(json.dumps(shlex.split(sys.argv[1])))',
                  command,
                ],
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
            assert.ok(args[2].startsWith(`exec ${env.FARMSLOT_NODE_PATH} --require `));
            assert.ok(servicePath.includes('/home/node-validation/.npm-global/bin'));
          } else {
            assert.equal(args[0], env.FARMSLOT_NODE_PATH);
            assert.equal(args[1], '--require');
            assert.equal(args.length, 6);
          }
        } finally {
          fs.rmSync(root, { recursive: true, force: true });
        }
      });
    }
  }
}

// The node imports agent-runtime's dist, and dist/native/review-sandbox.js
// requires ../../scripts/review-filesystem.cjs, so a dist-only copy crashes every
// deployed node at boot with MODULE_NOT_FOUND. The stub captures rsync argv
// instead of exiting 0 silently, which is the only way to see what a deploy ships.
test("deploy-node syncs a bundled package's scripts/ and bin/ beside dist/ and skips packages without them", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'node-deploy-rsync-'));
  try {
    const write = (relative, content, executable = false) => {
      const target = path.join(root, relative);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, content, { mode: executable ? 0o700 : 0o600 });
    };
    write('scripts/deploy-node.sh', fs.readFileSync(path.join(repo, 'scripts/deploy-node.sh')));
    write(
      'services/node/package.json',
      fs.readFileSync(path.join(repo, 'services/node/package.json')),
    );
    for (const name of ['protocol', 'capabilities', 'agent-runtime']) {
      write(
        `packages/${name}/package.json`,
        fs.readFileSync(path.join(repo, 'packages', name, 'package.json')),
      );
      fs.mkdirSync(path.join(root, 'packages', name, 'dist'), { recursive: true });
    }
    // Only agent-runtime publishes scripts/ and bin/; protocol publishes neither,
    // so it must issue no such rsync.
    write('packages/agent-runtime/scripts/review-filesystem.cjs', 'module.exports = {};\n');
    write('packages/agent-runtime/bin/farmslot-agent.mjs', '#!/usr/bin/env node\n', true);
    write('node-token', 'fixture-node-credential');
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
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// Workers run the `farmslot` on their PATH, so a node deploy that skipped the CLI
// left worker-side fixes on whatever revision the CLI was last installed at. The
// ssh stub runs each remote command locally with HOME at a temp directory: the
// snapshot, its links and the worker-shell verify are real files and processes.
const cliFixture = () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'node-deploy-cli-'));
  const home = path.join(root, 'home');
  const write = (relative, content, executable = false) => {
    const target = path.join(root, relative);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, content, { mode: executable ? 0o755 : 0o644 });
  };
  write('scripts/deploy-node.sh', fs.readFileSync(path.join(repo, 'scripts/deploy-node.sh')));
  write(
    'services/node/package.json',
    fs.readFileSync(path.join(repo, 'services/node/package.json')),
  );
  for (const name of ['protocol', 'capabilities', 'agent-runtime']) {
    write(
      `packages/${name}/package.json`,
      fs.readFileSync(path.join(repo, 'packages', name, 'package.json')),
    );
    fs.mkdirSync(path.join(root, 'packages', name, 'dist'), { recursive: true });
  }
  // Records how each worker-shell invocation saw its environment.
  write(
    'packages/cli/bin/farmslot.mjs',
    `#!/usr/bin/env node
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
if (process.argv[2] === '--version') console.log('0.0.0-fixture');
else if (fs.existsSync(path.join(home, 'gateway-down'))) { console.error('gateway unreachable'); process.exit(1); }
else console.log('{}');
`,
    true,
  );
  commitFixture(root);
  write('node-token', 'fixture-node-credential');
  write(
    'bin/ssh',
    '#!/bin/sh\nwhile [ "$1" = -o ]; do shift 2; done\nshift\nexec bash -c "$*"\n',
    true,
  );
  write('bin/uname', '#!/bin/sh\necho Linux\n', true);
  write('bin/yarn', '#!/bin/sh\necho "$PWD $*" >> "$HOME/yarn.log"\n', true);
  for (const command of ['rsync', 'systemctl', 'sleep'])
    write(`bin/${command}`, '#!/bin/sh\nexit 0\n', true);
  // The node user's login profile puts install.sh's link dir on PATH.
  write(
    'home/.bash_profile',
    `export PATH="$HOME/.local/bin:${path.dirname(process.execPath)}:$PATH"\n`,
  );
  const sha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
  const snapshot = path.join(home, '.local/share/farmslot-cli', sha);
  return {
    root,
    home,
    sha,
    snapshot,
    entry: path.join(snapshot, 'packages/cli/bin/farmslot.mjs'),
    deploy: (instance = 'prod', machine = 'fixture-machine', ...extraArgs) => {
      const env = {
        ...process.env,
        PATH: `${root}/bin:${process.env.PATH}`,
        HOME: home,
        SHELL: '/bin/bash',
        ASDF_DATA_DIR: '',
        GATEWAY_PORT: '',
        FARMSLOT_NODE_PATH: process.execPath,
        FARMSLOT_NATIVE_OWNER_PRINCIPAL_ID: '',
        FARMSLOT_GATEWAY_TOKEN: 'fixture-operator-secret',
      };
      // A tmux worker's login shell has no FARMSLOT_HOME of its own.
      delete env.FARMSLOT_HOME;
      return execFileSync(
        'bash',
        [
          path.join(root, 'scripts/deploy-node.sh'),
          machine,
          '127.0.0.1',
          '--instance',
          instance,
          '--node-token-file',
          path.join(root, 'node-token'),
          ...extraArgs,
        ],
        {
          env,
          cwd: root,
          encoding: 'utf8',
          stdio: ['ignore', 'pipe', 'pipe'],
          timeout: 60000,
        },
      );
    },
    calls: () =>
      fs
        .readFileSync(path.join(home, 'cli-calls.jsonl'), 'utf8')
        .split('\n')
        .filter(Boolean)
        .map((line) => JSON.parse(line)),
    snapshotInstalls: () =>
      fs
        .readFileSync(path.join(home, 'yarn.log'), 'utf8')
        .split('\n')
        .filter((line) => line === `${snapshot} install --immutable`).length,
  };
};

for (const instance of ['prod', 'dev']) {
  test(`deploy-node installs the deployed revision as the node CLI and verifies it from a worker shell (${instance})`, () => {
    const fixture = cliFixture();
    try {
      // macpro-style: npm-global link into a git checkout with local changes.
      const checkoutCli = path.join(fixture.home, 'dev/farmslot/packages/cli/bin/farmslot.mjs');
      fs.mkdirSync(path.dirname(checkoutCli), { recursive: true });
      fs.writeFileSync(checkoutCli, '// operator checkout\n');
      fs.mkdirSync(path.join(fixture.home, '.npm-global/bin'), { recursive: true });
      fs.symlinkSync(checkoutCli, path.join(fixture.home, '.npm-global/bin/farmslot'));

      const first = fixture.deploy(instance);
      assert.match(first, /installing node CLI snapshot/);
      assert.match(
        first,
        /\.npm-global\/bin\/farmslot \(was .*dev\/farmslot\/packages\/cli\/bin\/farmslot\.mjs\)/,
      );
      const archive = execFileSync('git', ['archive', '--format=tar', fixture.sha], {
        cwd: fixture.root,
        maxBuffer: 64 * 1024 * 1024,
      });
      assert.deepEqual(
        JSON.parse(fs.readFileSync(path.join(fixture.snapshot, 'DEPLOYED-REVISION.json'), 'utf8')),
        { sha: fixture.sha, sha256: crypto.createHash('sha256').update(archive).digest('hex') },
      );
      assert.equal(fixture.snapshotInstalls(), 1);
      for (const link of ['.local/bin/farmslot', '.npm-global/bin/farmslot'])
        assert.equal(fs.readlinkSync(path.join(fixture.home, link)), fixture.entry, link);
      assert.equal(fs.readFileSync(checkoutCli, 'utf8'), '// operator checkout\n');

      const expected = {
        script: fs.realpathSync(fixture.entry),
        gwUrl: `ws://127.0.0.1:${instance === 'dev' ? 7801 : 7777}`,
        // Tmux workers keep the login shell's FARMSLOT_HOME for both instances.
        farmslotHome: null,
        credentials: [],
      };
      assert.deepEqual(fixture.calls(), [
        { argv: ['--version'], ...expected },
        { argv: ['rpc', 'gateway.status'], ...expected },
      ]);

      // Re-deploying the same revision reuses the snapshot and leaves the links.
      const second = fixture.deploy(instance);
      assert.match(second, /node CLI snapshot [0-9a-f]+ already installed/);
      assert.doesNotMatch(second, / → .*\/bin\/farmslot/);
      assert.equal(fixture.snapshotInstalls(), 1);
      assert.equal(fixture.calls().length, 4);
    } finally {
      fs.rmSync(fixture.root, { recursive: true, force: true });
    }
  });
}

// On a local deploy the CLI on PATH is the operator's own, so the deploy leaves
// it alone unless asked. MACHINE matching `hostname -s` selects local mode.
test('deploy-node leaves the CLI as is on a local deploy unless --refresh-cli is passed', () => {
  const fixture = cliFixture();
  try {
    const local = execFileSync('hostname', ['-s'], { encoding: 'utf8' }).trim();
    const operatorCli = path.join(fixture.home, 'farmslot/packages/cli/bin/farmslot.mjs');
    const link = path.join(fixture.home, '.local/bin/farmslot');
    fs.mkdirSync(path.dirname(operatorCli), { recursive: true });
    fs.writeFileSync(operatorCli, '// operator checkout\n');
    fs.mkdirSync(path.dirname(link), { recursive: true });
    fs.symlinkSync(operatorCli, link);

    const skipped = fixture.deploy('prod', local);
    assert.match(
      skipped,
      /local deploy: node CLI left as is; pass --refresh-cli to install the deployed revision/,
    );
    assert.equal(fs.readlinkSync(link), operatorCli);
    assert.equal(fs.existsSync(fixture.snapshot), false);
    assert.equal(fs.existsSync(path.join(fixture.home, 'cli-calls.jsonl')), false);

    const refreshed = fixture.deploy('prod', local, '--refresh-cli');
    assert.match(refreshed, /installing node CLI snapshot/);
    assert.equal(fs.readlinkSync(link), fixture.entry);
    assert.equal(fixture.snapshotInstalls(), 1);
    assert.deepEqual(
      fixture.calls().map((call) => call.argv),
      [['--version'], ['rpc', 'gateway.status']],
    );
  } finally {
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
});

test('deploy-node fails loudly with the fix when a worker shell cannot reach the gateway', () => {
  const fixture = cliFixture();
  try {
    fs.mkdirSync(fixture.home, { recursive: true });
    fs.writeFileSync(path.join(fixture.home, 'gateway-down'), '');
    assert.throws(fixture.deploy, (error) => {
      assert.notEqual(error.status, 0);
      const stderr = String(error.stderr);
      assert.match(stderr, /farmslot rpc gateway\.status failed against ws:\/\/127\.0\.0\.1:7777/);
      assert.match(
        stderr,
        /farmslot gateway add <name> ws:\/\/127\.0\.0\.1:7777 && farmslot login <name>/,
      );
      assert.match(stderr, /workers on fixture-machine cannot use the deployed farmslot CLI/);
      assert.doesNotMatch(
        `${error.stdout}${stderr}`,
        /fixture-operator-secret|fixture-node-credential/,
      );
      return true;
    });
  } finally {
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
});

test('deploy-node fails when an asdf shim shadows the deployed CLI on the worker PATH', () => {
  const fixture = cliFixture();
  try {
    const shim = path.join(fixture.home, '.asdf/shims/farmslot');
    fs.mkdirSync(path.dirname(shim), { recursive: true });
    fs.writeFileSync(shim, '#!/bin/sh\necho stale\n', { mode: 0o755 });
    assert.throws(fixture.deploy, (error) => {
      assert.match(
        String(error.stderr),
        new RegExp(`farmslot on the worker PATH is ${shim}, not the deployed ${fixture.entry}`),
      );
      return true;
    });
  } finally {
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
});
