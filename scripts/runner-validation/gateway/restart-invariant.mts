#!/usr/bin/env tsx
// Restart invariant: a gateway restart at any pipeline step leaves the run with the outcome it
// has without one. On an isolated gateway with a remote node slot (lib/remote-node-stack.mts),
// a no-restart baseline runs for each run shape; then, for each step, a run is held at a known
// point in that step, the gateway restarts (once with the node up, once with the node away past
// recovery's node wait), the hold is released, and the run's end state (run status, step
// statuses, decisions presented, slot state) must equal the baseline's.
//
// The scripted worker drives every run. REVIEW and its fix round use a real codex reviewer
// (restart-invariant-fixtures.mts REVIEWER) on a two-file change; one run holds the reviewer and
// then the worker's fix, restarting twice at each, so the matrix makes two reviews plus the
// baseline's two.
//
// Run: node --import tsx scripts/runner-validation/gateway/restart-invariant.mts \
//   [--evidence <dir>] [--results <file>] [--only dispatch,monitor,...] [--baselines-only] \
//   [--cli-snapshots <dir>] [--node-away-s 20] [--review-node-away-s 130]
// Exit 0: every step matched its baseline. 1: a step differed. 2: the test could not run a step
// (setup failure, a hold that never took effect, a run that never settled).
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { appendFile, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

import type { Run } from '../../../packages/protocol/src/index.js';
import { cleanupOnExit, poll, startReaper, writeJson } from '../lib/isolated-stack.mjs';
import { type RemoteNodeStack, startRemoteNodeStack } from '../lib/remote-node-stack.mjs';

import {
  PIPE_PROJECT,
  projectPacks,
  REVIEW_PROJECT,
  REVIEW_TICKET,
  REVIEWER,
  SEED,
  slotCli,
} from './restart-invariant-fixtures.mjs';
import {
  outcomeDifferences,
  verdictDrift,
  type RunOutcome,
  runOutcome,
  type SlotView,
} from './restart-invariant-outcome.mjs';

// ---------------------------------------------------------------- arguments
const argv = process.argv.slice(2);
const arg = (name: string) => {
  const index = argv.indexOf(`--${name}`);
  return index >= 0 ? argv[index + 1] : undefined;
};
const root = fileURLToPath(new URL('../../../', import.meta.url));
const startedAt = new Date();
const evidence = path.resolve(
  root,
  arg('evidence') ?? `temp/restart-invariant/${startedAt.toISOString().replace(/[:.]/g, '-')}`,
);
const resultsFile = path.resolve(arg('results') ?? path.join(evidence, 'results.json'));
const cliSnapshots = path.resolve(
  arg('cli-snapshots') ??
    path.join(homedir(), 'dev', 'farmslot-worktrees', 'restart-invariant-cli-snapshots'),
);
// Past the 15 s a node RPC waits for its node, and the 120 s REVIEW waits for a reloading one.
const NODE_AWAY_MS = Number(arg('node-away-s') ?? 20) * 1000;
const REVIEW_NODE_AWAY_MS = Number(arg('review-node-away-s') ?? 130) * 1000;
const STEP_NAMES = [
  'dispatch',
  'monitor',
  'review',
  'review-fix',
  'human-gate-prep',
  'finalize',
  'release',
] as const;
type StepName = (typeof STEP_NAMES)[number];
const only = arg('only')?.split(',') ?? [...STEP_NAMES];
for (const name of only)
  if (!(STEP_NAMES as readonly string[]).includes(name)) throw new Error(`Unknown step ${name}`);
const selected = STEP_NAMES.filter((name) => only.includes(name));
const baselinesOnly = argv.includes('--baselines-only');

await mkdir(evidence, { recursive: true });
const t0 = Date.now();
const seconds = (since: number) => Math.round((Date.now() - since) / 100) / 10;
async function log(event: string, detail: Record<string, unknown> = {}) {
  const entry = { at: new Date().toISOString(), t: seconds(t0), event, ...detail };
  console.log(
    `[restart-invariant +${entry.t}s] ${event}${Object.keys(detail).length ? ` ${JSON.stringify(detail)}` : ''}`,
  );
  await appendFile(path.join(evidence, 'timeline.jsonl'), `${JSON.stringify(entry)}\n`);
}

// ---------------------------------------------------------------- run shapes
type Variant = 'node-up' | 'node-away';
type ShapeName = 'pipe' | 'review';
type Decision = Run['decisions'][number];

interface Shape {
  project: string;
  create(slotId: string): Record<string, unknown>;
  /** The action the test takes on a decision, or undefined to leave it for a person. */
  decide(decision: Decision): string | undefined;
  timeoutMs: number;
}

const offered = (decision: Decision, ...ids: string[]) =>
  ids.find((id) => (decision.actions ?? []).some((action) => action.id === id));

const SHAPES: Record<ShapeName, Shape> = {
  // Interactive dev with the reviewed profile: the profile whose HUMAN_GATE prepares a package
  // and presents a card. The worker changes nothing, so the gate offers to close the run as
  // shipped, which goes through FINALIZE without GitHub.
  pipe: {
    project: PIPE_PROJECT,
    create: (slotId) => ({
      project: PIPE_PROJECT,
      flowType: 'dev',
      mode: 'interactive',
      devInteractiveProfile: 'reviewed',
      ticketOrPr: 'restart invariant pipeline',
      initialContext: 'Scripted restart-invariant run; the worker changes nothing.',
      slotId,
      runner: 'scripted',
      model: 'scripted',
      transport: 'tmux',
      // The slot's CLI turns the scenario launch into the project's `work` command (slotCli).
      scripted: { mode: 'scenario', scenario: 'success' },
    }),
    decide: (decision) =>
      decision.type === 'engine_human_gate' ? offered(decision, 'close-as-shipped') : undefined,
    timeoutMs: 20 * 60_000,
  },
  // A validation dev run (never a publication candidate) whose REVIEW runs codex. Artifact-only,
  // so an output-review card is open while the fix round runs (#1724's case).
  review: {
    project: REVIEW_PROJECT,
    create: (slotId) => ({
      project: REVIEW_PROJECT,
      flowType: 'dev',
      mode: 'validation',
      // A Jira-shaped key passes dev ticket validation; ticketData means nothing is fetched. One
      // per run: a second run on the same ticket raises a collision decision the baseline lacks.
      ticketOrPr: `RI-${slotId.replace(/^.*-/, '')}`,
      ticketData: {
        source: 'manual',
        ...REVIEW_TICKET,
        acceptanceCriteria: [],
        affectedArea: 'src',
        stepsToReproduce: [],
        screenshots: [],
        labels: [],
      },
      slotId,
      runner: 'scripted',
      model: 'scripted',
      transport: 'tmux',
      // The slot's CLI turns the scenario launch into the project's `work` command (slotCli).
      scripted: { mode: 'scenario', scenario: 'success' },
      completionPolicy: 'artifact-only',
      reviewMode: 'cold',
      reviewValidationDepth: 'static-code',
      reviewSequence: [{ ...REVIEWER, mode: 'cold' }],
    }),
    decide: () => undefined,
    timeoutMs: 40 * 60_000,
  },
};

// ---------------------------------------------------------------- holds
interface View {
  run: Run;
  slot?: SlotView;
}

/** The run a hold belongs to: its slot, and where its evidence goes. */
interface HoldContext {
  slotId: string;
  slotRepo: string;
  dir: string;
  /** The run as the hold caught it, once it has. */
  held?: Run;
}

interface HoldPhase {
  step: StepName;
  restarts: Variant[];
  nodeAwayMs: number;
  /** When to arm: before the run is created, before the test resolves a decision, or on a poll. */
  armAt: 'create' | 'resolve' | ((view: View) => boolean);
  arm(context: HoldContext): Promise<void>;
  held(view: View): boolean;
  /** The step got past the hold point without being held. */
  missed(view: View): boolean;
  release(context: HoldContext): Promise<void>;
  /** A git hold must lift before the new gateway starts: it reads its branch at boot. */
  releaseWhileDown?: boolean;
  /** More to do while the gateway is down, after a release there. */
  whileDown?(context: HoldContext): Promise<void>;
  needsSlot?: boolean;
}

interface StepSpec {
  shape: ShapeName;
  hold: string;
  /** One phase, or several the run passes through in order (each holds and restarts). */
  phase(stack: RemoteNodeStack, restarts: Variant[]): HoldPhase | HoldPhase[];
}

const SETTLED_STEP = new Set(['done', 'failed', 'skipped']);
const TERMINAL = new Set(['done', 'failed', 'cancelled']);
// Statuses of a run that waits for a person's decision (runners/run-progress.ts).
const WAITING = new Set(['needs-decision', 'human-gating', 'blocked', 'review-failed']);
// No visible change for this long with nothing held: the run is not going to move.
const STALL_MS = 6 * 60_000;
const stepStatus = (run: Run, name: string) => run.steps.find((step) => step.name === name)?.status;
const contexts = (run: Run, role: string) =>
  (run.agentContexts ?? []).filter((context) => context.role === role);

/**
 * A marker under holds/. Its content says what to hold where the fixture reads it (the git and
 * ssh holds match commands against it). Release keeps what the hold caught (`.hit`, and the git
 * calls seen while armed, `.seen`) in the run's evidence.
 */
function marker(
  stack: RemoteNodeStack,
  name: string,
  content: (context: HoldContext) => string = () => 'hold\n',
) {
  const file = path.join(stack.holds, name);
  return {
    arm: (context: HoldContext) => writeFile(file, content(context)),
    hit: () => existsSync(`${file}.hit`),
    release: async (context: HoldContext) => {
      await rm(file, { force: true });
      for (const suffix of ['.hit', '.seen'])
        if (existsSync(`${file}${suffix}`)) {
          await appendFile(
            path.join(context.dir, `hold-${name}${suffix}`),
            await readFile(`${file}${suffix}`, 'utf8'),
          );
          // A later phase arming the same marker must see its own hit.
          await rm(`${file}${suffix}`, { force: true });
        }
    },
  };
}

/** Git calls on the run's own slot checkout; fleet refreshes of other slots go through. */
const slotGit = ({ slotId }: HoldContext) => `/slots/${slotId}( |/|$)`;

const STEPS: Record<StepName, StepSpec> = {
  dispatch: {
    shape: 'pipe',
    hold: "git on the run's slot waits while holds/git exists, armed as soon as DISPATCH runs; released while the gateway is down",
    phase: (stack, restarts) => {
      const git = marker(stack, 'git', slotGit);
      return {
        step: 'dispatch',
        restarts,
        nodeAwayMs: NODE_AWAY_MS,
        armAt: ({ run }) => stepStatus(run, 'dispatch') === 'running',
        arm: git.arm,
        held: ({ run }) => git.hit() && stepStatus(run, 'dispatch') === 'running',
        missed: ({ run }) => SETTLED_STEP.has(stepStatus(run, 'dispatch') ?? ''),
        release: git.release,
        releaseWhileDown: true,
      };
    },
  },
  monitor: {
    shape: 'pipe',
    hold: 'the scripted worker waits while holds/worker exists, armed before the run starts',
    phase: (stack, restarts) => {
      const worker = marker(stack, 'worker');
      return {
        step: 'monitor',
        restarts,
        nodeAwayMs: NODE_AWAY_MS,
        armAt: 'create',
        arm: worker.arm,
        held: ({ run }) => worker.hit() && stepStatus(run, 'monitor') === 'running',
        missed: ({ run }) => SETTLED_STEP.has(stepStatus(run, 'monitor') ?? ''),
        release: worker.release,
      };
    },
  },
  review: {
    shape: 'review',
    hold: "the codex proxy holds the reviewer's output once the node accepted its turn, while holds/review exists",
    phase: (stack, restarts) => {
      const review = marker(stack, 'review');
      return {
        step: 'review',
        restarts,
        nodeAwayMs: REVIEW_NODE_AWAY_MS,
        armAt: 'create',
        arm: review.arm,
        held: ({ run }) =>
          review.hit() &&
          stepStatus(run, 'review') === 'running' &&
          contexts(run, 'review').some((context) => context.nativeSession?.acceptedAt),
        missed: ({ run }) =>
          SETTLED_STEP.has(stepStatus(run, 'review') ?? '') ||
          contexts(run, 'review-fix').length > 0,
        release: review.release,
      };
    },
  },
  'review-fix': {
    shape: 'review',
    hold: 'the relaunched scripted worker commits its fix with the fix round live, then waits on holds/fix before marking it complete; the gateway restarts with the node up and the fix completes while it is down. Then the codex proxy holds the loop-2 re-review (holds/review) for a restart with the node away',
    // A scripted worker has no prompt receipt, so a restart while its fix signal still reads
    // running makes recovery resend the fix prompt, which it cannot accept: the fix finishes
    // during the outage instead (the #1724 shape), and the second restart lands on the re-review.
    phase: (stack) => {
      const fix = marker(stack, 'fix');
      const review = marker(stack, 'review');
      const fixContext = (run: Run) => contexts(run, 'review-fix').at(-1);
      return [
        {
          step: 'review-fix',
          restarts: ['node-up'],
          nodeAwayMs: REVIEW_NODE_AWAY_MS,
          armAt: 'create',
          arm: fix.arm,
          held: ({ run }) =>
            fix.hit() &&
            stepStatus(run, 'review') === 'running' &&
            fixContext(run)?.status === 'working',
          missed: ({ run }) =>
            SETTLED_STEP.has(stepStatus(run, 'review') ?? '') ||
            fixContext(run)?.status === 'complete',
          release: fix.release,
          releaseWhileDown: true,
          // The worker marks the fix complete while the gateway is down; the re-review that
          // recovery then launches must find its hold armed.
          whileDown: async (context) => {
            const signalFile = context.held && fixContext(context.held)?.signalFile;
            if (!signalFile) throw new Error('The held run has no review-fix signal file');
            await poll(
              'the fix signal to complete while the gateway is down',
              async () => {
                try {
                  const raw = await readFile(path.join(context.slotRepo, signalFile), 'utf8');
                  return (JSON.parse(raw) as { status?: string }).status === 'complete'
                    ? true
                    : undefined;
                } catch {
                  // Missing or mid-write: the next poll reads the finished file.
                  return undefined;
                }
              },
              120_000,
            );
            await review.arm(context);
          },
        },
        {
          step: 'review-fix',
          restarts: ['node-away'],
          nodeAwayMs: REVIEW_NODE_AWAY_MS,
          // Armed by the fix phase above, while the gateway was down.
          armAt: 'create',
          arm: async () => {},
          held: ({ run }) =>
            review.hit() &&
            stepStatus(run, 'review') === 'running' &&
            contexts(run, 'review').some(
              (context) =>
                (context.reviewLoopNumber ?? 0) >= 2 && context.nativeSession?.acceptedAt,
            ),
          missed: ({ run }) => SETTLED_STEP.has(stepStatus(run, 'review') ?? ''),
          release: review.release,
        },
      ];
    },
  },
  'human-gate-prep': {
    shape: 'pipe',
    hold: "git on the run's slot waits while holds/git exists, armed as soon as HUMAN_GATE runs, so the gate cannot finish preparing its package; released while the gateway is down",
    phase: (stack, restarts) => {
      const git = marker(stack, 'git', slotGit);
      const gateCard = (run: Run) =>
        run.decisions.some((decision) => decision.type === 'engine_human_gate');
      return {
        step: 'human-gate-prep',
        restarts,
        nodeAwayMs: NODE_AWAY_MS,
        armAt: ({ run }) => stepStatus(run, 'human-gate') === 'running',
        arm: git.arm,
        held: ({ run }) =>
          git.hit() && stepStatus(run, 'human-gate') === 'running' && !gateCard(run),
        missed: ({ run }) => gateCard(run) || SETTLED_STEP.has(stepStatus(run, 'human-gate') ?? ''),
        release: git.release,
        releaseWhileDown: true,
      };
    },
  },
  finalize: {
    shape: 'pipe',
    hold: "ssh waits while holds/ssh names session-usage.sh, FINALIZE's first slot call; armed as the test resolves the gate, released while the gateway is down",
    phase: (stack, restarts) => {
      const ssh = marker(stack, 'ssh', () => 'session-usage.sh');
      return {
        step: 'finalize',
        restarts,
        nodeAwayMs: NODE_AWAY_MS,
        armAt: 'resolve',
        arm: ssh.arm,
        held: ({ run }) => ssh.hit() && stepStatus(run, 'finalize') === 'running',
        missed: ({ run }) => SETTLED_STEP.has(stepStatus(run, 'finalize') ?? ''),
        release: ssh.release,
        releaseWhileDown: true,
      };
    },
  },
  release: {
    shape: 'pipe',
    hold: "git on the run's slot waits while holds/git exists, armed once the run is terminal, so the slot teardown cannot finish; released while the gateway is down",
    phase: (stack, restarts) => {
      const git = marker(stack, 'git', slotGit);
      return {
        step: 'release',
        restarts,
        nodeAwayMs: NODE_AWAY_MS,
        armAt: ({ run }) => TERMINAL.has(run.status),
        arm: git.arm,
        held: ({ run, slot }) =>
          TERMINAL.has(run.status) && git.hit() && slot !== undefined && slot.lifecycle !== 'ready',
        missed: ({ run, slot }) =>
          TERMINAL.has(run.status) && !git.hit() && slot?.lifecycle === 'ready',
        release: git.release,
        releaseWhileDown: true,
        needsSlot: true,
      };
    },
  },
};

// ---------------------------------------------------------------- one run
class Inconclusive extends Error {}

interface RestartRecord {
  step: StepName;
  variant: Variant;
  downS: number;
  nodeOfflineS?: number;
  before: string;
  after: string;
}

interface ScenarioResult {
  label: string;
  runId: string;
  outcome: RunOutcome;
  durationS: number;
  restarts: RestartRecord[];
  /** Holds the run never reached after an earlier restart. */
  unreached: StepName[];
  evidence: string;
}

const brief = (run: Run) =>
  `${run.status} | ${run.steps.map((step) => `${step.name}:${step.status}`).join(' ')} | decisions ${
    run.decisions
      .map((decision) => `${decision.type}${decision.resolvedAt ? '' : '(open)'}`)
      .join(',') || '-'
  }`;

const slotCounter: Record<string, number> = {};
const slotsFor = (project: string, count: number) =>
  Array.from({ length: count }, (_, index) => `${project}-${index + 1}`);

async function readSlot(stack: RemoteNodeStack, slotId: string): Promise<SlotView | undefined> {
  const { fleet } = await stack.call<{
    fleet: { slots: Array<{ slot: string; lifecycle: string; phase?: string | null }> };
  }>('fleet.status');
  return fleet.slots.find((slot) => slot.slot === slotId);
}

async function runScenario(
  stack: RemoteNodeStack,
  label: string,
  shapeName: ShapeName,
  phases: HoldPhase[],
): Promise<ScenarioResult> {
  const shape = SHAPES[shapeName];
  slotCounter[shape.project] = (slotCounter[shape.project] ?? 0) + 1;
  const slotId = `${shape.project}-${slotCounter[shape.project]}`;
  const dir = path.join(evidence, label);
  await mkdir(dir, { recursive: true });
  const started = Date.now();
  const hold: HoldContext = { slotId, slotRepo: stack.slotRepo(slotId), dir };
  // Workers start once MONITOR watches them (restart-invariant-fixtures.mts); one run at a time.
  const monitoring = path.join(stack.holds, 'monitoring');
  await rm(monitoring, { force: true });
  for (const phase of phases) if (phase.armAt === 'create') await phase.arm(hold);
  const armed = new Set(phases.filter((phase) => phase.armAt === 'create'));
  const { run: created } = await stack.call<{ run: Run }>('run.create', shape.create(slotId));
  const runId = created.id;
  await log(`${label}: run created`, { runId, slotId });
  const restarts: RestartRecord[] = [];
  const unreached: StepName[] = [];
  const getRun = async () => (await stack.call<{ run: Run }>('run.get', { runId })).run;
  let current = 0;
  let lastBrief = '';
  let changedAt = Date.now();
  let terminalSince: number | undefined;
  const deadline = started + shape.timeoutMs;
  for (;;) {
    if (Date.now() > deadline)
      throw new Inconclusive(
        `${label}: the run did not settle within ${shape.timeoutMs / 60_000} min`,
      );
    const run = await getRun();
    const phase = phases[current];
    const view: View = {
      run,
      ...(phase?.needsSlot || TERMINAL.has(run.status)
        ? { slot: await readSlot(stack, slotId) }
        : {}),
    };
    if (stepStatus(run, 'monitor') === 'running' && !existsSync(monitoring))
      await writeFile(monitoring, `${runId}\n`);
    const summary = `${brief(run)}${view.slot ? ` | slot ${view.slot.lifecycle}/${view.slot.phase ?? '-'}` : ''}`;
    if (summary !== lastBrief) {
      await log(`${label}: ${summary}`);
      await appendFile(
        path.join(dir, 'samples.jsonl'),
        `${JSON.stringify({ t: seconds(started), summary })}\n`,
      );
      lastBrief = summary;
      changedAt = Date.now();
    }

    if (phase) {
      if (!armed.has(phase) && typeof phase.armAt === 'function' && phase.armAt(view)) {
        await phase.arm(hold);
        armed.add(phase);
        await log(`${label}: ${phase.step} hold armed`);
      }
      if (armed.has(phase) && phase.held(view)) {
        await log(`${label}: ${phase.step} held`, { run: brief(run) });
        hold.held = run;
        await writeJson(path.join(dir, `run-held-${current + 1}-${phase.step}.json`), run);
        for (const [index, variant] of phase.restarts.entries()) {
          const last = index === phase.restarts.length - 1;
          const restart = await stack.restartGateway({
            ...(variant === 'node-away' ? { nodeAwayMs: phase.nodeAwayMs } : {}),
            ...(last && phase.releaseWhileDown
              ? {
                  whileDown: async () => {
                    await phase.release(hold);
                    await phase.whileDown?.(hold);
                  },
                }
              : {}),
          });
          const after = await getRun();
          restarts.push({
            step: phase.step,
            variant,
            downS: Math.round(restart.downMs / 100) / 10,
            ...(restart.nodeOfflineMs !== undefined
              ? { nodeOfflineS: Math.round(restart.nodeOfflineMs / 100) / 10 }
              : {}),
            before: brief(run),
            after: brief(after),
          });
          await log(`${label}: restarted (${variant})`, { after: brief(after) });
        }
        if (!phase.releaseWhileDown) await phase.release(hold);
        await log(`${label}: ${phase.step} released`);
        current += 1;
        continue;
      }
      const stalled = Date.now() - changedAt >= STALL_MS;
      if (phase.missed(view) || stalled) {
        // Before any restart, the hold itself failed. After one, the run went elsewhere than the
        // baseline: settle it and let the outcome comparison show where.
        if (restarts.length === 0)
          throw new Inconclusive(
            `${label}: ${phase.step} ${stalled ? 'never reached' : 'moved past'} its hold point (${summary})`,
          );
        unreached.push(...phases.slice(current).map((pending) => pending.step));
        await log(`${label}: after the restarts the run never reached the ${phase.step} hold`, {
          run: summary,
        });
        current = phases.length;
        continue;
      }
    }

    // Decisions the shape answers; a finalize hold arms just before the gate is resolved.
    let resolved = false;
    for (const decision of run.decisions.filter((candidate) => !candidate.resolvedAt)) {
      const action = shape.decide(decision);
      if (!action) continue;
      if (phase?.armAt === 'resolve' && !armed.has(phase)) {
        await phase.arm(hold);
        armed.add(phase);
        await log(`${label}: ${phase.step} hold armed`);
      }
      await stack.call('run.resolveDecision', { runId, decisionId: decision.id, actionId: action });
      await log(`${label}: resolved ${decision.type} with ${action}`);
      resolved = true;
    }
    if (resolved) continue;

    if (!phase) {
      // Settled: terminal with its slot no longer being released, waiting on a person, or
      // unchanged long enough that nothing will move it (a run a restart stranded).
      const unchangedMs = Date.now() - changedAt;
      const waiting =
        WAITING.has(run.status) && run.decisions.some((decision) => !decision.resolvedAt);
      let settled = unchangedMs >= STALL_MS || (waiting && unchangedMs >= 5000);
      if (TERMINAL.has(run.status)) {
        // A released slot is ready. Any other slot state stands only once the orphan
        // reconciler (every 60 s) has had two passes at it.
        terminalSince ??= Date.now();
        settled ||=
          (view.slot?.lifecycle === 'ready' && unchangedMs >= 1500) ||
          Date.now() - terminalSince > 150_000;
      }
      if (settled) {
        const slot = view.slot ?? (await readSlot(stack, slotId));
        await writeJson(path.join(dir, 'run-final.json'), run);
        if (unchangedMs >= STALL_MS)
          await log(`${label}: unchanged for ${STALL_MS / 60_000} min; recording it as settled`);
        return {
          label,
          runId,
          outcome: runOutcome(run, slot),
          durationS: seconds(started),
          restarts,
          unreached,
          evidence: dir,
        };
      }
    }
    const fastPoll = phase && !armed.has(phase) && typeof phase.armAt === 'function';
    await delay(fastPoll ? 100 : 500);
  }
}

/** Leaves nothing active: a later restart would otherwise recover this run too. */
async function retire(stack: RemoteNodeStack, runId: string) {
  const { run } = await stack.call<{ run: Run }>('run.get', { runId });
  if (TERMINAL.has(run.status)) return;
  const reason = 'restart-invariant: outcome recorded';
  try {
    await stack.call('run.cancel', { runId, reason });
  } catch (error) {
    // A run held for a result decision refuses cancel: close it through that decision.
    const close = run.decisions
      .filter((decision) => !decision.resolvedAt)
      .flatMap((decision) =>
        (decision.actions ?? [])
          .filter((action) => /close/.test(action.id))
          .map((action) => ({ decisionId: decision.id, actionId: action.id })),
      )[0];
    const closed =
      close &&
      (await stack.call('run.resolveDecision', { runId, ...close, reason }).then(
        () => true,
        () => false,
      ));
    // Its outcome is already recorded; later restarts recover it too, which only adds log noise.
    if (!closed) await log('could not retire the run', { runId, error: String(error) });
  }
}

// ---------------------------------------------------------------- the matrix
interface Check {
  restarts: Variant[];
  pass: boolean;
  runId?: string;
  durationS?: number;
  observed?: RunOutcome;
  baseline?: RunOutcome;
  differences: string[];
  /** Set when a difference comes with different reviewer verdicts (see verdictDrift). */
  note?: string;
  restartLog?: RestartRecord[];
  error?: string;
  evidence?: string;
}

const head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
const reaper = startReaper();
let stack: RemoteNodeStack | undefined;
const cleanupErrors: string[] = [];
let completed = false;
const cleanup = cleanupOnExit(async () => {
  if (stack) cleanupErrors.push(...(await stack.cleanup()));
  reaper.done();
  // A signal exits right after this; the normal path rewrites the file once the matrix is done.
  await writeResults();
});

const shapesNeeded = [...new Set(selected.map((name) => STEPS[name].shape))];
const reviewSteps = selected.filter((name) => STEPS[name].shape === 'review');
const pipeSteps = selected.filter((name) => STEPS[name].shape === 'pipe');
const baselines: Partial<Record<ShapeName, ScenarioResult>> = {};
const stepResults: Array<{ step: StepName; hold: string; pass: boolean; checks: Check[] }> = [];
let setupError: string | undefined;
let reviewerRuns = 0;

try {
  stack = await startRemoteNodeStack({
    root,
    evidence,
    machine: 'ri-node',
    // One slot per run: a run that strands its slot cannot affect the next.
    slots: [
      ...slotsFor(PIPE_PROJECT, (shapesNeeded.includes('pipe') ? 1 : 0) + pipeSteps.length * 2),
      ...slotsFor(REVIEW_PROJECT, reviewSteps.length > 0 ? 2 : 0),
    ],
    projects: projectPacks,
    seed: SEED,
    slotFiles: slotCli(root),
    cliSnapshots,
    ownerTag: process.env.RESTART_INVARIANT_STAMP ?? String(process.pid),
    reaper,
    log,
  });

  for (const shapeName of shapesNeeded) {
    const result = await runScenario(stack, `baseline-${shapeName}`, shapeName, []);
    await retire(stack, result.runId);
    if (shapeName === 'review') reviewerRuns += 1;
    baselines[shapeName] = result;
    await log(`baseline ${shapeName}`, { outcome: result.outcome, durationS: result.durationS });
  }

  const record = async (
    steps: StepName[],
    label: string,
    shapeName: ShapeName,
    phases: HoldPhase[],
    restarts: Variant[],
  ) => {
    const baseline = baselines[shapeName]!.outcome;
    let check: Check;
    try {
      const result = await runScenario(stack!, label, shapeName, phases);
      await retire(stack!, result.runId);
      const differences = [
        ...result.unreached.map(
          (step) =>
            `${step}: after the earlier restarts the run never reached this step's hold (the baseline did)`,
        ),
        ...outcomeDifferences(baseline, result.outcome),
      ];
      check = {
        restarts,
        pass: differences.length === 0,
        runId: result.runId,
        durationS: result.durationS,
        observed: result.outcome,
        baseline,
        differences,
        ...(differences.length && verdictDrift(baseline, result.outcome)
          ? { note: verdictDrift(baseline, result.outcome) }
          : {}),
        restartLog: result.restarts,
        evidence: result.evidence,
      };
    } catch (error) {
      if (!(error instanceof Inconclusive)) throw error;
      check = { restarts, pass: false, baseline, differences: [], error: error.message };
    }
    await log(`${label}: ${check.pass ? 'MATCHES BASELINE' : 'DIFFERS'}`, {
      differences: check.differences,
      ...(check.note ? { note: check.note } : {}),
      ...(check.error ? { error: check.error } : {}),
    });
    for (const step of steps) {
      let entry = stepResults.find((candidate) => candidate.step === step);
      if (!entry)
        stepResults.push((entry = { step, hold: STEPS[step].hold, pass: true, checks: [] }));
      entry.checks.push(check);
      entry.pass &&= check.pass;
    }
  };

  if (!baselinesOnly) {
    for (const step of selected) {
      if (STEPS[step].shape === 'review') {
        // REVIEW and its fix round share one reviewed run: two reviews, four restarts.
        if (step !== reviewSteps[0]) continue;
        const restarts: Variant[] = ['node-up', 'node-away'];
        await record(
          reviewSteps,
          'review',
          'review',
          reviewSteps.flatMap((name) => STEPS[name].phase(stack!, restarts)),
          restarts,
        );
        reviewerRuns += 1;
        continue;
      }
      for (const variant of ['node-up', 'node-away'] as const)
        await record(
          [step],
          `${step}-${variant}`,
          'pipe',
          [STEPS[step].phase(stack, [variant])].flat(),
          [variant],
        );
    }
  }
} catch (error) {
  setupError = error instanceof Error ? (error.stack ?? error.message) : String(error);
  await log('aborted', { error: String(error) });
} finally {
  await cleanup();
}

completed = true;
const { pass, summary, exitCode } = await writeResults();
console.log(JSON.stringify({ pass, summary, results: resultsFile }));
process.exit(exitCode);

/** Writes results.json from what has run so far; cleanup writes it too when a signal cut the run short. */
async function writeResults() {
  const inconclusive = stepResults.some((step) => step.checks.some((check) => check.error));
  const error = completed ? setupError : (setupError ?? 'interrupted before the matrix finished');
  const pass =
    !error &&
    !inconclusive &&
    stepResults.every((step) => step.pass) &&
    stepResults.length === (baselinesOnly ? 0 : selected.length);
  const failed = stepResults.filter((step) => !step.pass).map((step) => step.step);
  const summary = error
    ? `could not run: ${error.split('\n')[0]}`
    : `${stepResults.length - failed.length}/${stepResults.length} steps match the no-restart baseline${failed.length ? `; differ or unverified: ${failed.join(', ')}` : ''}`;
  await writeJson(resultsFile, {
    schemaVersion: 1,
    head,
    startedAt: startedAt.toISOString(),
    finishedAt: new Date().toISOString(),
    durationS: seconds(t0),
    pass,
    summary,
    reviewer: { ...REVIEWER, reviewedRuns: reviewerRuns },
    nodeAwayS: { default: NODE_AWAY_MS / 1000, review: REVIEW_NODE_AWAY_MS / 1000 },
    baselines,
    steps: stepResults,
    setupError: error ?? null,
    cleanupErrors,
    evidence,
  });
  const exitCode = pass || (baselinesOnly && !error) ? 0 : error || inconclusive ? 2 : 1;
  return { pass, summary, exitCode };
}
