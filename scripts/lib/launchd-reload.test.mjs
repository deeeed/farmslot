// The service restart deploy-node runs on a node host. launchd: a previous node that outlives
// bootout is stopped (by its recorded pid and start time only). Both service managers: a new node
// the gateway refuses as a duplicate fails the deploy, matched by the new node's pid. Scripts run
// the way deploy-node's run() does locally (eval under set -euo pipefail), and under zsh, the
// macOS login shell ssh uses.
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const lib = fileURLToPath(new URL('./launchd-reload.sh', import.meta.url));
const NEW_PID = 99999;
const registered = (pid) => `Registered with gateway as "m" (protocol 1, pid ${pid})`;
const refused = (pid) =>
  `Gateway registration failed [NODE_ALREADY_CONNECTED]: Node m is already connected (pid 86713); refused pid ${pid}`;

function generate(fn, ...args) {
  return execFileSync('bash', ['-c', `source ${JSON.stringify(lib)}; ${fn} "$@"`, '_', ...args], {
    encoding: 'utf8',
  });
}

function runScript(script, bin, shell = 'eval', env = {}) {
  const argv =
    shell === 'zsh'
      ? ['/bin/zsh', ['-f', '-c', script]]
      : ['bash', ['-c', 'set -euo pipefail; eval "$1"', '_', script]];
  return spawnSync(argv[0], argv[1], {
    encoding: 'utf8',
    timeout: 20_000,
    env: {
      ...process.env,
      PATH: `${bin}${path.delimiter}${process.env.PATH}`,
      FARMSLOT_DEPLOY_STOP_CHECKS: '4',
      FARMSLOT_DEPLOY_REGISTRATION_CHECKS: '4',
      ...env,
    },
  });
}

function launchdFixture(
  t,
  { newNodeLogs = [registered(NEW_PID)], ignoreTerm = true, loaded = true } = {},
) {
  const root = mkdtempSync(path.join(tmpdir(), 'launchd-reload-'));
  const bin = path.join(root, 'bin');
  mkdirSync(bin);
  const log = path.join(root, 'node.log');
  writeFileSync(log, `${registered(111)}\n`);
  // The previous node: a real process re-parented to init, as a launchd job's is, so it is reaped
  // once killed. When it ignores SIGTERM it outlives bootout like the orphan did.
  const pid = Number(
    execFileSync(
      'bash',
      [
        '-c',
        `(${ignoreTerm ? 'trap "" TERM; ' : ''}exec -a node-under-test bash -c 'while :; do sleep 0.1; done') </dev/null >/dev/null 2>&1 & echo $!`,
      ],
      { encoding: 'utf8' },
    ).trim(),
  );
  t.after(() => {
    try {
      process.kill(pid, 'SIGKILL');
    } catch {
      // Already gone: the reload killed it.
    }
    rmSync(root, { recursive: true, force: true });
  });
  const state = path.join(root, 'loaded');
  writeFileSync(state, loaded ? String(pid) : '');
  // launchctl: print shows the loaded job and its pid; bootout unloads it and sends SIGTERM;
  // bootstrap loads it as NEW_PID, and the new node writes its outcome to the log.
  writeFileSync(
    path.join(bin, 'launchctl'),
    `#!/bin/bash
state=${JSON.stringify(state)}
case "$1" in
  print) [ -s "$state" ] || exit 113; printf '\\tstate = running\\n\\tpid = %s\\n' "$(cat "$state")" ;;
  bootout) pid=$(cat "$state"); : > "$state"; [ -z "$pid" ] || kill -TERM "$pid" 2>/dev/null || true ;;
  enable) ;;
  bootstrap) echo ${NEW_PID} > "$state"; printf '%s\\n' ${newNodeLogs.map((line) => JSON.stringify(line)).join(' ')} >> ${JSON.stringify(log)} ;;
  *) echo "unexpected launchctl $*" >&2; exit 2 ;;
esac
`,
  );
  chmodSync(path.join(bin, 'launchctl'), 0o755);
  const script = generate(
    'launchd_reload_script',
    'com.example.node',
    'Library/LaunchAgents/x.plist',
    log,
  );
  const alive = () => {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  };
  return { root, bin, log, pid, alive, run: (shell, env) => runScript(script, bin, shell, env) };
}

const shells = ['eval', ...(existsSync('/bin/zsh') ? ['zsh'] : [])];

for (const shell of shells) {
  test(`(${shell}) a previous node that outlives bootout is killed before the new job starts`, (t) => {
    const f = launchdFixture(t);
    const result = f.run(shell);
    assert.equal(result.status, 0, result.stderr);
    assert.match(
      result.stderr,
      new RegExp(`previous node pid ${f.pid} outlived launchd bootout; killing it`),
    );
    assert.match(result.stdout, /node registered with the gateway/);
    assert.equal(f.alive(), false);
  });

  test(`(${shell}) a job that is not loaded yet is bootstrapped`, (t) => {
    const f = launchdFixture(t, { loaded: false, ignoreTerm: false });
    const result = f.run(shell);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /node registered with the gateway/);
  });
}

