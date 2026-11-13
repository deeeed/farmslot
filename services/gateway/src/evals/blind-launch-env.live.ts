// Live: a blind worker launched through production tmux paths on a private
// server, with every ancestor's environment read from outside via KERN_PROCARGS2.
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

import { shSingleQuote as q } from '../../../../scripts/lib/shell-quote.mjs';

const isolated =
  process.platform === 'darwin' && !process.env.TMUX && Boolean(process.env.TMUX_TMPDIR);

const MODEL_KEY = 'FAKE_SECRET-model-key';
const POOL_SECRETS = ['CODEX_LB_API_KEY', 'JIRA_API_TOKEN', 'NPM_TOKEN', 'OPENAI_API_KEY'];
const LOGIN_SECRETS = ['GITHUB_TOKEN', 'NPM_AUTH_TOKEN', 'LINEAR_API_KEY'];

// Reads argv and environment of each pid. Values go back to the test over a pipe, never to logs.
const PROCARGS = String.raw`
import ctypes, ctypes.util, json, struct, sys
libc = ctypes.CDLL(ctypes.util.find_library('c'), use_errno=True)
def sysctl(mib, size):
    buf = ctypes.create_string_buffer(size)
    length = ctypes.c_size_t(size)
    array = (ctypes.c_int * len(mib))(*mib)
    if libc.sysctl(array, len(mib), buf, ctypes.byref(length), None, 0) != 0:
        return None
    return buf.raw[:length.value]
argmax = struct.unpack('i', sysctl([1, 8], 4))[0]
out = {}
for pid in sys.argv[1:]:
    raw = sysctl([1, 49, int(pid)], argmax)
    if raw is None:
        out[pid] = None
        continue
    argc = struct.unpack('i', raw[:4])[0]
    rest = raw[4:].split(b'\0', 1)[1].lstrip(b'\0')
    parts = [part.decode('utf-8', 'replace') for part in rest.split(b'\0')]
    argv = parts[:argc]
    env = [part for part in parts[argc:] if '=' in part]
    out[pid] = {'argv': argv, 'env': dict(part.split('=', 1) for part in env)}
print(json.dumps(out))
`;

function procargs(pids: number[]): Record<string, { argv: string[]; env: Record<string, string> }> {
  return JSON.parse(
    execFileSync('python3', ['-I', '-c', PROCARGS, ...pids.map(String)], { encoding: 'utf8' }),
  );
}

function parents(): Map<number, number> {
  const map = new Map<number, number>();
  for (const line of execFileSync('/bin/ps', ['-axo', 'pid=,ppid='], { encoding: 'utf8' })
    .trim()
    .split('\n')) {
    const [pid, ppid] = line.trim().split(/\s+/).map(Number);
    map.set(pid!, ppid!);
  }
  return map;
}

