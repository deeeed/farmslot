import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { ROOT } from '../lib/common.mjs';
import { writeEvidence } from '../lib/evidence.mjs';

import { verifyNativeContextPinFailures } from './native-worker-context-pin-ui.mjs';
import { readPinnedWorkerHistory } from './native-worker-history.mjs';
import { rpc, wait } from './native-worker-lifecycle.mjs';
import { pinnedWorkerTarget } from './native-worker-read.mjs';

export const SCENARIO_ID = 'native-worker-history-ui';
export const RUNNER_AGNOSTIC = true;

export async function runScenario({ outDir, timeoutMs, explicit, prior: provided }) {
  if (!explicit) return { scenario: SCENARIO_ID, runner: 'codex', pass: true, skipped: true };
  const report = { runner: 'codex', checks: [], pass: false };
  try {
    assert.equal(process.env.FARMSLOT_GATEWAY, 'ws://127.0.0.1:18777');
    assert.equal(process.env.FARMSLOT_CDP_PORT, '19323');
    if (process.env.FARMSLOT_NATIVE_ARCHIVED_RUN_ID) {
      await verifyArchivedAttempts({
        runId: process.env.FARMSLOT_NATIVE_ARCHIVED_RUN_ID,
        outDir,
        timeoutMs,
        report,
      });
      report.pass = true;
      const outPath = writeEvidence(report, SCENARIO_ID, report.runner, outDir);
      return { scenario: SCENARIO_ID, runner: report.runner, pass: true, outPath, report };
    }
    let prior = provided;
    if (!prior) {
      const input = process.env.FARMSLOT_NATIVE_HISTORY_REPORT;
      assert.ok(
        input &&
          path.resolve(input).startsWith(path.join(ROOT, 'temp/native-validation') + path.sep),
      );
      prior = JSON.parse(fs.readFileSync(input, 'utf8'));
      assert.equal(prior.pass, true);
    }
    assert.ok(prior.parentRunId && prior.runId && prior.sessionId);
    const sourceRun = rpc('run.get', { runId: prior.parentRunId }).run;
    const successorRun = rpc('run.get', { runId: prior.runId }).run;
    const source = sourceRun.agentContexts.find(
      (context) => context.nativeSession?.sessionId === prior.sessionId,
    );
    const successor = successorRun.agentContexts.find(
      (context) => context.nativeSession?.sessionId === prior.sessionId,
    );
    assert.ok(source?.nativeSession.releasedAt);
    assert.ok(successor?.nativeSession);
    report.runner = source.runner ?? sourceRun.metrics.runner;
    const target = pinnedWorkerTarget(sourceRun.id, source.id, source.nativeSession.leaseId);
    const before = readPinnedWorkerHistory(sourceRun.id, source.id, source.nativeSession.leaseId);
    const next = readPinnedWorkerHistory(
      successorRun.id,
      successor.id,
      successor.nativeSession.leaseId,
    );
    assert.equal(before.scope.released, true);
    assert.equal(
      next.scope.startAfter,
      before.scope.endAt,
      'Task history includes successor events',
    );
    assert.throws(
      () =>
        rpc('native.session.read', {
          sessionId: prior.sessionId,
          executionNodeId: target.executionNodeId,
        }),
      /pinned run context/,
    );
    assert.throws(
      () => rpc('native.session.read', { ...target, after: before.scope.endAt + 1 }),
      /cursor/,
    );
    assert.throws(
      () =>
        rpc('native.session.read', {
          ...target,
          worker: {
            ...target.worker,
            leaseId: successor.nativeSession.leaseId,
            generation: successor.nativeSession.generation,
          },
        }),
      /unavailable or stale/,
    );
    for (const method of ['list', 'read', 'changes', 'diff'])
      assert.throws(
        () => rpc(`native.session.workspace.${method}`, { ...target, path: 'fixture.txt' }),
        /workspace is unavailable for task history/,
      );
    report.checks.push(
      'retired history has a fixed event window and rejects successor lease, out-of-window reads and current workspace access',
    );

    const cdp = (...args) =>
      JSON.parse(
        execFileSync(
          process.execPath,
          [path.join(ROOT, 'apps/command-center/scripts/cdp.mjs'), ...args],
          { cwd: ROOT, encoding: 'utf8', timeout: 30000 },
        ),
      );
    const walk =
      'const walk=r=>[...r.querySelectorAll("*")].flatMap(e=>e.shadowRoot?[e,...walk(e.shadowRoot)]:[e]);const all=walk(document);';
    const runRoute = `run/${sourceRun.id}`;
    const slotRoute = `slot/${sourceRun.slotId}?runId=${sourceRun.id}&contextId=${source.id}`;
    let tab = cdp('goto', runRoute);
    await wait(
      () =>
        cdp(
          'eval',
          runRoute,
          walk +
            `const link=all.find(e=>e.matches('[data-testid="run-native-session-${source.id}"]'));if(!link)return false;link.click();return true;`,
        ),
      Boolean,
      timeoutMs,
    );
    const probe = () => {
      const current = cdp('tabs').find((item) => item.id === tab.id);
      report.navigation = current?.url;
      if (!current?.url.includes(`#slot/${sourceRun.slotId}?`)) return null;
      const query = new URLSearchParams(new URL(current.url).hash.split('?')[1]);
      assert.equal(
        query.get('runId'),
        sourceRun.id,
        'Native history navigation selected another task',
      );
      return cdp(
        'eval',
        slotRoute,
        '--file',
        path.join(ROOT, 'apps/command-center/scripts/probes/native-worker-history.js'),
      );
    };
    const verify = (view) => {
      if (
        !view ||
        view.runId !== sourceRun.id ||
        view.status !== 'Task history' ||
        !view.entries.length
      )
        return false;
      assert.equal(view.contextId, source.id);
      assert.deepEqual(view.errors, []);
      assert.equal(view.workspaceToggle, false);
      assert.equal(view.workspaceMounted, false);
      assert.equal(view.pending, 0);
      for (const name of ['inputDisabled', 'sendDisabled', 'stopDisabled', 'closeDisabled'])
        assert.equal(view[name], true, name);
      assert.ok(
        view.entries.every(
          (entry) =>
            entry.sequence > before.scope.startAfter && entry.sequence <= before.scope.endAt,
        ),
        'Successor entries leaked into task history',
      );
      assert.ok(
        view.entries.some((entry) => entry.text.includes(source.taskFile)),
        'Source task is absent from rendered history',
      );
      assert.ok(
        !view.entries.some((entry) => entry.text.includes(successor.taskFile)),
        'Successor task leaked into rendered history',
      );
      return true;
    };
    const first = await wait(probe, verify, timeoutMs);
    cdp(
      'eval',
      slotRoute,
      walk +
        'const view=all.find(e=>e.matches("native-session-view"));view?.shadowRoot?.querySelector(".timeline article")?.scrollIntoView({block:"start"});return true;',
    );
    cdp('screenshot', slotRoute, path.join(outDir, 'task-history.png'));
    cdp('eval', slotRoute, 'location.reload();return true;');
    const reloaded = await wait(probe, verify, timeoutMs);
    assert.deepEqual(reloaded.entries, first.entries);
    assert.deepEqual(
      readPinnedWorkerHistory(sourceRun.id, source.id, source.nativeSession.leaseId),
      before,
    );
    const missingRoute = `slot/${sourceRun.slotId}?runId=${randomUUID()}&contextId=${source.id}`;
    tab = cdp('goto', missingRoute);
    await wait(
      () =>
        cdp(
          'eval',
          missingRoute,
          walk +
            'return {missing:all.some(e=>e.matches("[data-testid=native-context-unavailable]")),terminal:all.some(e=>e.matches("terminal-view")),native:all.some(e=>e.matches("native-session-view"))};',
        ),
      (state) => {
        if (!state.missing) return false;
        assert.equal(state.terminal, false, 'Missing pinned context exposed another task terminal');
        assert.equal(
          state.native,
          false,
          'Missing pinned context exposed another task conversation',
        );
        return true;
      },
      timeoutMs,
    );
    cdp('screenshot', missingRoute, path.join(outDir, 'missing-task-context.png'));
    tab = cdp('goto', slotRoute);
    await wait(probe, verify, timeoutMs);
    fs.writeFileSync(
      path.join(outDir, 'history-render.json'),
      JSON.stringify({ first, reloaded, scope: before.scope }, null, 2),
    );
    report.checks.push(
      'real run link opens task history; refresh preserves exact entries with task controls disabled and its native workspace unmounted',
    );
    report.checks.push(
      'an unavailable explicit task context exposes neither another task terminal nor its conversation',
    );
    report.checks.push(
      ...(await verifyNativeContextPinFailures({
        cdp,
        run: successorRun,
        context: successor,
        outDir,
        timeoutMs,
      })),
    );
    report.pass = true;
  } catch (error) {
    report.error = error.stack ?? String(error);
  }
  const outPath = writeEvidence(report, SCENARIO_ID, report.runner, outDir);
  return { scenario: SCENARIO_ID, runner: report.runner, pass: report.pass, outPath, report };
}

