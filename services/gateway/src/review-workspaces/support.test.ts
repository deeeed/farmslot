import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import type { PoolConfig, Run } from '@farmslot/protocol';

import type { ProjectVars } from '../core/config.js';
import { execFileArgv } from '../core/exec.js';
import { slotWriteFileBuffer, slotWriteFiles } from '../core/slot-io.js';
import { makeRun } from '../methods/run/test-fixtures.js';

import { collectReviewWorkspaceSupport } from './skills.js';
import {
  ensureReviewWorkspaceSupport,
  REVIEW_SUPPORT_NODE_SCRIPT,
  type ReviewWorkspaceSupportDependencies,
} from './support.js';

async function fixture(t: test.TestContext) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'support-cache-'));
  const previousOwner = process.env.FARMSLOT_NATIVE_OWNER_PRINCIPAL_ID;
  process.env.FARMSLOT_NATIVE_OWNER_PRINCIPAL_ID = 'fixture-owner';
  t.after(async () => {
    if (previousOwner === undefined) delete process.env.FARMSLOT_NATIVE_OWNER_PRINCIPAL_ID;
    else process.env.FARMSLOT_NATIVE_OWNER_PRINCIPAL_ID = previousOwner;
    await rm(root, { recursive: true, force: true });
  });
  const pack = path.join(root, 'pack');
  await mkdir(path.join(pack, 'skill'), { recursive: true });
  await writeFile(path.join(pack, 'skill/skill.md'), '# Canonical review\n');
  const project: ProjectVars = {
    projectName: 'fixture',
    projectConfig: path.join(pack, 'project.json'),
    projectTemplatesDir: path.join(pack, 'templates'),
    projectFixturesDir: path.join(pack, 'fixtures'),
    runtimeDir: '.runtime',
    artifactDir: 'artifacts',
    projectJson: {
      static_review: {
        domain: 'testing',
        support: {
          skills: [{ name: 'team-review', root: { projectPath: 'skill' }, entry: 'skill.md' }],
        },
      },
    },
  };
  await writeFile(project.projectConfig, JSON.stringify(project.projectJson));
  const runs = new Map<string, Run>();
  const counts = { collect: 0, publish: 0, batches: 0, large: 0, writes: 0 };
  let beforeExecute: ((action: string) => void) | undefined;
  const deps: Partial<ReviewWorkspaceSupportDependencies> = {
    cacheRoot: () => path.join(root, 'gateway-cache'),
    getRun: (id) => runs.get(id),
    updateRun: (id, patch) => {
      const next = { ...runs.get(id)!, ...patch };
      runs.set(id, next);
      return next;
    },
    persistRunNow: async (run) => {
      await writeFile(path.join(root, `${run.id}.json`), JSON.stringify(run));
    },
    loadProjectVars: async () => project,
    loadPoolConfigs: async () => [
      {
        machine: 'local',
        host: 'localhost',
        sshUser: 'fixture',
        project: 'fixture',
        slots: [],
      } as unknown as PoolConfig,
    ],
    collect: async (...args) => {
      counts.collect++;
      return collectReviewWorkspaceSupport(...args);
    },
    execute: async (_io, argv) => {
      const input = JSON.parse(argv[3]);
      beforeExecute?.(input.action);
      if (input.action === 'publish') counts.publish++;
      return execFileArgv([process.execPath, ...argv.slice(1)]);
    },
    writeFiles: async (io, dir, files) => {
      counts.batches++;
      counts.writes++;
      assert(Buffer.byteLength(JSON.stringify({ root: dir, files })) < 530 * 1024);
      await slotWriteFiles(io, dir, files);
    },
    writeBuffer: async (...args) => {
      counts.large++;
      counts.writes++;
      return slotWriteFileBuffer(...args);
    },
  };
  async function addRun(id: string) {
    const directory = path.join(root, 'node/review-workspaces/owner/runs', id);
    await mkdir(path.join(directory, 'source'), { recursive: true });
    await mkdir(path.join(directory, 'task/artifacts'), { recursive: true });
    const run: Run = {
      ...makeRun({
        id,
        project: 'fixture',
        slotId: null,
        flowType: 'review-pr',
        mode: 'autonomous',
      }),
      transport: 'native',
      nativeOwnerPrincipalId: 'fixture-owner',
      reviewWorkspaceTarget: { machine: 'local' },
      reviewWorkspace: {
        workspaceId: id,
        machine: 'local',
        executionNodeId: 'local',
        checkoutPath: path.join(directory, 'source'),
        taskPath: path.join(directory, 'task'),
        artifactPath: path.join(directory, 'task/artifacts'),
      },
    };
    runs.set(id, run);
    return run;
  }
  return {
    root,
    pack,
    project,
    runs,
    counts,
    deps,
    addRun,
    onExecute: (fn: typeof beforeExecute) => {
      beforeExecute = fn;
    },
  };
}

