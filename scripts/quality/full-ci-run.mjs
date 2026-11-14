import { spawnSync } from 'node:child_process';
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';

import { isMainModule } from './lib/step-timing.mjs';
import { latestFullReceipts, verifyFullReceipts } from './full-ci-receipts.mjs';

export function runFullJob(
  plan,
  job,
  root,
  spawn = spawnSync,
  node = Number(process.versions.node.split('.')[0]),
) {
  const receiptPath = path.join(root, '.cache/full-ci/receipts', `${job.id}.json`);
  const prior = existsSync(receiptPath) ? JSON.parse(readFileSync(receiptPath, 'utf8')) : null;
  if (prior && prior.sha !== plan.sha)
    throw new Error('Cannot resume a receipt from another commit');
  const receipt = {
    id: job.id,
    sha: plan.sha,
    status: 'running',
    tasks: prior?.tasks.filter((task) => task.node !== node) ?? [],
  };
  const stage = job.tasks.filter((task) => task.node === node);
  if (!stage.length) throw new Error(`No full CI tasks for Node ${node} in ${job.id}`);
  let stageStatus = 'ok';
  for (const task of stage) {
    const directory = path.join(root, '.cache/full-ci/timings', task.id);
    mkdirSync(directory, { recursive: true });
    const env = {
      ...process.env,
      FARMSLOT_TSX_TEST_WORKERS: '2',
      FARMSLOT_QUALITY_TIMINGS_DIR: directory,
      ...task.env,
    };
    delete env.FARMSLOT_CI_TEST_SELECTION;
    delete env.TSX_TSCONFIG_PATH;
    const started = Date.now();
    console.log(`+ [${task.label ?? task.id}] (${task.cwd}) ${task.command}`);
    const result = spawn('yarn', ['exec', 'bash', '-e', '-o', 'pipefail', '-c', task.command], {
      cwd: path.join(root, task.cwd),
      env,
      stdio: 'inherit',
    });
    const record = {
      id: task.id,
      command: task.command,
      cwd: task.cwd,
      node,
      status: result.status ?? 1,
      ms: Date.now() - started,
    };
    if (result.error) record.error = result.error.message;
    if (result.signal) record.signal = result.signal;
    if (task.reportCwd && record.status === 0) {
      const reports = readdirSync(directory)
        .filter((name) => name.startsWith('tsx-tests-'))
        .map((name) => JSON.parse(readFileSync(path.join(directory, name), 'utf8')));
      record.files = reports
        .flatMap((report) => report.files.map((file) => path.posix.join(task.reportCwd, file.file)))
        .sort();
      if (
        reports.some(
          (report) => report.status !== 'ok' || report.files.some((file) => file.status !== 'ok'),
        ) ||
        JSON.stringify(record.files) !== JSON.stringify(task.tests)
      ) {
        record.status = 1;
        record.error = 'Executed files do not match the complete test assignment';
      }
    }
    receipt.tasks.push(record);
    if (record.status !== 0) stageStatus = 'fail';
    // A failed independent guard must not hide the later suites in this job.
    mkdirSync(path.join(root, '.cache/full-ci/receipts'), { recursive: true });
    writeFileSync(
      path.join(root, '.cache/full-ci/receipts', `${job.id}.json`),
      `${JSON.stringify(receipt, null, 2)}\n`,
    );
  }
  const order = new Map(job.tasks.map((task, index) => [task.id, index]));
  receipt.tasks.sort((a, b) => order.get(a.id) - order.get(b.id));
  receipt.status =
    receipt.tasks.length !== job.tasks.length
      ? 'running'
      : receipt.tasks.every((task) => task.status === 0)
        ? 'ok'
        : 'fail';
  writeFileSync(
    path.join(root, '.cache/full-ci/receipts', `${job.id}.json`),
    `${JSON.stringify(receipt, null, 2)}\n`,
  );
  return { ...receipt, stageStatus };
}

if (isMainModule(import.meta.url)) {
  const root = process.cwd();
  const plan = JSON.parse(readFileSync('.cache/full-ci/plan.json', 'utf8'));
  const id = process.argv[2];
  if (id === 'verify') {
    const results = JSON.parse(process.env.FULL_CI_JOB_RESULTS);
    const receipts = latestFullReceipts('.cache/full-ci/results');
    verifyFullReceipts(plan, receipts, results);
    const text = `Full validation verified ${receipts.length} jobs, ${plan.coverage.baseline.files.length} test-file/configuration entries and ${plan.coverage.baseline.guards.length} guards with zero coverage differences.\n`;
    console.log(text);
    if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, text);
  } else {
    const job = [...plan.jobs, plan.desktop].find((entry) => entry.id === id);
    if (!job) throw new Error(`Unknown full CI job ${id}`);
    if (job.tasks[0]?.platform === 'linux')
      (await import('./ci-build-state.mjs')).verifyBuildReceipt(root);
    if (process.env.GITHUB_SHA && plan.sha !== process.env.GITHUB_SHA)
      throw new Error('Full plan does not match the checked-out commit');
    const receipt = runFullJob(plan, job, root);
    if (receipt.stageStatus !== 'ok') process.exitCode = 1;
  }
}
