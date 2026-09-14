// Hold the real executable resolution await in one private native host. This lets
// cancellation race the resume's final synchronous ownership/fence check.
import fs from 'node:fs';
import promises from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';

const config = process.env.FARMSLOT_NATIVE_RESUME_REPLY_FAULT;
const realpath = promises.realpath;
if (config) {
  promises.realpath = async function (...args) {
    const resolved = await realpath.apply(this, args);
    if (!fs.existsSync(config) || fs.existsSync(`${config}.probe`)) return resolved;
    const target = JSON.parse(fs.readFileSync(config, 'utf8'));
    if (
      target.mode !== 'probe-request' ||
      target.hostPid !== process.pid ||
      resolved !== target.executable
    )
      return resolved;
    fs.writeFileSync(
      `${config}.probe`,
      JSON.stringify({ hostPid: process.pid, executable: resolved }),
      { mode: 0o600 },
    );
    const deadline = Date.now() + 60000;
    while (!fs.existsSync(`${config}.release`)) {
      if (Date.now() > deadline) throw new Error('Private resume probe release timed out');
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    return resolved;
  };
  syncBuiltinESMExports();
}
