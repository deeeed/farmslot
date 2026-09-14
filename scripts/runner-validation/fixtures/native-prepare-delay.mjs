// Private project preflight: hold a real prepare after its slot admission.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const checkpoint = path.resolve(process.argv[2]);
assert.ok(checkpoint.includes('/temp/native-validation/'));
assert.equal(fs.existsSync(`${checkpoint}.ready`), false);
fs.writeFileSync(`${checkpoint}.ready`, JSON.stringify({ pid: process.pid }), { mode: 0o600 });
const deadline = Date.now() + 90000;
while (!fs.existsSync(`${checkpoint}.release`)) {
  assert.ok(Date.now() < deadline, 'Private prepare checkpoint timed out');
  await new Promise((resolve) => setTimeout(resolve, 50));
}