test('concurrent reviews publish once, and warm/restarted runs reuse verified cache without collecting or copying', async (t) => {
  const f = await fixture(t);
  const a = await f.addRun('review-a'),
    b = await f.addRun('review-b');
  const [first, second] = await Promise.all([
    ensureReviewWorkspaceSupport(a.id, () => {}, f.deps),
    ensureReviewWorkspaceSupport(b.id, () => {}, f.deps),
  ]);
  assert(first && second);
  assert.equal(first.path, second.path);
  assert.equal(f.counts.collect, 1);
  assert.equal(f.counts.publish, 1);
  assert.equal(await readFile(first.skills[0].path, 'utf8'), '# Canonical review\n');
  assert(
    Buffer.byteLength(JSON.stringify(first)) < 4096,
    'Run binding must not contain the bundle payload',
  );
  const writes = f.counts.writes;
  f.runs.set(a.id, JSON.parse(await readFile(path.join(f.root, `${a.id}.json`), 'utf8')));
  assert.deepEqual(await ensureReviewWorkspaceSupport(a.id, () => {}, f.deps), first);
  const c = await f.addRun('review-c');
  assert.equal((await ensureReviewWorkspaceSupport(c.id, () => {}, f.deps))?.sha256, first.sha256);
  assert.equal(f.counts.collect, 1);
  assert.equal(f.counts.writes, writes);
});

test('a blocked run stamped with cleanedAt still reuses its admitted support', async (t) => {
  const f = await fixture(t);
  const run = await f.addRun('review-cleaned');
  const first = (await ensureReviewWorkspaceSupport(run.id, () => {}, f.deps))!;
  f.deps.updateRun!(run.id, {
    reviewWorkspace: {
      ...f.runs.get(run.id)!.reviewWorkspace!,
      cleanedAt: new Date().toISOString(),
    },
  });
  assert.deepEqual(await ensureReviewWorkspaceSupport(run.id, () => {}, f.deps), first);
  assert.equal(f.counts.collect, 1);
  assert.equal(f.counts.publish, 1);
});

test('unchanged bytes republish after source metadata changes without a false conflict', async (t) => {
  const f = await fixture(t);
  const firstRun = await f.addRun('review-original');
  const first = (await ensureReviewWorkspaceSupport(firstRun.id, () => {}, f.deps))!;
  await writeFile(path.join(f.pack, 'skill/skill.md'), '# Canonical review\n');
  const secondRun = await f.addRun('review-refrozen');
  const second = (await ensureReviewWorkspaceSupport(secondRun.id, () => {}, f.deps))!;
  assert.equal(f.counts.collect, 2);
  assert.equal(second.sha256, first.sha256);
  assert.equal(f.counts.publish, 1);
});

