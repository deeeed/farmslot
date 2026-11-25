// The launchd reload deploy-node runs on a node host: a previous node that outlives bootout is
// stopped (by its recorded pid and start time only), and a new node the gateway refuses as a
// duplicate fails the deploy.
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const lib = fileURLToPath(new URL('./launchd-reload.sh', import.meta.url));

function fixture(
  t,
  { newNodeLogs = 'Registered with gateway as "m" (protocol 1)', ignoreTerm = true } = {},
) {
  const root = mkdtempSync(path.join(tmpdir(), 'launchd-reload-'));
  const bin = path.join(root, 'bin');
  mkdirSync(bin);
  const log = path.join(root, 'node.log');
  writeFileSync(log, 'Registered with gateway as "m" (protocol 0)\n');
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
  const old = { pid };
  t.after(() => {
    try {
      process.kill(old.pid, 'SIGKILL');
    } catch {
      // Already gone: the reload killed it.
    }
    rmSync(root, { recursive: true, force: true });
  });
  const state = path.join(root, 'loaded');
  writeFileSync(state, String(old.pid));
  // launchctl: print shows the loaded job and its pid; bootout unloads it and sends SIGTERM;
  // bootstrap loads it and the new node writes its outcome to the log.
  writeFileSync(
    path.join(bin, 'launchctl'),
    `#!/bin/bash
state=${JSON.stringify(state)}
case "$1" in
  print) [ -s "$state" ] || exit 113; printf '\\tstate = running\\n\\tpid = %s\\n' "$(cat "$state")" ;;
  bootout) pid=$(cat "$state"); : > "$state"; kill -TERM "$pid" 2>/dev/null || true ;;
  enable) ;;
  bootstrap) echo 99999 > "$state"; printf '%s\\n' ${JSON.stringify(newNodeLogs)} >> ${JSON.stringify(log)} ;;
  *) echo "unexpected launchctl $*" >&2; exit 2 ;;
esac
`,
  );
  chmodSync(path.join(bin, 'launchctl'), 0o755);
  const run = (env = {}) => {
    const script = execFileSync(
      'bash',
      [
        '-c',
        `source ${JSON.stringify(lib)}; launchd_reload_script com.example.node Library/LaunchAgents/x.plist "$1"`,
        '_',
        log,
      ],
      { encoding: 'utf8' },
    );
    return spawnSync('bash', ['-c', script], {
      encoding: 'utf8',
      timeout: 20_000,
      env: {
        ...process.env,
        PATH: `${bin}${path.delimiter}${process.env.PATH}`,
        FARMSLOT_DEPLOY_STOP_CHECKS: '8',
        FARMSLOT_DEPLOY_REGISTRATION_CHECKS: '6',
        ...env,
      },
    });
  };
  const alive = () => {
    try {
      process.kill(old.pid, 0);
      return true;
    } catch {
      return false;
    }
  };
  return { root, bin, log, old, run, alive };
}

test('a previous node that outlives bootout is killed before the new job starts', (t) => {
  const f = fixture(t);
  const result = f.run();
  assert.equal(result.status, 0, result.stderr);
  assert.match(
    result.stderr,
    new RegExp(`previous node pid ${f.old.pid} outlived launchd bootout; killing it`),
  );
  assert.match(result.stdout, /node registered with the gateway/);
  // SIGKILL lands asynchronously; the script only continued once the pid was gone.
  assert.equal(f.alive(), false);
});

test('a previous node that stops on SIGTERM is not killed', (t) => {
  const f = fixture(t, { ignoreTerm: false });
  const result = f.run();
  assert.equal(result.status, 0, result.stderr);
  assert.doesNotMatch(result.stderr, /killing it/);
});

test('a pid whose start time changed is a different process and is never signalled', (t) => {
  const f = fixture(t);
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

test('a new node the gateway refuses as a duplicate fails the deploy, quoting the refusal', (t) => {
  const f = fixture(t, {
    ignoreTerm: false,
    newNodeLogs:
      'Gateway node.connect failed [NODE_ALREADY_CONNECTED]: Node m is already connected (pid 86713); refused pid 99999',
  });
  const result = f.run();
  assert.equal(result.status, 1);
  assert.match(
    result.stderr,
    /the gateway refused the new node: .*NODE_ALREADY_CONNECTED.*pid 86713/,
  );
});

test('an earlier refusal in the log does not fail this deploy', (t) => {
  const f = fixture(t, { ignoreTerm: false });
  writeFileSync(f.log, 'Gateway node.connect failed [NODE_ALREADY_CONNECTED]: old\n', {
    flag: 'a',
  });
  const result = f.run();
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /node registered with the gateway/);
});

test('a node that neither registers nor is refused only warns', (t) => {
  const f = fixture(t, { ignoreTerm: false, newNodeLogs: 'Connecting to gateway...' });
  const result = f.run();
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stderr, /has not registered with the gateway/);
  assert.equal(readFileSync(f.log, 'utf8').includes('Connecting to gateway...'), true);
});
