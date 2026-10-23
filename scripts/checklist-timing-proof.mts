/** Read-only candidate timing endpoint over the existing live gateway. No run operations. */
import { appendFile, mkdir } from 'node:fs/promises';
import path from 'node:path';

import { WebSocket, WebSocketServer } from 'ws';

import type { TaskProgressParams, TaskProgressResult } from '@farmslot/protocol';

import { GatewayClient } from '../packages/cli/src/gateway-client.js';
import { resolveGatewayTarget } from '../packages/cli/src/gateway-profiles.js';
import { attachChecklistTiming } from '../services/gateway/src/tasks/checklist-timing-read.js';

const [profile, portArg, output] = process.argv.slice(2);
if (!profile || !output || !Number.isInteger(Number(portArg)))
  throw new Error('Usage: checklist-timing-proof.mts <upstream-profile> <port> <evidence-dir>');
const target = resolveGatewayTarget({ gateway: profile });
const reader = new GatewayClient({ ...target, timeout: 30000 });
await mkdir(output, { recursive: true });
const audit = (value: unknown) =>
  appendFile(path.join(output, 'candidate-reads.jsonl'), JSON.stringify(value) + '\n');
const allowed = new Set([
  'auth.connect',
  'ping',
  'fleet.status',
  'fleet.subscribe',
  'fleet.unsubscribe',
  'run.list',
  'run.get',
  'run.summary',
  'run.artifacts.list',
  'run.artifacts.read',
  'decision.list',
  'task.progress',
  'fs.list',
  'fs.read',
  'nodes.list',
  'gateway.status',
  'project.list',
  'settings.get',
  'family.list',
  'family.get',
]);

async function candidate(params: TaskProgressParams, result: TaskProgressResult) {
  if (!result.structured || !params.runId || !params.slotId) return result;
  const { run } = await reader.call('run.get', { runId: params.runId });
  const context = run.agentContexts?.find((entry) => entry.id === result.contextId);
  const taskFile = params.taskFile ?? context?.taskFile ?? run.activeTaskFile ?? run.taskFile;
  if (!taskFile) throw new Error('Live run has no checklist location');
  const checklist =
    path.basename(taskFile) === 'TASK.md'
      ? path.join(path.dirname(taskFile), 'CHECKLIST.md')
      : taskFile;
  const relative = (absolute: string) => {
    if (absolute.startsWith('/proof-source/')) return absolute.slice('/proof-source/'.length);
    const marker = absolute.indexOf('/.task/');
    if (marker >= 0) return absolute.slice(marker + 1);
    if (!path.isAbsolute(absolute)) return absolute;
    throw new Error('Proof reads are limited to the live run task directory');
  };
  await attachChecklistTiming(
    {
      host: 'proof-source.invalid',
      machine: 'proof-source',
      sshTarget: '',
      nodeRequest: async (method, params) => {
        if (
          !params ||
          typeof params !== 'object' ||
          !('root' in params) ||
          !('relPath' in params) ||
          typeof params.root !== 'string' ||
          typeof params.relPath !== 'string'
        )
          throw new Error('Invalid file read');
        const file = relative(path.join(params.root, params.relPath));
        if (method === 'fs.read')
          return reader.call('fs.read', { slotId: run.slotId!, path: file });
        if (method === 'fs.exists') {
          const { entries } = await reader.call('fs.list', {
            slotId: run.slotId!,
            path: path.dirname(file),
            includeIgnored: true,
          });
          return { exists: entries.some((entry) => entry.name === path.basename(file)) };
        }
        throw new Error(`Unsupported proof read: ${method}`);
      },
    },
    path.isAbsolute(checklist) ? checklist : path.join('/proof-source', checklist),
    result.structured,
    run,
    context,
  );
  await audit({
    runId: run.id,
    checklist,
    timing: result.structured.timing,
    readAt: new Date().toISOString(),
  });
  return result;
}

const server = new WebSocketServer({ host: '127.0.0.1', port: Number(portArg) });
server.on('connection', (client) => {
  const upstream = new WebSocket(target.url);
  const pending = new Map<string, { method: string; params: TaskProgressParams }>();
  const queued: string[] = [];
  upstream.on('open', () => {
    for (const frame of queued.splice(0)) upstream.send(frame);
  });
  client.on('message', (data) => {
    const frame = JSON.parse(data.toString());
    if (!allowed.has(frame.method)) {
      client.send(
        JSON.stringify({
          type: 'res',
          id: frame.id,
          ok: false,
          error: { code: 'PROOF_READ_ONLY', message: 'Read-only checklist proof' },
        }),
      );
      return;
    }
    pending.set(frame.id, frame);
    if (upstream.readyState === WebSocket.OPEN) upstream.send(data.toString());
    else queued.push(data.toString());
  });
  upstream.on('message', (data) => {
    void (async () => {
      const frame = JSON.parse(data.toString());
      const request = pending.get(frame.id);
      if (frame.type === 'res') pending.delete(frame.id);
      if (request?.method === 'task.progress' && frame.ok && frame.payload)
        frame.payload = await candidate(request.params, frame.payload);
      if (client.readyState === WebSocket.OPEN) client.send(JSON.stringify(frame));
    })().catch((error) => {
      console.error(error);
      client.close(1011, 'Candidate read failed');
    });
  });
  for (const socket of [client, upstream])
    socket.on('error', (error) => {
      console.error(error);
      client.close();
      upstream.close();
    });
  client.on('close', () => upstream.close());
  upstream.on('close', () => client.close());
});
console.log(
  JSON.stringify({ ready: true, port: Number(portArg), upstream: target.url, readOnly: true }),
);
for (const signal of ['SIGTERM', 'SIGINT'])
  process.once(signal, () => {
    for (const client of server.clients) client.terminate();
    server.close();
  });
