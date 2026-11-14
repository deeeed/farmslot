import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test, { type TestContext } from 'node:test';
import { fileURLToPath } from 'node:url';

import { runnerLaunchDir } from '../../../../scripts/lib/runner-runtime.cjs';
import { redactCommandCredentials } from '../core/credential-redaction.js';

import { buildBlindGitCommand, withBlindTrialBoundary } from './blind-git.js';

interface CapsuleProfileRules {
  profile: string;
  aliases: Record<string, string[]>;
}

function generatedProfile(
  t: TestContext,
  slotResourcePorts: Record<string, number> = {},
  invalidProfiles?: string,
) {
  const root = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'seatbelt-unit-')));
  t.after(() => rmSync(root, { recursive: true }));
  mkdirSync(path.join(root, 'boundary'));
  const home = path.join(root, 'boundary/home');
  mkdirSync(home);
  mkdirSync(path.join(root, 'credentials'));
  symlinkSync(path.join(root, 'credentials'), path.join(home, '.ssh'));
  const store = path.join(home, 'farmslot-node/node_modules/fixture-private');
  mkdirSync(store, { recursive: true });
  symlinkSync(store, path.join(home, '.farmslot-automation'));
  const installed = path.join(root, 'external-control/node');
  mkdirSync(installed, { recursive: true });
  symlinkSync(installed, path.join(home, 'farmslot-node-dev'));
  const gatewayFiles = [
    ...[
      '.farmslot',
      '.farmslot-dev/config',
      '.farmslot-automation',
      '../selected-home',
      '../selected-config',
    ].flatMap((directory) =>
      [
        'gateways.json',
        'credentials.json',
        'provider-accounts.json',
        'active-provider-accounts.json',
        'node.secret',
        'providers.env',
      ].map((name) => path.resolve(home, directory, name)),
    ),
    path.join(home, '.farmslot-automation/fixture-node-automation.secret'),
    path.join(home, 'Library/LaunchAgents/com.farmslot.node.dev.plist'),
    path.join(home, '.config/systemd/user/farmslot-node-dev.service'),
    path.join(home, 'farmslot-node/.env'),
    path.join(home, 'farmslot-node-dev/.env.ports'),
    path.join(root, 'external-control/.env'),
  ];
  for (const file of gatewayFiles) {
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, 'synthetic credential only');
  }
  const browserDirs = [
    'Google/Chrome',
    'Google/Chrome Beta',
    'Google/Chrome Canary',
    'Google/Chrome Dev',
    'Chromium',
    'Google/Chrome for Testing',
  ].map((name) => path.join(home, 'Library/Application Support', name));
  browserDirs.push(
    path.join(home, '.chrome-farmslot-9323'),
    path.join(home, '.chrome-farmslot-19323'),
    path.join(root, 'operator-debug'),
  );
  for (const directory of browserDirs) mkdirSync(directory, { recursive: true });
  symlinkSync(path.join(root, 'operator-debug'), path.join(home, '.chrome-farmslot-alias'));
  // Startup files are links into a dotfiles checkout, as on farm hosts.
  mkdirSync(path.join(root, 'dotfiles'));
  mkdirSync(path.join(home, '.config/secrets'), { recursive: true });
  for (const name of ['zshenv', 'zshrc']) {
    writeFileSync(path.join(root, 'dotfiles', name), 'export FAKE_SECRET=fixture-value\n');
    symlinkSync(path.join(root, 'dotfiles', name), path.join(home, `.${name}`));
  }
  // Each home/config must contribute, rather than only the selected/active profile.
  const profileFiles = gatewayFiles.filter((file) => path.basename(file) === 'gateways.json');
  for (const [index, file] of profileFiles.entries())
    writeFileSync(
      file,
      JSON.stringify({
        gateways: {
          inactive: {
            url: 'ws://unresolved.example.invalid:' + (17801 + index),
            secret: 'synthetic-only',
          },
          secure: { url: 'wss://example.invalid' },
          plain: { url: 'ws://example.invalid' },
        },
      }),
    );
  if (invalidProfiles !== undefined) writeFileSync(profileFiles[0], invalidProfiles);
  writeFileSync(path.join(root, 'state.json'), '{"originalIsDirectory":true}');
  const result = spawnSync(
    'python3',
    [
      '-c',
      `
import json, os, pathlib, runpy, sys
from unittest.mock import patch
blind = runpy.run_path(sys.argv[1], run_name='fixture')
with patch.dict(os.environ, {'HOME': sys.argv[2] + '/boundary/home', 'FARMSLOT_HOME': sys.argv[2] + '/boundary/selected-home', 'FARMSLOT_CONFIG_DIR': sys.argv[2] + '/boundary/selected-config', 'GATEWAY_URL': 'ws://[::1]:17901', 'GW_URL': 'ws://node.local:17902', 'FARMSLOT_GATEWAY': 'wss://node.local:17903', 'GATEWAY_PORT': '17904', 'FARMSLOT_GATEWAY_TLS_PORT': '17905', 'FARMSLOT_CDP_PORT': '19323', 'FARMSLOT_CDP_PROFILE': sys.argv[2] + '/operator-debug', 'TMUX_TMPDIR': '/tmp/fixture-tmux', 'TMUX': '/tmp/fixture-inherited/server,123,0'}, clear=True):
    print(blind['sandbox_profile']({'repo': sys.argv[2], 'slotResourcePorts': json.loads(sys.argv[3])}, pathlib.Path(sys.argv[2]), ['/tmp/fixture-discovered/server']))
`,
      fileURLToPath(new URL('./blind-git.py', import.meta.url)),
      root,
      JSON.stringify(slotResourcePorts),
    ],
    { encoding: 'utf8', timeout: 4500 },
  );
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stderr);
  return { root, home, profile: result.stdout, warnings: result.stderr, gatewayFiles, browserDirs };
}

test('blind profile denies every configured gateway port on every address and operator CDP', (t) => {
  const { profile, gatewayFiles } = generatedProfile(t);
  const ports = [
    7777,
    7778,
    7801,
    8808,
    8809,
    9323,
    19323,
    17901,
    17902,
    17903,
    17904,
    17905,
    ...gatewayFiles
      .filter((file) => path.basename(file) === 'gateways.json')
      .map((_, index) => 17801 + index),
  ];
  for (const port of ports)
    assert.ok(profile.includes('(remote tcp "*:' + port + '")'), 'missing denied port ' + port);
  assert.ok(!profile.includes('synthetic-only'));
  for (const port of [5174, 8081, 9222])
    assert.ok(!profile.includes('(remote tcp "*:' + port + '")'));
});

