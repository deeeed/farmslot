import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  collectProcessInventory,
  parseProcessInventory,
  PROCESS_INVENTORY_FAILURE_RETRY_MS,
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
  assert.equal(parsed.ancestryTruncated, false);
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

test('a hottest process survives when its ancestry exceeds the entry cap', () => {
  const lines = [psLine(1, 0)];
  for (let pid = 2; pid <= 40; pid += 1) {
    lines.push(psLine(pid, pid - 1, pid === 40 ? 100 : 0, 1024));
  }
  const parsed = parseProcessInventory(lines.join('\n'), 5);
  assert.equal(parsed.processes.length, 5);
  assert.ok(parsed.processes.some((process) => process.pid === 40));
  assert.equal(parsed.ancestryTruncated, true);
});

test('cached ownership roots survive the cap even when idle', () => {
  const lines = [psLine(1, 0)];
  for (let pid = 2; pid <= 20; pid += 1) lines.push(psLine(pid, 1, 20 - pid, 1024));
  lines.push(psLine(200, 1, 0, 1024));
  const parsed = parseProcessInventory(lines.join('\n'), 5, new Set([200]));
  assert.ok(parsed.processes.some((process) => process.pid === 200));
});

test('first census keeps an idle tmux tree before pane PID cache is warm', () => {
  const lines = [psLine(1, 0)];
  for (let pid = 2; pid <= 20; pid += 1) lines.push(psLine(pid, 1, 20 - pid, 1024));
  lines.push('100 1 0.0 1024 00:01 /opt/homebrew/bin/tmux');
  lines.push('101 100 0.0 1024 00:01 -zsh');
  const parsed = parseProcessInventory(lines.join('\n'), 5);
  assert.ok(parsed.processes.some((process) => process.pid === 100));
  assert.ok(parsed.processes.some((process) => process.pid === 101));
});

test('first census retains a deeper tmux pane descendant before PID caches are warm', () => {
  const lines = [psLine(1, 0)];
  for (let pid = 2; pid <= 20; pid += 1) lines.push(psLine(pid, 1, 20 - pid, 1024));
  lines.push('100 1 0.0 1024 00:01 /opt/homebrew/bin/tmux');
  lines.push('101 100 0.0 1024 00:01 -zsh');
  lines.push('102 101 0.0 1024 00:01 node');
  lines.push('103 102 0.0 1024 00:01 worker');
  const parsed = parseProcessInventory(lines.join('\n'), 5);
  assert.ok(parsed.processes.some((process) => process.pid === 103));
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

test('an in-flight census incorporates ownership PIDs from later callers', async () => {
  let release: (() => void) | undefined;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const lines = [psLine(1, 0)];
  for (let pid = 2; pid <= 300; pid += 1) lines.push(psLine(pid, 1, 300 - pid, 1024));
  lines.push(psLine(900, 1, 0, 1024));
  const runner = async () => {
    await gate;
    return lines.join('\n');
  };
  const first = collectProcessInventory(runner);
  const second = collectProcessInventory(runner, new Set([900]));
  release?.();
  const [a, b] = await Promise.all([first, second]);
  assert.equal(a.sampleId, b.sampleId);
  assert.ok(a.processes.some((process) => process.pid === 900));
});

test('process sampling cadence is five minutes normally and one minute under pressure', () => {
  assert.equal(PROCESS_INVENTORY_FAILURE_RETRY_MS, 60_000);
  assert.equal(
    processInventoryCadenceMs({ cpuPercent: 20, memoryPercent: 40, loadAvg1: 2, cpuCores: 10 }),
    300_000,
  );
  assert.equal(
    processInventoryCadenceMs({ cpuPercent: 20, memoryPercent: 80, loadAvg1: 2, cpuCores: 10 }),
    60_000,
  );
});
