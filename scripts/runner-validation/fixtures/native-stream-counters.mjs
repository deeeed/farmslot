/** Optional proof instrumentation. Counts actual journal reads and process starts, without timers. */
import childProcess from 'node:child_process';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import path from 'node:path';

const directory = process.env.FARMSLOT_STREAM_COUNTER_DIRECTORY;
const nativeRoot = process.env.FARMSLOT_NATIVE_STATE_DIR;
if (directory && nativeRoot) {
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const counters = { pid: process.pid, journalReads: 0, journalBytes: 0, processStarts: 0 };
  const write = fs.writeFileSync.bind(fs);
  const save = () => {
    const temporary = path.join(directory, process.pid + '.tmp');
    write(temporary, JSON.stringify(counters), { mode: 0o600 });
    fs.renameSync(temporary, path.join(directory, process.pid + '.json'));
  };
  const journal = (file) =>
    typeof file === 'string' && file.startsWith(nativeRoot + path.sep) && file.endsWith('.journal');
  const countRead = (file, result) => {
    if (journal(file)) {
      counters.journalReads++;
      counters.journalBytes +=
        typeof result === 'string' ? Buffer.byteLength(result) : result.byteLength;
      save();
    }
    return result;
  };
  const files = new Map();
  const openSync = fs.openSync.bind(fs);
  fs.openSync = (file, ...args) => {
    const fd = openSync(file, ...args);
    if (journal(file)) files.set(fd, file);
    return fd;
  };
  const closeSync = fs.closeSync.bind(fs);
  fs.closeSync = (fd) => {
    files.delete(fd);
    return closeSync(fd);
  };
  const readSync = fs.readFileSync.bind(fs);
  fs.readFileSync = (file, ...args) => countRead(files.get(file) ?? file, readSync(file, ...args));
  const read = fs.readFile.bind(fs);
  fs.readFile = (file, ...args) => {
    const callback = args.pop();
    return read(file, ...args, (error, result) =>
      callback(error, error ? result : countRead(file, result)),
    );
  };
  const readPromise = fs.promises.readFile.bind(fs.promises);
  fs.promises.readFile = async (file, ...args) => countRead(file, await readPromise(file, ...args));
  for (const name of ['spawn', 'spawnSync', 'execFile', 'execFileSync']) {
    const original = childProcess[name];
    const start = original.bind(childProcess);
    const custom = Symbol.for('nodejs.util.promisify.custom');
    const wrapped = (...args) => {
      counters.processStarts++;
      save();
      return start(...args);
    };
    if (original[custom])
      Object.defineProperty(wrapped, custom, {
        value: (...args) => {
          counters.processStarts++;
          save();
          return original[custom](...args);
        },
      });
    childProcess[name] = wrapped;
  }
  syncBuiltinESMExports();
  save();
}