test('blind profile protects operator browser stores and aliases after read exceptions', (t) => {
  const { profile, browserDirs } = generatedProfile(t);
  for (const directory of browserDirs) {
    const rule = '(deny file-read* (subpath ' + JSON.stringify(directory) + '))';
    assert.ok(profile.includes(rule), directory);
    assert.ok(profile.indexOf(rule) > profile.lastIndexOf('(allow file-read*'));
    assert.ok(profile.includes('(literal ' + JSON.stringify(path.dirname(directory)) + ')'));
  }
});

test('slot CDP is denied even without an operator profile on that port', (t) => {
  const { profile } = generatedProfile(t, { cdp_port: 19222 });
  assert.ok(profile.includes('(remote tcp "*:9323")'));
  assert.ok(profile.includes('(remote tcp "*:19323")'));
  assert.ok(profile.includes('(remote tcp "*:19222")'));
});

test('shared gateway ports stay open with actionable profile diagnostics and no credentials', (t) => {
  const { profile, warnings } = generatedProfile(t);
  for (const port of [80, 443]) {
    assert.ok(!profile.includes('(remote tcp "*:' + port + '")'));
    assert.match(
      warnings,
      new RegExp('profile "' + (port === 443 ? 'secure' : 'plain') + '".*' + port),
    );
  }
  assert.match(warnings, /credential hiding.*dedicated gateway port/u);
  assert.doesNotMatch(warnings, /synthetic-only|example.invalid/u);
});

test('denied gateway ports warn when they collide with any configured slot resource', (t) => {
  const { profile, warnings } = generatedProfile(t, {
    cdp_port: 7777,
    metro_port: 17801,
    port: 8081,
  });
  for (const port of [7777, 17801]) assert.ok(profile.includes('(remote tcp "*:' + port + '")'));
  assert.match(warnings, /gateway port 7777.*slot resource "cdp_port".*distinct port/u);
  assert.match(warnings, /gateway port 17801.*slot resource "metro_port".*distinct port/u);
  assert.doesNotMatch(warnings, /slot resource "port"/u);
});

test('malformed gateway discovery fails closed without exposing credential bytes', (t) => {
  for (const input of [
    '{"secret":"synthetic-secret-do-not-print",',
    '{"gateways":{"bad":{"url":"ws://host:invalid","secret":"synthetic-secret-do-not-print"}}}',
  ]) {
    assert.throws(
      () => generatedProfile(t, undefined, input),
      (error) => {
        assert.ok(error instanceof Error);
        assert.match(
          error.message,
          /(?:Cannot discover gateway endpoints|Invalid gateway endpoint)/u,
        );
        assert.doesNotMatch(error.message, /synthetic-secret-do-not-print/u);
        return true;
      },
    );
  }
});

test('blind profile denies gateway credentials after all runtime exceptions, including resolved aliases and rename guards', (t) => {
  const { profile, gatewayFiles } = generatedProfile(t);
  for (const file of gatewayFiles) {
    for (const alias of new Set([file, realpathSync(file)])) {
      for (const operation of ['file-read*', 'file-write*']) {
        const rule = `(deny ${operation} (subpath ${JSON.stringify(alias)}))`;
        assert.ok(profile.includes(rule), alias);
        assert.ok(profile.indexOf(rule) > profile.lastIndexOf('(allow file-read*'));
      }
      assert.ok(profile.includes(`(literal ${JSON.stringify(path.dirname(alias))})`), alias);
    }
  }
});

test('blind profile denies shell startup and secret files, including resolved dotfile targets, after read exceptions', (t) => {
  const { root, home, profile } = generatedProfile(t);
  const files = [
    ...[
      '.zshenv',
      '.zshrc',
      '.zprofile',
      '.zlogin',
      '.bashrc',
      '.bash_profile',
      '.profile',
      '.config/secrets',
      '.netrc',
      '.npmrc',
      '.pypirc',
      '.docker/config.json',
    ].map((name) => path.join(home, name)),
    path.join(root, 'dotfiles/zshenv'),
    path.join(root, 'dotfiles/zshrc'),
    path.join(root, '.agent/.launch'),
  ];
  for (const file of files)
    for (const operation of ['file-read*', 'file-write*']) {
      const rule = `(deny ${operation} (subpath ${JSON.stringify(file)}))`;
      assert.ok(profile.includes(rule), file);
      assert.ok(profile.indexOf(rule) > profile.lastIndexOf('(allow file-read*'), file);
      assert.ok(profile.indexOf(rule) > profile.lastIndexOf('(allow file-write*'), file);
    }
  // Moving the dotfiles checkout must not carry the startup file out of the denial.
  assert.ok(profile.includes(`(literal ${JSON.stringify(path.join(root, 'dotfiles'))})`));
});

test('blind profile denies outbound Unix sockets except the system DNS endpoint', (t) => {
  const { profile } = generatedProfile(t);
  for (const prefix of ['/tmp', '/private/tmp']) {
    for (const directory of [
      `tmux-${process.getuid!()}`,
      `fixture-tmux/tmux-${process.getuid!()}`,
    ]) {
      assert.ok(
        profile.includes(`(remote unix-socket (subpath "${prefix}/${directory}"))`),
        profile,
      );
    }
    for (const socket of ['fixture-inherited/server', 'fixture-discovered/server']) {
      assert.ok(profile.includes(`(remote unix-socket (literal "${prefix}/${socket}"))`), profile);
    }
  }
  assert.ok(profile.includes('(deny network-outbound (remote unix-socket)'), profile);
  // /var/run resolves through /private on macOS and /run on Ubuntu.
  const resolverPaths = new Set([
    '/var/run/mDNSResponder',
    '/private/var/run/mDNSResponder',
    path.join(realpathSync('/var/run'), 'mDNSResponder'),
  ]);
  assert.equal(
    profile.split('\n').find((line) => line.startsWith('(allow network-outbound')),
    `(allow network-outbound ${[...resolverPaths]
      .sort()
      .map((socket) => `(remote unix-socket (literal "${socket}"))`)
      .join(' ')})`,
  );
  assert.equal(profile.split('(allow network-outbound').length, 2);
});

