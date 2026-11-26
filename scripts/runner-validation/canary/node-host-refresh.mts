// Nightly case: a node host left on an older runtime build is refreshed at launch (#2540).
//
// On an isolated gateway and authenticated node built from this checkout, a native codex session
// holds a turn (a busy runner). While the node is down, the checkout's agent-runtime gains one
// source file: a real build change, as a deploy makes. The node restarts on the new build and
// keeps its busy host on the old one. Launches then go through the gateway's RPC:
//   1. while busy: refused as skewed, naming the busy session; the node lists busy sessions only
//      for a launch that carries the gateway's release list, so this shows the resend;
//   2. once idle: refused again, because a session no run binds is not on the release list;
//   3. once closed: accepted, on a refreshed host (new pid, the new build).
// host.json is never edited. Not covered: an idle worker of a finished run, which the release
// list names, stopped by the refresh.
//
// The build change is written into the checkout that runs the canary, which a gateway or node
// may also run from. So the case runs only in a disposable checkout that says so:
// FARMSLOT_CANARY_DISPOSABLE_CHECKOUT=1, which nightly.sh sets for its own clone.
import assert from 'node:assert/strict';
import { existsSync, readFileSync, rmSync } from 'node:fs';
import { appendFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { fixture as fakeCodex } from '../../../packages/agent-runtime/src/native/durability.test-support.js';
import { poll, type Reaper } from '../lib/isolated-stack.mjs';
import { startRemoteNodeStack } from '../lib/remote-node-stack.mjs';

import { PIPE_PROJECT, projectPacks, SEED, slotCli } from './fixtures.mjs';
import type { CheckResult } from './outcome.mjs';

/**
 * The build change: a source file the runtime build hashes (a dotfile, so no build emits it).
 * nightly.sh also removes it after its checkout, in case a killed run left it.
 */
export const NODE_HOST_REFRESH_BUMP = 'packages/agent-runtime/src/native/.canary-runtime-bump.ts';
const BUMP_MARKER = '// Runtime build change for the node host refresh canary (node-host-refresh.mts).';

/** Removes the build change, and only the file this case writes. */
function removeBump(file: string): void {
  if (existsSync(file) && readFileSync(file, 'utf8').startsWith(BUMP_MARKER)) rmSync(file);
}

export interface NodeHostRefreshOptions {
  root: string;
  evidence: string;
  reaper: Reaper;
  cliSnapshots: string;
  cliSnapshot?: string;
  log: (event: string, detail?: Record<string, unknown>) => Promise<void>;
  onCleanup: (cleanup: () => Promise<string[]>) => void;
}

type Info = { id: string; state: string; processStopped?: boolean };
type Launch = { name: string; launched?: string; code?: unknown; message?: string };

export async function runNodeHostRefresh(options: NodeHostRefreshOptions): Promise<CheckResult> {
  const started = performance.now();
  const out = path.join(options.evidence, 'node-host-refresh');
  await mkdir(out, { recursive: true });
  const bump = path.join(options.root, NODE_HOST_REFRESH_BUMP);
  const log = async (event: string, detail?: Record<string, unknown>) => {
    await appendFile(path.join(out, 'smoke.jsonl'), JSON.stringify({ event, ...detail }) + '\n');
    await options.log(`node-host-refresh: ${event}`, detail);
  };
  let stopStack: (() => Promise<string[]>) | undefined;
  let cleanupPromise: Promise<string[]> | undefined;
  const cleanup = () =>
    (cleanupPromise ??= (async () => {
      // First, so the change never outlives the case, even if the stack fails to stop.
      removeBump(bump);
      return (await stopStack?.()) ?? [];
    })());
  options.onCleanup(cleanup);
  const check: CheckResult = {
    case: 'node-host-refresh',
    variant: 'busy-then-closed',
    target: 'isolated',
    status: 'fail',
    model: 'scripted',
    modelCalls: 0,
    differences: [],
    observations: [],
    evidence: out,
  };
  if (process.env.FARMSLOT_CANARY_DISPOSABLE_CHECKOUT !== '1') {
    check.status = 'not-exercised';
    check.differences.push(
      'Writes a build change into its checkout: runs only where FARMSLOT_CANARY_DISPOSABLE_CHECKOUT=1 (nightly.sh)',
    );
    await writeFile(path.join(out, 'result.json'), JSON.stringify(check, null, 2));
    return check;
  }
  if (existsSync(bump)) {
    // Never this case's to remove here: nightly.sh clears its own after the checkout.
    check.differences.push(`${NODE_HOST_REFRESH_BUMP} already exists; remove it first`);
    await writeFile(path.join(out, 'result.json'), JSON.stringify(check, null, 2));
    return check;
  }
  try {
    const machine = 'refresh-node';
    const slotId = `${PIPE_PROJECT}-1`;
    const stack = await startRemoteNodeStack({
      root: options.root,
      evidence: out,
      machine,
      slots: [slotId],
      projects: (holds) => projectPacks(holds).filter((pack) => pack.name === PIPE_PROJECT),
      seeds: { [PIPE_PROJECT]: SEED },
      slotFiles: slotCli(options.root),
      cliSnapshots: options.cliSnapshots,
      ...(options.cliSnapshot ? { cliSnapshot: options.cliSnapshot } : {}),
      // The agent-runtime tests' fake codex app-server: with .manual-turns in its directory, a
      // turn waits until the file named in .turn-ready is written.
      binFiles: () => ({ codex: fakeCodex }),
      ownerTag: 'canary-node-host-refresh',
      reaper: options.reaper,
      onCleanup: (stop) => {
        stopStack = stop;
      },
      log,
    });
    // The node's host lives at <native state>/nodes/<machine>.
    const hostFile = path.join(stack.fixture, 'node-home', 'native-sessions', 'nodes', machine, 'host.json');
    const cwd = stack.slotRepo(slotId);
    const target = { executionNodeId: machine };
    const create = async () =>
      (
        await stack.call<{ session: Info }>('native.session.create', {
          ...target,
          runner: 'codex',
          cwd,
        })
      ).session;
    const read = async (sessionId: string) =>
      (await stack.call<{ session: Info }>('native.session.read', { ...target, sessionId }))
        .session;
    const host = async () => {
      const { pid, runtimeVersion, runtimeBuild } = JSON.parse(await readFile(hostFile, 'utf8'));
      return { pid, runtimeVersion, runtimeBuild } as {
        pid: number;
        runtimeVersion: string;
        runtimeBuild: string;
      };
    };
    const snapshot = async (name: string) => {
      await writeFile(path.join(out, `host-${name}.json`), await readFile(hostFile));
      return host();
    };
    const launch = async (name: string): Promise<Launch> => {
      try {
        return { name, launched: (await create()).id };
      } catch (error) {
        const code = error instanceof Error && 'code' in error ? error.code : undefined;
        return { name, code, message: error instanceof Error ? error.message : String(error) };
      }
    };

    // A busy runner on the node's host.
    const busy = await create();
    await writeFile(path.join(cwd, '.manual-turns'), '');
    await stack.call('native.session.send', {
      ...target,
      sessionId: busy.id,
      commandId: 'held-turn',
      text: 'hold',
    });
    await poll(
      'busy session running',
      async () => ((await read(busy.id)).state === 'running' ? true : undefined),
      60_000,
    );
    const before = await snapshot('before');
    await log('busy runner', { sessionId: busy.id, host: before });

    // A real build change while the node is down; the node restarts on it.
    await stack.restartNode(async () => {
      await writeFile(bump, `${BUMP_MARKER}\nexport {};\n`);
    });
    await poll(
      'session readable after node restart',
      async () =>
        read(busy.id).then(
          () => true,
          () => undefined,
        ),
      60_000,
    );
    const restarted = await snapshot('after-node-restart');
    assert.equal(restarted.pid, before.pid, 'the node start left the busy host running');
    await log('node restarted on the new build; host kept', { host: restarted });

    const whileBusy = await launch('while busy');
    await log('launch while busy', whileBusy);
    assert.equal(whileBusy.code, 'NATIVE_HOST_VERSION_SKEW', 'a launch while busy is refused');
    // The error carries the busy list as text only.
    assert.ok(String(whileBusy.message).includes(`Busy: ${busy.id} (running)`), whileBusy.message);
    assert.equal((await host()).pid, before.pid, 'the busy host keeps running');

    // The turn ends. A session no run binds is not on the gateway's release list.
    const ready = path.join(cwd, '.turn-ready');
    await poll('held turn waiting', async () => (existsSync(ready) ? true : undefined), 30_000);
    await writeFile(path.join(cwd, await readFile(ready, 'utf8')), '');
    await poll(
      'busy session idle',
      async () => ((await read(busy.id)).state === 'idle' ? true : undefined),
      60_000,
    );
    const whileIdle = await launch('while idle, not released');
    await log('launch while idle', whileIdle);
    assert.ok(
      String(whileIdle.message).includes(`Busy: ${busy.id} (not released by the gateway)`),
      whileIdle.message,
    );
    assert.equal((await host()).pid, before.pid, 'the unreleased session keeps the host');

    // Once it is closed, the next launch refreshes the host and starts.
    await stack.call('native.session.close', { ...target, sessionId: busy.id });
    await poll(
      'closed runner stopped',
      async () => ((await read(busy.id)).processStopped ? true : undefined),
      60_000,
    );
    const next = await launch('after close');
    await log('launch after close', next);
    assert.ok(next.launched, `the launch after close starts: ${next.message ?? ''}`);
    const after = await snapshot('after');
    assert.notEqual(after.pid, before.pid, 'the host was replaced');
    assert.notEqual(after.runtimeBuild, before.runtimeBuild, 'the new host runs the new build');
    check.status = 'pass';
    check.observations.push(
      `host ${before.pid} (build ${before.runtimeBuild.slice(0, 12)}) kept busy through a node restart, refreshed at launch to ${after.pid} (build ${after.runtimeBuild.slice(0, 12)})`,
    );
    await writeFile(
      path.join(out, 'receipt.json'),
      JSON.stringify(
        {
          hostBefore: before,
          hostAfterNodeRestart: restarted,
          hostAfter: after,
          launches: [whileBusy, whileIdle, next],
        },
        null,
        2,
      ),
    );
  } catch (error) {
    check.error = String(error);
    check.differences.push(String(error));
  } finally {
    const errors = await cleanup();
    if (errors.length) {
      check.status = 'fail';
      check.differences.push(...errors.map((error) => `cleanup: ${error}`));
    }
  }
  check.durationS = (performance.now() - started) / 1000;
  await writeFile(path.join(out, 'result.json'), JSON.stringify(check, null, 2));
  return check;
}
