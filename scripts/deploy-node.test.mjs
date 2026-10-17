import assert from 'node:assert/strict';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import test, { after } from 'node:test';
import { fileURLToPath } from 'node:url';

import ts from 'typescript';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// Both the platform matrix and owner cases read generated plists on Linux CI.
const readRenderedPlist = (file) =>
  JSON.parse(
    execFileSync(
      'python3',
      [
        '-c',
        'import plistlib,json,sys; print(json.dumps(plistlib.load(open(sys.argv[1],"rb"))))',
        file,
      ],
      { encoding: 'utf8' },
    ),
  );

// A checkout copy holding the deploy script, the worker prefix it reads, and
// the workspace packages the node bundles. It is removed when its scope (a test,
// or the file for a shared one) ends, however that ends.
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
    'scripts/build-dist-atomic.mjs',
    'scripts/lib/worker-env-prefix.sh',
    'scripts/lib/tmux-bin.sh',
    'scripts/lib/node-cli-refresh.sh',
    'services/node/package.json',
  ])
    write(relative, fs.readFileSync(path.join(repo, relative)));
  // Built dist/ and its atomic builds stay out of git, as in the checkout.
  write(
    '.gitignore',
    fs
      .readFileSync(path.join(repo, '.gitignore'), 'utf8')
      .split('\n')
      .filter((line) => line.startsWith('packages/*/'))
      .join('\n'),
  );
  for (const name of [
    'protocol',
    'capabilities',
    'agent-runtime',
    'slot-config',
    'adapter-sdk',
    'recipe-runner',
  ]) {
    write(
      `packages/${name}/package.json`,
      fs.readFileSync(path.join(repo, 'packages', name, 'package.json')),
    );
    fs.mkdirSync(path.join(root, 'packages', name, 'dist'), { recursive: true });
  }
  write(
    'packages/protocol/dist/node/slot-by-repo.js',
    ts.transpileModule(
      fs.readFileSync(path.join(repo, 'packages/protocol/src/node/slot-by-repo.ts'), 'utf8'),
      {
        compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
      },
    ).outputText,
  );
  write('node-token', 'fixture-node-credential');
  // tsc for the atomic dist builds: logs the package it builds and emits the current dist
  // (plus a BUILT stamp) into the requested outDir.
  write('bin/tsc-stub.cjs', FAKE_TSC);
  write('bin/tsc', '#!/bin/sh\nexec node "$(dirname "$0")/tsc-stub.cjs" "$@"\n', true);
  return { root, write };
};

const FAKE_TSC = `const fs = require('node:fs');
const path = require('node:path');
const args = process.argv.slice(2);
const home = process.env.FAKE_TSC_HOME || process.env.HOME;
fs.appendFileSync(path.join(home, 'tsc.log'), path.basename(process.cwd()) + '\\n');
if (fs.existsSync(path.join(home, 'tsc-fails'))) process.exit(1);
const out = args[args.indexOf('--outDir') + 1];
if (fs.existsSync('dist')) fs.cpSync('dist', out, { recursive: true, dereference: true });
else fs.mkdirSync(out, { recursive: true });
fs.writeFileSync(path.join(out, 'BUILT'), String(process.hrtime.bigint()));
`;

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

// Removed once the file's tests are done: fixtures that several tests share.
const fileCleanups = [];
after(() => {
  for (const cleanup of fileCleanups) cleanup();
});
const fileScope = { after: (cleanup) => fileCleanups.push(cleanup) };

