process.env.NODE_TEST_CONTEXT = '1';

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test, { type TestContext } from 'node:test';

import WebSocket from 'ws';

import {
  Methods,
  type RequestFrame,
  type ResponseFrame,
  type Run,
  type RunListParams,
  type RunListVersion,
} from '@farmslot/protocol';
import { canonicalResourceJson } from '@farmslot/protocol/client-cache';

await import('../../runtime/mock-pty.test-support.js');
const { trimRunForList } = await import('../../runs/list-trim.js');
const { RUN_LIST_PAGE_MAX_BYTES } = await import('../../runs/list-version.js');
const { archiveRun, createRun, deleteRun, getAllRuns, getRun, updateRun } =
  await import('../../runs/store.js');
const { runList } = await import('./context.js');
const { createGatewayAuthRuntime, initializeGatewayIdentity } =
  await import('../../security/auth.js');
const { createWebSocketServer } = await import('../../server.js');

const gatewayDir = path.resolve(import.meta.dirname, '../../..');
const restartFixture = path.join(gatewayDir, 'src/runs/list-version-restart.fixture.ts');

function fixtureRun(t: TestContext, ticketOrPr: string, summary?: string): Run {
  const run = createRun({ flowType: 'dev', project: 'list-versions', ticketOrPr });
  if (summary !== undefined) updateRun(run.id, { summary });
  t.after(async () => {
    if (!getRun(run.id)) return;
    updateRun(run.id, { status: 'done', completedAt: new Date().toISOString() });
    await deleteRun(run.id);
  });
  return getRun(run.id)!;
}

// The contract, computed here rather than through the gateway's helper: sha256 of the served row.
const rowVersion = (row: Run) =>
  createHash('sha256').update(canonicalResourceJson(row)).digest('hex');
const servedVersion = (id: string): RunListVersion => ({
  id,
  version: rowVersion(trimRunForList(getRun(id)!)),
});

// A hang fails its test instead of holding the lane's test lock; cleanup lives in t.after.
const TEST_TIMEOUT = { timeout: 15_000 };

test(
  'a versions read lists every live run in store order, ignoring filters, limit and ids',
  TEST_TIMEOUT,
  async (t) => {
    const running = fixtureRun(t, 'VERSIONS-RUNNING');
    updateRun(running.id, { status: 'monitoring' });
    const listed = fixtureRun(t, 'VERSIONS-TRIMMED');
    updateRun(listed.id, {
      output: {
        workerFinished: true,
        capturedAt: new Date().toISOString(),
        manifestDigest: 'digest',
        artifactManifest: [{ path: 'artifacts/report.md', purpose: 'report' }],
      } as Run['output'],
    });
    // The version is of the row run.list serves, not of the stored run.
    assert.notDeepEqual(trimRunForList(getRun(listed.id)!), getRun(listed.id));
    const archived = fixtureRun(t, 'VERSIONS-ARCHIVED');
    updateRun(archived.id, { status: 'done', completedAt: new Date().toISOString() });
    assert.equal(await archiveRun(archived.id), true);

    const reply = await runList({
      versions: true,
      status: 'monitoring',
      limit: 1,
      ids: [running.id],
    } as RunListParams);

    assert.deepEqual(reply.runs, []);
    assert.deepEqual(
      reply.versions,
      getAllRuns().map((run) => servedVersion(run.id)),
    );
    assert.ok(!reply.versions?.some((entry) => entry.id === archived.id), 'archived runs excluded');
    assert.equal(reply.totalCount, reply.versions?.length);
    assert.equal(reply.summaryMeta, undefined);

    const summarized = await runList({ versions: true, includeFamilySummaries: true });
    const live = getAllRuns().length;
    assert.deepEqual(summarized.summaryMeta, {
      scope: 'returned-runs',
      summaryRunCount: live,
      totalCount: live,
      isTruncated: false,
    });
    assert.ok(summarized.familySummaries?.some((family) => family.familyId === running.familyId));
  },
);

test(
  'an ids page serves rows in the order asked, stops before 2 MB and skips unknown ids',
  TEST_TIMEOUT,
  async (t) => {
    const large = 'x'.repeat(900_000);
    const a = fixtureRun(t, 'PAGE-A', large);
    const b = fixtureRun(t, 'PAGE-B', large);
    const c = fixtureRun(t, 'PAGE-C', large);
    const d = fixtureRun(t, 'PAGE-D');
    const oversized = fixtureRun(t, 'PAGE-OVERSIZED', 'y'.repeat(RUN_LIST_PAGE_MAX_BYTES + 1));
    const page = async (ids: string[]) => {
      const reply = await runList({ ids });
      assert.equal(reply.totalCount, reply.runs.length, 'an ids page counts the rows it served');
      assert.deepEqual(
        reply.versions,
        reply.runs.map((row) => ({ id: row.id, version: rowVersion(row) })),
      );
      assert.deepEqual(
        reply.runs,
        reply.runs.map((row) => trimRunForList(getRun(row.id)!)),
      );
      return reply.runs.map((row) => row.id);
    };

    // c and a fit; b would take the page past the cap, so the page stops before it.
    assert.deepEqual(await page([c.id, 'missing-run', a.id, b.id, d.id]), [c.id, a.id]);
    // The client asks again for the ids after the last served one.
    assert.deepEqual(await page([b.id, d.id]), [b.id, d.id]);
    // The first row is always served, so an oversized row goes alone.
    assert.deepEqual(await page([oversized.id, d.id]), [oversized.id]);
    assert.deepEqual(await page([d.id, oversized.id]), [d.id]);
    assert.deepEqual(await page([d.id, d.id, 'missing-run']), [d.id]);
    assert.deepEqual(await page(['missing-run']), []);
    // Filters, sort, limit and summary flags do not apply to a catch-up page.
    const filtered = await runList({
      ids: [d.id, c.id],
      status: 'monitoring',
      sort: 'oldest',
      limit: 1,
      includeFamilySummaries: true,
    });
    assert.deepEqual(
      filtered.runs.map((row) => row.id),
      [d.id, c.id],
    );
    assert.equal(filtered.familySummaries, undefined);
    await assert.rejects(runList({ ids: [1] } as unknown as RunListParams), {
      code: 'INVALID_PARAMS',
    });
  },
);

