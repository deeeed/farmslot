#!/usr/bin/env tsx
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

const exec = promisify(execFile);
const root = fileURLToPath(new URL('../', import.meta.url));
const evidence = path.resolve(process.argv[2] ?? path.join(root, 'temp/workspace-negative'));
await mkdir(evidence, { recursive: true });
const controls = [
  {
    id: 'offline-alternative',
    scenario: 'direct',
    driver: 'scripts/e2e-direct-workflow-defaults.mts',
    file: 'services/gateway/src/review-workspaces/direct-defaults.ts',
    before: ' && !isNodeTransportUnavailableError(error)',
    after: '',
    expected: 'Native execution node is temporarily unavailable',
  },
  {
    id: 'blocked-signal',
    scenario: 'blocked',
    file: 'services/gateway/src/review-workspaces/task.ts',
    before: "  if (signal.status === 'blocked') {",
    after: '  if (false) {',
    expected: 'Blocked signal must remain a blocked run',
  },
  {
    id: 'eligible-capacity-reason',
    scenario: 'direct',
    driver: 'scripts/e2e-direct-workflow-defaults.mts',
    file: 'services/gateway/src/review-workspaces/direct-defaults.ts',
    before: '        if (admission) waitingReason ??= error;',
    after: '        // Negative control: discard the eligible refusal.',
    expected: 'Eligible machine capacity must outrank an invalid fallback',
  },
  {
    id: 'queued-capacity-reason',
    scenario: 'direct',
    driver: 'scripts/e2e-direct-workflow-defaults.mts',
    file: 'services/gateway/src/backlog/dispatch-queue.ts',
    before: '      if (eligible) waitingReason ??= error;',
    after: '      // Negative control: discard the eligible queue refusal.',
    expected: 'Queue must retain the eligible machine capacity reason',
  },
  {
    id: 'static-default-mode',
    scenario: 'direct',
    driver: 'scripts/e2e-direct-workflow-defaults.mts',
    file: 'services/gateway/src/review-workspaces/direct-defaults.ts',
    before: "mode: original.mode ?? ('autonomous' as const),",
    after: 'mode: original.mode,',
    expected: 'missing or incompatible',
  },
  {
    id: 'static-template-pin',
    scenario: 'direct',
    driver: 'scripts/e2e-direct-workflow-defaults.mts',
    file: 'services/gateway/src/review-workspaces/direct-defaults.ts',
    before: 'original.executionTemplateId !== project?.staticReview?.templateId',
    after: 'false',
    expected: 'Missing expected rejection',
  },
  {
    id: 'startup-cancellation',
    scenario: 'cancel-launch',
    file: 'packages/agent-runtime/src/native/manager.ts',
    before: '      record.startupAbort?.abort();',
    after: '      // Negative control: initialization cannot be interrupted.',
    expected: 'Native launch cancellation must not wait for initialization',
  },
  {
    id: 'allocation-cancellation',
    scenario: 'cancel-allocation',
    file: 'services/gateway/src/review-workspaces/workspace-node.ts',
    before: '    marker(cancellationPath, identity, true);',
    after: '    // Negative control: do not fence or interrupt allocation.',
    expected: 'Allocation cancellation must not wait for the Git deadline',
  },
  {
    id: 'repeat-fallback',
    scenario: 'repeat-review',
    file: 'services/gateway/src/review-workspaces/pipeline.ts',
    before: "continuity: run.reviewScope === 'incremental' ? 'fallback-fresh' : 'fresh',",
    after: "continuity: run.reviewScope === 'incremental' ? 'fresh' : 'fresh',",
    expected: 'Repeat review must disclose a fresh-session fallback',
  },
  {
    id: 'slot-isolation',
    scenario: 'runtime-concurrency',
    file: 'services/gateway/src/review-workspaces/pipeline.ts',
    before:
      '      check();\n      return {\n        inputs: { machine: admission.pool.machine, headSha: subject.headSha },',
    after:
      "      check();\n      const { updateSlotStatus } = await import('../core/state.js');\n      await updateSlotStatus('busy-browser-1', { current_run_id: runId });\n      return {\n        inputs: { machine: admission.pool.machine, headSha: subject.headSha },",
    expected: 'Runtime slot assignments changed during static review',
  },
  {
    id: 'source-write-protection',
    scenario: 'readonly',
    file: 'packages/agent-runtime/src/native/codex.ts',
    before: "...filesystemPolicy!.writableRoots.map((root) => [root, 'write']),",
    after:
      "...filesystemPolicy!.writableRoots.map((root) => [root, 'write']),\n                      [options.cwd, 'write'],",
    expected: 'Source write probe must be rejected',
  },
];
const hash = (text: string) => createHash('sha256').update(text).digest('hex');
let active: { file: string; original: string; changed: string } | undefined;
function restore() {
  if (!active) return;
  assert.equal(
    readFileSync(active.file, 'utf8'),
    active.changed,
    'Source changed concurrently with a negative control',
  );
  writeFileSync(active.file, active.original);
  active = undefined;
}
process.on('exit', restore);
for (const signal of ['SIGINT', 'SIGTERM'] as const)
  process.on(signal, () => {
    restore();
    process.exit(1);
  });
const results = [];
const selected = process.argv[3]
  ? controls.filter((control) => control.id === process.argv[3])
  : controls;
assert(selected.length, 'Unknown negative control');
for (const control of selected) {
  const file = path.join(root, control.file);
  const original = readFileSync(file, 'utf8');
  assert.equal(original.split(control.before).length, 2, `Mutation anchor changed: ${control.id}`);
  const changed = original.replace(control.before, control.after);
  active = { file, original, changed };
  writeFileSync(file, changed);
  let output = '',
    failed = false;
  try {
    const result = await exec(
      'yarn',
      [
        'exec',
        'tsx',
        ...('driver' in control
          ? [control.driver!, control.scenario, path.join(evidence, control.id)]
          : [
              'scripts/e2e-workspace-review-lifecycle.mts',
              path.join(evidence, control.id),
              control.scenario,
            ]),
      ],
      { cwd: root, timeout: 900_000, maxBuffer: 4 * 1024 * 1024 },
    );
    output = result.stdout + result.stderr;
  } catch (error) {
    const failure = error as Error & { stdout?: string; stderr?: string };
    failed = true;
    output = (failure.stdout ?? '') + (failure.stderr ?? '') + failure.message;
  } finally {
    restore();
  }
  await writeFile(path.join(evidence, control.id + '.log'), output);
  const outcome = JSON.parse(readFileSync(path.join(evidence, control.id, 'outcome.json'), 'utf8'));
  assert.equal(outcome.cleanupComplete, true, `Negative control cleanup failed: ${control.id}`);
  assert(
    failed && output.includes(control.expected),
    `Negative control missed its required assertion: ${control.id}`,
  );
  results.push({
    id: control.id,
    detected: true,
    expectedAssertion: control.expected,
    source: control.file,
    originalSha256: hash(original),
    mutationSha256: hash(changed),
    restoredSha256: hash(readFileSync(file, 'utf8')),
  });
  await writeFile(path.join(evidence, 'results.json'), JSON.stringify(results, null, 2));
  console.log(JSON.stringify(results.at(-1)));
}