test('blind profile blocks SSH and remote shell TCP, SSH executables and credential paths', (t) => {
  const { root, home, profile } = generatedProfile(t);
  // Wildcard addresses also cover localhost DNS, IPv6 and other 127/8 aliases.
  for (const port of [22, 512, 513, 514])
    assert.ok(profile.includes(`(remote tcp "*:${port}")`), profile);
  assert.match(profile, /\(deny network-outbound \(remote tcp/u);
  for (const executable of ['ssh', 'scp', 'sftp'])
    assert.ok(profile.includes(`(literal "/usr/bin/${executable}")`), profile);
  assert.match(profile, /\(deny process-exec /u);
  for (const directory of [path.join(home, '.ssh'), path.join(root, 'credentials')]) {
    const rule = `(deny file-read* (subpath ${JSON.stringify(directory)}))`;
    assert.ok(profile.includes(rule), profile);
    assert.ok(profile.indexOf(rule) > profile.indexOf('(allow file-read*'), profile);
  }
});

test('broker regex paths match metacharacters literally and use only validated physical aliases', (t) => {
  const root = realpathSync(mkdtempSync('/tmp/seatbelt-regex-'));
  t.after(() => rmSync(root, { recursive: true }));
  const result = spawnSync(
    'python3',
    [
      '-c',
      `
import os, pathlib, runpy, sys
from unittest.mock import patch
blind = runpy.run_path(sys.argv[1], run_name='fixture')
root = pathlib.Path(sys.argv[2])
capsule = root / '.farmslot-blind-evals/slot/run-epoch'
(capsule / 'boundary').mkdir(parents=True)
(capsule / 'state.json').write_text('{"originalIsDirectory":true}')
temporary = root / 'allocated.+([x])^$|?*{2}\\\\dir"'
temporary.mkdir()
(capsule / 'boundary/tmp').symlink_to(temporary)
with patch.dict(os.environ, {'HOME': str(root)}, clear=True), \\
     patch.dict(blind['sandbox_profile'].__globals__, {'worker_temp': lambda capsule: temporary}):
    print(blind['sandbox_profile']({'repo': str(root)}, capsule, [], []))
`,
      fileURLToPath(new URL('./blind-git.py', import.meta.url)),
      root,
    ],
    { encoding: 'utf8', timeout: 4500 },
  );
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stderr);
  const prefix = '(allow network-outbound (remote unix-socket (regex ';
  const suffix = ')))';
  const rules = result.stdout.split('\n').filter((line) => line.startsWith(prefix));
  const physical = path.join(root, 'allocated.+([x])^$|?*{2}\\dir"/broker');
  const aliases = new Set([
    physical,
    physical.startsWith('/private') ? physical.slice(8) : '/private' + physical,
  ]);
  assert.equal(rules.length, aliases.size);
  for (const rule of rules) {
    // An ordinary SBPL string decodes JSON escapes before regex compilation.
    const pattern: string = JSON.parse(rule.slice(prefix.length, -suffix.length));
    const regex = new RegExp(pattern);
    const alias = [...aliases].find((value) => regex.test(value + '/own.sock'));
    assert.ok(alias, pattern);
    assert.ok(pattern.includes(String.raw`allocated\.\+\(\[x\]\)\^\$\|\?\*\{2\}\\dir"/broker`));
    for (const target of [
      alias.replace('allocated.', 'allocated_') + '/own.sock',
      alias.replace('+', '') + '/own.sock',
      alias + '/nested/own.sock',
      alias + '/own.sock/extra',
      alias + '-other/own.sock',
    ])
      assert.equal(regex.test(target), false, target);
    assert.equal(
      regex.test(
        path.join(root, '.farmslot-blind-evals/slot/run-epoch/boundary/tmp/broker/own.sock'),
      ),
      false,
    );
    if (process.platform === 'darwin' && alias === physical) {
      // Compile the generated expression with Seatbelt, including quotes and
      // backslashes, and prove a lookalike path does not match its denial.
      for (const [target, denied] of [
        [physical + '/own.sock', true],
        [physical.replace('allocated.', 'allocated_') + '/own.sock', false],
        [physical.replace('+', '') + '/own.sock', false],
        [physical + '/nested/own.sock', false],
      ] as const) {
        mkdirSync(path.dirname(target), { recursive: true });
        writeFileSync(target, 'synthetic');
        const probe = spawnSync(
          '/usr/bin/sandbox-exec',
          [
            '-p',
            `(version 1)(allow default)(deny file-read-data (regex ${JSON.stringify(pattern)}))`,
            '/bin/cat',
            target,
          ],
          { encoding: 'utf8', timeout: 1000 },
        );
        assert.ifError(probe.error);
        assert.equal(probe.status, denied ? 1 : 0, probe.stderr);
        if (denied) assert.match(probe.stderr, /Operation not permitted/u);
      }
    }
  }
});

test('blind profile hides boundary and node internals after runtime read exceptions', (t) => {
  const { root, home, profile } = generatedProfile(t);
  for (const installation of ['farmslot-node', 'farmslot-node-dev']) {
    const directory = path.join(home, installation);
    assert.ok(profile.includes(`(deny file-read* (subpath ${JSON.stringify(directory)}))`));
    for (const ancestor of [directory, path.join(directory, 'packages')])
      assert.ok(
        profile.includes(`(allow file-read-metadata (literal ${JSON.stringify(ancestor)}))`),
      );
    for (const runtime of ['support', 'node_modules', 'packages/agent-runtime']) {
      const rule = `(allow file-read* (subpath ${JSON.stringify(path.join(directory, runtime))}))`;
      assert.ok(profile.includes(rule));
    }
  }
  for (const file of [
    path.join(home, '.pi/agent/settings.json'),
    path.join(root, 'boundary/sandbox.sb'),
  ]) {
    const rule = `(deny file-read* (subpath ${JSON.stringify(file)}))`;
    assert.ok(profile.includes(rule));
    assert.ok(profile.indexOf(rule) > profile.lastIndexOf('(allow file-read*'));
  }
  assert.ok(profile.includes('/blind-git[.](py|ts|js)$'));
  assert.ok(profile.includes('(deny file-write-unlink '));
  for (const file of [path.join(home, '.ssh'), path.join(root, 'boundary/sandbox.sb')])
    assert.ok(profile.includes(`(deny file-write* (subpath ${JSON.stringify(file)}))`));
});

test('blind profile denies capsule writes and links after checkout allowances, with narrow log exceptions', (t) => {
  const root = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'capsule-profile-')));
  t.after(() => rmSync(root, { recursive: true }));
  const result = spawnSync(
    'python3',
    [
      '-c',
      `
import json, os, pathlib, runpy, sys
from unittest.mock import patch
blind = runpy.run_path(sys.argv[1], run_name='fixture')
root = pathlib.Path(sys.argv[2])
capsules = root / '.farmslot-blind-evals'
capsule = capsules / 'slot/run-epoch'
capsule.mkdir(parents=True)
(capsule / 'state.json').write_text('{"originalIsDirectory":true}')
link = root / 'capsule-link'
link.symlink_to(capsule)
with patch.dict(os.environ, {'HOME': str(root)}, clear=True):
    print(json.dumps({'profile': blind['sandbox_profile']({'repo': str(root / 'checkout'), 'siblingRepos': [str(root / 'other/checkout')]}, link, [], []),
                      'aliases': {str(p): blind['path_aliases'](p) for p in [capsules, capsule, link, root / 'other/.farmslot-blind-evals']}}))
`,
      fileURLToPath(new URL('./blind-git.py', import.meta.url)),
      root,
    ],
    { encoding: 'utf8', timeout: 4500 },
  );
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stderr);
  const { profile, aliases }: CapsuleProfileRules = JSON.parse(result.stdout);
  const checkoutRule = `(allow file-write* (subpath ${JSON.stringify(path.join(root, 'checkout'))}))`;
  const logRules = ['attempts.log', 'git-trace.jsonl'].map(
    (name) =>
      `(allow file-write* (literal ${JSON.stringify(path.join(root, '.farmslot-blind-evals/slot/run-epoch/boundary', name))}))`,
  );
  for (const paths of Object.values(aliases))
    for (const alias of paths) {
      const rule = `(deny file-write* file-link (subpath ${JSON.stringify(alias)}))`;
      // The explicit capsule link and the inferred trees must both be protected.
      assert.ok(profile.includes(rule), rule);
      assert.ok(profile.indexOf(rule) > profile.indexOf(checkoutRule));
      for (const logRule of logRules) assert.ok(profile.indexOf(logRule) > profile.indexOf(rule));
      const parent = path.dirname(alias);
      assert.ok(profile.includes(`(literal ${JSON.stringify(parent)})`), parent);
    }
  for (const rule of logRules) assert.ok(profile.includes(rule), rule);
  if (root.startsWith('/private/var/'))
    assert.ok(
      Object.values(aliases)
        .flat()
        .some((alias) => alias.startsWith('/var/')),
    );
});

