// The opt-in proofs no other job runs, one check each in the nightly. Each boots its own isolated
// gateway or fixture farm; nothing here touches the live farm. They rotted unrun until #2493.
//   node-handshake    scripts/e2e-node-registration-handshake.mts direct (no model)
//   direct-workflow   scripts/e2e-direct-workflow-defaults.mts direct (no model)
//   warm-review       services/gateway/src/review/native-warm-continuation.rpc.live.ts, a real
//                     codex reviewer on config.json's proofs.reviewModel (receipt `pass: true`)
import { spawn } from 'node:child_process';
import { closeSync, openSync } from 'node:fs';
import { mkdir, readFile } from 'node:fs/promises';
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

function spec(proof: Proof, root: string, dir: string, reviewModel: string): ProofSpec {
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
          TSX_TSCONFIG_PATH: path.join(root, 'services/gateway/tsconfig.json'),
          FARMSLOT_WARM_PROOF_INFRA: '1',
          FARMSLOT_WARM_PROOF_MODEL: reviewModel,
          FARMSLOT_WARM_PROOF_RECEIPT: path.join(dir, 'receipt.json'),
        },
        model: `codex ${reviewModel} reviewer`,
      };
  }
}

/** Runs `node argv` from the checkout root, output to `log`; resolves its exit code (null: killed). */
function run(argv: string[], root: string, env: NodeJS.ProcessEnv, log: string, reaper: Reaper) {
  return new Promise<number | null>((resolve, reject) => {
    const output = openSync(log, 'w');
    const child = spawn(process.execPath, argv, {
      cwd: root,
      env,
      stdio: ['ignore', output, output],
      detached: true,
    });
    closeSync(output);
    // Stopped with the canary if it dies mid-proof.
    reaper.group(child.pid);
    const timer = setTimeout(() => {
      // Its own group: the gateway or native host it started goes with it.
      if (child.pid) process.kill(-child.pid, 'SIGKILL');
    }, PROOF_TIMEOUT_MS);
    child.once('error', reject);
    child.once('exit', (code) => {
      clearTimeout(timer);
      resolve(code);
    });
  });
}

export async function runProofs(options: {
  root: string;
  evidence: string;
  reviewModel: string;
  reaper: Reaper;
  proofs?: readonly Proof[];
  log: (event: string, detail?: Record<string, unknown>) => Promise<void>;
  onCheck: (check: CheckResult) => void;
}): Promise<void> {
  for (const proof of options.proofs ?? PROOFS) {
    const dir = path.join(options.evidence, 'proofs', proof);
    await mkdir(dir, { recursive: true });
    const { argv, env, model } = spec(proof, options.root, dir, options.reviewModel);
    const log = path.join(dir, 'proof.log');
    const started = Date.now();
    const code = await run(argv, options.root, { ...process.env, ...env }, log, options.reaper);
    const differences: string[] = [];
    let reviewerRounds = 0;
    if (code === null) differences.push(`did not finish within ${PROOF_TIMEOUT_MS / 60_000} min`);
    else if (code !== 0) differences.push(`exited ${code}`);
    if (proof === 'warm-review' && code === 0) {
      const receipt = await readFile(path.join(dir, 'receipt.json'), 'utf8').catch(() => '');
      if (!receipt) differences.push('wrote no receipt');
      else {
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
      // bound on its reviewer's codex turns.
      modelCalls: reviewerRounds,
      durationS: Math.round((Date.now() - started) / 100) / 10,
      differences,
      observations: [`log: ${log}`],
      evidence: dir,
    };
    await options.log(`proof ${proof}: ${check.status.toUpperCase()}`, { differences });
    options.onCheck(check);
  }
}