test('a previous node that stops on SIGTERM is not killed', (t) => {
  const f = launchdFixture(t, { ignoreTerm: false });
  const result = f.run();
  assert.equal(result.status, 0, result.stderr);
  assert.doesNotMatch(result.stderr, /killing it/);
});

test('a pid whose start time changed is a different process and is never signalled', (t) => {
  const f = launchdFixture(t);
  // ps reports another start time than the one recorded before bootout: the pid was reused.
  const marker = path.join(f.root, 'ps-calls');
  writeFileSync(
    path.join(f.bin, 'ps'),
    `#!/bin/bash\necho x >> ${JSON.stringify(marker)}\nn=$(wc -l < ${JSON.stringify(marker)})\nif [ "$n" -le 1 ]; then echo 'Wed Nov 25 04:38:00 2026'; else echo 'Wed Nov 25 13:25:41 2026'; fi\n`,
  );
  chmodSync(path.join(f.bin, 'ps'), 0o755);
  const result = f.run();
  assert.equal(result.status, 0, result.stderr);
  assert.doesNotMatch(result.stderr, /killing it/);
  assert.equal(f.alive(), true, 'the reused pid is left alone');
});

test('the new node refused as a duplicate fails the deploy, quoting the refusal', (t) => {
  const f = launchdFixture(t, { ignoreTerm: false, newNodeLogs: [refused(NEW_PID)] });
  const result = f.run();
  assert.equal(result.status, 1);
  assert.match(
    result.stderr,
    new RegExp(
      `the gateway refused the new node: .*NODE_ALREADY_CONNECTED.*refused pid ${NEW_PID}`,
    ),
  );
});

test("another process's refusal or registration in the log does not decide the deploy", (t) => {
  // An orphan sharing node.log is refused, then logs a registration of its own, before the new
  // node registers: only the new node's pid counts.
  const f = launchdFixture(t, {
    ignoreTerm: false,
    newNodeLogs: [refused(12345), registered(12345), registered(NEW_PID)],
  });
  const result = f.run();
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /node registered with the gateway/);
  const g = launchdFixture(t, { ignoreTerm: false, newNodeLogs: [registered(12345)] });
  const other = g.run();
  assert.equal(other.status, 0, other.stderr);
  assert.doesNotMatch(other.stdout, /node registered/);
  assert.match(other.stderr, /has not registered with the gateway after 2 s/);
});

test('an earlier refusal in the log does not fail this deploy', (t) => {
  const f = launchdFixture(t, { ignoreTerm: false });
  writeFileSync(f.log, `${refused(NEW_PID)}\n`, { flag: 'a' });
  const result = f.run();
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /node registered with the gateway/);
});

test('a node that neither registers nor is refused only warns', (t) => {
  const f = launchdFixture(t, { ignoreTerm: false, newNodeLogs: ['Connecting to gateway...'] });
  const result = f.run();
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stderr, /has not registered with the gateway after 2 s/);
  assert.equal(readFileSync(f.log, 'utf8').includes('Connecting to gateway...'), true);
});

function systemdFixture(t, { failReload = false, newNodeLogs = [registered(NEW_PID)] } = {}) {
  const root = mkdtempSync(path.join(tmpdir(), 'systemd-restart-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const bin = path.join(root, 'bin');
  mkdirSync(bin);
  const log = path.join(root, 'node.log');
  const calls = path.join(root, 'calls');
  writeFileSync(
    path.join(bin, 'systemctl'),
    `#!/bin/bash
echo "$*" >> ${JSON.stringify(calls)}
case "$*" in
  '--user daemon-reload') ${failReload ? 'exit 1' : ':'} ;;
  '--user restart '*) printf '%s\\n' ${newNodeLogs.map((line) => JSON.stringify(line)).join(' ')} >> ${JSON.stringify(log)} ;;
  '--user show -p MainPID --value '*) echo ${NEW_PID} ;;
esac
`,
  );
  chmodSync(path.join(bin, 'systemctl'), 0o755);
  const script = generate('systemd_restart_script', 'farmslot-node.service', log);
  const read = () => (existsSync(calls) ? readFileSync(calls, 'utf8').trim().split('\n') : []);
  return { run: (shell, env) => runScript(script, bin, shell, env), calls: read };
}

test('a systemd restart is confirmed by the new node registering', (t) => {
  const f = systemdFixture(t);
  const result = f.run();
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /node registered with the gateway/);
});

test('a failed systemd daemon-reload fails the deploy and restarts nothing', (t) => {
  const f = systemdFixture(t, { failReload: true });
  const result = f.run();
  assert.notEqual(result.status, 0);
  assert.equal(
    f.calls().some((line) => line.includes('restart')),
    false,
    f.calls().join('\n'),
  );
});

test('a systemd node refused as a duplicate fails the deploy', (t) => {
  const f = systemdFixture(t, { newNodeLogs: [refused(NEW_PID)] });
  const result = f.run();
  assert.equal(result.status, 1);
  assert.match(result.stderr, /the gateway refused the new node/);
});
