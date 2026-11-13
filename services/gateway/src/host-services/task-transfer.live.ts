// Real child-process ownership and copy proof; no network host or farm slot is used.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { mock } from 'node:test';

const root = await mkdtemp(path.join(os.tmpdir(), 'task-transfer-proof-'));
const sourceHead = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
const rsync = execFileSync('which', ['rsync'], { encoding: 'utf8' }).trim();
const originalPath = process.env.PATH ?? '/usr/bin:/bin';
const bin = path.join(root, 'bin');
const log = path.join(root, 'calls.jsonl');
let background: typeof import('./background/client.js').backgroundHost | undefined;
try {
  for (const dir of [
    'bin',
    'pool',
    'projects/proof',
    'scripts',
    'services/gateway',
    'runs',
    'home',
    'task/artifacts',
    'worker',
  ])
    await mkdir(path.join(root, dir), { recursive: true });
  await writeFile(path.join(root, 'CLAUDE.md'), '# Disposable task-transfer fixture\n');
  await writeFile(path.join(root, 'scripts/dev.sh'), 'exit 1\n');
  await writeFile(path.join(root, 'services/gateway/package.json'), '{}');
  await writeFile(path.join(root, 'projects/proof/project.json'), '{"name":"proof"}');
  const status = path.join(root, 'status.json');
  await writeFile(status, '{"slots":[]}');
  const stub = `#!${process.execPath}\nconst fs=require('node:fs'),path=require('node:path');fs.appendFileSync(${JSON.stringify(log)},JSON.stringify({tool:path.basename(process.argv[1]),args:process.argv.slice(2),pid:process.pid,ppid:process.ppid})+'\\n');if(fs.existsSync(${JSON.stringify(path.join(root, 'fail'))})){process.stderr.write('fixture transfer failure');process.exit(37)}\n`;
  for (const tool of ['ssh', 'scp', 'rsync']) {
    await writeFile(path.join(bin, tool), stub);
    await chmod(path.join(bin, tool), 0o755);
  }
  Object.assign(process.env, {
    PATH: `${bin}:${process.env.PATH}`,
    NODE_TEST_CONTEXT: '1',
    FARMSLOT_ROOT: root,
    FARMSLOT_HOME: path.join(root, 'home'),
    FARMSLOT_POOL_DIR: path.join(root, 'pool'),
    FARMSLOT_PROJECTS_DIR: path.join(root, 'projects'),
    FARMSLOT_RUNS_DIR: path.join(root, 'runs'),
    FARMSLOT_TEST_STATUS_FILE: status,
    FARMSLOT_GATEWAY_BACKGROUND: '1',
  });
  delete process.env.TMUX;
  delete process.env.TMUX_PANE;
  const { execLocal } = await import('../core/exec.js');
  const { shellQuote } = await import('../core/tmux.js');
  for (const tool of ['ssh', 'scp', 'rsync'])
    assert.equal(
      (await execLocal(`command -v ${tool}`)).stdout.trim(),
      path.join(bin, tool),
      'fixture must never resolve a real network tool',
    );
  background = (await import('./background/client.js')).backgroundHost;
  background.start();
  await background.request('decisions.scan', {}, { deadlineMs: 10000 });
  const childPid = background.status().pid;
  assert.ok(childPid);
  const { copyTaskDirSubdirectories, copyPreparedTaskRootSidecars, TASK_ROOT_SIDECARS } =
    await import('../tasks/sidecars.js');
  const taskDir = path.join(root, 'task');
  await writeFile(path.join(taskDir, 'artifacts/proof.txt'), 'fixture bytes');
  await writeFile(path.join(taskDir, 'mark'), '#!/bin/sh\n');
  await writeFile(path.join(taskDir, 'CHECKLIST.md'), '- [ ] proof\n');
  await writeFile(path.join(taskDir, 'checklist-target.json'), '{}');
  const params = {
    taskDir,
    workerTaskAbs: path.join(root, 'worker'),
    host: 'fixture.invalid',
    machine: 'fixture-remote',
    sshTarget: 'fixture.invalid',
  };
  await copyTaskDirSubdirectories(params);
  await copyPreparedTaskRootSidecars({ ...params, excludeRelativePaths: ['mark'] });
  await copyPreparedTaskRootSidecars({
    ...params,
    excludeRelativePaths: TASK_ROOT_SIDECARS.filter((file) => file !== 'mark'),
  });
  const calls: Array<{ tool: string; args: string[]; pid: number; ppid: number }> = (
    await readFile(log, 'utf8')
  )
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line));
  assert.ok(calls.length >= 5);
  for (const call of calls)
    assert.equal(call.ppid, childPid, 'task transfer must spawn in the background child');
  assert.equal(calls.at(-2)?.tool, 'scp');
  assert.ok(calls.at(-2)?.args.at(-1)?.endsWith('/mark'));
  assert.equal(calls.at(-1)?.tool, 'ssh');
  assert.match(calls.at(-1)?.args.at(-1) ?? '', /^chmod 755 /);
  // The baseline reaches the ownership assertion above before importing the new helper.
  const { runTaskTransfer } = await import('./task-transfer.js');
  const { withCleanupSignal } = await import('../core/cleanup-scope.js');
  await writeFile(path.join(root, 'fail'), 'fail');
  const beforeFailure = calls.length;
  await assert.rejects(copyTaskDirSubdirectories(params), /fixture transfer failure/);
  const failedCalls = (await readFile(log, 'utf8'))
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line));
  assert.equal(failedCalls.length, beforeFailure + 1);
  await rm(path.join(root, 'fail'));
  const source = path.join(root, 'real-source');
  const dest = path.join(root, 'real-dest');
  await mkdir(source);
  await mkdir(dest);
  await writeFile(path.join(source, 'payload'), Buffer.alloc(1024 * 1024, 91));
  await writeFile(path.join(source, 'keep'), 'source');
  await writeFile(path.join(source, 'mirror.worker'), 'excluded');
  await writeFile(path.join(dest, 'keep'), 'destination');
  const copied = await runTaskTransfer(
    `PATH=${shellQuote(originalPath)}; ${shellQuote(rsync)} -a --ignore-existing --exclude='*.worker' ${shellQuote(source + '/')} ${shellQuote(dest + '/')}`,
  );
  assert.equal(copied.exitCode, 0, copied.stderr);
  assert.deepEqual(
    await readFile(path.join(source, 'payload')),
    await readFile(path.join(dest, 'payload')),
  );
  assert.equal(await readFile(path.join(dest, 'keep'), 'utf8'), 'destination');
  assert.equal(existsSync(path.join(dest, 'mirror.worker')), false);
  assert.deepEqual(await runTaskTransfer('printf out; printf err >&2; exit 7'), {
    stdout: 'out',
    stderr: 'err',
    exitCode: 7,
  });
  const aborted = new AbortController();
  aborted.abort();
  const forbidden = path.join(root, 'must-not-exist');
  assert.equal(
    (await runTaskTransfer(`touch ${shellQuote(forbidden)}`, { signal: aborted.signal })).exitCode,
    130,
  );
  assert.equal(existsSync(forbidden), false);
  const signal = new AbortController();
  const pidFile = path.join(root, 'cancel.pid');
  const commands = { pending: new Set<Promise<unknown>>(), unconfirmed: false };
  const code = `require('node:fs').writeFileSync(${JSON.stringify(pidFile)},String(process.pid));setInterval(()=>{},1000)`;
  const cancelling = withCleanupSignal(
    signal.signal,
    () =>
      runTaskTransfer(`${shellQuote(process.execPath)} -e ${shellQuote(code)}`, {
        closeoutTimeoutMs: 100,
      }),
    commands,
  );
  const deadline = Date.now() + 5000;
  while (!existsSync(pidFile)) {
    assert.ok(Date.now() < deadline, 'transfer did not start');
    await new Promise((r) => setTimeout(r, 20));
  }
  assert.equal(commands.pending.size, 1);
  signal.abort();
  assert.equal((await cancelling).exitCode, 130);
  assert.equal(commands.pending.size, 0);
  const cancelledPid = Number(await readFile(pidFile, 'utf8'));
  assert.throws(
    () => process.kill(cancelledPid, 0),
    (error: unknown) => error instanceof Error && 'code' in error && error.code === 'ESRCH',
  );
  let settled = false;
  mock.timers.enable({ apis: ['setTimeout'] });
  const untimed = runTaskTransfer('printf untimed').then(
    (result) => {
      settled = true;
      return { result };
    },
    (error) => {
      settled = true;
      return { error };
    },
  );
  await Promise.resolve();
  mock.timers.tick(600000);
  await Promise.resolve();
  assert.equal(settled, false, 'legacy untimed transfer must not acquire an answer deadline');
  mock.timers.reset();
  const outcome = await untimed;
  assert.ok('result' in outcome);
  assert.equal(outcome.result.stdout, 'untimed');
  console.log(
    JSON.stringify(
      {
        sourceHead,
        parentPid: process.pid,
        childPid,
        transferCalls: calls.length,
        allTransferParentsAreChild: true,
        markerLast: true,
        failureStopsPublication: true,
        realRsyncBytesAndFlags: true,
        inheritedCancellation: true,
        virtualUntimedMinutes: 10,
        exec: background.status().exec['taskFiles.transfer'],
        result: 'PASS',
      },
      null,
      2,
    ),
  );
} finally {
  mock.timers.reset();
  await background?.stop();
  await rm(root, { recursive: true, force: true });
}
