// A PR rule change through the production websocket server reaches a connected client as one
// small `pr-automation` resource change, and the client reads the rules through prRules.list.
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import WebSocket from 'ws';

import {
  type EventFrame,
  Events,
  type PRRuleSaveResult,
  type PRRulesListResult,
  type PRTeamConfig,
  type PRTriggerRuleConfig,
  type ResourceChangedPayload,
  type ResponseFrame,
} from '@farmslot/protocol';

const root = realpathSync(mkdtempSync(join(tmpdir(), 'pr-rules-broadcast-')));
for (const dir of ['scripts', 'services/gateway', 'pool', 'projects', 'home'])
  mkdirSync(join(root, dir), { recursive: true });
writeFileSync(join(root, 'CLAUDE.md'), '# Private fixture');
writeFileSync(join(root, 'scripts/dev.sh'), '#!/bin/sh');
writeFileSync(join(root, 'services/gateway/package.json'), '{}');
process.env.FARMSLOT_ROOT = root;
process.env.FARMSLOT_HOME = join(root, 'home');
process.env.FARMSLOT_POOL_DIR = join(root, 'pool');
process.env.FARMSLOT_PROJECTS_DIR = join(root, 'projects');

await import('../runtime/mock-pty.test-support.js');
const { createGatewayAuthRuntime } = await import('../security/auth.js');
const { broadcastEvent, broadcastPrincipalEvent, createWebSocketServer } =
  await import('../server.js');
const { resourceRevisions } = await import('../resources/revisions.js');
const { initPRMonitoring } = await import('./pr-watch.js');
const { initPRRules } = await import('./pr-rules.js');

const team: PRTeamConfig = {
  name: 'Team',
  account: { host: 'github.com', login: 'reader' },
  sources: [{ kind: 'repository', repo: 'owner/repo' }],
  predicate: { kind: 'compare', field: 'state', operator: 'equals', value: 'open' },
  repositories: [
    { repo: 'owner/repo', project: 'project', reviewProfile: 'standard', excludedLabels: [] },
  ],
  execution: {
    slotPolicy: { kind: 'exact', slotId: 'slot-a' },
    models: [{ mode: 'cold', runner: 'runner', model: 'model', effort: 'high' }],
  },
  githubTeams: [],
  notificationPrincipalIds: [],
};

test('a rule change reaches the client as a resource change, not the rules list', async (t) => {
  const auth = createGatewayAuthRuntime({ FARMSLOT_HOME: join(root, 'home') });
  // The gateway's own publisher (server.ts initServerGlobals) without the rest of its startup.
  resourceRevisions.setPublisher((payload) => broadcastEvent(Events.RESOURCE_CHANGED, payload));
  const monitors = await initPRMonitoring(auth, broadcastPrincipalEvent, false);
  const rules = await initPRRules(auth, broadcastPrincipalEvent, false, monitors);
  const server = createServer();
  const wss = createWebSocketServer(server, auth);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    rules.stop();
    monitors.stop();
    resourceRevisions.setPublisher(() => {});
    for (const client of wss.clients) client.terminate();
    await new Promise<void>((resolve) => wss.close(() => resolve()));
    await new Promise<void>((resolve) => server.close(() => resolve()));
    rmSync(root, { recursive: true, force: true });
  });

  const owner = auth.writer.createPrincipal({ type: 'service', displayName: 'Rule owner' }, [
    { role: 'admin', scope: { kind: 'global' } },
  ]);
  const credential = auth.writer.issueCredential(owner.id, 'pr rules broadcast test');
  // Setup-time seed: a team save resolves its GitHub account, a rule save does not.
  const saved = await rules.store.saveTeam(owner.id, team);

  const ws = new WebSocket(`ws://127.0.0.1:${(server.address() as { port: number }).port}/ws`);
  t.after(() => ws.terminate());
  await new Promise<void>((resolve, reject) => {
    ws.once('open', resolve);
    ws.once('error', reject);
  });
  const changes: ResourceChangedPayload[] = [];
  const events: Array<{ event: string; bytes: number }> = [];
  let requests = 0;
  ws.on('message', (data) => {
    const frame: EventFrame = JSON.parse(data.toString());
    if (frame.type !== 'event') return;
    if (frame.event === Events.RESOURCE_CHANGED)
      changes.push(frame.payload as ResourceChangedPayload);
    else events.push({ event: frame.event, bytes: Buffer.byteLength(data.toString()) });
  });
  const request = <T>(method: string, params: unknown) => {
    const id = `rules-${++requests}`;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`${method} timed out`)), 5000);
      const receive = (data: WebSocket.RawData) => {
        const frame: ResponseFrame = JSON.parse(data.toString());
        if (frame.type !== 'res' || frame.id !== id) return;
        clearTimeout(timer);
        ws.off('message', receive);
        if (frame.ok) resolve(frame.payload as T);
        else reject(new Error(JSON.stringify(frame.error)));
      };
      ws.on('message', receive);
      ws.send(JSON.stringify({ type: 'req', id, method, params }));
    });
  };
  await request('auth.connect', { clientKind: 'ui', token: credential.secret });
  events.length = 0;
  changes.length = 0;

  const config: PRTriggerRuleConfig = {
    name: 'Review',
    teamId: saved.id,
    predicate: team.predicate,
    actions: [{ kind: 'notify' }],
    pollIntervalMs: 300_000,
    maxAdmissionsPerScan: 1,
    rereviewOnHeadChange: false,
  };
  const { rule } = await request<PRRuleSaveResult>('prRules.ruleSave', { config });
  const changed = () =>
    changes.some((payload) =>
      payload.changes.some(
        ({ key }) => key.family === 'pr-automation' && Object.keys(key).length === 2,
      ),
    );
  for (let waited = 0; !changed() && waited < 2000; waited += 10)
    await new Promise((resolve) => setTimeout(resolve, 10));
  assert.ok(changed(), 'the rule save publishes the pr-automation resource');
  assert.deepEqual(events, [], 'no event carries the rules list');

  const list = await request<PRRulesListResult>('prRules.list', {});
  assert.deepEqual(
    list.rules.map((item) => [item.id, item.config.name]),
    [[rule.id, 'Review']],
  );
});
