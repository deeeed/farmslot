import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { once } from 'node:events';
import { mkdir, readFile, readlink, symlink, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { createServer as createPortProbe } from 'node:net';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

import type { GatewayConnection } from '../../../packages/cli/src/gateway-client.js';
import type { FleetStatusResult, SlotStatus, Run } from '../../../packages/protocol/src/index.js';
import { NativeProcessTree } from '../../../packages/agent-runtime/src/native/process-tree.js';
import { matchesProcess } from '../../../packages/agent-runtime/src/native/storage.js';

const quote = (value: string) => "'" + value.replaceAll("'", "'\\''") + "'";
async function port() {
  const probe = createPortProbe().listen(0, '127.0.0.1');
  await once(probe, 'listening');
  const value = (probe.address() as { port: number }).port;
  await new Promise<void>((resolve, reject) =>
    probe.close((error) => (error ? reject(error) : resolve())),
  );
  return value;
}
async function optionalJson(file: string) {
  try {
    return JSON.parse(await readFile(file, 'utf8'));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
}

export async function prepareBrowserSlots(root: string, fixture: string, evidence: string) {
  const server = createServer((_request, response) => {
    response.setHeader('Content-Type', 'text/html');
    response.end(
      '<!doctype html><title>Runtime smoke</title><button id="increment">Increment</button><output id="count">0</output><script>document.querySelector("#increment").onclick=()=>{document.querySelector("#count").textContent=String(Number(document.querySelector("#count").textContent)+1)}</script>',
    );
  }).listen(0, '127.0.0.1');
  await once(server, 'listening');
  const appPort = (server.address() as { port: number }).port;
  const release = path.join(fixture, 'release-runtime-work');
  const sessions: string[] = [];
  const profiles: string[] = [];
  const tasks: Array<{
    id: string;
    repo: string;
    session: string;
    taskFile: string;
    heartbeat: string;
    cdpPort: number;
    route: string;
    runId?: string;
  }> = [];
  let gateway: GatewayConnection | undefined;
  async function stop() {
    const errors: unknown[] = [];
    const workers = new Map<string, NativeProcessTree[]>();
    for (const session of sessions) {
      try {
        const panes = execFileSync(
          'tmux',
          ['list-panes', '-s', '-t', session, '-F', '#{pane_dead} #{pane_pid}'],
          { encoding: 'utf8' },
        )
          .trim()
          .split('\n');
        workers.set(
          session,
          panes.flatMap((line) => {
            const [dead, rawPid] = line.split(/\s+/);
            assert(dead === '0' || dead === '1');
            return dead === '1' ? [] : [new NativeProcessTree(Number(rawPid))];
          }),
        );
      } catch (error) {
        errors.push(error);
      }
    }
    if (gateway)
      for (const task of tasks)
        if (task.runId) {
          try {
            const { run } = await gateway.call<{ run: Run }>('run.get', { runId: task.runId });
            if (['done', 'failed', 'cancelled'].includes(run.status)) continue;
            const result = await gateway.call<{ effects: Array<{ status: string }> }>(
              'run.cancel',
              { runId: task.runId, reason: 'Runtime occupancy proof complete' },
            );
            assert(!result.effects.some((effect) => effect.status === 'failed'));
          } catch (error) {
            errors.push(error);
          }
        }
    await writeFile(release, 'release');
    for (const session of sessions) {
      try {
        let present = true;
        try {
          execFileSync('tmux', ['has-session', '-t', session], { stdio: 'pipe' });
        } catch (error) {
          // run.cancel can remove the whole owned session. Still verify the
          // process trees captured before that cancellation below.
          if ((error as { status?: number }).status !== 1) throw error;
          present = false;
        }
        if (present) execFileSync('tmux', ['kill-session', '-t', session], { stdio: 'pipe' });
        for (const tree of workers.get(session) ?? []) {
          tree.terminate();
          const deadline = Date.now() + 5000;
          while (!tree.empty() && Date.now() < deadline) await delay(100);
          if (!tree.empty()) tree.stop();
          const stoppedBy = Date.now() + 5000;
          while (!tree.empty() && Date.now() < stoppedBy) await delay(100);
          assert(tree.empty(), 'Runtime work cleanup unconfirmed');
        }
      } catch (error) {
        errors.push(error);
      }
    }
    for (const profile of profiles) {
      try {
        const pid = Number((await readlink(path.join(profile, 'SingletonLock'))).split('-').at(-1));
        assert(
          Number.isInteger(pid) && pid > 0 && matchesProcess(pid, '--user-data-dir=' + profile),
        );
        const tree = new NativeProcessTree(pid);
        tree.terminate();
        const deadline = Date.now() + 5000;
        while (!tree.empty() && Date.now() < deadline) await delay(100);
        if (!tree.empty()) tree.stop();
        const stoppedBy = Date.now() + 5000;
        while (!tree.empty() && Date.now() < stoppedBy) await delay(100);
        assert(tree.empty(), 'Runtime browser cleanup unconfirmed');
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') errors.push(error);
      }
    }
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
    if (errors.length) throw new AggregateError(errors, 'Runtime slot cleanup failed');
  }
  try {
    const commands: Record<string, unknown> = {};
    for (let index = 1; index <= 2; index++) {
      const id = `busy-browser-${index}`;
      const repo = path.join(fixture, id);
      await mkdir(repo);
      execFileSync('git', ['clone', '--shared', '--no-checkout', root, repo], { stdio: 'pipe' });
      for (const entry of ['scripts', 'services', 'packages', 'node_modules', 'package.json'])
        await symlink(path.join(root, entry), path.join(repo, entry));
      await symlink(path.join(fixture, 'projects'), path.join(repo, 'projects'));
      await writeFile(path.join(repo, 'CLAUDE.md'), '# Isolated runtime slot\n');
      const taskFile = path.join(fixture, 'runtime-tasks', id, 'TASK.md');
      await mkdir(path.dirname(taskFile), { recursive: true });
      await writeFile(
        taskFile,
        '# Worker: dev\n\nValidate the browser counter and keep observing it until released.\n',
      );
      const cdpPort = await port(),
        profile = path.join(fixture, `chrome-${index}`),
        route = `runtime-slot-${index}`;
      execFileSync(
        'bash',
        [
          path.join(root, 'apps/command-center/scripts/debug-chrome.sh'),
          '--headless',
          '--port',
          String(cdpPort),
          '--profile',
          profile,
          '--url',
          `http://127.0.0.1:${appPort}/#${route}`,
        ],
        { stdio: 'pipe' },
      );
      profiles.push(profile);
      const session = `${path.basename(fixture)}-runtime-${index}`;
      execFileSync('tmux', ['new-session', '-d', '-s', session, '-c', repo], { stdio: 'pipe' });
      sessions.push(session);
      const heartbeat = path.join(evidence, `runtime-${index}.json`);
      commands[id] = {
        command: [
          'node',
          path.join(root, 'scripts/runner-validation/lib/browser-slot-work.mjs'),
          String(cdpPort),
          route,
          heartbeat,
          release,
        ]
          .map(quote)
          .join(' '),
        timeout_ms: 600000,
      };
      tasks.push({ id, repo, session, taskFile, heartbeat, cdpPort, route });
    }
    const project = path.join(fixture, 'projects/runtime-work');
    await mkdir(path.join(project, 'shared/review-pr'), { recursive: true });
    await mkdir(path.join(project, 'templates/prompts'), { recursive: true });
    await writeFile(
      path.join(project, 'templates/prompts/worker-dispatch.md'),
      'Read {{TASK_FILE}} and execute the configured validation command.\n',
    );
    await writeFile(
      path.join(project, 'shared/review-pr/hold.md'),
      '---\nplatforms: [browser, cli]\n---\n\n- [ ] Exercise and observe the browser counter.\n',
    );
    await writeFile(
      path.join(project, 'project.json'),
      JSON.stringify({
        name: 'runtime-work',
        paths: { runtime_dir: '.agent', artifact_dir: '.task' },
        scripted: { commands },
        execution_templates: {
          sources: [{ id: 'runtime:shared', kind: 'workspace', root: { projectPath: 'shared' } }],
        },
      }),
    );
  } catch (error) {
    await stop();
    throw error;
  }
  const assignment = (slot: SlotStatus) => ({
    slot: slot.slot,
    currentRunId: slot.currentRunId,
    activeTaskFile: slot.activeTaskFile,
    agent: slot.agent,
    lifecycle: slot.lifecycle,
  });
  let before: ReturnType<typeof assignment>[] = [];
  return {
    slots: tasks.map((task) => ({
      id: task.id,
      project: 'runtime-work',
      platform: 'browser',
      enabled: true,
      repo: task.repo,
      session: task.session,
      resources: { browser: { cdp_port: task.cdpPort }, 'dev-server': { port: appPort } },
    })),
    initialSlots: tasks.map((task) => ({
      slot: task.id,
      machine: 'review-node',
      project: 'runtime-work',
      platform: 'browser',
      repo: task.repo,
      lifecycle: 'ready',
      phase: null,
      agent: 'idle',
      enabled: true,
      health: { ssh: 'LOCAL', device: '-', devserver: 'OK', cdp: 'OK', fixtures: '-' },
    })),
    async start(connection: GatewayConnection) {
      gateway = connection;
      const startedAt = Date.now();
      for (const task of tasks) {
        const result = await connection.call<{ run: Run }>('run.create', {
          project: 'runtime-work',
          flowType: 'review-pr',
          reviewValidationDepth: 'full-live',
          ticketOrPr: `example/runtime#${tasks.indexOf(task) + 1}`,
          slotId: task.id,
          taskFile: task.taskFile,
          mode: 'validation',
          runner: 'scripted',
          model: 'scripted',
          skipPrepare: true,
          scripted: { mode: 'command', commandRef: task.id },
        });
        task.runId = result.run.id;
      }
      const deadline = Date.now() + 45_000;
      for (;;) {
        const beats = await Promise.all(tasks.map((task) => optionalJson(task.heartbeat)));
        const { fleet } = await connection.call<FleetStatusResult>('fleet.status');
        if (
          beats.every(
            (beat, index) =>
              beat?.counter === 1 &&
              Date.parse(beat.startedAt) >= startedAt &&
              matchesProcess(beat.pid, tasks[index].heartbeat),
          ) &&
          fleet.slots.length === 2 &&
          fleet.slots.every((slot) => slot.lifecycle === 'busy')
        )
          break;
        for (const task of tasks) {
          const { run } = await connection.call<{ run: Run }>('run.get', { runId: task.runId });
          if (['failed', 'blocked', 'cancelled'].includes(run.status))
            throw new Error(run.error ?? `Runtime slot ${task.id} stopped`);
        }
        if (Date.now() >= deadline) throw new Error('Runtime browser smoke did not start');
        await delay(250);
      }
      const { fleet } = await connection.call<FleetStatusResult>('fleet.status');
      assert.equal(fleet.slots.length, 2);
      assert(fleet.slots.every((slot) => slot.lifecycle === 'busy'));
      before = fleet.slots.map(assignment).sort((a, b) => a.slot.localeCompare(b.slot));
      await writeFile(
        path.join(evidence, 'runtime-assignments-before.json'),
        JSON.stringify(before),
      );
    },
    async verify(connection: GatewayConnection) {
      const { fleet } = await connection.call<FleetStatusResult>('fleet.status');
      assert.deepEqual(
        fleet.slots.map(assignment).sort((a, b) => a.slot.localeCompare(b.slot)),
        before,
        'Runtime slot assignments changed during static review',
      );
      for (const task of tasks) {
        const { run } = await connection.call<{ run: Run }>('run.get', { runId: task.runId });
        assert.equal(run.status, 'monitoring');
        assert.equal(run.slotId, task.id);
        const beat = await optionalJson(task.heartbeat);
        assert(
          beat?.counter === 1 &&
            beat.observations > 1 &&
            Date.now() - Date.parse(beat.observedAt) < 15_000,
        );
        assert(matchesProcess(beat.pid, task.heartbeat), 'Runtime work process was replaced');
      }
    },
    stop,
  };
}
