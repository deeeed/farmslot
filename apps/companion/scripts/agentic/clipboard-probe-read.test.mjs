import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import { readForegroundClipboard } from './clipboard-probe/read.mjs';

for (const foreign of [false, true]) {
  test(
    foreign
      ? 'foreign cat output is fatal, without polling it into a success'
      : 'zero-exit missing nonce file waits for a real focused clipboard observation',
    async () => {
      const dir = await mkdtemp(path.join(os.tmpdir(), 'view-link-clipboard-'));
      try {
        const apk = path.join(dir, 'probe.apk');
        const bytes = Buffer.from('test-only probe identity');
        await writeFile(apk, bytes);
        const receiptPath = path.join(dir, 'build.json');
        await writeFile(
          receiptPath,
          JSON.stringify({ apk, apkSha256: createHash('sha256').update(bytes).digest('hex') }),
        );
        let reads = 0,
          waits = 0,
          requestId;
        const execute = (_file, args) => {
          if (args.includes('pidof')) return '71\n';
          if (args.includes('exec-out')) {
            reads++;
            requestId = /files\/clipboard-(.+)\.json/.exec(args.at(-1))[1];
            if (reads === 1)
              return Buffer.from(
                'cat: files/clipboard-' +
                  (foreign ? 'foreign' : requestId) +
                  '.json: No such file or directory\n',
              );
            return Buffer.from(
              JSON.stringify({
                requestId,
                status: 'read',
                itemCount: 1,
                text: 'https://cc.example.test/#run/observed',
              }),
            );
          }
          assert(args.some((x) => x.includes('ClipboardProbeActivity')));
          return '';
        };
        const run = () =>
          readForegroundClipboard({
            adb: 'owned-adb',
            serial: 'owned-device',
            receiptPath,
            artifactDir: dir,
            execute,
            wait: async () => {
              waits++;
            },
          });
        if (foreign) {
          await assert.rejects(run, SyntaxError);
          assert.equal(reads, 1);
          assert.equal(waits, 0);
          assert.equal(
            (await readdir(dir)).some((name) => name.startsWith('clipboard-probe-')),
            false,
          );
        } else {
          assert.equal((await run()).text, 'https://cc.example.test/#run/observed');
          assert.equal(reads, 2);
          assert.equal(waits, 1);
          assert((await readdir(dir)).includes('clipboard-probe-' + requestId + '.json'));
        }
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    },
  );
}
