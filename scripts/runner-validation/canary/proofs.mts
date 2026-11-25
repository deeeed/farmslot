// The opt-in proofs no other job runs, one check each in the nightly. Each boots its own isolated
// gateway or fixture farm under a private TMPDIR, with an environment that names no live state;
// nothing here touches the live farm. They rotted unrun until #2493.
//   node-handshake    scripts/e2e-node-registration-handshake.mts direct (no model)
//   direct-workflow   scripts/e2e-direct-workflow-defaults.mts direct (no model)
//   warm-review       services/gateway/src/review/native-warm-continuation.rpc.live.ts, a real
//                     codex reviewer on config.json's proofs.reviewModel (receipt `pass: true`)
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { closeSync, mkdtempSync, openSync } from 'node:fs';
import { mkdir, readFile, rm } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import path from 'node:path';

import type { Reaper } from '../lib/isolated-stack.mjs';

import type { CheckResult } from './outcome.mjs';

export const PROOFS = ['node-handshake', 'direct-workflow', 'warm-review'] as const;
export type Proof = (typeof PROOFS)[number];

const PROOF_TIMEOUT_MS = 15 * 60_000;

export interface ProofSpec {
  argv: string[];
  env?: Record<string, string>;
  model: string;
}

function spec(
  proof: Proof,
  root: string,
  dir: string,
  tmp: string,
  reviewModel: string,
): ProofSpec {
  const tsx = ['--import', 'tsx'];
  switch (proof) {
    case 'node-handshake':
      return {
        argv: [...tsx, 'scripts/e2e-node-registration-handshake.mts', 'direct'],
        model: 'none',
      };
    case 'direct-workflow':
      return {
        argv: [...tsx, 'scripts/e2e-direct-workflow-defaults.mts', 'direct'],
        model: 'none',
      };
    case 'warm-review':
      return {
        argv: [
          ...tsx,
          '--experimental-test-module-mocks',
          'services/gateway/src/review/native-warm-continuation.rpc.live.ts',
        ],
        env: {
          // Absolute: the proof's gateway modules resolve it from the checkout root.
          TSX_TSCONFIG_PATH: path.join(root, 'services/gateway/tsconfig.json'),
          // The proof pins its runs, pool and projects; a private home keeps a layout-2 host home,
          // which ignores those overrides, out of reach.
          FARMSLOT_HOME: path.join(tmp, 'home'),
          FARMSLOT_WARM_PROOF_INFRA: '1',
          FARMSLOT_WARM_PROOF_MODEL: reviewModel,
          FARMSLOT_WARM_PROOF_RECEIPT: path.join(dir, 'receipt.json'),
        },
        model: `codex ${reviewModel} reviewer`,
      };
  }
}

/**
 * The canary's environment minus anything that could point a proof at live state or carry a
 * provider token, as remote-node-stack's childEnv does. The reviewer reaches its model through
 * the local LB with CODEX_LB_API_KEY.
 */
export function proofEnv(tmp: string, extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (/^(FARMSLOT_|GATEWAY_|TMUX|TSX_|NODE_TEST_CONTEXT$)/.test(key)) continue;
    if (key !== 'CODEX_LB_API_KEY' && /^(GH_|GITHUB_|NPM_)|_TOKEN$|_PAT$|_API_KEY/.test(key))
      continue;
    env[key] = value;
  }
  return { ...env, TMPDIR: tmp, GIT_TERMINAL_PROMPT: '0', ...extra };
}

const errno = (error: unknown) => (error as NodeJS.ErrnoException).code;

/** SIGKILLs `target` (a pid, or a negated group id); false when nothing of ours is left there. */
function kill(target: number): boolean {
  try {
    process.kill(target, 'SIGKILL');
    return true;
  } catch (error) {
    // ESRCH: gone, or not a group leader. EPERM: only a zombie macOS has not reaped yet is left.
    if (errno(error) === 'ESRCH' || errno(error) === 'EPERM') return false;
    throw error;
  }
}

/**
 * Processes whose command line names `tmp`, or that hold a file under it: an e2e proof's gateway
 * names its fixture only in its environment, but keeps its log there open.
 */
export function processesUsing(tmp: string): number[] {
  const found = new Set<number>();
  for (const [command, args] of [
    ['pgrep', ['-f', tmp]],
    ['lsof', ['-t', '+D', tmp]],
  ] as const) {
    const result = spawnSync(command, args, { encoding: 'utf8' });
    if (result.error) throw result.error;
    // Both exit 1 when nothing matches.
    if (result.status !== 0 && result.status !== 1)
      throw new Error(`${command} exited ${result.status}: ${result.stderr.trim()}`);
    for (const line of result.stdout.split('\n')) if (Number(line)) found.add(Number(line));
  }
  found.delete(process.pid);
  return [...found];
}

