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
import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { appendFile, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { fixture as fakeCodex } from '../../../packages/agent-runtime/src/native/durability.test-support.js';
import { poll, type Reaper } from '../lib/isolated-stack.mjs';
import { startRemoteNodeStack } from '../lib/remote-node-stack.mjs';

import { PIPE_PROJECT, projectPacks, SEED, slotCli } from './fixtures.mjs';
import type { CheckResult } from './outcome.mjs';

/** The build change: a source file the runtime build hashes, removed before and after. */
export const NODE_HOST_REFRESH_BUMP = 'packages/agent-runtime/src/native/zz-canary-runtime-bump.ts';

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

const find = (dir: string, name: string): string[] =>
  existsSync(dir)
    ? readdirSync(dir, { withFileTypes: true }).flatMap((entry) =>
        entry.isDirectory()
          ? find(path.join(dir, entry.name), name)
          : entry.name === name
            ? [path.join(dir, entry.name)]
            : [],
      )
    : [];

export async function runNodeHostRefresh(options: NodeHostRefreshOptions): Promise<CheckResult> {
  const started = performance.now();
  const out = path.join(options.evidence, 'node-host-refresh');
  await mkdir(out, { recursive: true });
  const bump = path.join(options.root, NODE_HOST_REFRESH_BUMP);
  // A run that died before its cleanup leaves the file; it is this case's own.
  if (existsSync(bump)) rmSync(bump);
  const log = async (event: string, detail?: Record<string, unknown>) => {
    await appendFile(path.join(out, 'smoke.jsonl'), JSON.stringify({ event, ...detail }) + '\n');
    await options.log(`node-host-refresh: ${event}`, detail);
  };
  let stopStack: (() => Promise<string[]>) | undefined;
  let cleanupPromise: Promise<string[]> | undefined;
  const cleanup = () =>
    (cleanupPromise ??= (async () => {
      const errors = (await stopStack?.()) ?? [];
      if (existsSync(bump)) rmSync(bump);
      return errors;
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
    const nodeNative = path.join(stack.fixture, 'node-home', 'native-sessions');
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
    const hostFile = () => {
      const [file] = find(nodeNative, 'host.json');
      assert.ok(file, 'the node host records itself');
      return file;
    };
    const host = () => {
      const { pid, runtimeVersion, runtimeBuild } = JSON.parse(readFileSync(hostFile(), 'utf8'));
      return { pid, runtimeVersion, runtimeBuild };
    };
    const snapshot = async (name: string) => {
      await writeFile(path.join(out, `host-${name}.json`), readFileSync(hostFile()));
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
    writeFileSync(path.join(cwd, '.manual-turns'), '');
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
      writeFileSync(
        bump,
        '// Runtime build change for the node host refresh canary.\nexport {};\n',
      );
    });
    await stack.waitForNode(true);
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
    assert.match(String(whileBusy.message), new RegExp(`Busy: ${busy.id} \\(running\\)`));
    assert.equal(host().pid, before.pid, 'the busy host keeps running');

    // The turn ends. A session no run binds is not on the gateway's release list.
    const ready = path.join(cwd, '.turn-ready');
    await poll('held turn waiting', async () => (existsSync(ready) ? true : undefined), 30_000);
    writeFileSync(path.join(cwd, readFileSync(ready, 'utf8')), '');
    await poll(
      'busy session idle',
      async () => ((await read(busy.id)).state === 'idle' ? true : undefined),
      60_000,
    );
    const whileIdle = await launch('while idle, not released');
    await log('launch while idle', whileIdle);
    assert.match(
      String(whileIdle.message),
      new RegExp(`Busy: ${busy.id} \\(not released by the gateway\\)`),
    );
    assert.equal(host().pid, before.pid, 'the unreleased session keeps the host');

    // Once it is closed, the next launch refreshes the host and starts.
    await stack.call('native.session.close', { ...target, sessionId: busy.id });
    await poll(
      'closed runner stopped',
      async () => ((await read(busy.id)).processStopped ? true : undefined),
      60_000,
    );
    const next = await launch('after close');
    await log('launch after close', next);
    const after = await snapshot('after');
    assert.ok(next.launched, 'the launch after close starts');
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
    check.status = 'fail';
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
