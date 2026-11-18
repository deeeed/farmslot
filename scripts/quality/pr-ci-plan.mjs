import { spawnSync } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { gzipSync } from 'node:zlib';

import { isMainModule } from './lib/step-timing.mjs';
import { ownerOf, readGraph, selectAffectedTests } from './affected-tests.mjs';
import { ciParitySteps } from './ci-local.mjs';
import { GIT_LOCATION_ENV } from './run-tsx-tests.mjs';
import {
  affectedWorkspaceNames,
  isCiControlFile,
  runtimeImpactFiles,
  workspaceSuiteFiles,
  workspaceTestCatalog,
} from './workspace-test-targets.mjs';

export function balance(items, count, weight = () => 1) {
  const bins = Array.from({ length: Math.min(count, items.length) }, () => ({
    weight: 0,
    items: [],
  }));
  for (const item of [...items].sort(
    (a, b) => weight(b) - weight(a) || JSON.stringify(a).localeCompare(JSON.stringify(b)),
  )) {
    bins.sort((a, b) => a.weight - b.weight);
    bins[0].items.push(item);
    bins[0].weight += weight(item);
  }
  return bins.map(({ items: assigned }) => assigned);
}

// Three broad PR matrices leave four of the observed 40 hosted slots for setup and gates.
const PR_MATRIX_LIMIT = 12;

/** Fill existing test jobs before paying for another runner and setup. */
export function packPrTasks(jobs, tasks, budget = 120, maxJobs = PR_MATRIX_LIMIT) {
  const pooled = jobs.map((job) => ({ ...job, tasks: [...job.tasks] }));
  const cost = (job) => job.tasks.reduce((seconds, entry) => seconds + entry.seconds, 0);
  let next = 0;
  for (const task of [...tasks].sort((a, b) => b.seconds - a.seconds || a.id.localeCompare(b.id))) {
    let job = [...pooled].sort((a, b) => cost(a) - cost(b) || a.id.localeCompare(b.id))[0];
    if (!job || (pooled.length < maxJobs && cost(job) + task.seconds > budget)) {
      job = { id: `checks-${++next}`, tasks: [] };
      pooled.push(job);
    }
    job.tasks.push(task);
  }
  return pooled;
}

/** Match the runner: mocks/serial first, then four sorted round-robin lanes. */
export function estimateTestMs(files, workers, durations, lanes) {
  let sequential = 0;
  const parallel = Array(workers).fill(0);
  let index = 0;
  for (const file of [...files].sort()) {
    const ms = durations[file] ?? 1500;
    if ((lanes.get(file) ?? 'parallel') !== 'parallel') sequential += ms;
    else parallel[index++ % workers] += ms;
  }
  return sequential + Math.max(0, ...parallel);
}

export function balanceTestShards(files, count, workers, durations, lanes) {
  const bins = Array.from({ length: Math.min(count, files.length) }, () => ({ files: [], ms: 0 }));
  const weight = (file) =>
    (durations[file] ?? 1500) / ((lanes.get(file) ?? 'parallel') === 'parallel' ? workers : 1);
  for (const file of [...files].sort((a, b) => weight(b) - weight(a) || a.localeCompare(b))) {
    let best;
    for (const [index, bin] of bins.entries()) {
      const ms = estimateTestMs([...bin.files, file], workers, durations, lanes);
      const other = Math.max(
        0,
        ...bins.filter((_, candidate) => candidate !== index).map((b) => b.ms),
      );
      // Minimize the critical path, then idle runner time. Packing available
      // parallel lanes avoids paying twelve setups for twelve mostly idle jobs.
      const score = [Math.max(ms, other), ms - bin.ms, ms, index];
      const different = best && score.findIndex((value, i) => value !== best.score[i]);
      if (!best || (different >= 0 && score[different] < best.score[different]))
        best = { bin, ms, score };
    }
    best.bin.files.push(file);
    best.bin.ms = best.ms;
  }
  return bins.filter((bin) => bin.files.length);
}

export function withoutBuilds(script) {
  return script
    .split('&&')
    .map((part) => part.trim())
    .filter((part) => !/^yarn (?:workspace \S+ )?build$/.test(part))
    .join(' && ');
}

function command(id, args, seconds = 20, cwd = '.') {
  return { id, args, seconds, cwd };
}

