// Opt-in differential validation: <source-root> <output.json>. Not in the default suite.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, open, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { monitorEventLoopDelay } from 'node:perf_hooks';
import { setTimeout as delay } from 'node:timers/promises';
import { pathToFileURL } from 'node:url';

const [code, output] = process.argv.slice(2);
assert(code && output, 'Expected source root and output JSON');
const { NativeHostObservation } = await import(
  pathToFileURL(path.join(code, 'packages/agent-runtime/src/native/observation.ts')).href
);
const { NativeSessionClient } = await import(
  pathToFileURL(path.join(code, 'packages/agent-runtime/src/native/client.ts')).href
);
const { NativeProcessTree } = await import(
  pathToFileURL(path.join(code, 'packages/agent-runtime/src/native/process-tree.ts')).href
);
const retainedRoot = process.env.F366_REPRO_ROOT;
const root = retainedRoot ?? (await mkdtemp(path.join(tmpdir(), 'f366-loop-repro-')));
assert(path.basename(root).startsWith('f366-loop-repro-'));
assert((await realpath(root)).startsWith((await realpath(tmpdir())) + path.sep));
const ownership = path.join(root, 'validation-owner.json');
if (retainedRoot)
  assert.equal(JSON.parse(await readFile(ownership, 'utf8')).purpose, 'native-loop-validation');
else await writeFile(ownership, JSON.stringify({ purpose: 'native-loop-validation' }));
const host = path.join(root, 'host');
const source = new NativeHostObservation(
  new NativeSessionClient(host),
  'fixture',
  () => {},
  root,
  async () => [],
);
const children: ReturnType<typeof spawn>[] = [];
interface LoopSample {
  label: string;
  elapsedMs: number;
  maxLoopDelayMs: number;
}
const observations: LoopSample[] = [];
const loop = monitorEventLoopDelay({ resolution: 20 });
let pulse: NodeJS.Timeout | undefined;
let maxGap = 0;
async function measure(label: string, operation: () => Promise<unknown>): Promise<void> {
  loop.reset();
  await delay(40);
  maxGap = 0;
  const started = performance.now();
  await operation();
  const elapsedMs = performance.now() - started;
  await delay(40);
  observations.push({ label, elapsedMs, maxLoopDelayMs: Math.max(loop.max / 1e6, maxGap - 20) });
}
try {
  await mkdir(path.join(host, 'sessions'), { recursive: true, mode: 0o700 });
  const line = Buffer.from(JSON.stringify({ padding: 'x'.repeat(64 * 1024 - 15) }) + '\n');
  for (let i = 0; i < 4; i++) {
    const file = path.join(host, 'sessions', `${i}.journal`);
    if (existsSync(file)) continue;
    const handle = await open(file, 'w', 0o600);
    try {
      for (let n = 0; n < 1024; n++) await handle.write(line);
    } finally {
      await handle.close();
    }
  }
  loop.enable();
  let lastPulse = performance.now();
  pulse = setInterval(() => {
    const now = performance.now();
    maxGap = Math.max(maxGap, now - lastPulse);
    lastPulse = now;
  }, 20);
  await measure('cold-source-arm', () => source.start());
  for (let i = 0; i < 20; i++) {
    const child = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], {
      detached: true,
      stdio: 'ignore',
    });
    children.push(child);
    await once(child, 'spawn');
    // Registration has its existing synchronous boundary; this workload measures cleanup/fences.
    const tree = new NativeProcessTree(child.pid!);
    await measure('cleanup-and-journal-read', async () => {
      await tree.stop();
      await tree.empty();
      await source.read(async () => ({ fixture: true }));
    });
  }
} finally {
  if (pulse) clearInterval(pulse);
  source.stop();
  loop.disable();
  for (const child of children) {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    if (child.exitCode === null && child.signalCode === null) await once(child, 'exit');
  }
  if (!retainedRoot) await rm(root, { recursive: true, force: true });
  await writeFile(
    output,
    JSON.stringify(
      {
        root,
        code,
        journalBytes: 268435456,
        observations,
        ownedChildren: children.map((c) => c.pid),
        fixtureRetained: Boolean(retainedRoot),
        originalRunActions: 0,
      },
      null,
      2,
    ) + '\n',
  );
}
const mixed = observations.filter((row) => row.label === 'cleanup-and-journal-read');
const withinBudget = mixed.filter((row) => row.maxLoopDelayMs <= 250).length;
console.log(
  JSON.stringify({
    root,
    samples: mixed.length,
    withinBudget,
    p95Ms: mixed.map((row) => row.maxLoopDelayMs).sort((a, b) => a - b)[18],
  }),
);
assert(mixed.length === 20 && withinBudget >= 19, 'Native loop-delay p95 budget exceeded');