test('blind browser allocation skips protected and assigned ports and stays stable', (t) => {
  const root = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'blind-cdp-unit-')));
  t.after(() => rmSync(root, { recursive: true }));
  mkdirSync(path.join(root, 'home'));
  writeFileSync(path.join(root, 'state.json'), '{"originalIsDirectory":true}');
  const result = spawnSync(
    'python3',
    [
      '-c',
      `
import json, os, pathlib, runpy, sys
from unittest.mock import patch, Mock
blind = runpy.run_path(sys.argv[1], run_name='fixture')
root = pathlib.Path(sys.argv[2])
spec = {'repo': str(root), 'slotResourcePorts': {'cdp_port': 19222},
        'launchDirs': [str(root / '.farmslot-runtime/repo/.agent/.launch')]}
temporary = root / 'temporary'
temporary.mkdir()
globals = blind['prepare_boundary'].__globals__
probe = Mock()
probe.__enter__ = Mock(return_value=probe)
probe.__exit__ = Mock(return_value=False)
probe.getsockname.side_effect = [('127.0.0.1', p) for p in [7777, 19222, 19444]]
with patch.dict(os.environ, {'HOME': str(root / 'home')}, clear=True), \
     patch.dict(globals, {'require_sandbox': lambda: None, 'live_tmux_sockets': lambda: [], 'worker_temp': lambda capsule: temporary}), \
     patch('tempfile.mkdtemp', return_value=str(temporary)), \
     patch('socket.socket', return_value=probe) as sockets, \
     patch('subprocess.run', return_value=Mock(returncode=0)):
    assert blind['prepare_boundary'](spec, root) == 19444
    assert blind['prepare_boundary'](spec, root) == 19444
    assert sockets.call_count == 3
    spec['slotResourcePorts']['cdp_port'] = 19444
    try:
        blind['prepare_boundary'](spec, root)
    except RuntimeError as error:
        assert 'overlaps a protected endpoint' in str(error)
    else:
        raise AssertionError('retained endpoint collision must fail closed')
`,
      fileURLToPath(new URL('./blind-git.py', import.meta.url)),
      root,
    ],
    { encoding: 'utf8', timeout: 4500 },
  );
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stderr);
});

test('blind boundary strips gateway credentials, routing, tmux and SSH agent variables, keeps tools and pane identity', (t) => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'seatbelt-env-'));
  t.after(() => rmSync(root, { recursive: true }));
  mkdirSync(path.join(root, 'boundary'));
  const temporary = path.join(root, 'temporary');
  mkdirSync(temporary);
  symlinkSync(temporary, path.join(root, 'boundary/tmp'));
  const command = withBlindTrialBoundary(
    'env',
    {
      capsule: root,
      baseSha: 'a'.repeat(40),
      browserCdpPort: 19444,
    },
    ['OPENAI_API_KEY'],
  );
  // Inspect the shell setup on every platform without launching a real sandbox.
  const setup = command.slice(0, command.indexOf('/usr/bin/sandbox-exec'));
  const worker = spawnSync('/bin/sh', ['-c', `${setup} env`], {
    encoding: 'utf8',
    env: {
      PATH: process.env.PATH,
      FARMSLOT_BLIND_CDP_PORT: '19222',
      CDP_PORT: '19222',
      RECIPE_CDP_PORT: '19222',
      TMUX: '/fixture/socket,1,0',
      TMUX_TMPDIR: '/fixture',
      TMUX_PANE: '%42',
      SSH_AUTH_SOCK: '/fixture/agent.sock',
      SSH_AGENT_PID: '123',
      FARMSLOT_NODE_TOKEN: 'synthetic-node',
      FARMSLOT_GATEWAY_TOKEN: 'synthetic-admin',
      FARMSLOT_GATEWAY_PASSWORD: 'synthetic-password',
      GW_URL: 'ws://127.0.0.1:1',
      GATEWAY_URL: 'ws://127.0.0.1:1',
      FARMSLOT_GATEWAY: 'ws://127.0.0.1:1',
      FARMSLOT_GATEWAY_PROFILE: 'synthetic-profile',
      FARMSLOT_HOME: '/synthetic/tools-home',
      FARMSLOT_TASK_DIR: '/synthetic/task',
      OPENAI_API_KEY: 'synthetic-provider',
      ZDOTDIR: '/synthetic/operator-zdotdir',
      BASH_ENV: '/synthetic/operator-bashrc',
      ENV: '/synthetic/operator-profile',
    },
    timeout: 4500,
  });
  assert.equal(worker.status, 0, worker.stderr);
  for (const name of ['TMPDIR', 'TMP', 'TEMP', 'MAC_CHROMIUM_TMPDIR'])
    assert.ok(worker.stdout.includes(`${name}=${temporary}\n`));
  assert.ok(worker.stdout.includes(`FARMSLOT_BLIND_BROKER_DIR=${temporary}/broker\n`));
  assert.doesNotMatch(worker.stdout, /^TMUX(?:_TMPDIR)?=/mu);
  assert.doesNotMatch(worker.stdout, /^SSH_(?:AUTH_SOCK|AGENT_PID)=/mu);
  assert.doesNotMatch(
    worker.stdout,
    /^(?:FARMSLOT_(?:NODE_TOKEN|GATEWAY(?:_TOKEN|_PASSWORD|_PROFILE)?)|GW_URL|GATEWAY_URL)=/mu,
  );
  assert.match(worker.stdout, /^FARMSLOT_HOME=\/synthetic\/tools-home$/mu);
  assert.match(worker.stdout, /^FARMSLOT_TASK_DIR=\/synthetic\/task$/mu);
  assert.match(worker.stdout, /^OPENAI_API_KEY=synthetic-provider$/mu);
  assert.match(worker.stdout, /^TMUX_PANE=%42$/mu);
  assert.match(worker.stdout, /^FARMSLOT_BLIND_SEATBELT=1$/mu);
  assert.match(worker.stdout, /^RECIPE_CDP_PORT=19444$/mu);
  assert.match(worker.stdout, /^CDP_PORT=19444$/mu);
  assert.match(worker.stdout, /^FARMSLOT_BLIND_CDP_PORT=19444$/mu);
  assert.match(worker.stdout, /^FARMSLOT_CI_BASE_REF=a{40}$/mu);
  assert.ok(worker.stdout.includes(`ZDOTDIR=${root}/boundary/shell\n`));
  assert.doesNotMatch(worker.stdout, /^(?:BASH_ENV|ENV)=/mu);
});

