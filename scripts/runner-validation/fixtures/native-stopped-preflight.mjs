// Isolated prepare hook: prove the previous native process stopped before preparation.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const pid = Number(process.argv[2]);
const receipt = path.resolve(process.argv[3]);
assert.ok(Number.isSafeInteger(pid) && pid > 1);
assert.ok(receipt.includes('/temp/native-validation/'));
let stopped = false;
try {
  process.kill(pid, 0);
} catch (error) {
  if (error.code !== 'ESRCH') throw error;
  stopped = true;
}
assert.ok(stopped, 'Old native worker is still running when preparation starts');
fs.writeFileSync(receipt, JSON.stringify({ pid, stopped, checkedAt: new Date().toISOString() }), {
  mode: 0o600,
});