test('cache corruption and extra files are rejected without silently refreshing an admitted review', async (t) => {
  const f = await fixture(t);
  const run = await f.addRun('review-corrupt');
  const first = (await ensureReviewWorkspaceSupport(run.id, () => {}, f.deps))!;
  await writeFile(first.skills[0].path, 'Changed trusted instructions\n');
  await assert.rejects(
    ensureReviewWorkspaceSupport(run.id, () => {}, f.deps),
    /checksum mismatch/,
  );
  assert.equal(f.counts.collect, 1);
  await writeFile(first.skills[0].path, '# Canonical review\n');
  await writeFile(path.join(first.path, 'unrecorded.js'), 'throw Error("unrecorded");');
  await assert.rejects(
    ensureReviewWorkspaceSupport(run.id, () => {}, f.deps),
    /unrecorded files/,
  );
  assert.equal(f.counts.publish, 1);
});

test('an admitted empty support selection stays empty when the farm later adds skills', async (t) => {
  const f = await fixture(t);
  const config = f.project.projectJson.static_review!.support;
  delete f.project.projectJson.static_review!.support;
  const run = await f.addRun('without-support');
  assert.equal(await ensureReviewWorkspaceSupport(run.id, () => {}, f.deps), undefined);
  f.project.projectJson.static_review!.support = config;
  assert.equal(await ensureReviewWorkspaceSupport(run.id, () => {}, f.deps), undefined);
  assert.equal(f.counts.collect, 0);
  const next = await f.addRun('with-support');
  assert(await ensureReviewWorkspaceSupport(next.id, () => {}, f.deps));
  assert.equal(f.counts.collect, 1);
});

test('changed source content preserves existing admission and produces a new digest only for a new run', async (t) => {
  const f = await fixture(t);
  await execFileArgv(['git', 'init', '--quiet', f.pack]);
  const a = await f.addRun('review-old');
  const first = (await ensureReviewWorkspaceSupport(a.id, () => {}, f.deps))!;
  assert.equal(first.sources[0].sourceDirty, true);
  await writeFile(path.join(f.pack, 'skill/skill.md'), '# Revised canonical review\n');
  assert.deepEqual(await ensureReviewWorkspaceSupport(a.id, () => {}, f.deps), first);
  const b = await f.addRun('review-new');
  const second = (await ensureReviewWorkspaceSupport(b.id, () => {}, f.deps))!;
  assert.notEqual(second.sha256, first.sha256);
  assert.equal(await readFile(first.skills[0].path, 'utf8'), '# Canonical review\n');
  assert.equal(f.counts.collect, 2);
});

test('generation changes during publication never attach a stale support binding', async (t) => {
  const f = await fixture(t);
  const run = await f.addRun('review-generation');
  f.onExecute((action) => {
    if (action === 'publish') {
      const current = f.runs.get(run.id)!;
      current.engineState = {
        ...current.engineState!,
        generation: (current.engineState?.generation ?? 0) + 1,
      };
    }
  });
  await assert.rejects(
    ensureReviewWorkspaceSupport(run.id, () => {}, f.deps),
    /generation changed/,
  );
  assert.equal(f.runs.get(run.id)?.reviewWorkspace?.support, undefined);
  f.onExecute(undefined);
  assert(await ensureReviewWorkspaceSupport(run.id, () => {}, f.deps));
  assert.equal(f.counts.collect, 1);
  assert.equal(f.counts.publish, 1);
});

test('large files use chunked transport and ordinary batches remain below message bounds', async (t) => {
  const f = await fixture(t);
  await writeFile(path.join(f.pack, 'skill/large.bin'), Buffer.alloc(800_000, 7));
  for (let i = 0; i < 90; i++)
    await writeFile(path.join(f.pack, 'skill', `${i}.md`), 'x'.repeat(10_000));
  const run = await f.addRun('review-transfer');
  const support = (await ensureReviewWorkspaceSupport(run.id, () => {}, f.deps))!;
  assert(f.counts.batches >= 3);
  assert(f.counts.large >= 2, 'large binary and manifest use bounded byte transfer');
  assert.equal(
    (await readFile(path.join(support.path, 'skills/team-review/large.bin'))).length,
    800_000,
  );
});

