// Shared pin eligibility, also shipped verbatim to the node holding the files.
const fs = require('node:fs/promises');
const path = require('node:path');
const { randomUUID } = require('node:crypto');

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
    if (name.startsWith('.retention-')) continue;
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
function releasedTaskDirsOf(input) {
  const dirs = input.releasedTaskDirs ?? [];
  if (!Array.isArray(dirs) || !dirs.every((dir) => typeof dir === 'string' && path.isAbsolute(dir)))
    throw new Error('Released task directories must be absolute paths');
  return new Set(dirs.map((dir) => path.resolve(dir)));
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
  let cursor = '';
  try {
    cursor = await fs.readFile(path.join(root, '.retention-cursor'), 'utf8');
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  const names = (await fs.readdir(root)).filter((n) => !n.startsWith('.retention-')).sort();
  const ordered = names
    .filter((n) => n > cursor)
    .concat(names.filter((n) => n <= cursor))
    .slice(0, 32);
  const entries = await readTaskPins(root, ordered);
  const released = releasedTaskDirsOf(input);
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
  return { inspected: ordered.length, staged, stage: staged.length ? path.basename(stage) : null };
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
module.exports = { readTaskPins, retiredTaskPinsOf, stageTaskPins, purgeTaskPins, sweepTaskPins };
