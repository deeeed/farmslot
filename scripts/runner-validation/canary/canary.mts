#!/usr/bin/env tsx
import { RECOVERY_CASES, runRecoveryMatrix } from './recovery.mjs';
import { runPerformanceCanary } from './performance.mjs';
// Farmslot canary profiles.
//
//   canary   after every dev gateway update; zero inference, a few minutes. Against the deployed
//            gateway (--target live, the default): per canary node a native round trip and one
//            scripted run through find-slot, write-task, prepare, dispatch, monitor, complete,
//            gate, close and release, timed against config.json budgets; on one node, a replay
//            from dispatch with the gate card open (F324). On an isolated stack: one restart
//            mid-step (MONITOR, node up). --target isolated runs every case on the isolated stack.
//   nightly  the isolated restart matrix: dispatch, monitor, human-gate package prep, finalize
//            and release, each with the node up and with it away past recovery's node wait, plus
//            REVIEW with its node away past the reconnect wait (no model call), and worker-survives:
//            a restart with the worker or reviewer mid-turn in DISPATCH, MONITOR, REVIEW, its fix
//            round, HUMAN_GATE prep and FINALIZE, which must leave it alive (no model call: the test
//            answers the reviewer), and a Pi-runner worker in MONITOR whose model stream drops as
//            the gateway restarts. --with-review adds one reviewed run (two codex gpt-6-luna calls):
//            REVIEW and its fix round.
//
//   recovery  seven concurrent recovery cases on disposable slots, zero inference.
//             Hard ceiling 120 s including cleanup; cases over 5 s print step attribution.
//
// Every model a case would use must be on config.json's allowlist, or the canary stops before
// dispatching anything. Known failures (config.json) report as KNOWN; one that passes fails the
// canary until its entry is removed.
//
// Run: node --import tsx scripts/runner-validation/canary/canary.mts --profile canary|nightly|recovery
//   [--target live|isolated] [--with-review] [--only lifecycle,f324,…]
//   [--fast-scripted] (isolated lifecycle only; skips unused prepare work and timer windows)
//   [--survive-steps dispatch,monitor,…] [--budget step=seconds]…
//   [--evidence <dir>] [--results <file>] [--status-file <file>] [--hold-file <file>]
//   [--cli-snapshot <dir> | --cli-snapshots <dir>] [--node-away-s 20] [--review-node-away-s 130]
//   [--review-fix-node-away-s 100]
// Exit 0: every check passed (KNOWN and NOT_EXERCISED are warnings). 1: a check failed. 2: the
// canary could not run.
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { appendFile, mkdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { cleanupOnExit, startReaper } from '../lib/isolated-stack.mjs';

import { REVIEWER } from './fixtures.mjs';
import {
  RESTART_STEPS,
  runIsolated,
  SURVIVE_STEPS,
  type SurviveStep,
  type Variant,
} from './isolated.mjs';
import { runLive } from './live.mjs';
import { applyKnownFailures, type CheckResult, type KnownFailure } from './outcome.mjs';
import { report, type Verdict } from './report.mjs';

const argv = process.argv.slice(2);
if (argv.includes('--help')) {
  console.log(`Usage: node --import tsx scripts/runner-validation/canary/canary.mts
  --profile canary|nightly|recovery --target live|isolated
  [--only case,...] [--evidence <dir>] [--results <file>]
Recovery cases: ${RECOVERY_CASES.join(', ')}`);
  process.exit(0);
}
const arg = (name: string) => {
  const index = argv.indexOf(`--${name}`);
  return index >= 0 ? argv[index + 1] : undefined;
};
const args = (name: string) =>
  argv.flatMap((value, index) => (argv[index - 1] === `--${name}` ? [value] : []));
const expand = (value: string) => value.replace(/^~(?=\/|$)/, homedir());

const root = fileURLToPath(new URL('../../../', import.meta.url));
const profile = arg('profile') ?? 'canary';
if (profile !== 'canary' && profile !== 'nightly' && profile !== 'recovery')
  throw new Error('--profile must be canary, nightly or recovery');
const target = arg('target') ?? (profile === 'canary' ? 'live' : 'isolated');
if (target !== 'live' && target !== 'isolated')
  throw new Error('--target must be live or isolated');
if ((profile === 'nightly' || profile === 'recovery') && target === 'live')
  throw new Error('The nightly and recovery profiles run isolated only');
const withReview = argv.includes('--with-review');
const fastScripted = argv.includes('--fast-scripted');
if (fastScripted && (target !== 'isolated' || profile !== 'canary'))
  throw new Error('--fast-scripted requires --profile canary --target isolated');
const startedAt = new Date();
const evidence = path.resolve(
  expand(
    arg('evidence') ??
      `~/farmslot-canary/runs/${profile}-${startedAt.toISOString().replace(/[:.]/g, '-')}`,
  ),
);
const resultsFile = path.resolve(expand(arg('results') ?? path.join(evidence, 'results.json')));

const config = JSON.parse(readFileSync(new URL('./config.json', import.meta.url), 'utf8')) as {
  modelAllowlist: string[];
  budgetsS: Record<string, number>;
  knownFailures: KnownFailure[];
  live: {
    profileHome: string;
    profile: string;
    nodes: Array<{ machine: string; slot: string }>;
    f324Node: string;
  };
};
const budgetsS = { ...config.budgetsS };
for (const entry of args('budget')) {
  const [step, seconds] = entry.split('=');
  if (!step || !Number.isFinite(Number(seconds)))
    throw new Error(`--budget takes step=seconds, got ${entry}`);
  budgetsS[step] = Number(seconds);
}

// ---------------------------------------------------------------- the cases this run makes
const CASES = [
  ...RECOVERY_CASES,
  'performance',
  'lifecycle',
  'f324',
  'native-check',
  ...RESTART_STEPS,
  'review',
  'review-past-wait',
  'worker-survives',
] as const;
const only = arg('only')?.split(',') ?? (fastScripted ? ['lifecycle'] : undefined);
if (fastScripted && only!.some((name) => name !== 'lifecycle'))
  throw new Error('--fast-scripted supports lifecycle only');
for (const name of only ?? [])
  if (!(CASES as readonly string[]).includes(name)) throw new Error(`Unknown case ${name}`);
const available: readonly string[] =
  profile === 'recovery'
    ? RECOVERY_CASES
    : profile === 'canary'
      ? ['lifecycle', 'f324', 'native-check', 'monitor']
      : [
          'performance',
          ...RESTART_STEPS,
          'review-past-wait',
          'worker-survives',
          ...(withReview ? ['review'] : []),
        ];
for (const name of only ?? [])
  if (!available.includes(name)) throw new Error(`Case ${name} does not run in profile ${profile}`);
const wants = (name: (typeof CASES)[number]) => !only || only.includes(name);
const surviveSteps = (arg('survive-steps')?.split(',') ?? [...SURVIVE_STEPS]) as SurviveStep[];
for (const step of surviveSteps)
  if (!(SURVIVE_STEPS as readonly string[]).includes(step))
    throw new Error(`Unknown worker-survives step ${step}`);
const plan =
  profile === 'canary'
    ? {
        live: target === 'live' && (wants('lifecycle') || wants('f324') || wants('native-check')),
        lifecycle: target === 'isolated' && wants('lifecycle'),
        nativeCheck: target === 'isolated' && wants('native-check'),
        f324: target === 'isolated' && wants('f324'),
        restarts: wants('monitor')
          ? [{ step: 'monitor' as const, variants: ['node-up'] as Variant[] }]
          : [],
        review: false,
        reviewPastWait: false,
        survive: [] as SurviveStep[],
      }
    : {
        live: false,
        lifecycle: false,
        nativeCheck: false,
        f324: false,
        restarts: RESTART_STEPS.filter((step) => wants(step)).map((step) => ({
          step,
          variants: ['node-up', 'node-away'] as Variant[],
        })),
        review: withReview && wants('review'),
        reviewPastWait: wants('review-past-wait'),
        survive: wants('worker-survives') ? surviveSteps : [],
      };

// The models those cases would use, checked before anything is dispatched.
const reviews =
  plan.review ||
  plan.reviewPastWait ||
  plan.survive.some((step) => step === 'review' || step === 'review-fix');
const models = ['scripted', ...(reviews ? [REVIEWER.model] : [])];
const refused = models.filter((model) => !config.modelAllowlist.includes(model));

await mkdir(evidence, { recursive: true });
const t0 = Date.now();
async function log(event: string, detail: Record<string, unknown> = {}) {
  const entry = {
    at: new Date().toISOString(),
    t: Math.round((Date.now() - t0) / 100) / 10,
    event,
    ...detail,
  };
  console.log(
    `[canary +${entry.t}s] ${event}${Object.keys(detail).length ? ` ${JSON.stringify(detail)}` : ''}`,
  );
  await appendFile(path.join(evidence, 'timeline.jsonl'), `${JSON.stringify(entry)}\n`);
}

const head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
const reaper = startReaper();
let stopStack: (() => Promise<string[]>) | undefined;
let stopLive: (() => Promise<string[]>) | undefined;
const checks: CheckResult[] = [];
const cleanupErrors: string[] = [];
let setupError: string | undefined;
let completed = false;
let cleaning = false;
let reported: Promise<Verdict> | undefined;
/** Applies the known failures and reports, once, whichever path gets here first. */
const finish = () =>
  (reported ??= (async () => {
    if (profile === 'recovery' && Date.now() - startedAt.getTime() > 120_000) {
      checks.push({
        case: 'matrix-budget',
        variant: 'main',
        target: 'isolated',
        status: 'fail',
        model: 'scripted',
        modelCalls: 0,
        differences: ['Recovery matrix exceeded 120000ms including cleanup'],
        observations: [],
      });
    }
    for (const [index, check] of checks.entries())
      checks[index] = applyKnownFailures(check, config.knownFailures);
    return report({
      profile:
        profile === 'canary'
          ? 'canary'
          : profile === 'recovery'
            ? 'canary-recovery'
            : 'canary-nightly',
      head,
      startedAt,
      resultsFile,
      ...(arg('status-file') ? { statusFile: expand(arg('status-file')!) } : {}),
      ...(arg('hold-file') && profile === 'canary' ? { holdFile: expand(arg('hold-file')!) } : {}),
      checks,
      setupError: setupError ?? (completed ? undefined : 'interrupted before the canary finished'),
      cleanupErrors,
      evidence,
      extra: { target, withReview, models, budgetsS, knownFailures: config.knownFailures },
    });
  })());
const cleanup = cleanupOnExit(async () => {
  cleaning = true;
  cleanupErrors.push(...((await stopLive?.()) ?? []));
  const stackErrors = (await stopStack?.()) ?? [];
  cleanupErrors.push(...stackErrors);
  // What could not be stopped stays with the reaper, which tries again when this process exits.
  if (!stackErrors.length) reaper.done();
  // A signal exits right after this, so the report is written here on both paths.
  await finish();
});

try {
  if (refused.length)
    throw new Error(
      `Model(s) outside the canary allowlist (${config.modelAllowlist.join(', ')}): ${refused.join(', ')}`,
    );
  const onCheck = (check: CheckResult) => {
    checks.push(check);
  };
  if (profile === 'recovery')
    await runRecoveryMatrix({
      cases: only as (typeof RECOVERY_CASES)[number][] | undefined,
      root,
      evidence,
      reaper,
      log,
      onCheck,
      cliSnapshots: expand(arg('cli-snapshots') ?? '~/farmslot-canary/cli-snapshots'),
      ...(arg('cli-snapshot') ? { cliSnapshot: expand(arg('cli-snapshot')!) } : {}),
      onCleanup: (stop) => {
        stopStack = stop;
      },
    });
  if (profile === 'nightly' && wants('performance'))
    onCheck(
      await runPerformanceCanary({
        root,
        evidence,
        reaper,
        onCleanup: (stop) => {
          stopStack = stop;
        },
      }),
    );
  if (plan.live)
    await runLive({
      profileHome: expand(config.live.profileHome),
      profile: config.live.profile,
      nodes: config.live.nodes,
      lifecycle: wants('lifecycle'),
      nativeCheck: wants('native-check'),
      ...(wants('f324') ? { f324Node: config.live.f324Node } : {}),
      budgetsS,
      evidence,
      log,
      onCheck,
      onStop: (stop) => {
        stopLive = stop;
      },
    });
  if (
    profile !== 'recovery' &&
    (plan.nativeCheck ||
      plan.lifecycle ||
      plan.f324 ||
      plan.restarts.length ||
      plan.review ||
      plan.reviewPastWait ||
      plan.survive.length)
  )
    await runIsolated({
      root,
      evidence,
      log,
      reaper,
      ownerTag: process.env.CANARY_STAMP ?? String(process.pid),
      cliSnapshots: expand(arg('cli-snapshots') ?? '~/farmslot-canary/cli-snapshots'),
      ...(arg('cli-snapshot') ? { cliSnapshot: expand(arg('cli-snapshot')!) } : {}),
      budgetsS,
      nodeAwayMs: Number(arg('node-away-s') ?? 20) * 1000,
      reviewFixNodeAwayMs: Number(arg('review-fix-node-away-s') ?? 100) * 1000,
      reviewNodeAwayMs: Number(arg('review-node-away-s') ?? 130) * 1000,
      lifecycle: plan.lifecycle,
      fastScripted,
      nativeCheck: plan.nativeCheck,
      f324: plan.f324,
      restarts: plan.restarts,
      review: plan.review,
      reviewPastWait: plan.reviewPastWait,
      survive: plan.survive,
      onCheck,
      onCleanup: (stop) => {
        stopStack = stop;
      },
    });
  completed = true;
} catch (error) {
  // During a signal's cleanup the calls in flight fail; the report says it was interrupted.
  if (!cleaning) {
    setupError = error instanceof Error ? (error.stack ?? error.message) : String(error);
    await log('aborted', { error: String(error) });
  }
} finally {
  await cleanup();
}
const { exitCode } = await finish();
process.exit(exitCode);
