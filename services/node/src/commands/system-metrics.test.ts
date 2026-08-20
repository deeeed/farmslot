import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  collectProcessInventory,
  parseProcessInventory,
  processInventoryCadenceMs,
} from './system-metrics.js';

function psLine(pid: number, ppid: number, cpu = 0, rssKb = 1024): string {
  return `${pid} ${ppid} ${cpu.toFixed(1)} ${rssKb} 00:01 /usr/bin/process-${pid}`;
}

test('process inventory is bounded and retains ancestry for high-pressure processes', () => {
  const lines = [psLine(1, 0), `${process.pid + 1} ${process.pid} 99.0 1024 00:01 /bin/ps`];
  for (let pid = 2; pid <= 400; pid += 1) {
    lines.push(psLine(pid, pid === 400 ? 399 : 1, pid === 400 ? 99 : 0, pid));
  }
  const parsed = parseProcessInventory(lines.join('\n'), 32);
  assert.equal(parsed.totalProcesses, 400);
  assert.ok(parsed.processes.every((process) => process.executable !== '/bin/ps'));
  assert.equal(parsed.processes.length, 32);
  assert.equal(parsed.truncated, true);
  assert.ok(parsed.processes.some((process) => process.pid === 400));
  assert.ok(parsed.processes.some((process) => process.pid === 399));
  assert.ok(parsed.processes.every((process) => !process.executable.includes(' ')));
  const retainedPids = new Set(parsed.processes.map((process) => process.pid));
  assert.ok(
    parsed.processes.every(
      (process) =>
        process.ppid === 0 ||
        !lines.some((line) => line.startsWith(`${process.ppid} `)) ||
        retainedPids.has(process.ppid),
    ),
  );
});

test('concurrent inventory requests share one command and report skipped overlap', async () => {
  let executions = 0;
  let release: (() => void) | undefined;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const runner = async () => {
    executions += 1;
    await gate;
    return psLine(10, 1, 4, 2048);
  };
  const first = collectProcessInventory(runner);
  const second = collectProcessInventory(runner);
  assert.equal(executions, 1);
  release?.();
  const [a, b] = await Promise.all([first, second]);
  assert.equal(a.sampleId, b.sampleId);
  assert.equal(a.health.executions, b.health.executions);
  assert.ok(a.health.skippedBusy >= 1);
});

test('process sampling cadence is five minutes normally and one minute under pressure', () => {
  assert.equal(
    processInventoryCadenceMs({ cpuPercent: 20, memoryPercent: 40, loadAvg1: 2, cpuCores: 10 }),
    300_000,
  );
  assert.equal(
    processInventoryCadenceMs({ cpuPercent: 20, memoryPercent: 80, loadAvg1: 2, cpuCores: 10 }),
    60_000,
  );
});