export function createPrPlan({
  root,
  changed,
  workspaces,
  selected,
  durations = {},
  lanes,
  taskDurations = {},
}) {
  const eligible = workspaceSuiteFiles(workspaces, root);
  selected = selected.filter((file) => !ownerOf(file, workspaces) || eligible.has(file));
  const impact = runtimeImpactFiles(changed);
  const affected = affectedWorkspaceNames(workspaces, impact);
  for (const file of selected) {
    const owner = ownerOf(file, workspaces);
    if (owner) affected.add(owner.name);
  }
  const ciOnly = changed?.length > 0 && impact.length === 0;
  if (changed?.some(isCiControlFile))
    selected.push(
      'services/gateway/src/projects/repo-root.test.ts',
      'services/gateway/src/methods/acceptance-evidence.rpc.test.ts',
      'services/gateway/src/methods/acceptance-evidence.test.ts',
      'apps/command-center/ui/src/utils/url-state.test.ts',
      'packages/run-bundle/src/retained-locks.test.ts',
    );
  const parity = ciParitySteps(changed, root);
  // Keep external-input guards in the plan even when imports cannot express their
  // template trigger. The gateway shard then owns the forced file exactly once.
  for (const [label] of parity) {
    if (label === 'static review execution guard')
      selected.push('services/gateway/src/review/static-review-execution.test.ts');
    if (label === 'deterministic receipt guard')
      selected.push('packages/agent-runtime/test/deterministic-checks.test.cjs');
  }
  selected = [...new Set(selected)];
  // The source graph already classified files. Without that metadata, estimate
  // serial execution rather than rereading sources or assuming concurrency.
  lanes ??= new Map(selected.map((file) => [file, 'serial']));
  const tasks = [];
  const seedJobs = [];
  const assigned = new Set();
  function splitTests(id, dir, count, tsconfig, workers, runnerDir = dir) {
    const suite = selected.filter(
      (file) => file.startsWith(`${dir}/`) && file.endsWith('.test.ts'),
    );
    const toJobs = (chunks) =>
      chunks.map(({ files: chunk, ms }, index) => {
        const task = command(
          `${id}-${index + 1}`,
          [
            'node',
            'scripts/quality/run-tsx-tests.mjs',
            '--cwd',
            runnerDir,
            '--tsconfig',
            tsconfig,
            '--workers',
            String(workers),
            ...chunk.map((file) => path.posix.relative(runnerDir, file)),
          ],
          Math.max(1, Math.ceil(ms / 1000)),
        );
        task.tests = chunk;
        return { id: task.id, tasks: [task] };
      });
    let chunks;
    if (id === 'gateway') {
      const full =
        suite.length === [...eligible].filter((file) => file.startsWith(`${dir}/`)).length;
      let shards = full ? Math.min(count, suite.length) : 1;
      const distribute = (size) => balanceTestShards(suite, size, workers, durations, lanes);
      chunks = distribute(shards);
      while (shards < Math.min(count, suite.length) && chunks.some(({ ms }) => ms > 120_000))
        chunks = distribute(++shards);
    } else
      chunks = balance(suite, count, (file) => durations[file] ?? 1500).map((files) => ({
        files,
        ms: estimateTestMs(files, workers, durations, lanes),
      }));
    seedJobs.push(...toJobs(chunks));
    suite.forEach((file) => assigned.add(file));
  }
  splitTests(
    'command-center-ui',
    'apps/command-center/ui',
    ciOnly ? 1 : 4,
    'ui/tsconfig.json',
    2,
    'apps/command-center',
  );
  if (changed?.some(isCiControlFile) && !affected.has('@farmslot/run-bundle'))
    splitTests('run-bundle-smoke', 'packages/run-bundle', 1, 'tsconfig.json', 2);
  // Keep one slot for the longest workspace command or a batch of guards.
  const gatewaySlots = ciOnly ? 1 : PR_MATRIX_LIMIT - seedJobs.length - 1;
  splitTests('gateway', 'services/gateway', gatewaySlots, 'tsconfig.json', 4);
  for (const workspace of workspaces) {
    if (!affected.has(workspace.name)) continue;
    const pkg = JSON.parse(readFileSync(path.join(root, workspace.dir, 'package.json'), 'utf8'));
    if (pkg.scripts?.typecheck && workspace.dir !== 'apps/command-center') {
      const script = withoutBuilds(pkg.scripts.typecheck);
      tasks.push(
        command(
          `types-${workspace.name}`,
          ['yarn', 'exec', 'bash', '-e', '-o', 'pipefail', '-c', script],
          workspace.dir === 'apps/companion' ? 45 : 20,
          workspace.dir,
        ),
      );
    } else if (
      existsSync(path.join(root, workspace.dir, 'tsconfig.json')) &&
      !['apps/docs', 'apps/command-center'].includes(workspace.dir)
    ) {
      tasks.push(
        command(
          `types-${workspace.name}`,
          ['yarn', 'exec', 'tsc', '--noEmit', '-p', `${workspace.dir}/tsconfig.json`],
          20,
        ),
      );
    }
    if (
      !['services/gateway', 'apps/command-center', 'apps/command-center/ui', 'apps/docs'].includes(
        workspace.dir,
      )
    ) {
      const script = workspace.test ?? pkg.scripts?.['test:lib'];
      if (script) {
        const suite = selected.filter((file) => ownerOf(file, workspaces)?.name === workspace.name);
        // Custom suites may load runtime fixtures or shell commands outside an
        // import graph. Keep the declared suite whenever its workspace is affected.
        const task = command(
          `tests-${workspace.name}`,
          ['yarn', 'exec', 'bash', '-e', '-o', 'pipefail', '-c', withoutBuilds(script)],
          workspace.dir === 'packages/cli' ? 135 : 60,
          workspace.dir,
        );
        task.tests = suite;
        suite.forEach((file) => assigned.add(file));
        tasks.push(task);
      }
    }
  }
  // ciParitySteps remains the shared owner of architecture and repository guards.
  for (const [label, args] of parity) {
    // Gateway and agent-runtime suites already own these test files.
    if (label === 'static review execution guard' || label === 'large files') continue;
    if (
      label === 'deterministic receipt guard' &&
      assigned.has('packages/agent-runtime/test/deterministic-checks.test.cjs')
    )
      continue;
    tasks.push(
      command(
        `guard-${label}`,
        args,
        label === 'offline-first reads'
          ? 165
          : label === 'lint'
            ? 80
            : label === 'format'
              ? 40
              : 15,
      ),
    );
  }
  tasks.push(command('type-escape-ratchet', ['yarn', 'lint:type-escapes'], 15));
  const touches = (prefixes) =>
    changed === null || changed.some((file) => prefixes.some((prefix) => file.startsWith(prefix)));
  if (affected.has('@farmslot/command-center') || affected.has('@farmslot/command-center-ui')) {
    tasks.push(
      command('command-center-authority', [
        'bash',
        'apps/command-center/scripts/check-auto-recovery-authority.sh',
      ]),
    );
    tasks.push(
      command('recipe-operational-scripts', [
        'node',
        '--test',
        'apps/command-center/scripts/agentic/run-recipe.test.mjs',
        'apps/command-center/scripts/agentic/recording-target.test.mjs',
      ]),
    );
  }
  if (affected.has('@farmslot/mobile'))
    tasks.push(
      command('companion-structure', ['yarn', '--cwd', 'apps/companion', 'quality:structure:ci']),
    );
  if (
    touches([
      'apps/docs/',
      'docs/reference/',
      'docs/operations/onboarding.md',
      'scripts/docs/',
      'packages/protocol/',
      'services/gateway/',
      '.github/',
      'package.json',
      'yarn.lock',
    ])
  ) {
    tasks.push(command('generated-docs', ['node', 'scripts/quality/pr-ci-run.mjs', 'docs'], 55));
  }
  if (touches(['scripts/acceptance-evidence/', 'services/gateway/', 'packages/', '.github/']))
    tasks.push(
      command('acceptance-proof', ['node', 'scripts/quality/pr-ci-run.mjs', 'acceptance'], 15),
    );
  if (
    touches([
      '.agents/',
      'scripts/lib/',
      'scripts/install-runner-observability',
      'services/gateway/',
      'packages/',
      '.github/',
    ])
  )
    tasks.push(
      command('model-transport', ['node', 'scripts/quality/pr-ci-run.mjs', 'transport'], 45),
    );
  if (touches(['scripts/quality/', '.github/']))
    tasks.push(
      command(
        'ci-selection-contracts',
        [
          'node',
          '--test',
          'scripts/quality/affected-tests.test.mjs',
          'scripts/quality/pr-ci-plan.test.mjs',
          'scripts/quality/workspace-test-targets.test.mjs',
          'scripts/quality/gateway-ci-shards.test.mjs',
          'scripts/quality/run-tsx-tests.test.mjs',
        ],
        15,
      ),
    );
  if (touches(['services/node/', 'scripts/deploy-node', '.github/']))
    tasks.push(
      command('node-deploy-tests', ['node', '--test', 'scripts/deploy-node.test.mjs'], 20),
    );
  if (touches(['scripts/install-runner-observability', '.github/']))
    tasks.push(
      command(
        'observability-installer',
        ['node', '--test', 'scripts/install-runner-observability.test.mjs'],
        15,
      ),
    );
  tasks.push(command('export-parity', ['node', 'scripts/quality/check-cjs-esm-exports.mjs'], 15));
  if (
    touches([
      'packages/',
      'package.json',
      'scripts/quality/check-farmslot-package-readiness',
      '.github/',
    ])
  )
    tasks.push(
      command(
        'package-metadata',
        ['node', 'scripts/quality/check-farmslot-package-readiness.mjs'],
        15,
      ),
    );
  if (affected.has('@farmslot/gateway'))
    tasks.push(
      command('two-farm-instances', ['node', 'scripts/quality/pr-ci-run.mjs', 'farm-proof'], 12),
    );
  // Explicit script suites own their files too. Anything else selected by the
  // source graph gets an executable test task instead of a silent exemption.
  const specialOwners = [
    ['generated-docs', 'apps/docs/'],
    ['model-transport', '.agents/skills/'],
    ['acceptance-proof', 'scripts/acceptance-evidence/'],
  ];
  for (const [id, prefix] of specialOwners) {
    if (tasks.some((task) => task.id === id))
      selected.filter((file) => file.startsWith(prefix)).forEach((file) => assigned.add(file));
  }
  for (const task of tasks)
    for (const arg of task.args) if (selected.includes(arg)) assigned.add(arg);
  const remaining = selected.filter((file) => !assigned.has(file));
  const native = [];
  const typed = [];
  for (const file of remaining) (/\.[cm]?js$/.test(file) ? native : typed).push(file);
  const scriptGroups = [
    [native, ['node', '--experimental-test-module-mocks', '--test']],
    [
      typed,
      [
        'env',
        `TSX_TSCONFIG_PATH=${path.resolve(root, 'services/gateway/tsconfig.json')}`,
        'node',
        '--import',
        'tsx',
        '--experimental-test-module-mocks',
        '--test',
      ],
    ],
  ];
  let scriptIndex = 0;
  for (const [files, args] of scriptGroups) {
    for (const chunk of balance(
      files,
      Math.min(4, files.length),
      (file) => durations[file] ?? 1500,
    )) {
      const costs = chunk.map((file) => durations[file] ?? 1500);
      const seconds =
        2 + Math.ceil(Math.max(...costs, costs.reduce((ms, value) => ms + value, 0) / 2) / 1000);
      tasks.push(command(`other-selected-tests-${++scriptIndex}`, [...args, ...chunk], seconds));
      chunk.forEach((file) => assigned.add(file));
    }
  }
  if (selected.some((file) => !assigned.has(file)))
    throw new Error('Selected tests lack a CI owner');
  for (const task of tasks) {
    const sample = taskDurations[task.id];
    if (!sample) continue;
    let ms = sample.ms;
    if (sample.referenceFiles && task.tests) {
      const reference = estimateTestMs(sample.referenceFiles, sample.workers, durations, lanes);
      const current = estimateTestMs(
        task.tests.filter((file) => file.endsWith('.test.ts')),
        sample.workers,
        durations,
        lanes,
      );
      ms = sample.fixedMs + (reference ? ((sample.ms - sample.fixedMs) * current) / reference : 0);
    }
    task.seconds = Math.max(1, Math.ceil(ms / 1000));
  }
  const jobs = packPrTasks(seedJobs, tasks);
  const owners = new Map(selected.map((file) => [file, new Set()]));
  for (const task of jobs.flatMap((job) => job.tasks))
    for (const file of [...(task.tests ?? []), ...task.args]) owners.get(file)?.add(task.id);
  for (const [file, candidates] of owners) {
    if (!candidates.size)
      for (const [id, prefix] of specialOwners)
        if (file.startsWith(prefix) && tasks.some((task) => task.id === id)) candidates.add(id);
    if (candidates.size !== 1)
      throw new Error(`Selected test ${file} requires one owner: ${[...candidates].join(', ')}`);
  }
  const testOwners = Object.fromEntries([...owners].map(([file, ids]) => [file, [...ids][0]]));
  return { schemaVersion: 1, changed, selected, jobs, testOwners };
}