test('blind profile denies system ps execution, including aliases', (t) => {
  const { profile } = generatedProfile(t);
  assert.match(profile, /^\(deny process-exec \(literal "\/bin\/ps"\)/mu);
});

test('boundary ps refuses environment output in every option form and passes other calls through', (t) => {
  const root = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'blind-ps-')));
  t.after(() => rmSync(root, { recursive: true }));
  const real = path.join(root, 'real-ps');
  writeFileSync(real, '#!/bin/sh\necho "RAN $COMMAND_MODE $*"\n', { mode: 0o700 });
  const extracted = spawnSync(
    'python3',
    [
      '-c',
      "import runpy, sys; print(runpy.run_path(sys.argv[1], run_name='fixture')['PS_WRAPPER'], end='')",
      fileURLToPath(new URL('./blind-git.py', import.meta.url)),
    ],
    { encoding: 'utf8', timeout: 4500 },
  );
  assert.equal(extracted.status, 0, extracted.stderr);
  const wrapper = path.join(root, 'ps');
  writeFileSync(wrapper, extracted.stdout.replace('REAL_PS', real), { mode: 0o700 });
  const ps = (...args: string[]) =>
    spawnSync(wrapper, args, {
      encoding: 'utf8',
      env: { PATH: '/usr/bin:/bin', COMMAND_MODE: 'legacy' },
    });
  for (const args of [
    ['eww', '-p', '1'],
    ['e'],
    ['axe'],
    ['-E'],
    ['-e'],
    ['-axE', '-o', 'pid'],
    ['-ww', '-p', '1', '-E'],
    ['-ww', 'eww'],
    ['ax', '-e'],
    ['--', 'e'],
  ]) {
    const result = ps(...args);
    assert.equal(result.status, 1, args.join(' '));
    assert.match(result.stderr, /environment output is unavailable/u);
    assert.equal(result.stdout, '');
  }
  for (const args of [
    ['-ww', '-p', '1', '-o', 'lstart='],
    ['-ww', '-p', '1', '-o', 'etime=,rss='],
    ['-axo', 'pid=,command='],
    ['-opid=,etime=', '-p', '1'],
    ['axo', 'etime'],
    ['-A'],
  ]) {
    const result = ps(...args);
    assert.equal(result.status, 0, args.join(' '));
    assert.equal(result.stdout, `RAN unix2003 ${args.join(' ')}\n`);
  }
});

test('blind profile denies every slot runtime but its own, and every launch directory', () => {
  // Nothing is created: rules come from paths alone, outside /tmp and /var aliases.
  const root = '/blind-runtime-fixture';
  const repo = path.join(root, 'slots/product-1');
  const sibling = path.join(root, 'other/product-2');
  const spec = {
    slotId: 'slot',
    slotEpoch: 1,
    repo,
    capsule: path.join(root, 'capsule'),
    siblingRepos: [sibling],
    runId: 'run',
    branch: 'blind',
    baseSha: 'a'.repeat(40),
    referenceCommits: [],
  };
  // The gateway passes each slot's launch directory from the same helper tmux uses.
  const command = buildBlindGitCommand('boundary', spec);
  const launchDirs = [runnerLaunchDir(repo), runnerLaunchDir(sibling)];
  assert.ok(command.includes(JSON.stringify(launchDirs).slice(1, -1)));
  const rules = (withLaunchDirs: boolean) => {
    const result = spawnSync(
      'python3',
      [
        '-c',
        `import json, pathlib, runpy, sys
blind = runpy.run_path(sys.argv[1], run_name='fixture')
spec = json.loads(sys.argv[2])
print('\\n'.join(blind['slot_runtime_rules'](spec, pathlib.Path(spec['repo']), [pathlib.Path(p) for p in spec['siblingRepos']])))`,
        fileURLToPath(new URL('./blind-git.py', import.meta.url)),
        JSON.stringify(withLaunchDirs ? { ...spec, launchDirs } : spec),
      ],
      { encoding: 'utf8', timeout: 4500 },
    );
    assert.equal(result.status, 0, result.stderr);
    return result.stdout;
  };
  // With launchDirs, and with the fallback a directly prepared boundary uses.
  for (const profile of [rules(true), rules(false)]) {
    assert.equal(profile, rules(true));
    const own = path.join(root, 'slots/.farmslot-runtime/product-1');
    for (const operation of ['file-read*', 'file-write*', 'file-link']) {
      for (const tree of ['slots', 'other'])
        assert.ok(
          profile.includes(
            `(deny ${operation} (require-all (subpath ${JSON.stringify(path.join(root, tree, '.farmslot-runtime'))}) (require-not (require-any (subpath ${JSON.stringify(own)})))))`,
          ),
          `${operation} ${tree}`,
        );
      for (const launch of launchDirs)
        assert.ok(profile.includes(`(deny ${operation} (subpath ${JSON.stringify(launch)}))`));
      assert.ok(
        profile.includes(
          `(deny ${operation} (regex #"/[.]farmslot-runtime/[^/]+/[.]agent/[.]launch(/|$)"))`,
        ),
      );
    }
    // Renaming a runtime tree must not carry a launch script out of the denial.
    assert.ok(profile.includes(`(literal ${JSON.stringify(path.join(root, 'other'))})`));
  }
});