test('independent node publishers race safely on the same checksum-verified digest', async (t) => {
  const f = await fixture(t);
  const run = await f.addRun('review-race');
  const ownerRoot = path.resolve(run.reviewWorkspace!.checkoutPath, '../../..');
  const bundle = await collectReviewWorkspaceSupport(
    f.project,
    f.project.projectJson.static_review!.support!,
  );
  const manifest = JSON.stringify(bundle.manifest);
  const input = {
    ownerRoot,
    digest: bundle.manifest.sha256,
    manifestSha: createHash('sha256').update(manifest).digest('hex'),
  };
  const command = async (action: string, incoming?: string) => {
    const result = await execFileArgv([
      process.execPath,
      '-e',
      REVIEW_SUPPORT_NODE_SCRIPT,
      JSON.stringify({ ...input, action, incoming }),
    ]);
    assert.equal(result.exitCode, 0, result.stderr);
    return JSON.parse(result.stdout);
  };
  const incoming = await Promise.all([command('prepare'), command('prepare')]);
  for (const item of incoming) {
    await slotWriteFiles(
      { host: 'localhost', machine: 'local', sshTarget: '' },
      item.incoming,
      bundle.files.map((file) => ({
        path: file.relativePath,
        content: file.contentBase64,
        mode: file.mode,
      })),
    );
    await writeFile(path.join(item.incoming, 'manifest.json'), manifest, { mode: 0o600 });
  }
  const published = await Promise.all(incoming.map((item) => command('publish', item.incoming)));
  assert.equal(published.filter((item) => item.published).length, 1);
  assert.equal(published[0].path, published[1].path);
  assert.equal((await command('verify')).ready, true);
});

test('an interrupted admission recovers its frozen bundle after source and config removal', async (t) => {
  const f = await fixture(t);
  const run = await f.addRun('review-interrupted');
  f.onExecute((action) => {
    if (action === 'publish') throw new Error('interrupted publication');
  });
  await assert.rejects(
    ensureReviewWorkspaceSupport(run.id, () => {}, f.deps),
    /interrupted publication/,
  );
  assert.equal(f.runs.get(run.id)?.reviewWorkspace?.support, undefined);
  delete f.project.projectJson.static_review!.support;
  await rm(path.join(f.pack, 'skill'), { recursive: true });
  f.onExecute(undefined);
  const recovered = await ensureReviewWorkspaceSupport(run.id, () => {}, f.deps);
  assert(recovered);
  assert.equal(await readFile(recovered.skills[0].path, 'utf8'), '# Canonical review\n');
  assert.equal(f.counts.collect, 1);
});

test('a running reviewer cannot acquire a new support snapshot', async (t) => {
  const f = await fixture(t);
  const run = await f.addRun('review-running');
  run.agentContexts = [
    {
      id: 'review',
      role: 'review',
      label: 'Review',
      slotId: null,
      runId: run.id,
      status: 'working',
      nativeSession: {
        sessionId: 'session',
        leaseId: 'lease',
        commandId: 'command',
        ownerPrincipalId: 'fixture-owner',
        executionNodeId: 'local',
        generation: 'generation',
        launchRequestedAt: new Date().toISOString(),
      },
    },
  ];
  await assert.rejects(
    ensureReviewWorkspaceSupport(run.id, () => {}, f.deps),
    /after reviewer launch/,
  );
  assert.equal(f.counts.collect, 0);
});

test('a concurrent caller cannot skip its own current-authority check', async (t) => {
  const f = await fixture(t);
  const run = await f.addRun('review-authority');
  const first = ensureReviewWorkspaceSupport(run.id, () => {}, f.deps);
  await assert.rejects(
    ensureReviewWorkspaceSupport(
      run.id,
      () => {
        throw new Error('caller no longer authorized');
      },
      f.deps,
    ),
    /no longer authorized/,
  );
  assert(await first);
  assert.equal(f.counts.collect, 1);
});
