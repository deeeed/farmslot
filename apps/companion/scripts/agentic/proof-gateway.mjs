import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

import { WebSocket, WebSocketServer } from 'ws';

/** Transparent live-proof transport: hold real read replies, never change their contents. */
export function startProofReadProxy({ port, gatewayPort, directory }) {
  const control = path.join(directory, 'read-delay.json');
  const audit = path.join(directory, 'phone-rpc.jsonl');
  const held = path.join(directory, 'held-reads.jsonl');
  const server = new WebSocketServer({ host: '127.0.0.1', port });
  server.on('connection', (phone) => {
    const gateway = new WebSocket(`ws://127.0.0.1:${gatewayPort}`);
    const requests = new Map();
    const queued = [];
    const replies = [];
    const timer = setInterval(() => {
      const delayed = fs.existsSync(control) ? JSON.parse(fs.readFileSync(control, 'utf8')) : {};
      if (delayed.runId || phone.readyState !== WebSocket.OPEN) return;
      for (const reply of replies.splice(0)) phone.send(reply, { binary: false });
    }, 100);
    gateway.on('open', () => {
      for (const frame of queued.splice(0)) gateway.send(frame, { binary: false });
    });
    phone.on('message', (frame) => {
      const request = JSON.parse(frame.toString());
      requests.set(request.id, request);
      fs.appendFileSync(audit, JSON.stringify(request) + '\n');
      if (gateway.readyState === WebSocket.OPEN) gateway.send(frame, { binary: false });
      else queued.push(frame);
    });
    gateway.on('message', (frame) => {
      const reply = JSON.parse(frame.toString());
      const request = requests.get(reply.id);
      const delayed = fs.existsSync(control) ? JSON.parse(fs.readFileSync(control, 'utf8')) : {};
      if (request?.method === 'run.get' && delayed.runId === request.params?.runId) {
        replies.push(frame);
        fs.appendFileSync(
          held,
          JSON.stringify({ id: reply.id, runId: request.params.runId }) + '\n',
        );
      } else if (phone.readyState === WebSocket.OPEN) phone.send(frame, { binary: false });
    });
    phone.on('close', () => {
      const runIds = [
        ...new Set(
          [...requests.values()]
            .filter((request) => request.method === 'run.get')
            .map((request) => request.params.runId),
        ),
      ];
      if (runIds.length)
        fs.writeFileSync(
          path.join(directory, 'phone-disconnected.json'),
          JSON.stringify({ runIds }),
        );
      clearInterval(timer);
      gateway.close();
    });
    gateway.on('close', () => phone.close());
    for (const socket of [phone, gateway])
      socket.on('error', (error) => {
        console.error('Private proof transport failed', error);
        phone.close();
        gateway.close();
      });
  });
  return server;
}

export function processAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error.code === 'ESRCH') return false;
    throw error;
  }
}

export function groupAlive(pid) {
  try {
    return processAlive(-pid);
  } catch (error) {
    // macOS can report EPERM while a terminated group is being reaped.
    // Keep polling; only ESRCH confirms the group is gone.
    if (error.code === 'EPERM') return true;
    throw error;
  }
}

export function providerDaemonPid(stateDir) {
  return JSON.parse(fs.readFileSync(path.join(stateDir, 'daemon.json'), 'utf8')).pid;
}

export async function waitForProof(read, timeout = 60_000) {
  const until = Date.now() + timeout;
  while (Date.now() < until) {
    const value = await read();
    if (value) return value;
    await delay(100);
  }
  throw new Error('Proof condition timed out');
}

export function stopProofGateway(pid) {
  try {
    process.kill(-pid, 'SIGTERM');
  } catch (error) {
    if (error.code !== 'ESRCH') throw error;
  }
}

export function proofRPC(root, port, method, params = {}) {
  return JSON.parse(
    execFileSync(
      process.execPath,
      [
        path.join(root, 'apps/command-center/scripts/cdp.mjs'),
        'gateway',
        method,
        JSON.stringify(params),
      ],
      {
        cwd: root,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
        env: {
          ...process.env,
          FARMSLOT_GATEWAY: `ws://127.0.0.1:${port}`,
          FARMSLOT_RPC_TIMEOUT_MS: '45000',
        },
      },
    ),
  );
}