/** Uses a real rerun's archived bindings; no session or run state is injected. */
async function verifyArchivedAttempts({ runId, outDir, timeoutMs, report }) {
  const run = rpc('run.get', { runId }).run;
  assert.equal(run.transport, 'native');
  const attempts = run.agentContexts.flatMap((context) =>
    (context.nativeSessionHistory ?? []).map((binding) => ({ context, binding })),
  );
  assert(attempts.length, 'Rerun a native task first so nativeSessionHistory contains an attempt');
  report.runner = run.metrics.runner;
  report.runId = runId;
  const route = `run/${runId}`;
  const cdp = (...args) =>
    JSON.parse(
      execFileSync(
        process.execPath,
        [path.join(ROOT, 'apps/command-center/scripts/cdp.mjs'), ...args],
        { cwd: ROOT, encoding: 'utf8', timeout: 30000 },
      ),
    );
  cdp('goto', route);
  await wait(
    () =>
      cdp(
        'eval',
        route,
        'return !!document.querySelector("run-detail")?.shadowRoot?.querySelector("native-worker-history")?.shadowRoot?.querySelector("select");',
      ),
    Boolean,
    timeoutMs,
  );
  report.archivedAttempts = [];
  for (const { context, binding } of attempts) {
    const before = readPinnedWorkerHistory(runId, context.id, binding.leaseId);
    const key = JSON.stringify([
      JSON.stringify([
        runId,
        context.id,
        binding.sessionId,
        binding.executionNodeId,
        binding.leaseId,
      ]),
      binding.generation,
    ]);
    cdp(
      'select',
      route,
      'run-detail >>> native-worker-history >>> [data-testid=native-worker-history-select]',
      key,
    );
    const view = await wait(
      () =>
        cdp(
          'eval',
          route,
          '--file',
          path.join(ROOT, 'apps/command-center/scripts/probes/native-worker-history.js'),
        ),
      (value) =>
        value?.sessionId === binding.sessionId &&
        value.leaseId === binding.leaseId &&
        value.status === 'Task history' &&
        value.entries.length,
      timeoutMs,
    );
    assert.equal(view.runId, runId);
    assert.equal(view.contextId, context.id);
    assert.equal(view.generation, binding.generation);
    assert.equal(view.executionNodeId, binding.executionNodeId);
    assert.deepEqual(view.errors, []);
    assert.equal(view.pending, 0);
    assert.equal(view.workspaceMounted, false);
    assert.equal(view.workspaceToggle, false);
    for (const name of ['inputDisabled', 'sendDisabled', 'stopDisabled', 'closeDisabled'])
      assert.equal(view[name], true, name);
    assert(
      view.entries.every(
        (entry) => entry.sequence > before.scope.startAfter && entry.sequence <= before.scope.endAt,
      ),
    );
    assert.deepEqual(readPinnedWorkerHistory(runId, context.id, binding.leaseId), before);
    report.archivedAttempts.push(view);
  }
  cdp('screenshot', route, path.join(outDir, 'archived-attempt.png'));
  report.checks.push(
    'Run Detail opens each real archived attempt with its exact lease and generation, a bounded transcript and all mutation controls disabled',
  );
}
