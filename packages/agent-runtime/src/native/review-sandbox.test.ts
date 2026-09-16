import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';

import { hostReviewSandboxAvailable, reviewProcessSandbox } from './review-sandbox.js';

const exec = promisify(execFile);
test(
  'host review sandbox protects source, shared git metadata and unrelated files while reports stay writable',
  { skip: !hostReviewSandboxAvailable() },
  async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), 'review-permissions-')));
    const source = join(root, 'source'),
      output = join(root, 'reports'),
      metadata = join(root, 'git'),
      other = join(root, 'other');
    try {
      for (const dir of [source, output, metadata, other]) await mkdir(dir);
      for (const dir of [source, metadata, other]) await writeFile(join(dir, 'file'), 'original');
      const { sandbox } = await reviewProcessSandbox(
        { readOnlyRoots: [source, metadata], writableRoots: [output] },
        [],
      );
      const program = `const fs=require('node:fs');const roots=JSON.parse(process.argv[1]);const results={};for(const [name,root]of Object.entries(roots)){try{fs.writeFileSync(root+'/file','changed');results[name]=true;}catch(e){if(!['EPERM','EACCES'].includes(e.code))throw e;results[name]=false;}}console.log(JSON.stringify(results));`;
      const result = await exec(sandbox.executable, [
        ...sandbox.args,
        process.execPath,
        '-e',
        program,
        JSON.stringify({ source, metadata, other, output }),
      ]);
      assert.deepEqual(JSON.parse(result.stdout), {
        source: false,
        metadata: false,
        other: false,
        output: true,
      });
      assert.equal(await readFile(join(source, 'file'), 'utf8'), 'original');
      assert.equal(await readFile(join(output, 'file'), 'utf8'), 'changed');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
);
