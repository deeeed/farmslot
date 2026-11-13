import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test, { type TestContext } from 'node:test';
import { fileURLToPath } from 'node:url';

import { withBlindTrialBoundary } from './blind-git.js';

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
      '.yarnrc.yml',
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
spec = {'repo': str(root), 'slotResourcePorts': {'cdp_port': 19222}}
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
