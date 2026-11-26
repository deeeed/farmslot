// Shared pin eligibility, also shipped verbatim to the node holding the files.
const fs = require('node:fs/promises');
const path = require('node:path');
const { createHash, randomUUID } = require('node:crypto');

async function exists(file) {
  try {
    await fs.lstat(file);
    return true;
  } catch (error) {
    if (error.code === 'ENOENT') return false;
    throw error;
  }
}
async function readTaskPins(root, names) {
  if (!names) {
    try {
      names = await fs.readdir(root);
    } catch (error) {
      if (error.code === 'ENOENT') return [];
      throw error;
    }
  }
  const entries = [];
  for (const name of names) {
    // Dot-names are store bookkeeping (.retention-*, .content), never pins.
    if (name.startsWith('.')) continue;
    const pin = path.join(root, name),
      provenance = path.join(pin, 'provenance.json');
    try {
      if (!(await fs.lstat(pin)).isDirectory() || (await fs.lstat(provenance)).isSymbolicLink())
        continue;
      const info = await fs.stat(provenance),
        raw = await fs.readFile(provenance, 'utf8');
      const { taskDir } = JSON.parse(raw);
      if (typeof taskDir === 'string' && path.isAbsolute(taskDir))
        entries.push({ pin, taskDir, writtenAt: info.mtimeMs, provenance: raw });
    } catch {
      /* Unreadable, incomplete or invalid provenance is never eligible. */
    }
  }
  return entries;
}
// A pin follows its run's retention (ADR-039 Amendment 12): a pin whose task directory belongs
// to a released run goes even while that directory still exists. A pin no run references keeps
// the older rule and goes only once its task directory is gone.
async function retiredTaskPinsOf(entries, removed, context, pending, present, released) {
  const retired = [];
  for (const { pin, taskDir, writtenAt } of entries) {
    if (context.now - writtenAt < context.ageMs) continue;
    const resolved = path.resolve(taskDir);
    if (pending(resolved)) continue;
    if (present && !(await present(pin))) continue;
    if (removed.has(resolved) || released?.has(resolved) || !(await exists(resolved)))
      retired.push(pin);
  }
  return retired;
}
// A pin records its task directory's real path; a run records the path it was given, which
// can pass through a symlink (/var -> /private/var). Compare both forms, resolved on this node.
async function releasedTaskDirsOf(input) {
  const dirs = input.releasedTaskDirs ?? [];
  if (!Array.isArray(dirs) || !dirs.every((dir) => typeof dir === 'string' && path.isAbsolute(dir)))
    throw new Error('Released task directories must be absolute paths');
  const released = new Set();
  for (const dir of dirs) {
    released.add(path.resolve(dir));
    const real = await fs.realpath(dir).catch(() => undefined);
    if (real) released.add(real);
  }
  return released;
}
function protectedPin(entry, protection) {
  return (
    protection.pinIds.includes(path.basename(entry.pin)) ||
    protection.taskDirs.includes(path.resolve(entry.taskDir)) ||
    protection.taskNames.includes(path.basename(entry.taskDir))
  );
}
async function taskVolumeAvailable(taskDir) {
  const parts = taskDir.split(path.sep);
  // A disconnected removable volume must not turn its tasks into orphans.
  if (parts[1] !== 'Volumes' || !parts[2]) return true;
  const volume = path.join('/Volumes', parts[2]);
  try {
    const [parent, mount] = await Promise.all([fs.stat('/Volumes'), fs.stat(volume)]);
    return mount.dev !== parent.dev;
  } catch {
    return false; /* Unknown mount access retains the pin. */
  }
}
async function restoreStages(root) {
  const stages = (await fs.readdir(root))
    .filter((name) => name.startsWith('.retention-stage-'))
    .slice(0, 4);
  for (const name of stages) {
    const stage = path.join(root, name);
    if (!(await fs.lstat(stage)).isDirectory()) throw new Error('Invalid pin staging directory');
    const ids = await fs.readdir(stage);
    if (ids.length > 8) throw new Error('Pin stage exceeds the removal bound');
    for (const id of ids) {
      const target = path.join(root, id);
      if (await exists(target)) throw new Error('Pin staging conflicts with current pin: ' + id);
      await fs.rename(path.join(stage, id), target);
    }
    await fs.rmdir(stage);
  }
}
async function stageTaskPins(input, hooks = {}) {
  const { root, now, ageMs } = input;
  if (!(await exists(root))) return { inspected: 0, staged: [], stage: null };
  if (!(await fs.lstat(root)).isDirectory()) throw new Error('Pin root must be a real directory');
  await restoreStages(root);
  // Inside the admission fence, with no migration running: drop store entries no pin links.
  const swept = await sweepContentStore(root, now, hooks);
  let cursor = '';
  try {
    cursor = await fs.readFile(path.join(root, '.retention-cursor'), 'utf8');
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  const names = (await fs.readdir(root)).filter((n) => !n.startsWith('.')).sort();
  const ordered = names
    .filter((n) => n > cursor)
    .concat(names.filter((n) => n <= cursor))
    .slice(0, 32);
  const entries = await readTaskPins(root, ordered);
  const released = await releasedTaskDirsOf(input);
  const pending = (dir) => (hooks.protection?.() ?? input.protection).taskDirs.includes(dir);
  const candidates = new Set(
    await retiredTaskPinsOf(entries, new Set(), { now, ageMs }, pending, undefined, released),
  );
  const stage = path.join(root, '.retention-stage-' + randomUUID());
  const staged = [];
  for (const entry of entries) {
    if (staged.length === 8) break;
    if (!candidates.has(entry.pin) || protectedPin(entry, hooks.protection?.() ?? input.protection))
      continue;
    if (!(await taskVolumeAvailable(entry.taskDir))) continue;
    await hooks.beforeStage?.(entry);
    const current = (await readTaskPins(root, [path.basename(entry.pin)]))[0];
    if (
      !current ||
      current.provenance !== entry.provenance ||
      current.writtenAt !== entry.writtenAt ||
      protectedPin(current, hooks.protection?.() ?? input.protection) ||
      (!released.has(path.resolve(current.taskDir)) && (await exists(current.taskDir)))
    )
      continue;
    if (!staged.length) await fs.mkdir(stage);
    await fs.rename(current.pin, path.join(stage, path.basename(current.pin)));
    staged.push(path.basename(current.pin));
  }
  if (ordered.length) await fs.writeFile(path.join(root, '.retention-cursor'), ordered.at(-1));
  return {
    inspected: ordered.length,
    staged,
    stage: staged.length ? path.basename(stage) : null,
    swept,
  };
}
async function purgeTaskPins(root, result) {
  if (!result.stage) return { inspected: result.inspected, removed: [] };
  if (!/^\.retention-stage-[a-f0-9-]+$/.test(result.stage)) throw new Error('Invalid pin stage');
  const stage = path.join(root, result.stage);
  if (!(await fs.lstat(stage)).isDirectory()) throw new Error('Invalid pin stage');
  // Only entries already fenced and renamed by stageTaskPins are disposable.
  for (const id of result.staged) {
    if (path.basename(id) !== id || id === '.' || id === '..')
      throw new Error('Invalid pin identity');
    await fs.rm(path.join(stage, id), { recursive: true, force: true });
  }
  await fs.rmdir(stage);
  return { inspected: result.inspected, removed: result.staged };
}
async function sweepTaskPins(input, hooks = {}) {
  const staged = await stageTaskPins(input, hooks);
  await hooks.afterStage?.(staged);
  return purgeTaskPins(input.root, staged);
}

// Shared content store (ADR-039 Amendment 12). Pins are immutable copies, so each regular file
// is hard-linked to one read-only entry per (content, exec bits) under <root>/.content, on the
// pins' own volume. The filesystem link count is the reference count: link() and unlink() keep
// it exact through any crash, so an entry no pin links has nlink 1 and is swept after a grace.
const STORE_GRACE_MS = 60 * 60 * 1000;
function contentStore(root) {
  const store = path.join(root, '.content');
  return {
    store,
    objects: path.join(store, 'sha256'),
    tmp: path.join(store, 'tmp'),
    quarantine: path.join(store, 'quarantine'),
    migrated: path.join(store, 'migrated'),
  };
}
async function entries(dir) {
  try {
    return await fs.readdir(dir);
  } catch (error) {
    if (error.code === 'ENOENT') return [];
    throw error;
  }
}
async function hashFile(file) {
  return createHash('sha256')
    .update(await fs.readFile(file))
    .digest('hex');
}
async function sweepContentStore(root, now, hooks = {}) {
  const { objects, tmp } = contentStore(root);
  let swept = 0;
  for (const shard of await entries(objects))
    for (const name of await entries(path.join(objects, shard))) {
      const entry = path.join(objects, shard, name);
      const info = await fs.lstat(entry).catch(() => null);
      // ctime moves with every link and unlink, so the grace runs from the last pin change.
      if (!info?.isFile() || info.nlink !== 1 || now - info.ctimeMs < STORE_GRACE_MS) continue;
      await hooks.beforeSweep?.(entry);
      const current = await fs.lstat(entry).catch(() => null);
      if (current?.ino !== info.ino || current.nlink !== 1) continue;
      await fs.unlink(entry);
      swept++;
    }
  for (const name of await entries(tmp)) {
    const file = path.join(tmp, name);
    const info = await fs.lstat(file).catch(() => null);
    if (info && now - info.mtimeMs >= STORE_GRACE_MS) await fs.rm(file, { force: true });
  }
  return swept;
}
const unshareable = new Set(['EXDEV', 'EPERM', 'ENOTSUP', 'EMLINK']);
const readOnly = (info) => 0o444 | (info.mode & 0o111);
async function shareFile(file, info, sha, context) {
  const key = `${sha}-${(info.mode & 0o111).toString(8)}`;
  const entry = path.join(context.store.objects, sha.slice(0, 2), key);
  const temporary = path.join(context.store.tmp, randomUUID());
  const keepPrivate = async (reason) => {
    await fs.chmod(file, readOnly(info));
    context.private[reason] = (context.private[reason] ?? 0) + 1;
    return;
  };
  await fs.mkdir(path.dirname(entry), { recursive: true });
  const existing = await fs.lstat(entry).catch(() => null);
  if (existing?.ino === info.ino) return;
  if (existing) {
    await context.hooks.beforeLink?.(entry);
    try {
      await context.link(entry, temporary);
    } catch (error) {
      // Swept between the lookup and the link: this file becomes the entry instead.
      if (error.code !== 'ENOENT') {
        if (unshareable.has(error.code)) return keepPrivate(error.code);
        throw error;
      }
      return insert();
    }
    // Recompute on the linked inode before it replaces anything: a damaged entry is moved
    // aside and this file keeps its private copy.
    const linked = await fs.lstat(temporary);
    if (
      !context.verified.has(key) &&
      ((await hashFile(temporary)) !== sha ||
        linked.size !== info.size ||
        (linked.mode & 0o111) !== (info.mode & 0o111))
    ) {
      await fs.unlink(temporary);
      await fs.mkdir(context.store.quarantine, { recursive: true });
      await fs
        .rename(entry, path.join(context.store.quarantine, `${key}-${randomUUID()}`))
        .catch(() => undefined);
      return keepPrivate('mismatch');
    }
    context.verified.add(key);
    await fs.rename(temporary, file);
    context.shared++;
    context.savedBytes += info.blocks * 512;
    return;
  }
  return insert();
  async function insert() {
    await fs.chmod(file, readOnly(info));
    try {
      await context.link(file, temporary);
    } catch (error) {
      if (unshareable.has(error.code)) return keepPrivate(error.code);
      throw error;
    }
    await fs.rename(temporary, entry);
    context.verified.add(key);
    context.inserted++;
    return;
  }
}
/** A pin's tree in order, [relative path, kind, exec bits, size, content|target], with hashes. */
async function pinFingerprint(pin) {
  const rows = [];
  const hashes = new Map();
  const walk = async (dir) => {
    for (const name of (await fs.readdir(dir)).sort()) {
      const file = path.join(dir, name);
      const info = await fs.lstat(file);
      const relative = path.relative(pin, file);
      if (info.isDirectory()) {
        rows.push([relative, 'd']);
        await walk(file);
      } else if (info.isSymbolicLink()) rows.push([relative, 'l', await fs.readlink(file)]);
      else if (info.isFile()) {
        const sha = await hashFile(file);
        hashes.set(relative, sha);
        rows.push([relative, 'f', info.mode & 0o111, info.size, sha]);
      } else rows.push([relative, 'other']);
    }
  };
  await walk(pin);
  return { fingerprint: JSON.stringify(rows), hashes };
}
async function sharePin(pin, context) {
  const before = await pinFingerprint(pin);
  const walk = async (dir) => {
    for (const name of await fs.readdir(dir)) {
      const file = path.join(dir, name);
      const info = await fs.lstat(file);
      if (info.isDirectory()) await walk(file);
      else if (info.isFile() && !(dir === pin && name === 'provenance.json'))
        await shareFile(file, info, before.hashes.get(path.relative(pin, file)), context);
    }
  };
  await walk(pin);
  // Recompute every byte after linking: the same paths, kinds, exec bits, sizes and contents.
  return before.fingerprint === (await pinFingerprint(pin)).fingerprint;
}
/** Migrate at most `limit` unshared pins into the store; never touches pins being staged. */
async function shareTaskPins(input, hooks = {}) {
  const { root } = input;
  const limit = input.limit ?? 8;
  const store = contentStore(root);
  const result = {
    pins: [],
    unverified: [],
    shared: 0,
    inserted: 0,
    private: {},
    savedBytes: 0,
  };
  if (!(await exists(root))) return result;
  await fs.mkdir(store.tmp, { recursive: true });
  const done = new Set((await fs.readFile(store.migrated, 'utf8').catch(() => '')).split('\n'));
  const pins = (await readTaskPins(root)).map((entry) => path.basename(entry.pin));
  const context = {
    store,
    hooks,
    link: hooks.link ?? fs.link,
    verified: new Set(),
    shared: 0,
    inserted: 0,
    private: result.private,
    savedBytes: 0,
  };
  for (const id of pins
    .filter((name) => !done.has(name))
    .sort()
    .slice(0, limit)) {
    if (await sharePin(path.join(root, id), context)) {
      done.add(id);
      result.pins.push(id);
    } else result.unverified.push(id);
  }
  const live = new Set(pins);
  const record = path.join(store.tmp, `migrated-${randomUUID()}`);
  await fs.writeFile(
    record,
    [...done]
      .filter((id) => live.has(id))
      .sort()
      .join('\n'),
  );
  await fs.rename(record, store.migrated);
  return {
    ...result,
    shared: context.shared,
    inserted: context.inserted,
    savedBytes: context.savedBytes,
  };
}
module.exports = {
  readTaskPins,
  retiredTaskPinsOf,
  stageTaskPins,
  purgeTaskPins,
  sweepTaskPins,
  sweepContentStore,
  shareTaskPins,
};
