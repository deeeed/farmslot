// Manual, read-only before/after proof. Pass the live operator root and a separate worktree copy.
import assert from 'node:assert/strict';
import { realpath } from 'node:fs/promises';
import os from 'node:os';
import { performance } from 'node:perf_hooks';

import { resolveConfiguredExecutionTemplateSources as sourceSync } from '@farmslot/agent-runtime';
import { NativeProcessTree } from '@farmslot/agent-runtime/native/process-tree';

import { resolveConfiguredExecutionTemplateSources as sourceAsync } from './execution-template-sources.js';
import { withMeasuredNativeProcessCensus } from './native-process.js';

async function sample<T>(count: number, operation: () => T | Promise<T>) {
  const blocked: number[] = [];
  const durations: number[] = [];
  const answers: T[] = [];
  for (let i = 0; i < count; i++) {
    const started = performance.now();
    let timer: NodeJS.Timeout | undefined;
    const tick = new Promise<void>((resolve) => {
      timer = setTimeout(() => {
        blocked.push(performance.now() - started);
        resolve();
      }, 0);
    });
    try {
      answers.push(await operation());
    } finally {
      await tick;
      clearTimeout(timer);
    }
    durations.push(performance.now() - started);
  }
  return {
    calls: count,
    longestLoopBlockMs: Math.max(...blocked),
    totalMs: durations.reduce((a, b) => a + b, 0),
    answers,
  };
}

const [operatorRoot, copyRoot] = process.argv.slice(2);
if (!operatorRoot || !copyRoot)
  throw new Error('Usage: async-spawns-benchmark.live.ts <operator-root> <worktree-copy>');
// Git status may normally refresh its index. Read-only proof must not write either checkout.
process.env.GIT_OPTIONAL_LOCKS = '0';
const operator = await realpath(operatorRoot);
const copy = await realpath(copyRoot);
assert.notEqual(operator, copy, 'proof requires an isolated worktree copy');
const config = {
  sources: [{ id: 'proof-source', kind: 'workspace' as const, root: { projectPath: '.' } }],
};
// Baseline calls use the unchanged synchronous API; candidates use the measured gateway driver.
const realSource = await sample(1, () => sourceSync(config, { projectPackRoot: operator }));
const realProcess = await sample(1, () =>
  new NativeProcessTree(process.pid, { gated: true }).snapshot(),
);
const sourceBefore = await sample(20, () => sourceSync(config, { projectPackRoot: copy }));
const sourceAfter = await sample(20, () => sourceAsync(config, { projectPackRoot: copy }));
assert.deepEqual(
  sourceAfter.answers,
  sourceBefore.answers,
  'source identity or dirty status changed',
);
const processBefore = await sample(20, () =>
  new NativeProcessTree(process.pid, { gated: true }).snapshot(),
);
const processAfter = await sample(20, async () =>
  (
    await withMeasuredNativeProcessCensus(() =>
      NativeProcessTree.create(process.pid, { gated: true }),
    )
  ).snapshot(),
);
assert.deepEqual(processAfter.answers, processBefore.answers, 'process identity changed');
function summary<T>({ answers: _answers, ...metrics }: Awaited<ReturnType<typeof sample<T>>>) {
  return metrics;
}
console.log(
  JSON.stringify(
    {
      host: os.hostname(),
      node: process.version,
      load: os.loadavg(),
      operatorReadOnly: { source: summary(realSource), process: summary(realProcess) },
      copy: {
        sourceBefore: summary(sourceBefore),
        sourceAfter: summary(sourceAfter),
        processBefore: summary(processBefore),
        processAfter: summary(processAfter),
      },
      equalAnswers: true,
      metadataOnly: true,
      operatorWrites: 0,
      serversStarted: 0,
    },
    null,
    2,
  ),
);
