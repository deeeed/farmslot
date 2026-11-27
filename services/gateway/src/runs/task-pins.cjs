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
    if (removed.has(resolved) || released?.has(resolved)) {
      retired.push(pin);
      continue;
    }
    try {
      if (!(await exists(resolved))) retired.push(pin);
    } catch (error) {
      // An inaccessible or invalid path is not evidence of an orphan. Leave that pin in place.
      if (typeof error?.code !== 'string') throw error;
    }
  }
  return retired;
}
/** Rethrow anything but a missing path, which reads as `fallback`. */
function unlessMissing(fallback) {
  return (error) => {
    if (error.code === 'ENOENT') return fallback;
    throw error;
  };
}
// A pin records its task directory's real path; a run records the path it was given, which
// can pass through a symlink (/var -> /private/var). Compare both forms, resolved on this node.
async function realDirs(dirs, label) {
  if (!Array.isArray(dirs) || !dirs.every((dir) => typeof dir === 'string' && path.isAbsolute(dir)))
    throw new Error(`${label} must be absolute paths`);
  const resolved = new Set();
  for (const dir of dirs) {
    resolved.add(path.resolve(dir));
    const real = await fs.realpath(dir).catch(unlessMissing(undefined));
    if (real) resolved.add(real);
  }
  return resolved;
}
async function normalizedProtection(protection) {
  return {
    pinIds: protection.pinIds,
    taskDirs: await realDirs(protection.taskDirs, 'Protected task directories'),
    taskNames: protection.taskNames,
  };
}
function protectedPin(entry, protection) {
  return (
    protection.pinIds.includes(path.basename(entry.pin)) ||
    protection.taskDirs.has(path.resolve(entry.taskDir)) ||
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
/** The next 32 pins after the rotating cursor: the pass's bounded window. */
async function pinWindow(root) {
  const cursor = await fs
    .readFile(path.join(root, '.retention-cursor'), 'utf8')
    .catch(unlessMissing(''));
  const names = (await fs.readdir(root)).filter((n) => !n.startsWith('.')).sort();
  return names
    .filter((n) => n > cursor)
    .concat(names.filter((n) => n <= cursor))
    .slice(0, 32);
}
/** The window's pins and task directories, read-only, so the gateway sends only what matters. */
async function inspectTaskPins(input) {
  const { root } = input;
  if (!(await exists(root))) return { pins: [] };
  const entries = await readTaskPins(root, await pinWindow(root));
  return {
    pins: entries.map((entry) => ({ id: path.basename(entry.pin), taskDir: entry.taskDir })),
  };
}
async function stageTaskPins(input, hooks = {}) {
  const { root, now, ageMs } = input;
  if (!(await exists(root))) return { inspected: 0, staged: [], stage: null };
  if (!(await fs.lstat(root)).isDirectory()) throw new Error('Pin root must be a real directory');
  await restoreStages(root);
  // Inside the admission fence, a bounded slice: drop store entries no pin links any more.
  const swept = await sweepContentStore(root, now, hooks);
  const window = await pinWindow(root);
  if (
    input.ids !== undefined &&
    (!Array.isArray(input.ids) || !input.ids.every((id) => typeof id === 'string'))
  )
    throw new Error('Inspected pin ids must be names');
  // Only pins the gateway inspected are decided: its release and protection lists cover them.
  const ordered = input.ids ? window.filter((name) => input.ids.includes(name)) : window;
  const entries = await readTaskPins(root, ordered);
  const released = await realDirs(input.releasedTaskDirs ?? [], 'Released task directories');
  // Resolved once; a test hook that changes protection mid-stage is re-read each time.
  const fixed = hooks.protection ? undefined : await normalizedProtection(input.protection);
  const protection = async () => fixed ?? normalizedProtection(hooks.protection());
  const initial = await protection();
  const candidates = new Set(
    await retiredTaskPinsOf(
      entries,
      new Set(),
      { now, ageMs },
      (dir) => initial.taskDirs.has(dir),
      undefined,
      released,
    ),
  );
  const stage = path.join(root, '.retention-stage-' + randomUUID());
  const staged = [];
  for (const entry of entries) {
    if (staged.length === 8) break;
    if (!candidates.has(entry.pin) || protectedPin(entry, await protection())) continue;
    if (!(await taskVolumeAvailable(entry.taskDir))) continue;
    await hooks.beforeStage?.(entry);
    const current = (await readTaskPins(root, [path.basename(entry.pin)]))[0];
    if (
      !current ||
      current.provenance !== entry.provenance ||
      current.writtenAt !== entry.writtenAt ||
      protectedPin(current, await protection()) ||
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
// is hard-linked to one read-only entry per (content, read and exec bits) under <root>/.content,
// on the pins' own volume. The filesystem link count is the reference count: link() and unlink()
// keep it exact through any crash, so an entry no pin links has nlink 1 and is swept after a grace.
const STORE_GRACE_MS = 60 * 60 * 1000;
/** Shards of 256 swept per pass, so the sweep stays bounded inside the admission fence. */
const SWEEP_SHARDS = 16;
const QUARANTINE_SWEEP = 64;
function contentStore(root) {
  const store = path.join(root, '.content');
  return {
    store,
    objects: path.join(store, 'sha256'),
    tmp: path.join(store, 'tmp'),
    quarantine: path.join(store, 'quarantine'),
    migrated: path.join(store, 'migrated'),
    sweepCursor: path.join(store, 'sweep-cursor'),
    quarantineCursor: path.join(store, 'quarantine-cursor'),
    shareCursor: path.join(store, 'share-cursor'),
  };
}
/** The next `limit` of sorted `names` after `cursor`, wrapping around. */
function rotate(names, cursor, limit) {
  return names
    .filter((name) => name > cursor)
    .concat(names.filter((name) => name <= cursor))
    .slice(0, limit);
}
async function readCursor(file) {
  return fs.readFile(file, 'utf8').catch(unlessMissing(''));
}
async function entries(dir) {
  return (await fs.readdir(dir).catch(unlessMissing([]))).sort();
}
async function hashFile(file, context) {
  const bytes = await fs.readFile(file);
  if (context) context.bytesHashed += bytes.length;
  return createHash('sha256').update(bytes).digest('hex');
}
/** Unlink `file` if no pin links it and its last link change is older than the grace. */
async function sweepUnlinked(file, now, hooks) {
  const info = await fs.lstat(file).catch(unlessMissing(null));
  // ctime moves with every link and unlink, so the grace runs from the last pin change.
  if (!info?.isFile() || info.nlink !== 1 || now - info.ctimeMs < STORE_GRACE_MS) return false;
  await hooks.beforeSweep?.(file);
  const current = await fs.lstat(file).catch(unlessMissing(null));
  if (current?.ino !== info.ino || current.nlink !== 1) return false;
  await fs.unlink(file);
  return true;
}
async function sweepContentStore(root, now, hooks = {}) {
  const store = contentStore(root);
  const shards = await entries(store.objects);
  const ordered = rotate(shards, await readCursor(store.sweepCursor), SWEEP_SHARDS);
  let swept = 0;
  for (const shard of ordered)
    for (const name of await entries(path.join(store.objects, shard)))
      if (await sweepUnlinked(path.join(store.objects, shard, name), now, hooks)) swept++;
  if (ordered.length) await fs.writeFile(store.sweepCursor, ordered.at(-1));
  const quarantined = rotate(
    await entries(store.quarantine),
    await readCursor(store.quarantineCursor),
    QUARANTINE_SWEEP,
  );
  for (const name of quarantined)
    await sweepUnlinked(path.join(store.quarantine, name), now, hooks);
  if (quarantined.length) await fs.writeFile(store.quarantineCursor, quarantined.at(-1));
  for (const name of await entries(store.tmp)) {
    const file = path.join(store.tmp, name);
    const info = await fs.lstat(file).catch(unlessMissing(null));
    // A fresh temporary link keeps its inode's old mtime; its ctime is the link's own.
    if (info && now - info.ctimeMs >= STORE_GRACE_MS) await fs.rm(file, { force: true });
  }
  return swept;
}
const unshareable = new Set(['EXDEV', 'EPERM', 'ENOTSUP', 'EMLINK']);
/** Read and exec bits kept, write bits dropped; the entry key carries them, so 0600 stays 0400. */
const readOnly = (info) => info.mode & 0o555;
/** Link one file into the store; returns the hash taken on the inode now at `file`. */
async function shareFile(file, info, sha, context) {
  const key = `${sha}-${readOnly(info).toString(8)}`;
  const entry = path.join(context.store.objects, sha.slice(0, 2), key);
  const temporary = path.join(context.store.tmp, randomUUID());
  const keepPrivate = async (reason) => {
    await fs.chmod(file, readOnly(info));
    context.private[reason] = (context.private[reason] ?? 0) + 1;
    return undefined;
  };
  // Hash the linked inode itself; nothing replaces a file on a hash taken elsewhere.
  const linkedMatches = async () => {
    const linked = await fs.lstat(temporary);
    const hash = await hashFile(temporary, context);
    return hash === sha && linked.size === info.size && readOnly(linked) === readOnly(info)
      ? hash
      : undefined;
  };
  const insert = async () => {
    await fs.chmod(file, readOnly(info));
    try {
      await context.link(file, temporary);
    } catch (error) {
      if (unshareable.has(error.code)) return keepPrivate(error.code);
      throw error;
    }
    const hash = await linkedMatches();
    if (!hash) {
      // The file changed since the pin was fingerprinted: never label it with the old hash.
      await fs.unlink(temporary);
      return keepPrivate('changed');
    }
    await fs.rename(temporary, entry);
    context.inserted++;
    return hash;
  };
  await fs.mkdir(path.dirname(entry), { recursive: true });
  const existing = await fs.lstat(entry).catch(unlessMissing(null));
  if (!existing) return insert();
  if (existing.ino === info.ino) return hashFile(file, context);
  await context.hooks.beforeLink?.(entry);
  try {
    await context.link(entry, temporary);
  } catch (error) {
    // Swept between the lookup and the link: this file becomes the entry instead.
    if (error.code === 'ENOENT') return insert();
    if (unshareable.has(error.code)) return keepPrivate(error.code);
    throw error;
  }
  const hash = await linkedMatches();
  if (!hash) {
    // A damaged entry is moved aside and this file keeps its private copy.
    await fs.unlink(temporary);
    await fs.mkdir(context.store.quarantine, { recursive: true });
    await fs
      .rename(entry, path.join(context.store.quarantine, `${key}-${randomUUID()}`))
      .catch(unlessMissing(undefined));
    return keepPrivate('mismatch');
  }
  await fs.rename(temporary, file);
  context.shared++;
  context.savedBytes += info.blocks * 512;
  return hash;
}
/**
 * A pin's tree in order: [relative path, kind, exec bits, size, content|target]. `known` gives
 * hashes already taken on the inode now at a path; any other file is hashed here.
 */
async function pinFingerprint(pin, context, known = new Map()) {
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
        const sha = known.get(relative) ?? (await hashFile(file, context));
        hashes.set(relative, sha);
        rows.push([relative, 'f', info.mode & 0o111, info.size, sha]);
      } else rows.push([relative, 'other']);
    }
  };
  await walk(pin);
  return { fingerprint: JSON.stringify(rows), hashes };
}
async function sharePin(pin, context) {
  const before = await pinFingerprint(pin, context);
  const after = new Map();
  const walk = async (dir) => {
    for (const name of await fs.readdir(dir)) {
      const file = path.join(dir, name);
      const info = await fs.lstat(file);
      if (info.isDirectory()) await walk(file);
      else if (info.isFile() && !(dir === pin && name === 'provenance.json')) {
        const relative = path.relative(pin, file);
        const hash = await shareFile(file, info, before.hashes.get(relative), context);
        if (hash) after.set(relative, hash);
      }
    }
  };
  await walk(pin);
  // Recompute after linking: same paths, kinds, exec bits and sizes, and bytes hashed on each
  // linked inode (files kept private are hashed again here).
  return before.fingerprint === (await pinFingerprint(pin, context, after)).fingerprint;
}
/** Migrate at most `limit` unshared pins into the store; one failing pin never blocks the rest. */
async function shareTaskPins(input, hooks = {}) {
  const started = Date.now();
  const { root } = input;
  const limit = input.limit ?? 8;
  const store = contentStore(root);
  const context = {
    store,
    hooks,
    link: hooks.link ?? fs.link,
    shared: 0,
    inserted: 0,
    private: {},
    savedBytes: 0,
    bytesHashed: 0,
  };
  const result = { pins: [], unverified: [], failed: [] };
  const summary = () => ({
    ...result,
    shared: context.shared,
    inserted: context.inserted,
    private: context.private,
    savedBytes: context.savedBytes,
    bytesHashed: context.bytesHashed,
    seconds: Math.round((Date.now() - started) / 1000),
  });
  if (!(await exists(root))) return summary();
  await fs.mkdir(store.tmp, { recursive: true });
  const done = new Set(
    (await fs.readFile(store.migrated, 'utf8').catch(unlessMissing(''))).split('\n'),
  );
  const pins = (await readTaskPins(root)).map((entry) => path.basename(entry.pin));
  // A rotating cursor: pins that keep failing never hold back the ones after them.
  const batch = rotate(
    pins.filter((name) => !done.has(name)).sort(),
    await readCursor(store.shareCursor),
    limit,
  );
  if (batch.length) await fs.writeFile(store.shareCursor, batch.at(-1));
  for (const id of batch) {
    try {
      if (await sharePin(path.join(root, id), context)) {
        done.add(id);
        result.pins.push(id);
      } else result.unverified.push(id);
    } catch (error) {
      result.failed.push({ id, code: error.code ?? 'ERROR', message: String(error.message) });
    }
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
  return summary();
}
module.exports = {
  readTaskPins,
  retiredTaskPinsOf,
  inspectTaskPins,
  stageTaskPins,
  purgeTaskPins,
  sweepTaskPins,
  sweepContentStore,
  shareTaskPins,
};
