import assert from 'node:assert/strict';
import net from 'node:net';
import test from 'node:test';

import {
  checkPortStatus,
  getResourceWatchRuntimeStats,
  parseBootedIosSimulatorInventory,
  setResourceWatchExecForTests,
  startResourceWatch,
  stopAllResourceWatches,
  stopResourceWatch,
} from './resource-watch.js';

async function waitFor(predicate: () => boolean, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error('timed out waiting for resource watch result');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

function simulatorInventory(names: string[]): string {
  return JSON.stringify({
    devices: {
      'com.apple.CoreSimulator.SimRuntime.iOS-26-5': names.map((name, index) => ({
        name,
        udid: `00000000-0000-0000-0000-${String(index).padStart(12, '0')}`,
        state: 'Booted',
      })),
    },
  });
}

function listenOnLoopback(): Promise<{ server: net.Server; port: number }> {
  return new Promise((resolve, reject) => {
    const server = net.createServer((socket) => socket.end());
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (!address || typeof address === 'string') {
        server.close();
        reject(new Error('expected TCP address'));
        return;
      }
      resolve({ server, port: address.port });
    });
  });
}

test('checkPortStatus detects an open TCP listener', async () => {
  const { server, port } = await listenOnLoopback();
  try {
    assert.equal(await checkPortStatus(port), 'running');
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((err) => (err ? reject(err) : resolve()));
    });
  }
});

test('checkPortStatus reports stopped for an invalid port', async () => {
  assert.equal(await checkPortStatus(0), 'stopped');
});

test('iOS simulator inventory indexes booted devices by name and UDID only', () => {
  const booted = parseBootedIosSimulatorInventory(
    JSON.stringify({
      devices: {
        runtime: [
          { name: 'sim-a', udid: 'UDID-A', state: 'Booted' },
          { name: 'sim-b', udid: 'UDID-B', state: 'Shutdown' },
        ],
      },
    }),
  );
  assert.deepEqual([...booted].sort(), ['UDID-A', 'sim-a']);
});

test('startResourceWatch replaces the complete slot watch set, including with empty', () => {
  try {
    assert.equal(
      startResourceWatch(
        'slot-a',
        [
          { id: 'metro', watch: { type: 'port-listen', port: 1, intervalMs: 60_000 } },
          { id: 'cdp', watch: { type: 'port-listen', port: 2, intervalMs: 60_000 } },
        ],
        () => {},
      ),
      2,
    );
    assert.equal(
      startResourceWatch('slot-a', [], () => {}),
      0,
    );
  } finally {
    stopAllResourceWatches();
  }
});

test('twelve iOS simulator watches share one inventory subprocess per cycle', async () => {
  let execCalls = 0;
  const updates = new Map<string, string>();
  const baseline = getResourceWatchRuntimeStats().sharedProcessPolls;
  setResourceWatchExecForTests(async () => {
    execCalls += 1;
    return {
      stdout: simulatorInventory(['sim-1', 'sim-12']),
      stderr: '',
      exitCode: 0,
    };
  });
  try {
    for (let index = 1; index <= 12; index += 1) {
      const slotId = `slot-${index}`;
      startResourceWatch(
        slotId,
        [
          {
            id: 'ios-sim',
            watch: {
              type: 'process-poll',
              cmd: `legacy-simctl-fallback-${index}`,
              provider: 'ios-simulator-inventory',
              target: `sim-${index}`,
              intervalMs: 60_000,
            },
          },
        ],
        (change) => updates.set(change.slotId, change.status),
      );
    }

    await waitFor(() => updates.size === 12);
    assert.equal(execCalls, 1);
    assert.equal(updates.get('slot-1'), 'running');
    assert.equal(updates.get('slot-12'), 'running');
    assert.equal(updates.get('slot-6'), 'stopped');
    const stats = getResourceWatchRuntimeStats();
    assert.equal(stats.maxConcurrentProcessPolls, 2);
    assert.equal(stats.sharedProcessPolls!.executions - (baseline?.executions ?? 0), 1);
    assert.equal(stats.sharedProcessPolls!.fanout - (baseline?.fanout ?? 0), 12);
  } finally {
    stopAllResourceWatches();
    setResourceWatchExecForTests();
  }
});

test('adding a shared watch reschedules the pending interval for prompt first status', async () => {
  let execCalls = 0;
  const updates = new Map<string, string>();
  setResourceWatchExecForTests(async () => {
    execCalls += 1;
    return { stdout: simulatorInventory(['sim-a', 'sim-b']), stderr: '', exitCode: 0 };
  });
  try {
    startResourceWatch(
      'slot-a',
      [
        {
          id: 'ios-sim',
          watch: {
            type: 'process-poll',
            cmd: 'legacy-a',
            provider: 'ios-simulator-inventory',
            target: 'sim-a',
            intervalMs: 60_000,
          },
        },
      ],
      (change) => updates.set(change.slotId, change.status),
    );
    await waitFor(() => updates.has('slot-a'));
    startResourceWatch(
      'slot-b',
      [
        {
          id: 'ios-sim',
          watch: {
            type: 'process-poll',
            cmd: 'legacy-b',
            provider: 'ios-simulator-inventory',
            target: 'sim-b',
            intervalMs: 60_000,
          },
        },
      ],
      (change) => updates.set(change.slotId, change.status),
    );
    await waitFor(() => updates.has('slot-b'));
    assert.equal(execCalls, 2);
  } finally {
    stopAllResourceWatches();
    setResourceWatchExecForTests();
  }
});