test('blind profile denies host credential stores last, except the trial own paths and pinned code', (t) => {
  const root = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'seatbelt-host-')));
  t.after(() => rmSync(root, { recursive: true }));
  const home = path.join(root, 'home');
  // Paths only: rules come from names; the farm homes are discovered as directories.
  for (const name of ['.farmslot-dev', '.farmslot-rollout-backups'])
    mkdirSync(path.join(home, name), { recursive: true });
  const repo = path.join(root, 'ws/product');
  const capsule = path.join(root, 'ws/.farmslot-blind-evals/slot/run-1');
  mkdirSync(capsule, { recursive: true });
  writeFileSync(path.join(capsule, 'state.json'), '{"originalIsDirectory":true}');
  const data = path.join(root, 'data');
  const spec = {
    repo,
    hostDeniedRoots: [data],
    hostReadableRoots: [path.join(data, 'state/task-pins')],
  };
  const result = spawnSync(
    'python3',
    [
      '-c',
      `import json, os, pathlib, runpy, sys
from unittest.mock import patch
blind = runpy.run_path(sys.argv[1], run_name='fixture')
spec, capsule = json.loads(sys.argv[2]), pathlib.Path(sys.argv[3])
with patch.dict(os.environ, {'HOME': sys.argv[4], 'FARMSLOT_BLIND_DENIED_PATHS': sys.argv[5]}, clear=True):
    profile = blind['sandbox_profile'](spec, capsule, [], set())
    volume = blind['host_secret_paths']({'repo': '/Volumes/fixture/dev/org/product'}, pathlib.Path('/Volumes/fixture/dev/org/product'), capsule, [])
print(json.dumps({'profile': profile, 'volume': [str(p) for p in volume]}))`,
      fileURLToPath(new URL('./blind-git.py', import.meta.url)),
      JSON.stringify(spec),
      capsule,
      home,
      path.join(root, 'extra'),
    ],
    { encoding: 'utf8', timeout: 4500 },
  );
  assert.equal(result.status, 0, result.stderr);
  const { profile, volume } = JSON.parse(result.stdout) as { profile: string; volume: string[] };
  const lines = profile.trim().split('\n');
  const q = JSON.stringify;
  const denial = (operation: string, store: string) =>
    lines.findIndex(
      (line) =>
        line.startsWith(`(deny ${operation} (subpath ${q(store)})`) ||
        line.startsWith(`(deny ${operation} (require-all (subpath ${q(store)}) `),
    );
  const stores = [
    ...[
      '.claude',
      '.codex',
      '.pi',
      '.grok',
      '.config',
      '.farmslot',
      '.farmslot-dev',
      '.farmslot-rollout-backups',
      'farm-paths-brief',
      'xreview',
      'Library/Application Support',
      'Library/Preferences',
      'Library/HTTPStorages',
      'Library/Keychains',
      'Library/Cookies',
    ].map((name) => path.join(home, name)),
    data,
    path.join(root, 'extra'),
    path.join(root, 'ws/.farmslot-runtime/product/.blind-pi'),
  ];
  const lastAllow = Math.max(
    profile.lastIndexOf('(allow file-read*'),
    profile.lastIndexOf('(allow file-write*'),
  );
  const first = Math.min(
    ...stores.map((store) => denial('file-read*', store)).filter((index) => index >= 0),
  );
  for (const store of stores)
    for (const operation of ['file-read*', 'file-write*', 'file-link']) {
      const index = denial(operation, store);
      assert.ok(index >= 0, `${operation} ${store}`);
      // No later allowance can reopen a store.
      assert.ok(profile.indexOf(lines[index]!) > lastAllow, `${operation} ${store} is not last`);
    }
  for (const line of lines.slice(first))
    assert.match(line, /^\(deny |^\(allow file-read-metadata \(literal "[^"]+"\)\)$/u, line);
  // Reads keep pinned task CLIs, installed code and Pi's tools; writes keep none of them.
  const farm = lines[denial('file-read*', path.join(home, '.farmslot-dev'))]!;
  for (const kept of ['task-pins', 'state/task-pins', 'code'])
    assert.ok(farm.includes(`(subpath ${q(path.join(home, '.farmslot-dev', kept))})`), kept);
  assert.ok(
    lines[denial('file-read*', data)]!.includes(
      `(subpath ${q(path.join(data, 'state/task-pins'))})`,
    ),
  );
  assert.ok(
    lines[denial('file-read*', path.join(home, '.pi'))]!.includes(
      `(subpath ${q(path.join(home, '.pi/agent/bin'))})`,
    ),
  );
  for (const store of [path.join(home, '.farmslot-dev'), path.join(home, '.pi'), data])
    assert.ok(lines.includes(`(deny file-write* (subpath ${q(store)}))`), store);
  // Only this trial's Pi home survives in the slot runtime's Pi homes.
  const piHomes = path.join(root, 'ws/.farmslot-runtime/product/.blind-pi');
  for (const operation of ['file-read*', 'file-write*', 'file-link']) {
    const rule = lines[denial(operation, piHomes)]!;
    assert.ok(rule.includes(`(require-not (require-any `), rule);
    assert.ok(rule.includes(`(subpath ${q(path.join(piHomes, 'run-1'))})`), rule);
  }
  assert.ok(
    profile.includes(`(allow file-read-metadata (literal ${q(path.join(home, '.pi/agent'))}))`),
  );
  // A rename of an ancestor cannot carry a store out of its denial.
  assert.ok(profile.includes(`(literal ${q(path.join(home, 'Library'))})`));
  for (const name of ['lanes', 'slot-retained', 'xreview', 'dev/xreview-personal'])
    assert.ok(volume.includes(path.join('/Volumes/fixture', name)), name);
  // The legacy in-checkout launch directory also refuses hard links.
  assert.ok(lines.includes(`(deny file-link (subpath ${q(path.join(repo, '.agent/.launch'))}))`));
});

test('blind Pi static models keep only extension providers, with env key references and no credential', (t) => {
  const root = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'seatbelt-pi-models-')));
  t.after(() => rmSync(root, { recursive: true }));
  const home = path.join(root, 'home');
  mkdirSync(path.join(home, '.pi/agent'), { recursive: true });
  const model = (id: string) => ({
    id,
    name: id,
    reasoning: true,
    input: ['text'],
    contextWindow: 65536,
    maxTokens: 1024,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    headers: { 'x-api-key': 'sk-FAKESECRETmodelheader0123456789' },
    apiKey: 'FAKE_SECRET-model-key',
  });
  writeFileSync(
    path.join(home, '.pi/agent/models.json'),
    JSON.stringify({
      providers: {
        localsparks: {
          baseUrl: 'http://192.0.2.1:8890/v1',
          api: 'openai-completions',
          apiKey: 'sk-FAKESECRETrouterkey0123456789abc',
          headers: { Authorization: 'Bearer sk-FAKESECRETbearer0123456789abc' },
          compat: { supportsDeveloperRole: false },
          models: [model('GLM-fixture-s1234')],
        },
        litellm: {
          baseUrl: 'https://litellm.example.invalid/v1',
          api: 'openai-completions',
          apiKey: 'Fake0Secret1Litellm2Key3',
          models: [model('fixture-litellm')],
        },
        // A key in the URL drops the provider; the extension supplies the endpoint.
        ollama: {
          baseUrl: 'http://user:FakeSecret0123456789@192.0.2.2/v1',
          models: [model('fixture-ollama')],
        },
        lmstudio: { baseUrl: 'http://192.0.2.3/v1', apiKey: 'Fake0Secret1Studio2Key3', models: [] },
      },
    }),
  );
  const target = path.join(root, 'models.json');
  const result = spawnSync(
    'python3',
    [
      '-c',
      `import os, pathlib, runpy, sys
from unittest.mock import patch
blind = runpy.run_path(sys.argv[1], run_name='fixture')
with patch.dict(os.environ, {'HOME': sys.argv[2], 'FARMSLOT_PI_ROUTER_ID': 'localsparks'}, clear=True):
    blind['write_blind_pi_models'](pathlib.Path(sys.argv[3]))`,
      fileURLToPath(new URL('./blind-git.py', import.meta.url)),
      home,
      target,
    ],
    { encoding: 'utf8', timeout: 4500 },
  );
  assert.equal(result.status, 0, result.stderr);
  const text = readFileSync(target, 'utf8');
  assert.equal(statSync(target).mode & 0o777, 0o600);
  // The shared redaction check finds no credential-shaped value.
  assert.equal(redactCommandCredentials(text).count, 0, text);
  assert.doesNotMatch(text, /FAKE|Fake|headers|user:/u);
  const providers = JSON.parse(text).providers as Record<
    string,
    { apiKey: string; models: { id: string }[] }
  >;
  assert.deepEqual(Object.keys(providers).sort(), ['litellm', 'localsparks']);
  assert.equal(providers.localsparks!.apiKey, '$FARMSLOT_PI_ROUTER_KEY');
  assert.equal(providers.litellm!.apiKey, '$LITELLM_API_KEY');
  for (const provider of Object.values(providers)) {
    assert.match(provider.apiKey, /^\$[A-Z_][A-Z0-9_]*$/u);
    for (const entry of provider.models) assert.ok(!('apiKey' in entry) && !('headers' in entry));
  }
  assert.deepEqual(
    providers.localsparks!.models.map((entry) => entry.id),
    ['GLM-fixture-s1234'],
  );
});