export function prChangedFiles(root, pullRequest) {
  const env = { ...process.env };
  for (const name of GIT_LOCATION_ENV) delete env[name];
  // The checked-out synthetic merge can include main commits newer than the
  // event's base SHA. Compare the PR head against the fetched base branch.
  const result = spawnSync(
    'git',
    ['diff', '--name-only', '-z', `origin/${pullRequest.base.ref}...${pullRequest.head.sha}`],
    { cwd: root, env, encoding: 'utf8' },
  );
  if (result.status !== 0) throw new Error(`Cannot determine PR changes: ${result.stderr}`);
  return result.stdout.split('\0').filter(Boolean);
}

export function inlinePlanOutput(json) {
  const encoded = gzipSync(json).toString('base64');
  // Leave room below Linux's 128 KiB per-environment-entry limit. Larger plans
  // keep using the retained artifact, with the same receipt validation.
  return encoded.length <= 96 * 1024 ? encoded : '';
}

if (isMainModule(import.meta.url)) {
  const root = process.cwd();
  const event = JSON.parse(readFileSync(process.env.GITHUB_EVENT_PATH, 'utf8'));
  const base = event.pull_request?.base?.sha;
  const replay =
    process.env.GITHUB_EVENT_NAME === 'workflow_dispatch' ? event.inputs?.replay_pr : null;
  if (!base && !replay) throw new Error('PR selection requires a pull request base SHA');
  const git = (args) => {
    const result = spawnSync('git', args, { encoding: 'utf8', maxBuffer: 20 * 1024 * 1024 });
    if (result.status !== 0) throw new Error(result.stderr);
    return result.stdout.split('\0').filter(Boolean);
  };
  const files = git(['ls-files', '-z']);
  let changed;
  if (replay) {
    if (!/^[1-9]\d*$/.test(replay)) throw new Error('Replay PR must be a positive number');
    changed = [];
    for (let page = 1; ; page++) {
      const response = await fetch(
        `https://api.github.com/repos/${process.env.GITHUB_REPOSITORY}/pulls/${replay}/files?per_page=100&page=${page}`,
        {
          headers: {
            Authorization: `Bearer ${process.env.GITHUB_TOKEN}`,
            Accept: 'application/vnd.github+json',
          },
        },
      );
      if (!response.ok) throw new Error(`Cannot load replay PR files: HTTP ${response.status}`);
      const files = await response.json();
      if (!Array.isArray(files) || files.some((file) => typeof file.filename !== 'string'))
        throw new Error('Invalid replay PR file response');
      changed.push(
        ...files.flatMap((file) =>
          file.previous_filename ? [file.previous_filename, file.filename] : [file.filename],
        ),
      );
      if (files.length < 100) break;
    }
  } else changed = prChangedFiles(root, event.pull_request);
  const workspaces = workspaceTestCatalog(root);
  const graph = readGraph(root, files, workspaces);
  const selected = selectAffectedTests({ files, changed, workspaces, graph });
  const { files: durations, tasks: taskDurations } = JSON.parse(
    readFileSync('scripts/quality/pr-ci-durations.json', 'utf8'),
  );
  const plan = createPrPlan({
    root,
    changed,
    workspaces,
    selected,
    durations,
    lanes: graph.lanes,
    taskDurations,
  });
  if (replay) plan.replayPr = Number(replay);
  mkdirSync('.cache/pr-ci', { recursive: true });
  const json = `${JSON.stringify(plan, null, 2)}\n`;
  writeFileSync('.cache/pr-ci/plan.json', json);
  const inlinePlan = inlinePlanOutput(json);
  if (inlinePlan) appendFileSync(process.env.GITHUB_OUTPUT, `inline_plan=${inlinePlan}\n`);
  appendFileSync(
    process.env.GITHUB_OUTPUT,
    `matrix=${JSON.stringify({ include: plan.jobs.map(({ id, tasks }) => ({ id, lint: tasks.some((task) => task.id === 'guard-lint') })) })}\n`,
  );
  console.log(
    JSON.stringify(
      {
        changed: changed.length,
        selected: plan.selected.length,
        jobs: plan.jobs.map(({ id, tasks }) => ({ id, tasks: tasks.map((task) => task.id) })),
      },
      null,
      2,
    ),
  );
}
