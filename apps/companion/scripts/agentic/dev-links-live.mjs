// Own the live recipe even when the CLI exits before workflow teardown.
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { createAgentDeviceClient } from 'agent-device';

import { runExpoRecipeDocument } from '@farmslot/adapter-rn';

import {
  processAlive,
  providerDaemonPid,
  stopProofGateway,
  waitForProof,
} from './proof-gateway.mjs';

if (process.argv[3] === 'execute') {
  const result = await runExpoRecipeDocument(
    'scripts/agentic/recipe/recipes/dev-links.recipe.json',
    {
      artifactsDir: process.argv[2],
      recordVideo: {
        mode: 'off',
        reason: 'This preparation and routing proof uses three HUD stills and protocol receipts.',
      },
    },
  );
  console.log(JSON.stringify({ status: result.status, artifacts: result.artifactManifestPath }));
  process.exit(result.status === 'pass' ? 0 : 1);
}

const proof = process.env.COMPANION_DEV_LINKS_PROOF_DIR;
assert(
  process.argv[2] && process.argv.length === 3,
  'Usage: dev-links-live.mjs <fresh-evidence-dir>',
);
assert(proof && !fs.existsSync(proof), 'Set a fresh COMPANION_DEV_LINKS_PROOF_DIR');
const stateDir = `${proof}-device`;
assert(!fs.existsSync(stateDir), 'Use fresh provider state for this proof');
assert.equal(
  process.env.AGENT_DEVICE_DAEMON_IDLE_TIMEOUT_MS,
  '10000',
  'Launch through run-recipe.sh',
);
const child = spawn(
  process.execPath,
  [fileURLToPath(import.meta.url), process.argv[2], 'execute'],
  {
    detached: true,
    stdio: 'inherit',
    env: { ...process.env, FARMSLOT_AGENT_DEVICE_STATE_DIR: stateDir },
  },
);
let canceled = false;
for (const signal of ['SIGINT', 'SIGTERM'])
  process.once(signal, () => {
    canceled = true;
    stopProofGateway(child.pid);
  });
try {
  const code = await new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', (code) => resolve(code));
  });
  process.exitCode = canceled ? 130 : (code ?? 1);
} finally {
  try {
    // Every provider session here belongs to this invocation's fresh state directory.
    const infoFile = path.join(stateDir, 'daemon.json');
    if (fs.existsSync(infoFile)) {
      const client = createAgentDeviceClient({ stateDir });
      for (const session of await client.sessions.list()) {
        await client.sessions.close({ session: session.name, shutdown: false });
      }
      const pid = providerDaemonPid(stateDir);
      await waitForProof(() => !processAlive(pid), 20000);
    }
  } finally {
    execFileSync(process.execPath, ['scripts/agentic/dev-links-proof.mjs', 'stop'], {
      stdio: 'inherit',
    });
    fs.rmSync(stateDir, { recursive: true, force: true });
  }
}
