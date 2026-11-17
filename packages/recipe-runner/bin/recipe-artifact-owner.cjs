const fs = require('node:fs/promises');
const { createReadStream, readFileSync } = require('node:fs');
const { createHash } = require('node:crypto');
const path = require('node:path');

const RECIPE_ARTIFACT_OWNERSHIP_DIR = 'artifacts/recipe-ownership';
const ROOTS = ['temp/recipe/calls', 'temp/recipe/runs'];
const record = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const relative = (value) =>
  typeof value === 'string' &&
  value.length > 0 &&
  !path.isAbsolute(value) &&
  !value.split(/[\\/]/).includes('..') &&
  !/[\r\n\0]/.test(value);
const hex = (value) => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);

function parseRecipeArtifactOwner(value) {
  if (
    !record(value) ||
    Object.keys(value).length !== 4 ||
    value.schemaVersion !== 1 ||
    typeof value.runId !== 'string' ||
    !value.runId ||
    !relative(value.taskFile) ||
    typeof value.recipeRunId !== 'string' ||
    !/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(value.recipeRunId)
  )
    return null;
  return {
    schemaVersion: 1,
    runId: value.runId,
    taskFile: value.taskFile,
    recipeRunId: value.recipeRunId,
  };
}

async function readJson(file) {
  let bytes;
  try {
    bytes = await fs.readFile(file);
  } catch (error) {
    // Missing legacy ownership is unknown, never permission to remove evidence.
    if (error.code === 'ENOENT') return null;
    throw error;
  }
  try {
    return { value: JSON.parse(bytes.toString('utf8')) };
  } catch (error) {
    // A malformed receipt remains unowned and is preserved.
    if (error instanceof SyntaxError) return null;
    throw error;
  }
}

function location(directory) {
  const bucket = path.resolve(directory);
  const kind = path.dirname(bucket);
  const recipe = path.dirname(kind);
  const temp = path.dirname(recipe);
  if (
    !['calls', 'runs'].includes(path.basename(kind)) ||
    path.basename(recipe) !== 'recipe' ||
    path.basename(temp) !== 'temp'
  )
    return null;
  return { bucket, repo: path.dirname(temp) };
}