test('removing one shared watch does not trigger an extra inventory probe', async () => {
  let execCalls = 0;
  const updates = new Map<string, string>();
  setResourceWatchExecForTests(async () => {
    execCalls += 1;
    return { stdout: simulatorInventory(['sim-a', 'sim-b']), stderr: '', exitCode: 0 };
  });
  try {
    for (const [slotId, target] of [
      ['slot-a', 'sim-a'],
      ['slot-b', 'sim-b'],
    ]) {
      startResourceWatch(
        slotId,
        [
          {
            id: 'ios-sim',
            watch: {
              type: 'process-poll',
              cmd: `legacy-${slotId}`,
              provider: 'ios-simulator-inventory',
              target,
              intervalMs: 60_000,
            },
          },
        ],
        (change) => updates.set(change.slotId, change.status),
      );
    }
    await waitFor(() => updates.size === 2);
    stopResourceWatch('slot-b');
    await new Promise((resolve) => setTimeout(resolve, 500));
    assert.equal(execCalls, 1);
  } finally {
    stopAllResourceWatches();
    setResourceWatchExecForTests();
  }
});

test('removing a watch before the first shared probe preserves prompt initial status', async () => {
  let execCalls = 0;
  const updates: string[] = [];
  setResourceWatchExecForTests(async () => {
    execCalls += 1;
    return { stdout: simulatorInventory(['sim-a']), stderr: '', exitCode: 0 };
  });
  try {
    startResourceWatch(
      'slot-a',
      [
        {
          id: 'ios-sim',
          watch: {
            type: 'process-poll',
            cmd: 'legacy-a',
            provider: 'ios-simulator-inventory',
            target: 'sim-a',
            intervalMs: 60_000,
          },
        },
      ],
      (change) => updates.push(change.status),
    );
    startResourceWatch(
      'slot-b',
      [
        {
          id: 'ios-sim',
          watch: {
            type: 'process-poll',
            cmd: 'legacy-b',
            provider: 'ios-simulator-inventory',
            target: 'sim-b',
            intervalMs: 60_000,
          },
        },
      ],
      () => {},
    );
    stopResourceWatch('slot-b');

    await waitFor(() => updates.includes('running'));
    assert.equal(execCalls, 1);
  } finally {
    stopAllResourceWatches();
    setResourceWatchExecForTests();
  }
});

test('a replaced iOS watch ignores stale inventory and receives a fresh shared result', async () => {
  let execCalls = 0;
  const firstPoll = {
    resolve: undefined as
      | ((value: { stdout: string; stderr: string; exitCode: number }) => void)
      | undefined,
  };
  const oldUpdates: string[] = [];
  const newUpdates: string[] = [];
  setResourceWatchExecForTests(async () => {
    execCalls += 1;
    if (execCalls === 1) {
      return new Promise((resolve) => {
        firstPoll.resolve = resolve;
      });
    }
    return { stdout: simulatorInventory(['new-sim']), stderr: '', exitCode: 0 };
  });
  try {
    startResourceWatch(
      'slot-a',
      [
        {
          id: 'ios-sim',
          watch: {
            type: 'process-poll',
            cmd: 'legacy-old',
            provider: 'ios-simulator-inventory',
            target: 'old-sim',
            intervalMs: 60_000,
          },
        },
      ],
      (change) => oldUpdates.push(change.status),
    );
    await waitFor(() => execCalls === 1);

    startResourceWatch(
      'slot-a',
      [
        {
          id: 'ios-sim',
          watch: {
            type: 'process-poll',
            cmd: 'legacy-new',
            provider: 'ios-simulator-inventory',
            target: 'new-sim',
            intervalMs: 60_000,
          },
        },
      ],
      (change) => newUpdates.push(change.status),
    );
    assert.ok(firstPoll.resolve);
    firstPoll.resolve({ stdout: simulatorInventory(['old-sim']), stderr: '', exitCode: 0 });

    await waitFor(() => newUpdates.includes('running'));
    assert.deepEqual(oldUpdates, []);
    assert.equal(execCalls, 2);
  } finally {
    stopAllResourceWatches();
    setResourceWatchExecForTests();
  }
});

test('a failed shared inventory probe preserves cached status instead of flapping every slot', async () => {
  const updates: string[] = [];
  const baselineFailures = getResourceWatchRuntimeStats().sharedProcessPolls?.failures ?? 0;
  setResourceWatchExecForTests(async () => ({
    stdout: '',
    stderr: 'CoreSimulator unavailable',
    exitCode: 1,
  }));
  try {
    startResourceWatch(
      'slot-failure',
      [
        {
          id: 'ios-sim',
          watch: {
            type: 'process-poll',
            cmd: 'legacy-fallback',
            provider: 'ios-simulator-inventory',
            target: 'sim-a',
            intervalMs: 60_000,
          },
        },
      ],
      (change) => updates.push(change.status),
    );
    await waitFor(
      () => (getResourceWatchRuntimeStats().sharedProcessPolls?.failures ?? 0) > baselineFailures,
    );
    assert.deepEqual(updates, []);
  } finally {
    stopAllResourceWatches();
    setResourceWatchExecForTests();
  }
});