/**
 * SIGKILLs `pid`, every process descended from it and their groups, then every process still using
 * the proof's TMPDIR. The proofs start their gateway and native host detached (own groups), so the
 * proof's group alone would leave them; while the proof lives they are still its descendants.
 * Resolves what survived, as cleanup errors.
 */
export async function killProofTree(
  pid: number | undefined,
  tmp: string,
  scan: (tmp: string) => number[] = processesUsing,
): Promise<string[]> {
  if (pid !== undefined) {
    const children = new Map<number, number[]>();
    for (const line of execFileSync('ps', ['-Ao', 'pid=,ppid='], { encoding: 'utf8' }).split(
      '\n',
    )) {
      const [child, parent] = line.trim().split(/\s+/).map(Number);
      if (!child || !parent) continue;
      children.set(parent, [...(children.get(parent) ?? []), child]);
    }
    const tree = [pid];
    for (let index = 0; index < tree.length; index++)
      tree.push(...(children.get(tree[index]) ?? []));
    for (const target of tree) {
      kill(-target);
      kill(target);
    }
  }
  // A gateway still shutting down can start a child between scans: kill until none is left.
  let survivors = scan(tmp);
  for (let pass = 0; survivors.length && pass < 25; pass++) {
    for (const target of survivors) kill(target);
    await delay(200);
    survivors = scan(tmp);
  }
  return survivors.length
    ? [`proof processes survived SIGKILL under ${tmp}: ${survivors.join(', ')}`]
    : [];
}

/** killProofTree that reports its own failure (a broken ps, pgrep or lsof) instead of throwing. */
export async function stopProofTree(
  pid: number | undefined,
  tmp: string,
  killTree: typeof killProofTree = killProofTree,
): Promise<string[]> {
  try {
    return await killTree(pid, tmp);
  } catch (error) {
    return [`could not stop the proof's processes under ${tmp}: ${String(error)}`];
  }
}

/**
 * Dismisses the reaper only when every cleanup step (the canary's stack, the proof in flight)
 * stopped cleanly: whatever could not be stopped stays with it, which tries again when the canary
 * exits. True when dismissed.
 */
export function dismissReaper(reaper: Reaper, ...cleanupErrors: readonly string[][]): boolean {
  if (cleanupErrors.some((errors) => errors.length)) return false;
  reaper.done();
  return true;
}

/** The reaper's commands run with an empty environment: lsof lives in /usr/sbin. */
const REAPER_ENV = { PATH: '/usr/bin:/bin:/usr/sbin:/sbin' };

/** Registers what the reaper stops and removes if the canary dies without cleaning up. */
export function reapProof(reaper: Reaper, tmp: string): void {
  reaper.command(['pkill', '-KILL', '-f', tmp], REAPER_ENV);
  reaper.command(['sh', '-c', `lsof -t +D '${tmp}' | xargs kill -9`], REAPER_ENV);
  reaper.path(tmp);
}

/** How a proof process ended, as check differences (none for a clean exit). */
export function exitDifferences(exit: ProofExit, timeoutMs = PROOF_TIMEOUT_MS): string[] {
  if (exit.timedOut) return [`did not finish within ${Math.round(timeoutMs / 1000)} s`];
  if (exit.signal) return [`killed by ${exit.signal}`];
  if (exit.code !== 0) return [`exited ${exit.code}`];
  return [];
}

export interface ProofExit {
  code: number | null;
  signal: NodeJS.Signals | null;
  timedOut: boolean;
}

