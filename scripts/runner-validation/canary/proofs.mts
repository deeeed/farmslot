// The opt-in proofs no other job runs, one check each in the nightly. Each boots its own isolated
// gateway or fixture farm under a private TMPDIR, with an environment that names no live state;
// nothing here touches the live farm. They rotted unrun until #2493.
//   node-handshake    scripts/e2e-node-registration-handshake.mts direct (no model)
//   direct-workflow   scripts/e2e-direct-workflow-defaults.mts direct (no model)
//   warm-review       services/gateway/src/review/native-warm-continuation.rpc.live.ts, a real
//                     codex reviewer on config.json's proofs.reviewModel (receipt `pass: true`)
import { execFileSync, spawn } from 'node:child_process';
import { closeSync, mkdtempSync, openSync } from 'node:fs';
import { mkdir, readFile, rm } from 'node:fs/promises';
import path from 'node:path';

import type { Reaper } from '../lib/isolated-stack.mjs';

import type { CheckResult } from './outcome.mjs';

export const PROOFS = ['node-handshake', 'direct-workflow', 'warm-review'] as const;
export type Proof = (typeof PROOFS)[number];

const PROOF_TIMEOUT_MS = 15 * 60_000;

interface ProofSpec {
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
function proofEnv(tmp: string, extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (/^(FARMSLOT_|GATEWAY_|TMUX|TSX_|NODE_TEST_CONTEXT$)/.test(key)) continue;
    if (key !== 'CODEX_LB_API_KEY' && /^(GH_|GITHUB_|NPM_)|_TOKEN$|_PAT$|_API_KEY/.test(key))
      continue;
    env[key] = value;
  }
  return { ...env, TMPDIR: tmp, GIT_TERMINAL_PROMPT: '0', ...extra };
}

/**
 * SIGKILLs `pid`, every process descended from it and their groups. The proofs start their gateway
 * and native host detached (own groups), so killing the proof's group alone would leave them; while
 * the proof lives they are still its descendants. Then anything left naming the proof's TMPDIR.
 */
function killProofTree(pid: number | undefined, tmp: string): void {
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
    for (const target of tree)
      for (const signalled of [-target, target]) {
        try {
          process.kill(signalled, 'SIGKILL');
        } catch {
          // Already gone, or not a group leader: the next target.
        }
      }
  }
  try {
    execFileSync('pkill', ['-9', '-f', tmp], { stdio: 'ignore' });
  } catch {
    // pkill exits 1 when nothing matched.
  }
}

interface ProofExit {
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
}): Promise<void> {
  let current: { pid: number | undefined; tmp: string } | undefined;
  options.onCleanup(async () => {
    if (current) killProofTree(current.pid, current.tmp);
    return [];
  });
  for (const proof of options.proofs ?? PROOFS) {
    if (options.cleaning()) return;
    const dir = path.join(options.evidence, 'proofs', proof);
    await mkdir(dir, { recursive: true });
    // Short: the proofs' tmux and native host sockets live under it.
    const tmp = mkdtempSync('/tmp/fsp-');
    const { argv, env, model } = spec(proof, options.root, dir, tmp, options.reviewModel);
    const log = path.join(dir, 'proof.log');
    const started = Date.now();
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
      // A canary killed outright leaves the proof to the reaper, which stops its group.
      options.reaper.group(child.pid);
      let timedOut = false;
      const timer = setTimeout(() => {
        timedOut = true;
        killProofTree(child.pid, tmp);
      }, PROOF_TIMEOUT_MS);
      child.once('error', reject);
      child.once('exit', (code, signal) => {
        clearTimeout(timer);
        resolve({ code, signal, timedOut });
      });
    });
    // A proof that exited cleans up after itself; this only catches what one left behind.
    killProofTree(undefined, tmp);
    current = undefined;
    await rm(tmp, { recursive: true, force: true });
    const differences: string[] = [];
    if (exit.timedOut) differences.push(`did not finish within ${PROOF_TIMEOUT_MS / 60_000} min`);
    else if (exit.signal) differences.push(`killed by ${exit.signal}`);
    else if (exit.code !== 0) differences.push(`exited ${exit.code}`);
    const observations = [`log: ${log}`];
    let reviewerRounds = 0;
    if (proof === 'warm-review') {
      const receipt = await readFile(path.join(dir, 'receipt.json'), 'utf8').catch(() => '');
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
