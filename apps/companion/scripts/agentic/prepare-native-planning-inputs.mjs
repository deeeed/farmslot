import assert from 'node:assert/strict';
import { readFile, realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { D07_HEAD, digest, exclusiveJson, within } from './native-planning-fixture.mjs';

// Receipt encoder only. ROOT's future setup invokes owning APIs before app startup.
// No RPC, service, device, credential, cache or SQLite writer lives here.
const [authorizationFile, specificationFile, outputFile] = process.argv.slice(2);
assert(
  authorizationFile && specificationFile && outputFile,
  'Use authorization setup-specification output-fixture',
);
const authorization = JSON.parse(await readFile(authorizationFile, 'utf8'));
assert.equal(authorization.executionAuthorized, true, 'Static proposal grants no setup execution');
assert.equal(authorization.sourceHead, D07_HEAD);
assert.equal(authorization.purpose, 'D07-native-planning');
const sourceRoot = fileURLToPath(new URL('../../../../', import.meta.url)).replace(/\/$/, '');
const relative = 'apps/companion/scripts/agentic/prepare-native-planning-inputs.mjs';
assert.equal(
  digest(await readFile(fileURLToPath(import.meta.url))),
  authorization.driverHashes[relative],
);
const specification = JSON.parse(await readFile(specificationFile, 'utf8'));
const farmRoot = await realpath(specification.farmRoot);
const fixtureRoot = await realpath(specification.fixtureRoot);
assert.notEqual(farmRoot, await realpath(sourceRoot));
assert(within(fixtureRoot, path.resolve(outputFile)));
assert.equal(
  await realpath(path.dirname(outputFile)),
  path.dirname(path.resolve(outputFile)),
  'Refuse a symlinked output parent',
);
assert(!within(await realpath(sourceRoot), farmRoot));
const readReceipt = async (file, method) => {
  const receipt = JSON.parse(await readFile(file, 'utf8'));
  assert.equal(receipt.method, method);
  assert.equal(receipt.sourceHead, D07_HEAD);
  assert.equal(receipt.ok, true);
  assert(receipt.completedAt > 0);
  return receipt.payload;
};
const backlog = (await readReceipt(specification.receipts.backlog, 'backlog.create')).item;
const roadmap = (await readReceipt(specification.receipts.roadmap, 'roadmap.save')).item;
const queue = (await readReceipt(specification.receipts.queue, 'dispatch.queue.add')).item;
const graph = (await readReceipt(specification.receipts.graph, 'workGraph.create')).graph.graph;
assert.equal(backlog.status, 'candidate');
assert.equal(backlog.project, specification.project);
assert.equal(roadmap.project, specification.project);
assert.equal(queue.project, specification.project);
assert.equal(graph.project, specification.project);
assert.equal(backlog.title, specification.labels.backlogBefore);
assert.equal(roadmap.title, specification.labels.roadmapBefore);
const projectsDir = await realpath(specification.projectsDir);
const paths = {
  backlog: specification.backlogFile,
  roadmap: path.resolve(farmRoot, roadmap.filePath),
  project: path.join(projectsDir, specification.project, 'project.json'),
  queue: specification.queueFile,
  graph: specification.graphFile,
};
const files = {};
for (const [kind, name] of Object.entries(paths)) {
  const file = await realpath(name);
  assert(within(farmRoot, file));
  const bytes = await readFile(file);
  files[kind] = { path: file, sha256: digest(bytes) };
}
const backlogBytes = JSON.parse(await readFile(paths.backlog, 'utf8'));
assert.equal(
  backlogBytes.length,
  1,
  'Require one private candidate so the real disabled label is unambiguous',
);
assert(
  backlogBytes.some(
    (row) => row.id === backlog.id && row.title === backlog.title && row.status === 'candidate',
  ),
);
assert.equal((await readFile(paths.roadmap, 'utf8')).split(roadmap.title).length, 2);
files.newProject = {
  path: path.join(projectsDir, specification.addedProject, 'project.json'),
  exists: false,
};
try {
  await stat(files.newProject.path);
  assert.fail('New project must be absent');
} catch (error) {
  if (error.code !== 'ENOENT') throw error;
}
await exclusiveJson(outputFile, {
  version: 1,
  sourceHead: D07_HEAD,
  sourceRoot,
  fixtureRoot,
  farmRoot,
  home: await realpath(specification.home),
  projectsDir,
  project: specification.project,
  addedProject: specification.addedProject,
  nativeCompatibilityReceipt: specification.nativeCompatibilityReceipt,
  sourceWriter: specification.sourceWriter,
  files,
  setupInputs: Object.fromEntries(
    await Promise.all(
      Object.entries(specification.receipts).map(async ([name, file]) => [
        name,
        { path: await realpath(file), sha256: digest(await readFile(file)) },
      ]),
    ),
  ),
  expected: {
    backlog: {
      id: backlog.id,
      before: backlog.title,
      after: specification.labels.backlogAfter,
      status: 'candidate',
    },
    roadmap: { id: roadmap.id, before: roadmap.title, after: specification.labels.roadmapAfter },
    queue: { id: queue.id },
    graph: { id: graph.id, nativeUi: 'unimplemented' },
  },
});