test('an unchanged row keeps its version across a gateway restart', { timeout: 90_000 }, (t) => {
  const root = mkdtempSync(path.join(tmpdir(), 'run-list-version-restart-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const runsDir = path.join(root, 'runs');
  const lifetime = (mode: 'create' | 'load' | 'change') => {
    // The store logs to stdout, so each lifetime reports through its own file.
    const output = path.join(root, `${mode}.json`);
    execFileSync(process.execPath, ['--import', 'tsx', restartFixture, mode, output], {
      cwd: gatewayDir,
      env: { ...process.env, FARMSLOT_RUNS_DIR: runsDir, TSX_TSCONFIG_PATH: 'tsconfig.json' },
      stdio: 'ignore',
      timeout: 25_000,
    });
    return JSON.parse(readFileSync(output, 'utf8')) as {
      versions: RunListVersion[];
      changed?: RunListVersion[];
    };
  };
  const byId = (versions: RunListVersion[]) =>
    [...versions].sort((left, right) => left.id.localeCompare(right.id));

  const created = lifetime('create');
  assert.equal(created.versions.length, 2);
  const first = lifetime('load');
  const second = lifetime('change');
  // Two real store loads of the same files give every row the same version.
  assert.deepEqual(byId(second.versions), byId(first.versions));
  assert.deepEqual(byId(first.versions), byId(created.versions));
  // The version follows the row: the one changed run gets a new version, the other keeps its own.
  const [changedId] = second.versions.map((entry) => entry.id);
  for (const entry of second.changed!) {
    const before = first.versions.find((version) => version.id === entry.id)!;
    if (entry.id === changedId) assert.notEqual(entry.version, before.version);
    else assert.equal(entry.version, before.version);
  }
});

test(
  'version lists and catch-up pages keep run.list operator authorization',
  TEST_TIMEOUT,
  async (t) => {
    const home = mkdtempSync(path.join(tmpdir(), 'run-list-versions-auth-'));
    t.after(() => rmSync(home, { recursive: true, force: true }));
    const runtime = createGatewayAuthRuntime({ FARMSLOT_HOME: home, GATEWAY_HOST: '127.0.0.1' });
    initializeGatewayIdentity(runtime, { host: '127.0.0.1' });
    const operator = runtime.writer.createPrincipal(
      { type: 'service', displayName: 'versions-operator' },
      [{ role: 'operator', scope: { kind: 'global' } }],
    );
    const outsider = runtime.writer.createPrincipal(
      { type: 'service', displayName: 'versions-outsider' },
      [],
    );
    // Credentials are issued before any session exists: an authority change closes live sockets.
    const tokens = new Map(
      [operator, outsider].map((principal) => [
        principal.id,
        runtime.writer.issueCredential(principal.id, 'versions-proof').secret,
      ]),
    );
    const server = createServer();
    const wss = createWebSocketServer(server, runtime);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    t.after(async () => {
      for (const client of wss.clients) client.terminate();
      await new Promise<void>((resolve) => wss.close(() => resolve()));
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    });
    const { port } = server.address() as { port: number };
    for (const [principal, allowed] of [
      [operator, true],
      [outsider, false],
    ] as const) {
      const ws = new WebSocket(`ws://127.0.0.1:${port}`);
      t.after(() => ws.terminate());
      await new Promise<void>((resolve, reject) => {
        ws.once('open', resolve);
        ws.once('error', reject);
        ws.once('close', (code) => reject(new Error(`socket closed before open (${code})`)));
      });
      const token = tokens.get(principal.id);
      assert.equal((await request(ws, Methods.AUTH_CONNECT, { clientKind: 'ui', token })).ok, true);
      for (const params of [{ versions: true }, { ids: ['missing-run'] }]) {
        const reply = await request(ws, Methods.RUN_LIST, params);
        assert.equal(reply.ok, allowed, JSON.stringify(params));
        if (allowed) assert.ok(Array.isArray((reply.payload as { versions?: unknown }).versions));
        else assert.equal(reply.error?.code, 'AUTH_FORBIDDEN');
      }
      ws.close();
    }
  },
);

let requestId = 0;
function request(ws: WebSocket, method: string, params: unknown): Promise<ResponseFrame> {
  const id = `run-list-versions-${++requestId}`;
  const response = new Promise<ResponseFrame>((resolve, reject) => {
    const onMessage = (data: WebSocket.RawData) => {
      const frame = JSON.parse(data.toString()) as ResponseFrame;
      if (frame.type !== 'res' || frame.id !== id) return;
      ws.off('message', onMessage);
      resolve(frame);
    };
    ws.on('message', onMessage);
    ws.once('error', reject);
    // A session the server closes fails the request at once instead of waiting it out.
    ws.once('close', (code, reason) =>
      reject(new Error(`socket closed before ${method} replied (${code} ${reason.toString()})`)),
    );
  });
  const frame: RequestFrame = { type: 'req', id, method, params };
  ws.send(JSON.stringify(frame));
  return response;
}