test('blind boundary refuses a configured Pi home inside a denied store', (t) => {
  const root = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'seatbelt-pi-home-')));
  t.after(() => rmSync(root, { recursive: true }));
  const home = path.join(root, 'home');
  mkdirSync(home);
  const check = (agentDir?: string) =>
    spawnSync(
      'python3',
      [
        '-c',
        `import os, pathlib, runpy, sys
from unittest.mock import patch
blind = runpy.run_path(sys.argv[1], run_name='fixture')
env = {'HOME': sys.argv[2]}
if len(sys.argv) > 4: env['PI_CODING_AGENT_DIR'] = sys.argv[4]
with patch.dict(os.environ, env, clear=True):
    blind['check_pi_agent_dir']({'repo': sys.argv[3]}, pathlib.Path(sys.argv[3]) / 'capsule')`,
        fileURLToPath(new URL('./blind-git.py', import.meta.url)),
        home,
        path.join(root, 'repo'),
        ...(agentDir === undefined ? [] : [agentDir]),
      ],
      { encoding: 'utf8', timeout: 4500 },
    );
  for (const denied of ['~/.pi/agent', path.join(home, '.pi'), path.join(home, '.config/pi')]) {
    const result = check(denied);
    assert.notEqual(result.status, 0, denied);
    assert.match(
      result.stderr,
      /PI_CODING_AGENT_DIR .* is inside a store the blind sandbox denies/u,
    );
  }
  for (const allowed of [undefined, path.join(root, 'pool-pi-home')])
    assert.equal(check(allowed).status, 0, String(allowed));
});

test('a non-blind pi launch keeps the pool launcher and operator Pi home, with no blind boundary', async () => {
  const { buildLaunchCommand, buildRunnerSessionReloadCommand } =
    await import('../runners/launch-command.js');
  const { makeVars } = await import('../runners/test-fixtures.js');
  const launcher = '/Users/operator/.npm-global/bin/farmslot-pi-anthropic';
  const vars = makeVars({ remoteRepo: '/work/product', piPath: launcher });
  const model = 'localsparks/GLM-fixture-s1234';
  const blind = { blindTrialBoundary: { capsule: '/work/capsule', baseSha: 'a'.repeat(40) } };
  const commands = {
    fresh: buildLaunchCommand(vars, 'pi', model, 'Task', { taskDir: '/work/product/task' }),
    retained: buildRunnerSessionReloadCommand(vars, 'pi', model, 'session-1', {}),
  };
  for (const [stage, command] of Object.entries(commands)) {
    assert.ok(command.includes(launcher), stage);
    // Pi resolves its default operator home; nothing selects or denies another.
    assert.doesNotMatch(command, /PI_CODING_AGENT_DIR|pi-agent|sandbox-exec|blind/u, stage);
  }
  // Only the blind launch selects the trial's home.
  assert.match(
    buildLaunchCommand(vars, 'pi', model, 'Task', { taskDir: '/work/product/task', ...blind }),
    /PI_CODING_AGENT_DIR=.*\/work\/capsule\/boundary\/pi-agent/u,
  );
});

