#!/usr/bin/env tsx
// Sets up the live canary: its demo project and one canary slot per canary node.
//
//   node --import tsx scripts/runner-validation/canary/setup.mts --farm ~/dev/farmslot [--apply]
//
// --config <file> selects a canary configuration, including an isolated proof node.
// Without --apply it prints what it would do. With it:
// - on each node in config.json (over ssh to the host its pool file names): ~/farmslot-canary/
//   origin.git, a bare repo holding the canary repo (fixtures.mts CANARY_REPO), and
//   ~/farmslot-canary/slot, the slot's checkout of it. Existing ones are kept as they are.
// - in the farm, once every node is ready and the project before the pools: projects/farmslot-canary
//   (the pack) and pool/canary-<machine>.json (one slot, host and ssh user copied from the farm's
//   pool/<machine>.json). Each file is published whole, only if it does not exist.
// It never edits an existing farm file. The gateway lists the new slots after its next fleet
// refresh.
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';

import { publishIfAbsent } from '../lib/isolated-stack.mjs';

import { CANARY_PROJECT, CANARY_REPO, canaryPack } from './fixtures.mjs';

const argv = process.argv.slice(2);
const farmArg = argv[argv.indexOf('--farm') + 1];
if (!argv.includes('--farm') || !farmArg) throw new Error('--farm <farm checkout> is required');
const farm = path.resolve(farmArg.replace(/^~(?=\/|$)/, homedir()));
const apply = argv.includes('--apply');
const configArg = argv.includes('--config') ? argv[argv.indexOf('--config') + 1] : undefined;
if (argv.includes('--config') && (!configArg || configArg.startsWith('--')))
  throw new Error('--config <file> is required');
const config = JSON.parse(
  readFileSync(configArg ?? new URL('./config.json', import.meta.url), 'utf8'),
) as {
  live: { nodes: Array<{ machine: string; slot: string }> };
};

interface PoolFile {
  machine: string;
  host: string;
  ssh_user?: string;
  os?: string;
  project?: string;
  env?: Record<string, string>;
}

/** The farm's existing pool file for a machine: where its host and ssh user come from. */
function machinePool(machine: string): PoolFile {
  for (const name of readdirSync(path.join(farm, 'pool')).filter((file) =>
    file.endsWith('.json'),
  )) {
    const pool = JSON.parse(readFileSync(path.join(farm, 'pool', name), 'utf8')) as PoolFile;
    if (pool.machine === machine && pool.project !== CANARY_PROJECT) return pool;
  }
  throw new Error(`No pool file for ${machine} in ${farm}/pool`);
}

const ssh = (host: string, script: string) =>
  execFileSync('ssh', ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=10', host, 'bash', '-s'], {
    input: script,
    encoding: 'utf8',
  }).trim();

async function publish(file: string, content: string) {
  if (!apply) {
    console.log(`would write ${file} unless it exists`);
    return;
  }
  console.log(`${(await publishIfAbsent(file, content)) ? 'wrote' : 'kept'} ${file}`);
}

// The canary repo as a shell script that creates it from nothing (heredocs, no shared files).
const seedScript = Object.entries(CANARY_REPO)
  .map(
    ([file, content]) =>
      `mkdir -p "$(dirname '${file}')" && cat > '${file}' <<'CANARY_EOF'\n${content.endsWith('\n') ? content : `${content}\n`}CANARY_EOF`,
  )
  .join('\n');

const pools: Array<{ file: string; content: string }> = [];
for (const node of config.live.nodes) {
  const pool = machinePool(node.machine);
  const host = pool.ssh_user ? `${pool.ssh_user}@${pool.host}` : pool.host;
  const nodeHome = ssh(host, 'printf %s "$HOME"');
  const base = `${nodeHome}/farmslot-canary`;
  const slotRepo = `${base}/slot`;
  const script = [
    'set -euo pipefail',
    `base='${base}'`,
    'if [ -d "$base/slot/.git" ]; then echo "kept $base/slot"; exit 0; fi',
    'seed="$(mktemp -d)"',
    'cd "$seed"',
    seedScript,
    'git init -q -b main',
    'git add -A',
    'git -c user.name=Canary -c user.email=canary@example.invalid commit -q -m "canary: seed"',
    'mkdir -p "$base"',
    'git clone -q --bare "$seed" "$base/origin.git"',
    'git clone -q "$base/origin.git" "$base/slot"',
    'git -C "$base/slot" config user.name "Canary Worker"',
    'git -C "$base/slot" config user.email canary@example.invalid',
    'printf \'.task/\\n.agent/\\n\' >> "$base/slot/.git/info/exclude"',
    'rm -rf "$seed"',
    'echo "created $base/slot"',
  ].join('\n');
  if (apply) console.log(`${node.machine}: ${ssh(host, script)}`);
  else
    console.log(
      `would create ${host}:${slotRepo} (bare origin ${base}/origin.git) unless it exists`,
    );
  pools.push({
    file: path.join(farm, 'pool', `canary-${node.machine}.json`),
    content: `${JSON.stringify(
      {
        machine: node.machine,
        host: pool.host,
        ...(pool.ssh_user ? { ssh_user: pool.ssh_user } : {}),
        project: CANARY_PROJECT,
        platform: 'cli',
        os: pool.os ?? 'darwin',
        env: pool.env ?? {},
        slots: [
          {
            id: node.slot,
            enabled: true,
            mode: 'dispatch',
            repo: slotRepo,
            session: node.slot,
            resources: {},
          },
        ],
      },
      null,
      2,
    )}\n`,
  });
}

const pack = canaryPack();
const projectDir = path.join(farm, 'projects', CANARY_PROJECT);
if (existsSync(path.join(projectDir, 'project.json')))
  console.log(`kept ${projectDir}: it exists (remove it to rewrite)`);
else {
  for (const [file, content] of Object.entries(pack.files))
    await publish(path.join(projectDir, file), content);
  await publish(
    path.join(projectDir, 'project.json'),
    `${JSON.stringify({ name: CANARY_PROJECT, ...pack.projectJson }, null, 2)}\n`,
  );
}
for (const { file, content } of pools) await publish(file, content);
console.log(apply ? 'canary setup applied' : 'dry run: rerun with --apply to write');
