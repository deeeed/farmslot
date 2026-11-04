import { measurePerformanceOverhead } from './performance-overhead.mjs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { judgePerformanceWorkload } from './performance-budget.mjs';
import assert from 'node:assert/strict';
import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { readFile, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir, hostname } from 'node:os';
import path from 'node:path';
import { createServer as createViteServer, type ViteDevServer } from 'vite';
import {
  performanceBudgetVerdicts,
  slowestActions,
  type PerformanceSnapshot,
} from '../../../packages/protocol/src/performance/index.js';
import type { Run } from '../../../packages/protocol/src/index.js';
import {
  freePort,
  linkCheckout,
  startIsolatedStack,
  stopProcess,
  type IsolatedStackParts,
  type Reaper,
} from '../lib/isolated-stack.mjs';
import type { CheckResult } from './outcome.mjs';

export interface PerformanceCanaryOptions {
  root: string;
  evidence: string;
  reaper: Reaper;
  onCleanup: (cleanup: () => Promise<string[]>) => void;
  onMeasured?: (context: { fixture: string; webUrl: string; cdpPort: number }) => Promise<void>;
}
/** Versioned normal workload, deliberately separate from restart/fault scenarios. */
export async function runPerformanceCanary(
  options: PerformanceCanaryOptions,
): Promise<CheckResult> {
  const { root, evidence, reaper } = options;
  const started = performance.now(),
    fixture = await mkdtemp(path.join(tmpdir(), 'farmslot-performance-'));
  const out = path.join(evidence, 'performance');
  await mkdir(out, { recursive: true });
  const parts: IsolatedStackParts = {};
  let browser: ChildProcess | undefined, vite: ViteDevServer | undefined;
  let cleanupPromise: Promise<string[]> | undefined;
  const cleanup = () =>
    (cleanupPromise ??= (async () => {
      parts.connection?.close();
      await stopProcess(browser);
      await vite?.close();
      await stopProcess(parts.node);
      await stopProcess(parts.gateway);
      await rm(fixture, { recursive: true, force: true });
      return [];
    })());
  options.onCleanup(cleanup);
  reaper.path(fixture);
  const check: CheckResult = {
    case: 'performance',
    variant: 'workload-v1',
    target: 'isolated',
    status: 'fail',
    model: 'none',
    modelCalls: 0,
    differences: [],
    observations: [],
    evidence: out,
  };
  let snapshot: PerformanceSnapshot | undefined;
  try {
    await linkCheckout(root, fixture, 'Normal performance fixture');
    for (const dir of ['runs', 'projects/performance/tasks', 'pool'])
      await mkdir(path.join(fixture, dir), { recursive: true });
    const now = new Date().toISOString();
    for (let i = 0; i < 100; i++) {
      const run: Run = {
        id: `perf-run-${i}`,
        familyId: `perf-family-${i % 4}`,
        parentRunId: null,
        familyRootTicketOrPr: `PERF-${i % 4}`,
        lane: 'production',
        variant: null,
        flowType: 'fix-bug',
        mode: 'interactive',
        status: 'done',
        project: 'performance',
        ticketOrPr: `PERF-${i % 4}`,
        slotId: null,
        branch: null,
        taskFile: null,
        steps: [],
        decisions: [],
        metrics: {
          nudgeCount: 0,
          model: 'scripted',
          runner: 'scripted',
          runnerSessionId: null,
          runnerSessionPath: null,
        },
        createdAt: now,
        updatedAt: now,
        completedAt: now,
        summary: `Performance record ${i}`,
      };
      await writeFile(path.join(fixture, 'runs', `${run.id}.json`), JSON.stringify(run));
    }
    const slots = Array.from({ length: 8 }, (_, i) => ({
      id: `performance-${i}`,
      platform: 'cli',
      enabled: false,
      repo: path.join(fixture, `slot-${i}`),
    }));
    await writeFile(
      path.join(fixture, 'pool', 'performance.json'),
      JSON.stringify({ machine: 'performance-fixture', host: 'localhost', slots }),
    );
    await writeFile(
      path.join(fixture, 'projects/performance/project.json'),
      JSON.stringify({
        name: 'performance',
        task_dir: path.join(fixture, 'projects/performance/tasks'),
      }),
    );
    for (let i = 0; i < 20; i++) {
      const dir = path.join(fixture, 'projects/performance/tasks', `gate-${i}`);
      await mkdir(dir, { recursive: true });
      await writeFile(
        path.join(dir, '.pending_decision.json'),
        JSON.stringify({
          id: `perf-gate-${i}`,
          type: 'blocked_alert',
          title: 'Non-publishing fixture gate',
          actions: [{ id: 'ack', label: 'Acknowledge' }],
        }),
      );
    }
    const env: NodeJS.ProcessEnv = { ...process.env };
    for (const key of Object.keys(env))
      if (/^(FARMSLOT_|GATEWAY_|TMUX|TSX_)|^(GH_|GITHUB_|NPM_)|_TOKEN$|_PAT$|_API_KEY$/.test(key))
        delete env[key];
    const stack = await startIsolatedStack({ root, evidence: out, fixture, env, reaper }, parts);
    const call = <T,>(method: string, params: unknown = {}) =>
      stack.connection.call<T>(method, params, { timeoutMs: 120000 });
    const initial = await call<{ runs: Run[] }>('run.list', { limit: 100 });
    assert.equal(initial.runs.length, 100);
    const fleet = await call<{ fleet: { slots: Array<{ slot: string }> } }>('fleet.status');
    assert.equal(fleet.fleet.slots.length, 8);
    const family = await call<{ snapshot: { familyId: string; runs: unknown[] } }>(
      'family.observability.get',
      { familyId: 'perf-family-0', project: 'performance' },
    );
    assert.equal(family.snapshot.familyId, 'perf-family-0');
    assert.equal(family.snapshot.runs.length, 25);
    const gates = await call<{ decisions: Array<{ id: string }> }>('decision.list');
    assert.equal(gates.decisions.length, 20);
    const windowStart = performance.now();
    let resolveBrowser!: (result: unknown) => void;
    const browserResult = new Promise<unknown>((resolve) => {
      resolveBrowser = resolve;
    });

    const handleBrowser = async (req: IncomingMessage, res: ServerResponse, next: () => void) => {
      if (req.url === '/performance-rpc' || req.url === '/performance-result') {
        try {
          let body = '';
          for await (const chunk of req) body += chunk.toString();
          const input: unknown = JSON.parse(body);
          if (req.url === '/performance-result') {
            resolveBrowser(input);
            res.end('{}');
            return;
          }
          assert(
            input &&
              typeof input === 'object' &&
              'method' in input &&
              typeof input.method === 'string',
          );
          const allowed = ['run.get', 'gateway.performance.report'];
          assert(allowed.includes(input.method));
          const result = await call(input.method, 'params' in input ? input.params : {});
          res.setHeader('Content-Type', 'application/json');
          res.end(JSON.stringify(result));
        } catch (error) {
          res.statusCode = 500;
          res.end(String(error));
        }
        return;
      }
      if (req.url === '/doctor-proof.html') {
        const html = await readFile(path.join(root, 'apps/command-center/ui/index.html'), 'utf8');
        res.setHeader('Content-Type', 'text/html');
        res.end(html.replace('src="/src/main.ts"', 'src="/apps/command-center/ui/src/main.ts"'));
        return;
      }
      if (req.url === '/performance.html') {
        res.setHeader('Content-Type', 'text/html');
        res.end(
          '<!doctype html><title>Performance fixture</title><p id="cache-result">Loading retained data</p><script type="module" src="/scripts/runner-validation/canary/performance-browser.ts"></script>',
        );
        return;
      }
      next();
    };
    vite = await createViteServer({
      configFile: false,
      root,
      optimizeDeps: { exclude: ['@sqlite.org/sqlite-wasm'] },
      worker: { format: 'es' },
      logLevel: 'error',
      plugins: [
        {
          name: 'performance-fixture',
          configureServer(server) {
            server.middlewares.use(handleBrowser);
          },
        },
      ],
      resolve: {
        alias: [
          { find: '@farmslot/theme', replacement: path.join(root, 'packages/theme/src') },
          {
            find: '@farmslot/local-store',
            replacement: path.join(root, 'packages/local-store/src'),
          },
          {
            find: '@farmslot/review-dispatch',
            replacement: path.join(root, 'packages/review-dispatch/src'),
          },
          {
            find: '@farmslot/adapter-sdk/evidence',
            replacement: path.join(root, 'packages/adapter-sdk/src/evidence.ts'),
          },
          {
            find: '@farmslot/recipe-runner/evidence',
            replacement: path.join(root, 'packages/recipe-runner/src/evidence/index.ts'),
          },
          {
            find: /^@farmslot\/protocol$/,
            replacement: path.join(root, 'packages/protocol/src/index.ts'),
          },
          {
            find: /^@farmslot\/protocol\/(.*)$/,
            replacement: path.join(root, 'packages/protocol/src/$1'),
          },
        ],
      },
      server: {
        host: '127.0.0.1',
        port: 0,
        proxy: {
          '/ws': { target: `http://127.0.0.1:${stack.port}`, ws: true },
          '/api': { target: `http://127.0.0.1:${stack.port}` },
        },
        headers: {
          'Cross-Origin-Opener-Policy': 'same-origin',
          'Cross-Origin-Embedder-Policy': 'require-corp',
        },
      },
    });
    await vite.listen();
    const address = vite.httpServer!.address();
    assert(address && typeof address === 'object');
    const chrome =
      process.env.FARMSLOT_CHROME ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
    const cdpPort = await freePort();
    browser = spawn(
      chrome,
      [
        `--remote-debugging-port=${cdpPort}`,
        '--remote-debugging-address=127.0.0.1',
        '--headless=new',
        '--disable-gpu',
        '--no-first-run',
        '--no-default-browser-check',
        `--user-data-dir=${path.join(fixture, 'browser-profile')}`,
        `http://127.0.0.1:${address.port}/performance.html`,
      ],
      { detached: true, stdio: 'ignore' },
    );
    browser.once('error', (error) => resolveBrowser({ error: String(error) }));
    reaper.group(browser.pid);
    const workload = async () => {
      for (let i = 0; i < 20; i++) {
        const value = await call<{ snapshot: { familyId: string; runs: unknown[] } }>(
          'family.observability.get',
          { familyId: `perf-family-${i % 4}`, project: 'performance' },
        );
        assert.equal(value.snapshot.familyId, `perf-family-${i % 4}`);
        assert.equal(value.snapshot.runs.length, 25);
        const valueFleet = await call<{ fleet: { slots: unknown[] } }>('fleet.status');
        assert.equal(valueFleet.fleet.slots.length, 8);
        const gate = await call<{ resolved: boolean }>('decision.resolve', {
          decisionId: `perf-gate-${i}`,
          actionId: 'ack',
        });
        assert.equal(gate.resolved, true);
      }
      const result = await browserResult;
      assert(result && typeof result === 'object' && !('error' in result), JSON.stringify(result));
      return result;
    };
    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        workload(),
        new Promise<never>((_, reject) => {
          timeout = setTimeout(
            () => reject(new Error('Normal performance window exceeded 120 seconds')),
            120000,
          );
        }),
      ]);
    } finally {
      clearTimeout(timeout);
    }
    const windowSeconds = (performance.now() - windowStart) / 1000;
    snapshot = await call<PerformanceSnapshot>('gateway.performance.get');
    const { coverage, verdicts: allVerdicts, differences } = judgePerformanceWorkload(snapshot);
    check.differences = differences;
    check.status = check.differences.length ? 'fail' : 'pass';
    const overhead = await measurePerformanceOverhead();
    if (overhead.addedMedianMs > 1) {
      check.status = 'fail';
      check.differences.push('Shared collection adds more than 1 ms per fixture call');
    }
    const head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
    await writeFile(
      path.join(out, 'snapshot.json'),
      JSON.stringify(
        {
          workloadVersion: 1,
          head,
          dirty:
            execFileSync('git', ['status', '--porcelain'], { cwd: root, encoding: 'utf8' }).length >
            0,
          host: hostname(),
          observedAt: new Date().toISOString(),
          windowSeconds,
          workload: {
            retainedRuns: 100,
            families: 4,
            slots: 8,
            gateActions: 20,
            cacheState: 'stored-then-memory',
          },
          coverage,
          verdicts: allVerdicts,
          overhead,
          snapshot,
          slowest: slowestActions(snapshot),
        },
        null,
        2,
      ),
    );
    await options.onMeasured?.({
      fixture,
      webUrl: `http://127.0.0.1:${address.port}/doctor-proof.html#doctor`,
      cdpPort,
    });
    check.observations.push(
      'workload-v1: 100 runs, 4 families, 8 slots, 20 gates; browser SQLite hydration/paint and held-data refresh',
    );
  } catch (error) {
    check.status = 'fail';
    check.error = String(error);
    check.differences.push(String(error));
    if (snapshot)
      await writeFile(path.join(out, 'failed-snapshot.json'), JSON.stringify(snapshot, null, 2));
  } finally {
    await cleanup();
  }
  check.durationS = (performance.now() - started) / 1000;
  await writeFile(path.join(out, 'result.json'), JSON.stringify(check, null, 2));
  return check;
}