async function taskOwner(repo, file) {
  let actual;
  try {
    actual = await fs.realpath(file);
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
  const taskFile = path.relative(repo, actual).split(path.sep).join('/');
  if (!relative(taskFile) || path.basename(actual) !== 'TASK.md') return null;
  const handoff = path.join(path.dirname(actual), 'inputs/handoff.json');
  const metadata = await readJson(handoff);
  if (
    !metadata ||
    !record(metadata.value) ||
    metadata.value.schemaVersion !== 1 ||
    typeof metadata.value.attemptId !== 'string' ||
    !metadata.value.attemptId
  )
    return null;
  if (!relative(path.relative(repo, await fs.realpath(handoff)))) return null;
  return { schemaVersion: 1, runId: metadata.value.attemptId, taskFile };
}

function parseReceipt(value) {
  if (
    !record(value) ||
    Object.keys(value).length !== 5 ||
    !relative(value.relative) ||
    !ROOTS.some((root) => path.posix.dirname(value.relative) === root)
  )
    return null;
  const { relative: directory, ...fields } = value;
  const owner = parseRecipeArtifactOwner(fields);
  return owner && { owner, relative: directory };
}

function receiptPath(repo, owner) {
  return path.join(
    repo,
    path.dirname(owner.taskFile),
    RECIPE_ARTIFACT_OWNERSHIP_DIR,
    owner.recipeRunId + '.json',
  );
}

/** A task-local receipt names only this invocation, without enumerating slot history. */
async function recordRecipeArtifactOwner(
  directory,
  recipeRunId,
  taskFile = process.env.FARMSLOT_TASK_FILE,
) {
  const place = location(directory);
  if (
    !place ||
    !taskFile ||
    typeof recipeRunId !== 'string' ||
    !/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(recipeRunId)
  )
    return null;
  const repo = await fs.realpath(place.repo);
  const entry = await fs.lstat(place.bucket);
  const bucket = await fs.realpath(place.bucket);
  if (
    !entry.isDirectory() ||
    entry.isSymbolicLink() ||
    bucket !== path.join(repo, path.relative(place.repo, place.bucket))
  )
    return null;
  const task = await taskOwner(repo, taskFile);
  if (!task) return null;
  const owner = { ...task, recipeRunId };
  const file = receiptPath(repo, owner);
  const artifacts = path.dirname(path.dirname(file));
  await fs.mkdir(artifacts, { recursive: true });
  if ((await fs.realpath(artifacts)) !== artifacts) return null;
  await fs.mkdir(path.dirname(file), { recursive: true });
  if ((await fs.realpath(path.dirname(file))) !== path.dirname(file)) return null;
  const receipt = { ...owner, relative: path.relative(repo, bucket).split(path.sep).join('/') };
  const bytes = JSON.stringify(receipt) + '\n';
  try {
    await fs.writeFile(file, bytes, { flag: 'wx', mode: 0o600 });
  } catch (error) {
    if (error.code !== 'EEXIST') throw error;
    if ((await fs.readFile(file, 'utf8')) !== bytes)
      throw new Error('Recipe invocation ownership already recorded elsewhere');
  }
  return owner;
}

async function snapshot(repo, relativeDir, owner, maxBytes) {
  if (!relative(relativeDir) || !ROOTS.some((root) => path.posix.dirname(relativeDir) === root)) {
    throw new Error('Invalid recipe artifact directory');
  }
  const bucket = path.join(repo, relativeDir);
  const entry = await fs.lstat(bucket);
  if (!entry.isDirectory() || entry.isSymbolicLink() || (await fs.realpath(bucket)) !== bucket)
    throw new Error('Recipe artifact directory changed: ' + relativeDir);
  const invocation = await readJson(path.join(bucket, 'recipe-invocation.json'));
  if (
    !invocation ||
    !record(invocation.value) ||
    invocation.value.version !== 1 ||
    invocation.value.recipeRunId !== owner.recipeRunId
  )
    return null;
  const hash = createHash('sha256');
  const files = [];
  let bytes = 0;
  async function walk(dir) {
    const children = await fs.readdir(dir, { withFileTypes: true });
    children.sort((a, b) => a.name.localeCompare(b.name));
    for (const child of children) {
      const file = path.join(dir, child.name);
      if (child.name === '.git' || child.isSymbolicLink())
        throw new Error('Recipe artifacts contain a checkout or link: ' + relativeDir);
      if (child.isDirectory()) await walk(file);
      else if (child.isFile()) {
        bytes += (await fs.stat(file)).size;
        if (bytes > maxBytes) throw new Error('Recipe artifacts exceed the archive budget');
        const fileHash = createHash('sha256');
        for await (const chunk of createReadStream(file)) fileHash.update(chunk);
        const name = path.relative(repo, file).split(path.sep).join('/');
        files.push(name);
        hash.update(JSON.stringify([name, fileHash.digest('hex')]) + '\n');
      } else throw new Error('Recipe artifacts contain an unsupported file: ' + relativeDir);
    }
  }
  await walk(bucket);
  return { relative: relativeDir, owner, digest: hash.digest('hex'), bytes, files };
}

function parseRecipeArtifactSnapshots(value) {
  if (
    !Array.isArray(value) ||
    !value.every(
      (item) =>
        record(item) &&
        relative(item.relative) &&
        ROOTS.some((root) => path.posix.dirname(item.relative) === root) &&
        parseRecipeArtifactOwner(item.owner) &&
        hex(item.digest) &&
        Number.isSafeInteger(item.bytes) &&
        item.bytes >= 0 &&
        Array.isArray(item.files) &&
        item.files.every((file) => relative(file) && file.startsWith(item.relative + '/')),
    )
  ) {
    throw new Error('Invalid recipe artifact inventory');
  }
  return value;
}

async function recipeArtifactOperation(input) {
  const repo = await fs.realpath(input.repo);
  if (input.kind === 'inventory') {
    const snapshots = [];
    const tasks = new Set();
    const buckets = new Set();
    let total = 0;
    for (const taskFile of new Set(input.taskFiles)) {
      if (!relative(taskFile)) throw new Error('Invalid recipe task path');
      const task = await taskOwner(repo, path.join(repo, taskFile));
      if (!task || task.runId !== input.runId || tasks.has(task.taskFile)) continue;
      tasks.add(task.taskFile);
      const directory = path.join(repo, path.dirname(task.taskFile), RECIPE_ARTIFACT_OWNERSHIP_DIR);
      let children;
      try {
        if ((await fs.realpath(directory)) !== directory) continue;
        children = await fs.readdir(directory, { withFileTypes: true });
      } catch (error) {
        if (error.code === 'ENOENT') continue;
        throw error;
      }
      for (const child of children) {
        if (!child.isFile() || !child.name.endsWith('.json')) continue;
        const document = await readJson(path.join(directory, child.name));
        const receipt = document && parseReceipt(document.value);
        if (
          !receipt ||
          receipt.owner.runId !== input.runId ||
          receipt.owner.taskFile !== task.taskFile ||
          child.name !== receipt.owner.recipeRunId + '.json'
        )
          continue;
        let found;
        try {
          found = await snapshot(repo, receipt.relative, receipt.owner, input.maxBytes - total);
        } catch (error) {
          // A previous completed cleanup may leave a receipt until its task root is removed.
          if (error.code === 'ENOENT') continue;
          throw error;
        }
        if (!found) continue;
        if (buckets.has(found.relative)) throw new Error('Overlapping recipe artifact ownership');
        buckets.add(found.relative);
        total += found.bytes;
        snapshots.push(found);
      }
    }
    const files = snapshots.flatMap((item) => item.files);
    if (files.length) await fs.appendFile(input.fileList, files.join('\0') + '\0');
    return snapshots;
  }
  if (input.kind !== 'remove') throw new Error('Unknown recipe artifact operation');
  const snapshots = parseRecipeArtifactSnapshots(input.snapshots);
  // Validate the whole selected cohort before any source is removed.
  for (const expected of snapshots) {
    const document = await readJson(receiptPath(repo, expected.owner));
    const receipt = document && parseReceipt(document.value);
    if (
      !receipt ||
      receipt.relative !== expected.relative ||
      JSON.stringify(receipt.owner) !== JSON.stringify(expected.owner)
    )
      throw new Error('Recipe ownership receipt changed after capture');
    const current = await snapshot(repo, expected.relative, expected.owner, input.maxBytes);
    if (
      !current ||
      current.owner.runId !== input.runId ||
      JSON.stringify(current) !== JSON.stringify(expected)
    )
      throw new Error('Recipe artifacts changed after capture: ' + expected.relative);
    const owner = await taskOwner(repo, path.join(repo, expected.owner.taskFile));
    if (
      !owner ||
      owner.runId !== expected.owner.runId ||
      owner.taskFile !== expected.owner.taskFile
    )
      throw new Error('Recipe task ownership changed: ' + expected.relative);
  }
  for (const item of snapshots) await fs.rm(path.join(repo, item.relative), { recursive: true });
  return { removed: snapshots.map((item) => item.relative) };
}

let operationSource;
function buildRecipeArtifactCommand(input) {
  operationSource ??= readFileSync(
    require.resolve('@farmslot/recipe-runner/runtime/artifact-owner'),
    'utf8',
  );
  return [
    "node --input-type=commonjs <<'FARMSLOT_RECIPE_ARTIFACTS'",
    operationSource,
    'recipeArtifactOperation(' + JSON.stringify(input) + ').then((result) => {',
    "process.stdout.write(JSON.stringify(result) + '\\n');",
    '}).catch((error) => { console.error(error.message); process.exitCode = 1; });',
    'FARMSLOT_RECIPE_ARTIFACTS',
  ].join('\n');
}

module.exports = {
  RECIPE_ARTIFACT_OWNERSHIP_DIR,
  recordRecipeArtifactOwner,
  parseRecipeArtifactOwner,
  parseRecipeArtifactSnapshots,
  buildRecipeArtifactCommand,
  recipeArtifactOperation,
};
