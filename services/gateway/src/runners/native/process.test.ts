import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { JsonLineProcess } from './process.js';

for (const malformed of ['null', '{"method":"broken"}']) {
  test(`protocol failure isolates the child for ${malformed}`, async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'native-protocol-failure-'));
    const script = join(cwd, 'runner.cjs');
    await writeFile(script, `console.log(${JSON.stringify(malformed)});setInterval(()=>{},1000);`);
    const errors: Array<Error | undefined> = [];
    const process = new JsonLineProcess(
      globalThis.process.execPath,
      [script],
      { cwd },
      () => {
        throw new Error('Invalid native event');
      },
      (error) => errors.push(error),
    );
    try {
      await once(process.child, 'close');
      assert.equal(errors.length, 1);
      assert.match(
        errors[0]?.message ?? '',
        /Native runner (emitted invalid JSON|protocol event failed)/,
      );
      assert.throws(() => process.write({ method: 'next' }), /closed/);
    } finally {
      await process.close();
      await rm(cwd, { recursive: true, force: true });
    }
  });
}