test(
  'blind worker launch shells hold no credential beyond the model key, and only the worker chain holds that',
  { skip: !isolated, timeout: 120_000 },
  async (t) => {
    // A deterministic PATH, set before exec.ts captures it: tmux hands the client's PATH to
    // panes. macOS returns no environment for Apple platform binaries, so the launch shells
    // must run a non-system bash (as operators' PATH bash usually is) to be observable.
    const bashDir = ['/opt/homebrew/bin', '/usr/local/bin'].find((dir) =>
      existsSync(path.join(dir, 'bash')),
    );
    if (!bashDir) return t.skip('needs a non-system bash on PATH to observe launch shells');
    const previousPath = process.env.PATH;
    process.env.PATH = [
      path.dirname(process.execPath),
      bashDir,
      '/usr/bin',
      '/bin',
      '/usr/sbin',
      '/sbin',
    ].join(':');
    t.after(() => {
      process.env.PATH = previousPath;
    });
    // Gateway modules load only once the process is confined to its private tmux socket.
    const { buildRoleLaunchCommandWithDiagnosticHold } =
      await import('../methods/dispatch/execute.js');
    const { writeTmuxLaunchScript } = await import('../core/tmux-launch-script.js');
    const { respawnTmuxWindowWithCommand } = await import('../core/tmux.js');
    const { WORKER_ENV_PREFIX } = await import('../runners/registry.js');
    const launch = await import('../runners/launch-command.js');
    const { makeVars } = await import('../runners/test-fixtures.js');

    const home = realpathSync(mkdtempSync(path.join(os.homedir(), '.blind-launch-env-')));
    t.after(() => rmSync(home, { recursive: true, force: true }));
    const root = path.join(home, 'repo');
    const capsule = path.join(home, '.farmslot-blind-evals/fixture/run-epoch');
    mkdirSync(path.join(capsule, 'boundary'), { recursive: true });
    mkdirSync(root);
    writeFileSync(path.join(capsule, 'state.json'), '{"originalIsDirectory":true}');
    symlinkSync(path.join(capsule, 'boundary'), path.join(root, 'boundary'));
    execFileSync(
      'python3',
      [
        '-I',
        '-c',
        `import pathlib, runpy, sys
blind = runpy.run_path(sys.argv[1], run_name='fixture')
blind['prepare_boundary']({'repo': sys.argv[2], 'siblingRepos': [], 'slotResourcePorts': {}}, pathlib.Path(sys.argv[3]))`,
        fileURLToPath(new URL('./blind-git.py', import.meta.url)),
        root,
        capsule,
      ],
      { env: { PATH: process.env.PATH, HOME: home }, encoding: 'utf8', timeout: 20_000 },
    );
    const temporary = path.join(capsule, 'boundary/tmp');
    t.after(() => {
      if (existsSync(temporary)) rmSync(realpathSync(temporary), { recursive: true, force: true });
    });
    // The operator's login file exports credentials, as a real ~/.zshenv does.
    writeFileSync(
      path.join(home, '.zshenv'),
      LOGIN_SECRETS.map((name) => `export ${name}=${q(`FAKE_SECRET-login-${name}`)}\n`).join(''),
    );
    const standIn = path.join(root, 'pi-stand-in.mjs');
    writeFileSync(
      standIn,
      `console.log('BLIND-STAND-IN-PID=' + process.pid); setInterval(() => {}, 1000);\n`,
    );

    const socket = path.join(process.env.TMUX_TMPDIR!, `tmux-${process.getuid!()}`, 'default');
    mkdirSync(path.dirname(socket), { recursive: true, mode: 0o700 });
    const serverEnv = {
      PATH: process.env.PATH,
      HOME: home,
      USER: process.env.USER,
      LOGNAME: process.env.LOGNAME,
      SHELL: '/bin/zsh',
      TERM: 'xterm-256color',
      TMUX_TMPDIR: process.env.TMUX_TMPDIR,
      // The server's own environment (whoever started it) also carries credentials.
      ...Object.fromEntries(POOL_SECRETS.map((name) => [name, `FAKE_SECRET-server-${name}`])),
    };
    const tmux = (...args: string[]) =>
      execFileSync('tmux', ['-S', socket, '-f', '/dev/null', ...args], {
        env: serverEnv,
        encoding: 'utf8',
      });
    tmux('new-session', '-d', '-s', 'blind', '-n', 'worker', '-c', root, '/bin/cat');
    t.after(() => {
      spawnSync('tmux', ['-S', socket, 'kill-server'], { env: serverEnv });
    });
    const serverPid = Number(tmux('display-message', '-p', '#{pid}').trim());
    t.diagnostic(
      `tmux server holds: ${Object.keys(procargs([serverPid])[serverPid]!.env)
        .sort()
        .join(' ')}`,
    );

    const vars = makeVars({
      machine: 'local',
      remoteRepo: root,
      piPath: `${q(process.execPath)} ${q(standIn)}`,
      machineEnv: {
        // The pool's PATH replaces the gateway's boot PATH, which tmux hands the pane.
        PATH: process.env.PATH!,
        ...Object.fromEntries(POOL_SECRETS.map((name) => [name, `FAKE_SECRET-pool-${name}`])),
        LITELLM_API_KEY: MODEL_KEY,
        LITELLM_URL: 'http://litellm.invalid/v1',
      },
    });
    const model = 'litellm/fixture';
    const options = {
      taskDir: path.join(root, 'task'),
      blindTrialBoundary: { capsule, baseSha: 'a'.repeat(40) },
    };
    const names = launch.blindLaunchEnvironment?.(vars, 'pi', model);

    const stages = {
      // Fresh dispatch: execute.ts respawnRoleWindowWithCommand.
      fresh: async (target: string) => {
        const command = launch.wrapWorkerShellCommand(
          launch.buildLaunchCommand(vars, 'pi', model, 'Synthetic task', options),
          { projectJson: {}, vars },
        );
        const entry = await writeTmuxLaunchScript(
          vars,
          target,
          buildRoleLaunchCommandWithDiagnosticHold(command, root, Boolean(names)),
          names,
        );
        tmux('respawn-window', '-k', '-t', target, '-c', root, entry);
      },
      // Retained reload: runtime-recovery.ts.
      retained: (target: string) =>
        respawnTmuxWindowWithCommand(
          vars,
          target,
          `${WORKER_ENV_PREFIX} && ${launch.buildRunnerSessionReloadCommand(vars, 'pi', model, 'synthetic-session', options)}`,
          { preserveWindowAfterExit: true, blindEnvironment: names },
        ),
    };

    const seen = new Set<number>();
    for (const [stage, start] of Object.entries(stages)) {
      await t.test(stage, async () => {
        const target = 'blind:worker';
        const log = path.join(home, `${stage}.log`);
        tmux('pipe-pane', '-t', target, `cat >> ${q(log)}`);
        await start(target);
        let worker = 0;
        for (let attempt = 0; attempt < 200 && !worker; attempt++) {
          await delay(50);
          const pane = tmux('capture-pane', '-p', '-J', '-S', '-', '-t', target);
          worker =
            [...pane.matchAll(/BLIND-STAND-IN-PID=(\d+)/g)]
              .map((match) => Number(match[1]))
              .find((pid) => !seen.has(pid)) ?? 0;
        }
        seen.add(worker);
        assert.ok(
          worker,
          `stand-in worker did not start:\n${existsSync(log) ? readFileSync(log, 'utf8').slice(-3000) : ''}`,
        );
        try {
          const tree = parents();
          const chain: number[] = [];
          for (let pid = tree.get(worker)!; pid && pid !== serverPid; pid = tree.get(pid)!)
            chain.push(pid);
          assert.equal(tree.get(chain.at(-1)!), serverPid, 'chain must end at the tmux server');
          const processes = procargs([worker, ...chain]);
          assert.equal(processes[worker]!.env.LITELLM_API_KEY, MODEL_KEY, 'model key reached pi');
          for (const pid of chain) {
            const { argv, env } = processes[pid]!;
            t.diagnostic(
              `${stage} ${argv.slice(0, 3).join(' ').slice(0, 80)} : ${Object.keys(env).sort().join(' ') || '(macOS returns no environment for this platform binary)'}`,
            );
          }
          const failures: string[] = [];
          // macOS returns no environment for Apple platform binaries (/bin/sh, /bin/bash);
          // the launch shells run the PATH bash, as before, so theirs stay observable.
          assert.ok(
            chain.some((pid) => Object.keys(processes[pid]!.env).length > 0),
            'no outer launch shell environment was observable',
          );
          for (const pid of chain) {
            const { argv, env } = processes[pid]!;
            const sandboxed = env.FARMSLOT_BLIND_SEATBELT === '1';
            const held = Object.entries(env)
              .filter(([, value]) => value.includes('FAKE_SECRET'))
              .map(([name]) => name);
            const illegal = held.filter((name) => !(sandboxed && name === 'LITELLM_API_KEY'));
            if (illegal.length) failures.push(`${argv[0]}(${pid}) env: ${illegal.join(' ')}`);
            if (argv.some((part) => part.includes('FAKE_SECRET')))
              failures.push(`${argv[0]}(${pid}) argv carries a credential value`);
          }
          assert.deepEqual(failures, []);
        } finally {
          process.kill(worker, 'SIGTERM');
        }
      });
    }
  },
);
