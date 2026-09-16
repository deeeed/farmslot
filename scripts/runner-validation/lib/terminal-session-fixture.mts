import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { openSync, closeSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

import type { GatewayConnection } from '../../../packages/cli/src/gateway-client.js';
import type {
  TmuxWorkerListResult,
  TmuxWorkerSummary,
} from '../../../packages/protocol/src/index.js';

/** One isolated tmux server and registered node; never lists or stops operator sessions. */
export async function terminalSessionFixture(input: {
  connection: GatewayConnection;
  root: string;
  fixture: string;
  evidence: string;
  port: number;
}) {
  const { connection, root, fixture, evidence, port } = input;
  const machine = 'session-fixture-node';
  const session = 'session-to-end';
  const protectedSession = 'managed-fixture-session';
  const socket = `fs-terminal-${path.basename(fixture)}`;
  const tmuxBinary = execFileSync('which', ['tmux'], { encoding: 'utf8' }).trim();
  const tmux = (...args: string[]) =>
    execFileSync(tmuxBinary, ['-L', socket, ...args], { encoding: 'utf8' });
  let nodeProcess: ReturnType<typeof spawn> | undefined;
  async function cleanup() {
    if (nodeProcess && nodeProcess.exitCode === null && nodeProcess.signalCode === null)
      process.kill(-nodeProcess.pid!, 'SIGTERM');
    const remaining = spawn(tmuxBinary, ['-L', socket, 'kill-server'], { stdio: 'ignore' });
    await new Promise<void>((resolve, reject) => {
      remaining.once('error', reject);
      // The private server may already have exited after its last session closed.
      remaining.once('exit', (code) =>
        code === 0 || code === 1
          ? resolve()
          : reject(new Error(`Fixture tmux cleanup failed: ${code}`)),
      );
    });
  }
  try {
    tmux('new-session', '-d', '-s', protectedSession, 'sleep 300');
    tmux('new-session', '-d', '-s', session, 'sleep 300');
    const tmuxEnvironment = tmux(
      'display-message',
      '-p',
      '-t',
      protectedSession,
      '#{socket_path},#{pid},0',
    ).trim();
    const nodeRoot = path.join(fixture, 'session-node');
    await mkdir(nodeRoot, { recursive: true });
    await writeFile(
      path.join(fixture, 'pool/session-fixture.json'),
      JSON.stringify({
        machine,
        project: 'review',
        platform: 'cli',
        os: process.platform,
        host: 'localhost',
        ssh_user: '',
        slots: [
          {
            id: 'protected-session-fixture',
            enabled: false,
            repo: fixture,
            session: protectedSession,
          },
        ],
      }),
    );
    const { principal } = await connection.call<{ principal: { id: string } }>('principal.create', {
      subject: { type: 'node', machine, displayName: 'Terminal cleanup fixture' },
      roles: [],
    });
    const credential = await connection.call<{ secret: string }>('credential.issue', {
      principalId: principal.id,
      displayName: 'Isolated node',
    });
    await writeFile(
      path.join(nodeRoot, '.env.local-auth'),
      `FARMSLOT_NODE_TOKEN=${credential.secret}\n`,
      { mode: 0o600 },
    );
    const fd = openSync(path.join(evidence, 'session-node.log'), 'w', 0o600);
    const node = spawn('yarn', ['workspace', '@farmslot/node', 'start'], {
      cwd: root,
      detached: true,
      stdio: ['ignore', fd, fd],
      env: {
        ...process.env,
        FARMSLOT_ROOT: nodeRoot,
        FARMSLOT_NODE_TOKEN: credential.secret,
        GATEWAY_URL: `ws://127.0.0.1:${port}`,
        MACHINE_NAME: machine,
        FARMSLOT_HOME: path.join(nodeRoot, 'home'),
        TMUX: tmuxEnvironment,
        SCREEN_CONTROL_SOCKET: `/tmp/fs-control-${path.basename(fixture)}.sock`,
      },
    });
    nodeProcess = node;
    closeSync(fd);
    let workers: TmuxWorkerSummary[] = [];
    for (let attempt = 0; attempt < 100; attempt++) {
      workers = (await connection.call<TmuxWorkerListResult>('tmux.worker.list', { machine }))
        .workers;
      if (workers.length === 2) break;
      if (node.exitCode !== null) throw new Error('Fixture node exited before registering');
      await delay(200);
    }
    const worker = workers.find((worker) => worker.ref.session === session);
    const protectedWorker = workers.find((worker) => worker.ref.session === protectedSession);
    await writeFile(path.join(evidence, 'session-inventory.json'), JSON.stringify(workers));
    assert(worker?.canEndSession && worker.pid, 'Isolated unmanaged session was not discovered');
    assert(protectedWorker && !protectedWorker.canEndSession);
    await assert.rejects(
      connection.call('tmux.worker.endSession', {
        worker: protectedWorker.ref,
        expectedPid: protectedWorker.pid,
      }),
      /Farmslot workspace/,
    );
    await assert.rejects(
      connection.call('tmux.worker.endSession', {
        worker: worker.ref,
        expectedPid: worker.pid + 1,
      }),
      /Session changed/,
    );
    tmux('has-session', '-t', '=' + session);
    return {
      worker,
      session,
      machine,
      cleanup,
      confirmMessage: `End tmux session "${session}" on ${machine}?\n\nEvery pane and any programs running in this session will stop.`,
      exists: () => {
        tmux('has-session', '-t', '=' + session);
      },
      assertClosed: () => {
        assert.throws(() => tmux('has-session', '-t', '=' + session));
        tmux('has-session', '-t', '=' + protectedSession);
      },
    };
  } catch (error) {
    await cleanup();
    throw error;
  }
}