// ssh [-o option]... host command: keep the documents the deploy streams over
// stdin and answer its remote probes for the platform and capture mode under test.
const RENDER_SSH = `#!/bin/bash
while [ "$1" = -o ]; do shift 2; done
shift
command="$*"
IFS= read -r -d '' body
case $body in
  '<?xml'*) printf '%s' "$body" > "$RENDER_ROOT/service.plist" ;;
  '[Unit]'*) printf '%s' "$body" > "$RENDER_ROOT/service.unit" ;;
  *) [[ $command != */package.json ]] || printf '%s' "$body" > "$RENDER_ROOT/standalone-package.json" ;;
esac
case $command in
  'uname -s') echo "$RENDER_OS" ;;
  'echo $HOME') echo /home/node-validation ;;
  'id -u') echo 501 ;;
  *'SHELL:-/bin/sh'*) if [ "$RENDER_OS" = Darwin ]; then echo /bin/zsh; else echo /bin/bash; fi ;;
  *'which yarn'*) echo no ;;
  'test -d '*) exit 1 ;;
  'test -f '*.plist*) [[ $RENDER_CAPTURE_MODE =~ ^(retained|missing-key|corrupt)$ ]] ;;
  '/usr/bin/plutil -extract EnvironmentVariables.FARMSLOT_NATIVE_OWNER_PRINCIPAL_ID '*)
    printf '%s\n' "$command" >> "$RENDER_ROOT/native-owner-probes"
    [ -n "$RENDER_NATIVE_OWNER" ] || exit 1
    [[ $command == *' -o /dev/null '* ]] || printf '%s\n' "$RENDER_NATIVE_OWNER"
    ;;
  '/usr/bin/plutil -lint '*) [ "$RENDER_CAPTURE_MODE" != corrupt ] ;;
  '/usr/bin/plutil -extract '*) [ "$RENDER_CAPTURE_MODE" = retained ] && echo /opt/homebrew/bin/capture-helper ;;
esac
`;

// The deploy only reads its checkout, so the render cases share one, built by
// the first case to run; each case renders into its own directory.
const renderCheckouts = new Map();
const sharedRenderCheckout = (nativeOwnerDefault) => {
  if (renderCheckouts.has(nativeOwnerDefault)) return renderCheckouts.get(nativeOwnerDefault);
  const { root, write } = deployFixture(fileScope, 'node-deploy-render-');
  write('bin/ssh', RENDER_SSH, true);
  // These succeed doing nothing, as the bare binary: no shell to start per call.
  for (const command of ['rsync', 'yarn', 'sleep'])
    fs.symlinkSync('/usr/bin/true', path.join(root, 'bin', command));
  if (nativeOwnerDefault !== undefined)
    write('.env.local-auth', `FARMSLOT_NATIVE_OWNER_PRINCIPAL_ID=${nativeOwnerDefault}\n`);
  commitFixture(root);
  renderCheckouts.set(nativeOwnerDefault, root);
  return root;
};