function writeBlindPiModels(t: TestContext, operatorModels: string, prepare = '') {
  const root = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'seatbelt-pi-write-')));
  t.after(() => rmSync(root, { recursive: true }));
  const home = path.join(root, 'home');
  mkdirSync(path.join(home, '.pi/agent'), { recursive: true, mode: 0o700 });
  writeFileSync(path.join(home, '.pi/agent/models.json'), operatorModels);
  const trial = path.join(root, 'trial-pi');
  mkdirSync(trial, { mode: 0o700 });
  const result = spawnSync(
    'python3',
    [
      '-c',
      `import os, pathlib, runpy, sys
from unittest.mock import patch
blind = runpy.run_path(sys.argv[1], run_name='fixture')
root, trial = pathlib.Path(sys.argv[2]), pathlib.Path(sys.argv[3])
${prepare}
with patch.dict(os.environ, {'HOME': str(root / 'home'), 'FARMSLOT_PI_ROUTER_ID': 'localsparks'}, clear=True):
    blind['write_blind_pi_models'](trial / 'models.json')`,
      fileURLToPath(new URL('./blind-git.py', import.meta.url)),
      root,
      trial,
    ],
    { encoding: 'utf8', timeout: 4500 },
  );
  return { root, trial, result };
}

const piModel = { id: 'GLM-fixture-s1234', name: 'Fixture', contextWindow: 65536, maxTokens: 1024 };

test('blind Pi static models drop credentials nested in provider and model compat', (t) => {
  const { trial, result } = writeBlindPiModels(
    t,
    JSON.stringify({
      providers: {
        localsparks: {
          baseUrl: 'http://192.0.2.1:8890/v1',
          compat: {
            supportsStore: true,
            apiKey: 'sk-FAKESECRETcompatkey0123456789',
            headers: { Authorization: 'Bearer sk-FAKESECRETcompatheader01234' },
            chatTemplateKwargs: { enable_thinking: true, token: 'Fake0Secret1Kwargs2Token3' },
          },
          models: [
            {
              ...piModel,
              compat: {
                maxTokensField: 'max_tokens',
                accessToken: 'Fake0Secret1Model2Token3',
                nested: {
                  client_secret: 'Fake0Secret1Nested2Value3',
                  note: 'Fake0Secret1Bare2Value3',
                },
              },
            },
          ],
        },
      },
    }),
  );
  assert.equal(result.status, 0, result.stderr);
  const text = readFileSync(path.join(trial, 'models.json'), 'utf8');
  assert.equal(redactCommandCredentials(text).count, 0, text);
  assert.doesNotMatch(text, /FAKE|Fake|Bearer|apiKey": "sk|headers|token"|secret/u);
  const provider = JSON.parse(text).providers.localsparks;
  assert.equal(provider.apiKey, '$FARMSLOT_PI_ROUTER_KEY');
  assert.deepEqual(provider.compat, {
    supportsStore: true,
    chatTemplateKwargs: { enable_thinking: true },
  });
  assert.deepEqual(provider.models[0].compat, { maxTokensField: 'max_tokens', nested: {} });
  assert.equal(provider.models[0].id, 'GLM-fixture-s1234');
});

test('blind Pi static models parse the operator file as Pi does, with comments and trailing commas', (t) => {
  const { trial, result } = writeBlindPiModels(
    t,
    `{
  // Local Sparks router, as operators annotate it.
  "providers": {
    "localsparks": {
      "baseUrl": "http://192.0.2.1:8890/v1", // endpoint
      "models": [{ "id": "GLM-fixture-s1234", "name": "Fixture // not a comment", },],
    },
  },
}
`,
  );
  assert.equal(result.status, 0, result.stderr);
  const models = JSON.parse(readFileSync(path.join(trial, 'models.json'), 'utf8')).providers
    .localsparks.models as { id: string; name: string }[];
  assert.deepEqual(models, [{ id: 'GLM-fixture-s1234', name: 'Fixture // not a comment' }]);
});

test('blind Pi static models never write through a link the worker planted in its Pi home', (t) => {
  const operator = JSON.stringify({ providers: { localsparks: { models: [piModel] } } });
  // Every pending name and the target itself point at a fake operator login.
  const planted = `auth = root / 'operator-auth.json'
auth.write_text('FAKE_SECRET operator login')
for name in ['models.pending', 'models.json']:
    (trial / name).symlink_to(auth)`;
  const { root, trial, result } = writeBlindPiModels(t, operator, planted);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(
    readFileSync(path.join(root, 'operator-auth.json'), 'utf8'),
    'FAKE_SECRET operator login',
  );
  assert.ok(!lstatSync(path.join(trial, 'models.json')).isSymbolicLink());
  assert.equal(
    JSON.parse(readFileSync(path.join(trial, 'models.json'), 'utf8')).providers.localsparks
      .models[0].id,
    piModel.id,
  );
  // A Pi home swapped for a link is refused before anything is written.
  const swapped = writeBlindPiModels(
    t,
    operator,
    `import shutil
target = root / 'elsewhere'
target.mkdir(mode=0o700)
shutil.rmtree(trial)
trial.symlink_to(target)`,
  );
  assert.notEqual(swapped.result.status, 0);
  assert.match(swapped.result.stderr, /Blind trial Pi home is not a private directory/u);
  assert.deepEqual(readdirSync(path.join(swapped.root, 'elsewhere')), []);
});

test('blind profile lets Yarn read but never write the operator ~/.yarnrc.yml', (t) => {
  const { home, profile } = generatedProfile(t);
  const yarnrc = JSON.stringify(path.join(home, '.yarnrc.yml'));
  assert.ok(!profile.includes(`(deny file-read* (subpath ${yarnrc}))`));
  const write = `(deny file-write* file-link (subpath ${yarnrc}))`;
  assert.ok(profile.includes(write));
  assert.ok(profile.indexOf(write) > profile.lastIndexOf('(allow file-write*'));
});

test('blind workers receive the core project Node location and no unlisted pool entry', async () => {
  const { buildLaunchCommand } = await import('../runners/launch-command.js');
  const { makeVars } = await import('../runners/test-fixtures.js');
  const vars = makeVars({
    remoteRepo: '/work/product',
    machineEnv: { CORE_NODE_BIN: '/synthetic/node/bin', UNLISTED_POOL_SETTING: 'synthetic' },
  });
  const command = buildLaunchCommand(vars, 'pi', 'litellm/fixture', 'Task', {
    taskDir: '/work/product/task',
    blindTrialBoundary: { capsule: '/work/capsule', baseSha: 'a'.repeat(40) },
  });
  assert.match(command, /CORE_NODE_BIN=/u);
  assert.doesNotMatch(command, /UNLISTED_POOL_SETTING/u);
});
