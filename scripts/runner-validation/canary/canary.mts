#!/usr/bin/env tsx
// Farmslot canary: one tool, two profiles.
//
//   canary   after every dev gateway update; zero inference, a few minutes. Against the deployed
//            gateway (--target live, the default): per canary node a native round trip and one
//            scripted run through find-slot, write-task, prepare, dispatch, monitor, complete,
//            gate, close and release, timed against config.json budgets; on one node, a replay
//            from dispatch with the gate card open (F324). On an isolated stack: one restart
//            mid-step (MONITOR, node up). --target isolated runs every case on the isolated stack.
//   nightly  the isolated restart matrix: dispatch, monitor, human-gate package prep, finalize
//            and release, each with the node up and with it away past recovery's node wait, plus
//            REVIEW with its node away past the reconnect wait (no model call). --with-review adds
//            one reviewed run (two codex gpt-6-luna calls): REVIEW and its fix round.
//
// Every model a case would use must be on config.json's allowlist, or the canary stops before
// dispatching anything. Known failures (config.json) report as KNOWN; one that passes fails the
// canary until its entry is removed.
//
// Run: node --import tsx scripts/runner-validation/canary/canary.mts --profile canary|nightly
//   [--target live|isolated] [--with-review] [--only lifecycle,f324,…] [--budget step=seconds]…
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

import type { GatewayConnection } from '../../../packages/cli/src/gateway-client.js';
import { cleanupOnExit, startReaper } from '../lib/isolated-stack.mjs';
import type { RemoteNodeStack } from '../lib/remote-node-stack.mjs';

import { REVIEWER } from './fixtures.mjs';
import { RESTART_STEPS, runIsolated, type Variant } from './isolated.mjs';
import { runLive } from './live.mjs';
import { applyKnownFailures, type CheckResult, type KnownFailure } from './outcome.mjs';
import { report } from './report.mjs';

const argv = process.argv.slice(2);
const arg = (name: string) => {
  const index = argv.indexOf(`--${name}`);
  return index >= 0 ? argv[index + 1] : undefined;
};
const args = (name: string) =>
  argv.flatMap((value, index) => (argv[index - 1] === `--${name}` ? [value] : []));
const expand = (value: string) => value.replace(/^~(?=\/|$)/, homedir());

const root = fileURLToPath(new URL('../../../', import.meta.url));
const profile = arg('profile') ?? 'canary';
if (profile !== 'canary' && profile !== 'nightly')
  throw new Error('--profile must be canary or nightly');
const target = arg('target') ?? (profile === 'canary' ? 'live' : 'isolated');
if (target !== 'live' && target !== 'isolated')
  throw new Error('--target must be live or isolated');
if (profile === 'nightly' && target === 'live')
  throw new Error('The nightly profile runs isolated only');
const withReview = argv.includes('--with-review');
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
  'lifecycle',
  'f324',
  'native-check',
  ...RESTART_STEPS,
  'review',
  'review-past-wait',
] as const;
const only = arg('only')?.split(',');
for (const name of only ?? [])
  if (!(CASES as readonly string[]).includes(name)) throw new Error(`Unknown case ${name}`);
const wants = (name: (typeof CASES)[number]) => !only || only.includes(name);
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
      };

// The models those cases would use, checked before anything is dispatched.
const models = ['scripted', ...(plan.review || plan.reviewPastWait ? [REVIEWER.model] : [])];
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
let stack: RemoteNodeStack | undefined;
let liveConnection: GatewayConnection | undefined;
const checks: CheckResult[] = [];
const cleanupErrors: string[] = [];
let setupError: string | undefined;
let completed = false;
// Cleanup reports only when a signal ran it; the normal path reports after applying known failures.
let signalled = true;
const finish = () =>
  report({
    profile: profile === 'canary' ? 'canary' : 'canary-nightly',
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
const cleanup = cleanupOnExit(async () => {
  liveConnection?.close();
  if (stack) cleanupErrors.push(...(await stack.cleanup()));
  reaper.done();
  // A signal exits right after this: report what ran, as interrupted.
  if (signalled) await finish();
});

try {
  if (refused.length)
    throw new Error(
      `Model(s) outside the canary allowlist (${config.modelAllowlist.join(', ')}): ${refused.join(', ')}`,
    );
  if (plan.live)
    checks.push(
      ...(await runLive({
        profileHome: expand(config.live.profileHome),
        profile: config.live.profile,
        nodes: config.live.nodes,
        lifecycle: wants('lifecycle'),
        nativeCheck: wants('native-check'),
        ...(wants('f324') ? { f324Node: config.live.f324Node } : {}),
        budgetsS,
        evidence,
        log,
        onConnection: (connection) => {
          liveConnection = connection;
        },
      })),
    );
  if (
    plan.nativeCheck ||
    plan.lifecycle ||
    plan.f324 ||
    plan.restarts.length ||
    plan.review ||
    plan.reviewPastWait
  )
    checks.push(
      ...(await runIsolated({
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
        nativeCheck: plan.nativeCheck,
        f324: plan.f324,
        restarts: plan.restarts,
        review: plan.review,
        reviewPastWait: plan.reviewPastWait,
        onStack: (created) => {
          stack = created;
        },
      })),
    );
} catch (error) {
  setupError = error instanceof Error ? (error.stack ?? error.message) : String(error);
  await log('aborted', { error: String(error) });
} finally {
  signalled = false;
  await cleanup();
}
for (const [index, check] of checks.entries())
  checks[index] = applyKnownFailures(check, config.knownFailures);
completed = true;
const { exitCode } = await finish();
process.exit(exitCode);