// Execute the actual deployment script with remote side effects replaced by command stubs.
// This proves generated service documents, not remote installation or runner execution.
for (const platform of ['Darwin', 'Linux']) {
  for (const native of [false, true]) {
    for (const captureMode of platform === 'Darwin'
      ? ['bundled', 'retained', 'override', 'missing-key', 'corrupt']
      : ['bundled']) {
      test(`deploy-node renders ${platform} service with native=${native}, capture=${captureMode}`, (t) => {
        const root = sharedRenderCheckout();
        const output = fs.mkdtempSync(path.join(os.tmpdir(), 'node-deploy-render-out-'));
        t.after(() => fs.rmSync(output, { recursive: true, force: true }));
        const env = {
          ...process.env,
          PATH: `${root}/bin:${process.env.PATH}`,
          RENDER_ROOT: output,
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
          assert.equal(fs.existsSync(path.join(output, 'service.plist')), false);
          return;
        }
        deploy();
        let args;
        let servicePath;
        if (platform === 'Darwin') {
          const document = readRenderedPlist(path.join(output, 'service.plist'));
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
          const unit = fs.readFileSync(path.join(output, 'service.unit'), 'utf8');
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
          fs.readFileSync(path.join(output, 'standalone-package.json'), 'utf8'),
        );
        assert.equal(
          standalone.dependencies['@siteed/capture-helper'],
          platform === 'Darwin' ? '^0.2.6' : undefined,
          'macOS nodes bundle capture-helper at the supported floor; Linux nodes bundle none',
        );
        for (const name of ['adapter-sdk', 'recipe-runner']) {
          const pkg = JSON.parse(
            fs.readFileSync(path.join(repo, 'packages', name, 'package.json'), 'utf8'),
          );
          for (const [dependency, version] of Object.entries(pkg.dependencies))
            if (!dependency.startsWith('@farmslot/'))
              assert.equal(
                standalone.dependencies[dependency],
                dependency === '@noble/hashes' ? '1.4.0' : version,
                dependency,
              );
        }
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
  // The task-helper copy of agent-runtime ships without dist/ or the atomic builds beside it.
  assert.match(
    invocations.find((line) => line.endsWith(`${remote}/packages/agent-runtime/`)) ?? '',
    / --exclude dist --exclude \.dist-\* /,
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
      '  [ ! -f "$HOME/yarn-edits-lock" ] || echo "# resolved anew" >> yarn.lock ;;\n' +
      'workspace\\ @farmslot/recipe-cli\\ build)\n' +
      '  [ ! -f "$HOME/build-fails" ] || { echo "fixture build failure"; exit 1; } ;;\nesac\n',
    true,
  );
  write(
    'bin/tmux',
    `#!/bin/sh
if [ -f "$HOME/tmux-unresponsive" ] && [ "$(cat "$HOME/tmux-unresponsive")" = "$1" ]; then
  echo $$ > "$HOME/tmux-unresponsive.pid"
  exec node -e 'setInterval(() => {}, 60000)'
fi
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
  fs.symlinkSync('/usr/bin/true', path.join(root, 'bin/rsync'));
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
    tscBuilds: () => read('tsc.log'),
    systemctl: () => read('systemctl.log'),
    tmuxLaunches: () => read('tmux.log'),
    tmuxKills: () => read('tmux-kills.log'),
    snapshotInstalls: () => read('yarn.log').filter((line) => line.includes(' workspaces focus ')),
    snapshotBuilds: () =>
      read('yarn.log').filter((line) => line.includes(' workspace @farmslot/recipe-cli build')),
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

    // Every dist-shipping package was built atomically: protocol's dist/ holds the new build, still
    // a real directory, with nothing left beside it.
    assert.ok(fixture.tscBuilds().includes('protocol'));
    const protocol = path.join(fixture.root, 'packages/protocol');
    assert.ok(fs.lstatSync(path.join(protocol, 'dist')).isDirectory());
    assert.ok(fs.existsSync(path.join(protocol, 'dist/BUILT')));
    assert.ok(fs.existsSync(path.join(protocol, 'dist/node/slot-by-repo.js')));
    assert.deepEqual(
      fs.readdirSync(protocol).filter((entry) => entry.startsWith('.dist-')),
      [],
    );

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
    // Plain-node task tooling imports dist/, so the packages are built in place, after the install.
    assert.deepEqual(fixture.snapshotBuilds(), [
      installs[0].replace(
        / workspaces focus @farmslot\/cli immutable=1 /,
        ' workspace @farmslot/recipe-cli build immutable= ',
      ),
    ]);
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
  assert.equal(fixture.snapshotBuilds().length, 0);
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

// The gateway machine's dev stack runs its own node, so a full local deploy there
// would start a second one: --cli-only refreshes the CLI without the node service.
// A remote CLI refresh needs no node token either: the service is never touched.
for (const [where, machine] of [
  ['local', localMachine],
  ['remote', () => 'fixture-machine'],
]) {
  test(`deploy-node --cli-only installs the ${where} CLI and leaves the node service alone`, (t) => {
    const fixture = cliFixture(t);
    link(
      fixture,
      '.local/bin/farmslot',
      path.join(fixture.home, 'farmslot/packages/cli/bin/farmslot.mjs'),
    );

    const output = fixture.deploy({
      machine: machine(),
      args: ['--cli-only'],
      nodeTokenFile: false,
    });

    assert.match(output, /installing node CLI snapshot/);
    assert.doesNotMatch(output, /Update: bash scripts\/deploy-node\.sh/);
    assert.equal(fs.readlinkSync(path.join(fixture.home, '.local/bin/farmslot')), fixture.entry);
    assert.deepEqual(
      fixture.calls().map((call) => call.argv),
      [['--version'], ['rpc', 'gateway.status']],
    );
    assert.deepEqual(fixture.systemctl(), []);
    // No node bundle ships, and the protocol dist the CLI stage reads is present: nothing builds.
    assert.deepEqual(fixture.tscBuilds(), []);
  });
}

test('deploy-node --cli-only builds only the protocol dist, and only when it is missing', (t) => {
  const fixture = cliFixture(t);
  fs.rmSync(path.join(fixture.root, 'packages/protocol/dist/node/slot-by-repo.js'));

  fixture.deploy({ machine: 'fixture-machine', args: ['--cli-only'], nodeTokenFile: false });

  assert.deepEqual(fixture.tscBuilds(), ['protocol']);
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
// old ~/farmslot-node/.env) left nodes failing auth after a deploy
// that reported success.
test('deploy-node fails before the service is reloaded when an env file shadows the node token', (t) => {
  const fixture = cliFixture(t);
  const file = path.join(fixture.home, 'farmslot-node/.env');
  fixture.write('home/farmslot-node/.env', 'FARMSLOT_NODE_TOKEN=stale-file-credential\n');
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
  fixture.write('home/farmslot-node/.env', 'FARMSLOT_NODE_TOKEN=fixture-node-credential\n');

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
  fixture.write('home/decoy/.env', 'FARMSLOT_NODE_TOKEN=fixture-node-credential\n');
  fixture.write(
    'home/.bash_profile',
    'echo "login banner from the profile"\nexport FARMSLOT_ROOT="$HOME/decoy"\n',
  );
  fixture.write('home/farmslot-node/.env', 'FARMSLOT_NODE_TOKEN=stale-file-credential\n');
  assert.throws(
    () => fixture.deploy({ env: { FARMSLOT_NATIVE_OWNER_PRINCIPAL_ID: 'fixture-owner' } }),
    (error) => {
      assert.equal(error.status, 1);
      assert.match(String(error.stdout), /login banner from the profile/);
      const stderr = String(error.stderr);
      assert.ok(
        stderr.includes(
          `[deploy] ERROR: ${fs.realpathSync(path.join(fixture.home, 'farmslot-node/.env'))} sets FARMSLOT_NODE_TOKEN`,
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

// Without --node-token-file the service uses only an explicit node credential.
for (const [held, deploys] of [
  ['fixture-node-credential', true],
  ['different-node-credential', false],
]) {
  test(`deploy-node checks a node-token-only deploy against that token (${deploys ? 'matching' : 'differing'} file)`, (t) => {
    const fixture = cliFixture(t);
    fixture.write('home/farmslot-node/.env', `FARMSLOT_NODE_TOKEN=${held}\n`);
    const deploy = () =>
      fixture.deploy({
        machine: localMachine(),
        nodeTokenFile: false,
        env: { FARMSLOT_NODE_TOKEN: 'fixture-node-credential' },
      });
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
  fixture.write('home/farmslot-node/.env', 'FARMSLOT_NODE_TOKEN=file-credential\n');

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
          `FARMSLOT_HOME=.+ farmslot gateway add <name> ws://127\\.0\\.0\\.1:${port} && FARMSLOT_HOME=.+ farmslot login <name>`,
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

test('deploy-node keeps the log and installs nothing when building the CLI packages fails', (t) => {
  const fixture = cliFixture(t);
  fixture.write('home/build-fails', '');
  assert.throws(fixture.deploy, (error) => {
    assert.match(
      String(error.stderr),
      /building the node CLI's packages failed; full log: .*\.yarn-install\.log/,
    );
    return true;
  });
  assert.deepEqual(fs.readdirSync(fixture.cliRoot), [`${fixture.sha}.yarn-install.log`]);
  assert.match(
    fs.readFileSync(path.join(fixture.cliRoot, `${fixture.sha}.yarn-install.log`), 'utf8'),
    /fixture build failure/,
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

// The node-side refresh script, run straight from the CLI stage deploy-node.sh sources: contenders
// started together over a lock left by a dead holder must take it one at a
// time. Each installs its own revision; the fake yarn brackets the install.
test('node CLI refreshes started together over a stale lock never overlap', async (t) => {
  const refresh = /CLI_REFRESH=\$\(cat << 'REFRESH'\n([\s\S]*?)\nREFRESH\n/.exec(
    fs.readFileSync(path.join(repo, 'scripts/lib/node-cli-refresh.sh'), 'utf8'),
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
    // Each contender's focused install and package build run whole under the lock.
    const installs = fs.readFileSync(path.join(home, 'yarn.log'), 'utf8').trim().split('\n');
    assert.equal(installs.length, 12);
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

for (const [name, explicit, expected, instance, authDefault, captureMode = 'retained'] of [
  ['retained prod', undefined, 'retained-owner', 'prod'],
  [
    'never source checkout auth',
    undefined,
    undefined,
    'dev',
    '$(touch "$RENDER_ROOT/legacy-auth-sourced")',
    'bundled',
  ],
  ['retained dev', undefined, 'retained-owner', 'dev'],
  ['explicit replacement', 'new-owner', 'new-owner', 'dev'],
  ['explicit disable', '', undefined, 'dev'],
  ['retained prod over auth default', undefined, 'retained-owner', 'prod', 'stale-owner'],
  ['retained dev over auth default', undefined, 'retained-owner', 'dev', 'stale-owner'],
  ['explicit replacement over auth default', 'new-owner', 'new-owner', 'dev', 'stale-owner'],
  ['explicit disable over auth default', '', undefined, 'dev', 'stale-owner'],
  ['ignore auth default on first install', undefined, undefined, 'dev', 'default-owner', 'bundled'],
  [
    'ignore auth default without prior owner',
    undefined,
    undefined,
    'dev',
    'default-owner',
    'missing-key',
  ],
]) {
  test(`deploy-node preserves existing native enrollment: ${name}`, (t) => {
    const root = sharedRenderCheckout(authDefault);
    const output = fs.mkdtempSync(path.join(os.tmpdir(), 'node-deploy-native-owner-'));
    t.after(() => fs.rmSync(output, { recursive: true, force: true }));
    const env = {
      ...process.env,
      PATH: `${root}/bin:${process.env.PATH}`,
      RENDER_ROOT: output,
      RENDER_OS: 'Darwin',
      RENDER_CAPTURE_MODE: captureMode,
      RENDER_NATIVE_OWNER: captureMode === 'retained' ? 'retained-owner' : '',
      FARMSLOT_NODE_PATH: '/opt/node/bin/node',
      FARMSLOT_NODE_INSTANCE: instance,
      CAPTURE_HELPER_PATH: '',
    };
    if (explicit === undefined) delete env.FARMSLOT_NATIVE_OWNER_PRINCIPAL_ID;
    else env.FARMSLOT_NATIVE_OWNER_PRINCIPAL_ID = explicit;
    execFileSync(
      'bash',
      [
        path.join(root, 'scripts/deploy-node.sh'),
        'fixture-machine',
        '127.0.0.1',
        '--node-token-file',
        path.join(root, 'node-token'),
      ],
      { cwd: root, env, stdio: 'pipe' },
    );
    const document = readRenderedPlist(path.join(output, 'service.plist'));
    assert.equal(document.EnvironmentVariables.FARMSLOT_NATIVE_OWNER_PRINCIPAL_ID, expected);
    assert.equal(fs.existsSync(path.join(output, 'legacy-auth-sourced')), false);
    assert.equal(document.ProgramArguments[1] === '-lc', Boolean(expected));
    const probes = path.join(output, 'native-owner-probes');
    if (explicit === undefined && captureMode !== 'bundled') {
      const query = fs.readFileSync(probes, 'utf8');
      assert.ok(query.includes(`com.farmslot.node${instance === 'dev' ? '.dev' : ''}.plist`));
    } else assert.equal(fs.existsSync(probes), false);
  });
}

for (const tmuxServer of [true, false]) {
  test(`deploy-node honors the pool worker profile home (${tmuxServer ? 'tmux' : 'login shell'})`, (t) => {
    const fixture = cliFixture(t, { tmuxServer });
    fixture.write('bin/sleep', '#!/bin/sh\nexec /bin/sleep "$@"\n', true);
    const serviceHome = path.join(fixture.home, "service profiles' literal-$value");
    fixture.write(
      'pool/z-configured-worker.json',
      JSON.stringify({
        machine: 'fixture-machine',
        env: { FARMSLOT_HOME: serviceHome },
      }),
    );
    fixture.write(
      'pool/example.json',
      JSON.stringify({
        machine: 'fixture-machine',
        env: { FARMSLOT_HOME: 'ignored-example' },
      }),
    );
    link(fixture, '.local/bin/farmslot', seedSnapshot(fixture, fixture.sha));
    const script = fs.readFileSync(
      path.join(fixture.root, 'scripts/lib/node-cli-refresh.sh'),
      'utf8',
    );
    const start = script.indexOf('  # Verify the way a tmux slot worker runs:');
    const endMarker = script.indexOf('\nVERIFY\n', start);
    const end = script.indexOf('\n  fi\n', endMarker) + '\n  fi\n'.length;
    assert(start >= 0 && endMarker > start && end > endMarker);
    const env = {
      HOME: fixture.home,
      PATH: `${fixture.root}/bin:${fixture.root}/node-bin:/usr/bin:/bin:/usr/sbin:/sbin`,
      REPO_ROOT: fixture.root,
      SCRIPT_DIR: path.join(fixture.root, 'scripts'),
      MACHINE: 'fixture-machine',
      CLI_ENTRY: fixture.entry,
      NODE_PATH: path.join(fixture.root, 'node-bin/node'),
      NODE_GATEWAY_URL: 'ws://127.0.0.1:7777',
      INSTANCE: 'prod',
      CLI_VERIFY_TIMEOUT_SECONDS: '5',
      FARMSLOT_NODE_TOKEN: 'fixture-node-credential',
      FARMSLOT_GATEWAY_TOKEN: 'fixture-control-credential',
    };
    execFileSync(
      'bash',
      ['-c', 'set -euo pipefail\nrun() { eval "$@"; }\n' + script.slice(start, end)],
      {
        env,
        cwd: fixture.root,
        stdio: 'pipe',
        timeout: 10_000,
      },
    );
    const calls = fixture.calls();
    assert.deepEqual(
      calls.map(({ argv }) => argv),
      [['--version'], ['rpc', 'gateway.status']],
    );
    for (const call of calls) {
      assert.equal(
        call.farmslotHome,
        serviceHome,
        'verification must use the configured worker profile store',
      );
      assert.deepEqual(
        call.credentials,
        [],
        'node and inherited gateway credentials must remain absent',
      );
    }
  });
}

for (const phase of ['list-sessions', 'new-session', 'kill-session', 'success']) {
  test(
    phase === 'success'
      ? 'worker verify clears earlier dev health failure after successful verification'
      : `worker verify bounds an unresponsive tmux ${phase} client and reports dev health`,
    async (t) => {
      const fixture = cliFixture(t);
      fixture.write('home/tmux-unresponsive', phase);
      const entry = seedSnapshot(fixture, fixture.sha);
      link(fixture, '.local/bin/farmslot', entry);
      const script = fs.readFileSync(path.join(repo, 'scripts/lib/node-cli-refresh.sh'), 'utf8');
      const verify = /<< 'VERIFY'\n([\s\S]*?)\nVERIFY\n/.exec(script)[1];
      const healthFile = path.join(fixture.home, '.farmslot-dev/node-worker-cli-health.json');
      fixture.write(
        'home/.farmslot-dev/node-worker-cli-health.json',
        JSON.stringify({
          ok: false,
          checkedAt: new Date().toISOString(),
          reason: 'earlier failure',
        }),
      );
      const env = {
        ...process.env,
        HOME: fixture.home,
        ASDF_DATA_DIR: '',
        PATH: `${fixture.root}/bin:${fixture.root}/node-bin:/usr/bin:/bin:/usr/sbin:/sbin`,
      };
      for (const key of ['FARMSLOT_HOME', 'BASH_ENV', 'ZDOTDIR', 'TMUX', 'TMUX_PANE'])
        delete env[key];
      const child = spawn(
        'bash',
        [
          '-s',
          entry,
          'ws://127.0.0.1:7801',
          fs.readFileSync(path.join(repo, 'scripts/lib/worker-env-prefix.sh'), 'utf8').trimEnd(),
          fs.readFileSync(path.join(repo, 'scripts/lib/tmux-bin.sh'), 'utf8'),
          '1',
          'dev',
          '',
          path.join(fixture.root, 'node-bin/node'),
          'fixture-machine',
          healthFile,
        ],
        {
          detached: true,
          env,
          stdio: ['pipe', 'pipe', 'pipe'],
        },
      );
      const stop = () => {
        if (!child.pid) return;
        try {
          process.kill(-child.pid, 'SIGKILL');
        } catch (error) {
          if (error.code !== 'ESRCH') throw error;
        } // Only this owned fixture group.
      };
      t.after(stop);
      // A failure ceiling, not a wait: removing the production bound cannot hang the test.
      const ceiling = setTimeout(stop, 3_000);
      let stdout = '';
      let stderr = '';
      child.stdout.on('data', (chunk) => {
        stdout += chunk;
      });
      child.stderr.on('data', (chunk) => {
        stderr += chunk;
      });
      try {
        const finished = new Promise((resolve, reject) => {
          child.once('error', reject);
          child.once('close', (code) => resolve(code));
        });
        child.stdin.end(verify);
        assert.equal(await finished, phase === 'success' ? 0 : 1, stderr);
      } finally {
        clearTimeout(ceiling);
      }
      if (phase !== 'success') assert.match(stderr, /tmux server unresponsive on fixture-machine/);
      assert.doesNotMatch(stdout, /no tmux server running/);
      const health = JSON.parse(fs.readFileSync(healthFile, 'utf8'));
      assert.equal(health.ok, phase === 'success');
      assert.equal(
        health.reason,
        phase === 'success' ? undefined : 'tmux server unresponsive on fixture-machine',
      );
      assert(Number.isFinite(Date.parse(health.checkedAt)));
      if (phase !== 'success') {
        const client = Number(
          fs.readFileSync(path.join(fixture.home, 'tmux-unresponsive.pid'), 'utf8'),
        );
        assert.throws(
          () => process.kill(client, 0),
          { code: 'ESRCH' },
          'timed-out client was reaped',
        );
      }
    },
  );
}

// build-dist-atomic exchanges a package's dist/ with its new build in one rename, so a process
// importing it from a live checkout never finds dist/ missing mid-build.
const atomicFixture = (t) => {
  const { buildDistAtomic } = atomicModule;
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'build-dist-atomic-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const write = (relative, content) => {
    fs.mkdirSync(path.dirname(path.join(root, relative)), { recursive: true });
    fs.writeFileSync(path.join(root, relative), content);
  };
  const plain = 'rm -rf dist && tsc --project tsconfig.json';
  write(
    'packages/a/package.json',
    JSON.stringify({ name: '@fixture/a', main: 'dist/index.js', scripts: { build: plain } }),
  );
  write(
    'packages/b/package.json',
    JSON.stringify({
      name: '@fixture/b',
      main: 'dist/index.js',
      dependencies: { '@fixture/a': 'workspace:*' },
      scripts: { build: `yarn workspace @fixture/a build && ${plain}` },
    }),
  );
  write('packages/a/dist/BUILT', 'legacy');
  write('bin/tsc-stub.cjs', FAKE_TSC);
  write('bin/tsc', '#!/bin/sh\nexec node "$(dirname "$0")/tsc-stub.cjs" "$@"\n');
  fs.chmodSync(path.join(root, 'bin/tsc'), 0o755);
  const saved = { PATH: process.env.PATH, FAKE_TSC_HOME: process.env.FAKE_TSC_HOME };
  process.env.PATH = `${path.join(root, 'bin')}${path.delimiter}${process.env.PATH}`;
  process.env.FAKE_TSC_HOME = root;
  t.after(() => {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });
  const dir = path.join(root, 'packages/a');
  const build = (...names) => buildDistAtomic(root, names, () => {});
  const builds = () => fs.readFileSync(path.join(root, 'tsc.log'), 'utf8').trim().split('\n');
  const built = () => fs.readFileSync(path.join(dir, 'dist/BUILT'), 'utf8');
  const leftovers = () => fs.readdirSync(dir).filter((entry) => entry.startsWith('.dist-'));
  return { root, dir, build, builds, built, leftovers };
};
const atomicModule = await import(path.join(repo, 'scripts/build-dist-atomic.mjs'));

test('build-dist-atomic builds dependencies first and replaces dist/ in place', (t) => {
  const f = atomicFixture(t);
  f.build('@fixture/b', '@fixture/a');
  assert.deepEqual(f.builds(), ['a', 'b']);
  // Like `yarn workspace @fixture/b build`, building b alone also builds the a it chains.
  f.build('@fixture/b');
  assert.deepEqual(f.builds(), ['a', 'b', 'a', 'b']);
  // dist/ stays a real directory (packing and the gateway refuse a linked one) with the new build.
  const before = f.built();
  f.build('@fixture/a');
  assert.ok(fs.lstatSync(path.join(f.dir, 'dist')).isDirectory());
  assert.notEqual(f.built(), before);
  assert.deepEqual(f.leftovers(), []);
});

test('build-dist-atomic leaves dist/ as it was when a build fails', (t) => {
  const f = atomicFixture(t);
  f.build('@fixture/a');
  const before = f.built();
  fs.writeFileSync(path.join(f.root, 'tsc-fails'), '');
  assert.throws(() => f.build('@fixture/a'), /build failed; its dist\/ is unchanged/);
  assert.equal(f.built(), before);
  // The failed build's partial output is gone.
  assert.deepEqual(f.leftovers(), []);
});

test('build-dist-atomic exchanges the new build with dist/ in one step', (t) => {
  const f = atomicFixture(t);
  fs.mkdirSync(path.join(f.dir, '.dist-build-next'));
  fs.writeFileSync(path.join(f.dir, '.dist-build-next/BUILT'), 'next');
  assert.equal(atomicModule.switchDist(f.dir, '.dist-build-next'), 'exchanged');
  assert.equal(f.built(), 'next');
  assert.deepEqual(f.leftovers(), []);
});

test('build-dist-atomic moves the build into place where dist/ cannot be exchanged', (t) => {
  const f = atomicFixture(t);
  fs.mkdirSync(path.join(f.dir, '.dist-build-next'));
  fs.writeFileSync(path.join(f.dir, '.dist-build-next/BUILT'), 'next');
  assert.match(
    atomicModule.switchDist(f.dir, '.dist-build-next', () => 'unsupported'),
    /no exchange: unsupported/,
  );
  assert.equal(f.built(), 'next');
  assert.deepEqual(f.leftovers(), []);
});

test('build-dist-atomic spares a build another run is still compiling', (t) => {
  const f = atomicFixture(t);
  // Another run's compile in progress, and one a crash left behind two hours ago.
  fs.mkdirSync(path.join(f.dir, '.dist-build-running'));
  fs.mkdirSync(path.join(f.dir, '.dist-build-crashed'));
  const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000);
  fs.utimesSync(path.join(f.dir, '.dist-build-crashed'), twoHoursAgo, twoHoursAgo);
  f.build('@fixture/a');
  assert.deepEqual(f.leftovers(), ['.dist-build-running']);
});

test('build-dist-atomic reads only plain tsc build scripts', () => {
  const { parseBuild } = atomicModule;
  assert.deepEqual(parseBuild('rm -rf dist && tsc --project tsconfig.build.json'), {
    chain: [],
    tsconfig: 'tsconfig.build.json',
  });
  assert.deepEqual(
    parseBuild('yarn workspace x build && yarn workspace y build && tsc --project tsconfig.json'),
    { chain: ['x', 'y'], tsconfig: 'tsconfig.json' },
  );
  assert.equal(parseBuild('tsc --project tsconfig.json && node copy-assets.mjs'), null);
  assert.equal(parseBuild('node codegen.mjs && tsc --project tsconfig.json'), null);
  assert.equal(parseBuild(undefined), null);
});

const READER = `const fs = require('node:fs');
const [file, stop, ready] = process.argv.slice(2);
let reads = 0;
let misses = 0;
fs.writeFileSync(ready, '');
const tick = () => {
  if (fs.existsSync(stop)) {
    process.stdout.write(JSON.stringify({ reads, misses }));
    return;
  }
  try {
    fs.readFileSync(file);
    reads++;
  } catch {
    misses++;
  }
  setImmediate(tick);
};
tick();
`;

// Reads `file` in a child process, as fast as it can, while `rebuild` runs.
async function readWhile(t, root, file, rebuild) {
  const stop = path.join(root, 'reader-stop');
  const ready = path.join(root, 'reader-ready');
  fs.rmSync(stop, { force: true });
  fs.rmSync(ready, { force: true });
  fs.writeFileSync(path.join(root, 'reader.cjs'), READER);
  const reader = spawn(process.execPath, [path.join(root, 'reader.cjs'), file, stop, ready]);
  t.after(() => reader.kill());
  let out = '';
  reader.stdout.on('data', (chunk) => (out += chunk));
  const exited = new Promise((resolve) => reader.on('exit', resolve));
  const deadline = Date.now() + 5000;
  while (!fs.existsSync(ready)) {
    if (Date.now() > deadline) throw new Error('the reader did not start within 5 s');
    await new Promise((r) => setTimeout(r, 5));
  }
  try {
    rebuild();
  } finally {
    fs.writeFileSync(stop, '');
  }
  await exited;
  return JSON.parse(out);
}

test('a reader never finds dist/ missing while it is rebuilt atomically', async (t) => {
  const f = atomicFixture(t);
  const file = path.join(f.dir, 'dist/BUILT');
  const atomic = await readWhile(t, f.root, file, () => {
    for (let i = 0; i < 10; i++) f.build('@fixture/a');
  });
  assert.ok(atomic.reads > 0);
  assert.equal(atomic.misses, 0);
  // The reader does see the gap a remove-then-write rebuild leaves.
  const dist = path.join(f.dir, 'dist');
  const plain = await readWhile(t, f.root, file, () => {
    for (let i = 0; i < 10; i++) {
      fs.rmSync(dist, { recursive: true, force: true });
      execFileSync('sleep', ['0.01']);
      fs.mkdirSync(dist);
      fs.writeFileSync(path.join(dist, 'BUILT'), String(i));
    }
  });
  assert.ok(plain.misses > 0);
});
