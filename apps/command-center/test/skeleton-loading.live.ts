// Manual browser tier: FARMSLOT_CDP_PORT=9323 node --import tsx --test <this-file>.
// Uses the production shell and workspace against an isolated read-only protocol fixture.
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer as createHttpServer } from 'node:http';
import { createServer as createPortProbe } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath, URL } from 'node:url';
import { promisify } from 'node:util';

import { createServer } from 'vite';
import { type WebSocket, WebSocketServer } from 'ws';

import { Methods } from '@farmslot/protocol';

const root = fileURLToPath(new URL('../../../', import.meta.url));
const execute = promisify(execFile);
const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null;

test(
  'production workspace keeps its boundary and cached read through compact, refresh and error states',
  { skip: !process.env.FARMSLOT_CDP_PORT },
  async (t) => {
    const server = createHttpServer();
    const wss = new WebSocketServer({ server });
    const pending: Array<{ socket: WebSocket; id: string }> = [];
    let reads = 0;
    const reply = (socket: WebSocket, id: string, payload: unknown, error?: string) =>
      socket.send(
        JSON.stringify({
          type: 'res',
          id,
          ok: !error,
          ...(error ? { error: { code: 'FIXTURE_READ_FAILED', message: error } } : { payload }),
        }),
      );
    const emptyFleet = {
      checkedAt: new Date().toISOString(),
      slots: [],
      summary: {
        total: 0,
        ready: 0,
        busy: 0,
        held: 0,
        manual: 0,
        disabled: 0,
        blocked: 0,
        warmCount: 0,
      },
    };
    const snapshots: Record<string, unknown> = {
      [Methods.FLEET_STATUS]: { fleet: emptyFleet },
      [Methods.RUN_LIST]: { runs: [] },
      [Methods.DECISION_LIST]: { decisions: [] },
      [Methods.DISPATCH_QUEUE_LIST]: { items: [] },
      [Methods.BACKLOG_LIST]: { items: [] },
      [Methods.WORK_GRAPH_LIST]: { graphs: [] },
      [Methods.CONFIG_PROJECTS]: { projects: [] },
      [Methods.PR_LIST]: { prs: [] },
      [Methods.TMUX_WORKER_LIST]: { nodes: [], workers: [] },
      [Methods.NODES_LIST]: { nodes: [] },
    };
    wss.on('connection', (socket) =>
      socket.on('message', (raw) => {
        const frame: unknown = JSON.parse(raw.toString());
        if (
          !isRecord(frame) ||
          frame.type !== 'req' ||
          typeof frame.id !== 'string' ||
          typeof frame.method !== 'string'
        )
          throw new Error('Invalid fixture request');
        if (frame.method === Methods.AUTH_CONNECT)
          return reply(socket, frame.id, {
            ok: true,
            capabilities: { workspaceAccess: 'farm' },
            principal: {
              id: 'fixture-reader',
              subjectKind: 'service',
              displayName: 'Fixture reader',
              roles: [{ role: 'admin', scope: { kind: 'global' } }],
            },
          });
        if (frame.method === Methods.RUN_RECIPE_RUNS_FOR_RUN) {
          reads++;
          pending.push({ socket, id: frame.id });
          return;
        }
        if (frame.method in snapshots) return reply(socket, frame.id, snapshots[frame.method]);
        reply(socket, frame.id, null, 'Read-only fixture: unsupported request');
      }),
    );
    t.after(async () => {
      for (const socket of wss.clients) socket.terminate();
      await new Promise<void>((resolve) => wss.close(() => resolve()));
      if (server.listening)
        await new Promise<void>((resolve, reject) =>
          server.close((error) => (error ? reject(error) : resolve())),
        );
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    assert.ok(address && typeof address !== 'string');
    const probe = createPortProbe();
    await new Promise<void>((resolve) => probe.listen(0, '127.0.0.1', resolve));
    const proposed = probe.address();
    assert.ok(proposed && typeof proposed !== 'string');
    const port = proposed.port;
    await new Promise<void>((resolve, reject) =>
      probe.close((error) => (error ? reject(error) : resolve())),
    );
    const cache = await mkdtemp(path.join(tmpdir(), 'skeleton-vite-'));
    t.after(() => rm(cache, { recursive: true, force: true }));
    const vite = await createServer({
      cacheDir: cache,
      root: path.join(root, 'apps/command-center/ui'),
      configFile: path.join(root, 'apps/command-center/ui/vite.config.ts'),
      envFile: false,
      define: {
        'import.meta.env.VITE_FARMSLOT_GATEWAY_URL': JSON.stringify(
          `ws://127.0.0.1:${address.port}`,
        ),
      },
      server: { host: '127.0.0.1', port, strictPort: true },
    });
    t.after(() => vite.close());
    await vite.listen();
    const env = { ...process.env, FARMSLOT_UI_URL: `http://127.0.0.1:${port}` };
    const cdp = async (...args: string[]) =>
      (
        await execute(
          process.execPath,
          [path.join(root, 'apps/command-center/scripts/cdp.mjs'), ...args],
          { env, timeout: 30_000 },
        )
      ).stdout.trim();
    const route = `dev/async-workspace?capture=1&fixture=${port}`;
    const opened = JSON.parse(await cdp('goto', route, '--new'));
    t.after(async () => {
      const response = await fetch(
        `http://127.0.0.1:${env.FARMSLOT_CDP_PORT}/json/close/${opened.id}`,
      );
      assert.ok(response.ok);
    });
    const waitFor = async (expression: string) =>
      assert.equal(
        await cdp(
          'eval',
          route,
          `const until=Date.now()+15000;while(!(${expression})&&Date.now()<until)await new Promise(r=>setTimeout(r,40));return Boolean(${expression});`,
        ),
        'true',
        expression,
      );
    const waitReads = async (expected: number) => {
      const until = Date.now() + 10_000;
      while (reads < expected && Date.now() < until)
        await new Promise<void>((resolve) => setTimeout(resolve, 20));
      assert.equal(reads, expected);
    };
    const measure = async () =>
      JSON.parse(
        await cdp(
          'eval',
          route,
          "const el=document.querySelector('ready-workspace');if(!el?.querySelector('.publication-gate'))throw Error('Production gate missing');return JSON.stringify({height:el.getBoundingClientRect().height,below:document.querySelector('[data-testid=workspace-layout-anchor]').getBoundingClientRect().top-el.getBoundingClientRect().top});",
        ),
      );
    await waitFor("document.querySelector('ready-workspace .publication-gate')");
    assert.equal(
      await cdp(
        'eval',
        route,
        "return document.querySelectorAll('.gate-loading-judgment').length;",
      ),
      '4',
    );
    const compact = await measure();
    assert.equal(reads, 0);
    await cdp('click', route, '[data-workspace-phase=loaded]');
    await waitReads(1);
    const loadedMetadata = await measure();
    assert.equal(loadedMetadata.below, compact.below);
    const output = process.env.FARMSLOT_SKELETON_PROOF_DIR;
    if (output) await mkdir(output, { recursive: true });
    const first = pending.shift();
    assert.ok(first);
    reply(first.socket, first.id, null, 'Cold evidence read failure');
    await waitFor("document.querySelector('.gate-read-error')");
    const coldError = await measure();
    assert.equal(coldError.below, compact.below);
    if (output) await cdp('screenshot', route, path.join(output, 'cold-error.png'));
    await cdp('click', route, '.gate-status button');
    await waitReads(2);
    if (output) await cdp('screenshot', route, path.join(output, 'cold-retry.png'));
    assert.equal(
      await cdp(
        'eval',
        route,
        "return document.querySelector('.publication-gate')?.getAttribute('aria-busy');",
      ),
      'true',
      'A cold Retry must show loading until evidence arrives',
    );
    assert.equal(
      await cdp(
        'eval',
        route,
        "return document.querySelectorAll('.gate-loading-judgment').length;",
      ),
      '4',
    );
    assert.equal(
      await cdp('eval', route, "return Boolean(document.querySelector('.gate-read-error'));"),
      'false',
    );
    const coldRetry = await measure();
    assert.equal(coldRetry.below, compact.below);
    const coldRetried = pending.shift();
    assert.ok(coldRetried);
    reply(coldRetried.socket, coldRetried.id, { recipeRuns: [], selectedRecipeRunId: null });
    await waitFor(
      "document.querySelector('.publication-gate')?.getAttribute('aria-busy')==='false'",
    );
    const loaded = await measure();
    assert.equal(loaded.below, compact.below);
    await cdp('click', route, '[data-workspace-phase=refreshing]');
    await waitReads(3);
    await cdp('click', route, '[data-workspace-phase=refreshing]');
    assert.equal(reads, 3);
    assert.equal(
      await cdp(
        'eval',
        route,
        "return document.querySelector('.publication-gate')?.getAttribute('aria-busy');",
      ),
      'false',
    );
    const refreshing = await measure();
    assert.equal(refreshing.below, compact.below);
    const failed = pending.shift();
    assert.ok(failed);
    reply(failed.socket, failed.id, null, 'Temporary evidence read failure');
    await waitFor("document.querySelector('.gate-read-error')");
    const error = await measure();
    assert.equal(error.below, compact.below);
    await cdp('click', route, '.gate-status button');
    await waitReads(4);
    const retried = pending.shift();
    assert.ok(retried);
    reply(retried.socket, retried.id, { recipeRuns: [], selectedRecipeRunId: null });
    await waitFor("!document.querySelector('.gate-read-error')");
    await cdp('click', route, '[data-workspace-phase=paused]');
    assert.equal(
      await cdp(
        'eval',
        route,
        "return document.querySelector('[data-testid=gate-approve]')?.textContent?.includes('Submitting');",
      ),
      'false',
    );
    const paused = await measure();
    assert.equal(paused.below, compact.below);
    if (output) {
      await writeFile(
        path.join(output, 'workspace-layout.json'),
        JSON.stringify(
          {
            compact,
            loadedMetadata,
            coldError,
            coldRetry,
            loaded,
            refreshing,
            error,
            paused,
            reads,
            maxShift: 0,
          },
          null,
          2,
        ),
      );
      await cdp('screenshot', route, path.join(output, 'workspace-paused.png'));
    }
  },
);