export async function runProofs(options: {
  root: string;
  evidence: string;
  reviewModel: string;
  reaper: Reaper;
  proofs?: readonly Proof[];
  /** True once the canary is shutting down: no further proof starts. */
  cleaning: () => boolean;
  /** Registers the stop for the proof in flight, which the canary's cleanup runs. */
  onCleanup: (stop: () => Promise<string[]>) => void;
  log: (event: string, detail?: Record<string, unknown>) => Promise<void>;
  onCheck: (check: CheckResult) => void;
  /** Tests only: what each proof runs, its deadline, and how its TMPDIR is removed. */
  seams?: {
    spec?: (proof: Proof, dir: string, tmp: string) => ProofSpec;
    timeoutMs?: number;
    removeTemp?: (tmp: string) => Promise<void>;
    killTree?: typeof killProofTree;
  };
}): Promise<void> {
  const timeoutMs = options.seams?.timeoutMs ?? PROOF_TIMEOUT_MS;
  const killTree = options.seams?.killTree ?? killProofTree;
  const removeTemp =
    options.seams?.removeTemp ??
    ((tmp: string) => rm(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }));
  let current: { pid: number | undefined; tmp: string } | undefined;
  options.onCleanup(async () => {
    if (!current) return [];
    const { pid, tmp } = current;
    const errors = await stopProofTree(pid, tmp, killTree);
    // The reaper is dismissed after a clean stop, so the TMPDIR goes here.
    await removeTemp(tmp).catch((error: unknown) =>
      errors.push(`could not remove ${tmp}: ${String(error)}`),
    );
    return errors;
  });
  for (const proof of options.proofs ?? PROOFS) {
    if (options.cleaning()) return;
    const dir = path.join(options.evidence, 'proofs', proof);
    await mkdir(dir, { recursive: true });
    // Short: the proofs' tmux and native host sockets live under it.
    const tmp = mkdtempSync('/tmp/fsp-');
    // A canary killed outright (SIGKILL, a dropped ssh session) leaves the proof to the reaper.
    reapProof(options.reaper, tmp);
    const { argv, env, model } =
      options.seams?.spec?.(proof, dir, tmp) ??
      spec(proof, options.root, dir, tmp, options.reviewModel);
    const log = path.join(dir, 'proof.log');
    const started = Date.now();
    // Cleanup may have begun while this one was being set up.
    if (options.cleaning()) {
      await removeTemp(tmp);
      return;
    }
    let timeoutKill: Promise<string[]> | undefined;
    const exit = await new Promise<ProofExit>((resolve, reject) => {
      const output = openSync(log, 'w');
      const child = spawn(process.execPath, argv, {
        cwd: options.root,
        env: proofEnv(tmp, env),
        stdio: ['ignore', output, output],
        detached: true,
      });
      closeSync(output);
      current = { pid: child.pid, tmp };
      options.reaper.group(child.pid);
      let timedOut = false;
      const timer = setTimeout(() => {
        timedOut = true;
        timeoutKill = killTree(child.pid, tmp).catch((error: unknown) => {
          // The tree could not be read: at least the proof itself must go, or exit never comes.
          child.kill('SIGKILL');
          return [`timeout kill failed: ${String(error)}`];
        });
      }, timeoutMs);
      child.once('error', reject);
      child.once('exit', (code, signal) => {
        clearTimeout(timer);
        resolve({ code, signal, timedOut });
      });
    });
    // What the proof left running, e.g. a gateway it sent SIGTERM and did not wait for.
    const differences = [
      ...exitDifferences(exit, timeoutMs),
      ...((await timeoutKill) ?? []),
      ...(await stopProofTree(undefined, tmp, killTree)),
    ];
    current = undefined;
    const observations = [`log: ${log}`];
    // A process that exited during the removal can still write into it: retry, then report.
    await removeTemp(tmp).catch((error: unknown) =>
      observations.push(`could not remove ${tmp}: ${String(error)}`),
    );
    let reviewerRounds = 0;
    if (proof === 'warm-review') {
      const receipt = await readFile(path.join(dir, 'receipt.json'), 'utf8').catch(
        (error: unknown) => {
          // No receipt is a proof result; any other read failure is not.
          if (errno(error) === 'ENOENT') return '';
          throw error;
        },
      );
      if (!receipt) {
        if (exit.code === 0) differences.push('wrote no receipt');
        // The receipt is written after the last round: a failed proof's spend is not recorded.
        observations.push('model calls unknown: no receipt (it is written after the last round)');
      } else {
        const parsed = JSON.parse(receipt) as Record<string, unknown>;
        if (parsed.pass !== true) differences.push('receipt does not record pass: true');
        // Each recorded review round is at least one codex turn.
        reviewerRounds = Object.values(parsed).filter(
          (value) => typeof value === 'object' && value !== null && 'session' in value,
        ).length;
      }
    }
    const check: CheckResult = {
      case: 'proof',
      variant: proof,
      target: 'isolated',
      status: differences.length ? 'fail' : 'pass',
      model,
      // The e2e proofs make no model call; the warm proof counts its recorded review rounds, a lower
      // bound on its reviewer's codex turns (unknown, see observations, when it wrote no receipt).
      modelCalls: reviewerRounds,
      durationS: Math.round((Date.now() - started) / 100) / 10,
      differences,
      observations,
      evidence: dir,
    };
    await options.log(`proof ${proof}: ${check.status.toUpperCase()}`, { differences });
    options.onCheck(check);
  }
}
