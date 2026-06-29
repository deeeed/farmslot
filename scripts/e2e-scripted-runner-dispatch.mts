#!/usr/bin/env tsx
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

import { dispatchExecute } from '../services/gateway/src/methods/dispatch/execute.js';

const root = process.cwd();
const runId = `${process.pid}-${Date.now()}`;
const slotId = `scripted-e2e-${runId}`;
const session = slotId;
const poolFile = path.join(root, 'pool', `${slotId}.json`);
const sourceTaskRoot = path.join(root, 'temp', 'scripted-runner-e2e', runId);
const scenarios = (
  process.argv.includes('--failure-only') ? ['failure'] : ['success', 'failure']
) as const;
const previousScenarioFlag = process.env.FARMSLOT_ENABLE_SCRIPTED_SCENARIOS;
const previousNodeTestContext = process.env.NODE_TEST_CONTEXT;

function run(command: string, args: string[], options: { ignoreFailure?: boolean } = {}) {
  const result = spawnSync(command, args, { cwd: root, stdio: 'pipe', encoding: 'utf-8' });
  if (result.error) throw result.error;
  if (!options.ignoreFailure && result.status !== 0) {
    throw new Error(`${command} ${args.join(' ')} failed: ${result.stderr || result.stdout}`);
  }
  return result;
}

async function pollSignal(signalPath: string) {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    if (existsSync(signalPath)) return JSON.parse(await readFile(signalPath, 'utf-8'));
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`Timed out waiting for ${signalPath}`);
}

function writeTempPool() {
  writeFileSync(
    poolFile,
    `${JSON.stringify(
      {
        machine: 'scripted-e2e',
        project: 'farmslot-farm',
        platform: 'cli',
        host: 'localhost',
        ssh_user: process.env.USER || 'dev',
        os: process.platform === 'darwin' ? 'darwin' : 'linux',
        slots: [
          {
            id: slotId,
            enabled: true,
            repo: '.',
            session,
            resources: { 'dev-server': { port: 7777 } },
          },
        ],
      },
      null,
      2,
    )}\n`,
  );
}

async function main() {
  process.env.NODE_TEST_CONTEXT = '1';
  process.env.FARMSLOT_ENABLE_SCRIPTED_SCENARIOS = '1';
  mkdirSync(path.dirname(poolFile), { recursive: true });
  writeTempPool();
  run('tmux', ['kill-session', '-t', session], { ignoreFailure: true });
  run('tmux', ['new-session', '-d', '-s', session, '-c', root]);

  try {
    for (const scenario of scenarios) {
      const taskName = `scripted-${scenario}-${runId}`;
      const sourceTaskDir = path.join(sourceTaskRoot, 'tasks', 'dev', taskName);
      mkdirSync(sourceTaskDir, { recursive: true });
      writeFileSync(
        path.join(sourceTaskDir, 'TASK.md'),
        `# Worker: dev\n\n- Task profile: dev\n**Runner:** scripted\n\nValidate scripted ${scenario}.\n`,
        'utf-8',
      );

      const result = await dispatchExecute(
        {
          slotId,
          taskFile: path.join(sourceTaskDir, 'TASK.md'),
          mode: 'validation',
          runner: 'scripted',
          skipPrepare: true,
          force: true,
          scripted: { mode: 'scenario', scenario, stepDelayMs: 3000 },
        },
        () => {},
      );
      assert.equal(result.dispatched, true);
      assert.match(
        result.launchCommand ?? '',
        /packages\/cli\/bin\/farmslot\.mjs' scripted-runner/,
      );
      assert.match(result.launchCommand ?? '', /FARMSLOT_ENABLE_SCRIPTED_SCENARIOS=1/);
      assert.doesNotMatch(result.launchCommand ?? '', /npx farmslot/);
      assert.doesNotMatch(result.launchCommand ?? '', /(^|\s)farmslot fake-runner/);

      const workerTaskDirMatch = result.launchCommand?.match(/--task-dir '([^']+)'/);
      const workerTaskDir = path.join(root, workerTaskDirMatch?.[1] ?? `.task/dev/${taskName}`);
      let signal;
      try {
        signal = await pollSignal(path.join(workerTaskDir, 'SIGNAL.json'));
      } catch (err) {
        const pane = run('tmux', ['capture-pane', '-p', '-t', session, '-S', '-120'], {
          ignoreFailure: true,
        });
        throw new Error(`${(err as Error).message}

Launch command:
${result.launchCommand ?? ''}

Tmux pane:
${pane.stdout || pane.stderr}`);
      }
      assert.equal(signal.outcome, scenario === 'success' ? 'success' : 'failure');
      assert.equal(signal.status, scenario === 'success' ? 'complete' : 'failed');
      console.log(`scripted ${scenario}: ${signal.status}/${signal.outcome}`);
      rmSync(workerTaskDir, { recursive: true, force: true });
    }
  } finally {
    run('tmux', ['kill-session', '-t', session], { ignoreFailure: true });
    rmSync(poolFile, { force: true });
    rmSync(sourceTaskRoot, { recursive: true, force: true });
    for (const scenario of scenarios) {
      rmSync(path.join(root, '.task', 'dev', `scripted-${scenario}-${runId}`), {
        recursive: true,
        force: true,
      });
    }
    if (previousScenarioFlag === undefined) delete process.env.FARMSLOT_ENABLE_SCRIPTED_SCENARIOS;
    else process.env.FARMSLOT_ENABLE_SCRIPTED_SCENARIOS = previousScenarioFlag;
    if (previousNodeTestContext === undefined) delete process.env.NODE_TEST_CONTEXT;
    else process.env.NODE_TEST_CONTEXT = previousNodeTestContext;
  }
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
