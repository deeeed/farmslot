import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';

import { latestAttempts } from './lib/latest-attempts.mjs';

export function latestFullReceipts(directory) {
  const artifacts = readdirSync(directory).map((name) => {
    const match = /^full-ci-(.+)-attempt-([1-9]\d*)$/.exec(name);
    if (!match) throw new Error(`Unexpected full CI artifact ${name}`);
    const [, id, rawAttempt] = match;
    return { id, attempt: rawAttempt, name };
  });
  return latestAttempts(artifacts).map(({ id, name }) => {
    const receipt = JSON.parse(readFileSync(path.join(directory, name, `${id}.json`), 'utf8'));
    if (receipt.id !== id) throw new Error(`Artifact/receipt mismatch for ${id}`);
    return receipt;
  });
}

export function verifyFullReceipts(plan, receipts, results) {
  if (plan.mode !== 'full' || plan.version !== 1 || !plan.prerequisites)
    throw new Error('Full validation requires an unfiltered complete plan');
  if (Object.values(plan.coverage.diff).some((values) => values.length))
    throw new Error('Full coverage parity failed');
  if (Object.values(results).some((status) => status !== 'success'))
    throw new Error(`Full job result: ${JSON.stringify(results)}`);
  const expected = new Map([...plan.jobs, plan.desktop].map((job) => [job.id, job]));
  const seen = new Set();
  for (const receipt of receipts) {
    const job = expected.get(receipt.id);
    if (!job || seen.has(receipt.id))
      throw new Error(`Unexpected or duplicate receipt ${receipt.id}`);
    seen.add(receipt.id);
    if (
      receipt.sha !== plan.sha ||
      receipt.status !== 'ok' ||
      receipt.tasks.length !== job.tasks.length
    )
      throw new Error(`Incomplete full CI job ${receipt.id}`);
    for (const [index, task] of job.tasks.entries()) {
      const actual = receipt.tasks[index];
      if (
        actual.id !== task.id ||
        actual.command !== task.command ||
        actual.cwd !== task.cwd ||
        actual.node !== task.node ||
        actual.status !== 0
      )
        throw new Error(`Failed or missing full CI task ${task.id}`);
      if (task.reportCwd && JSON.stringify(actual.files) !== JSON.stringify(task.tests))
        throw new Error(`Missing or duplicate executed test files for ${task.id}`);
    }
  }
  if (seen.size !== expected.size)
    throw new Error(
      `Missing full CI jobs: ${[...expected.keys()].filter((id) => !seen.has(id)).join(', ')}`,
    );
}
