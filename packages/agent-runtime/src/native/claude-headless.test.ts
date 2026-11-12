import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { claudeNativeAdapter } from './claude.js';
import type { NativeAdapterOptions, NativeAdapterSession } from './types.js';

const fixture = `#!${process.execPath}
const fs = require('node:fs');
fs.writeFileSync('launch.json', JSON.stringify({
 argv: process.argv.slice(2),
 background: process.env.CLAUDE_CODE_DISABLE_BACKGROUND_TASKS,
 mcpBackground: process.env.CLAUDE_CODE_DISABLE_MCP_TASK_BACKGROUND,
 preserved: process.env.SYNTHETIC_LAUNCH_VALUE,
}));
const flag = process.argv.includes('--resume') ? '--resume' : '--session-id';
const session_id = process.argv[process.argv.indexOf(flag) + 1];
const send = m => process.stdout.write(JSON.stringify(m) + '\\n');
require('node:readline').createInterface({input:process.stdin}).on('line', line => {
 const m = JSON.parse(line);
 if (m.type === 'control_request') send({type:'control_response',response:{request_id:m.request_id,subtype:'success',response:{}}});
 if (m.type === 'user') {
  send({...m,session_id});
  send({type:'result',session_id,subtype:'success',is_error:false});
 }
});
`;

const paths: [string, Partial<NativeAdapterOptions>][] = [
  ['worker', {}],
  ['reviewer', { filesystemPolicy: { readOnlyRoots: ['/source'], writableRoots: ['/task'] } }],
  ['resume', { resumeSessionId: randomUUID() }],
];
for (const [name, options] of paths) {
  for (const modelQuestions of [undefined, 'off'] as const) {
    test(`headless Claude ${name} forbids background work with questions ${modelQuestions ?? 'on'}`, async (t) => {
      const cwd = await mkdtemp(join(tmpdir(), 'claude-headless-'));
      const executable = join(cwd, 'runner');
      await writeFile(executable, fixture, { mode: 0o700 });
      let session: NativeAdapterSession | undefined;
      t.after(async () => {
        await session?.close();
        await rm(cwd, { recursive: true, force: true });
      });
      const completed = new Set<string>();
      session = await claudeNativeAdapter.start(
        {
          cwd,
          executable,
          ...options,
          modelQuestions,
          env: {
            ...process.env,
            CLAUDE_CODE_DISABLE_BACKGROUND_TASKS: '0',
            CLAUDE_CODE_DISABLE_MCP_TASK_BACKGROUND: '0',
            SYNTHETIC_LAUNCH_VALUE: 'kept',
          },
        },
        (event) => {
          if (event.type === 'turn.completed' && event.commandId) completed.add(event.commandId);
        },
      );
      const launch = JSON.parse(await readFile(join(cwd, 'launch.json'), 'utf8'));
      assert.equal(
        launch.background,
        '1',
        'profile/project values cannot reenable background work',
      );
      assert.equal(launch.preserved, 'kept');
      assert.equal(launch.mcpBackground, '1');
      const argv: string[] = launch.argv;
      assert(argv.includes('--print'));
      assert.equal(argv.filter((arg) => arg === '--disallowedTools').length, 1);
      const tools = argv.slice(
        argv.indexOf('--disallowedTools') + 1,
        argv.indexOf(options.resumeSessionId ? '--resume' : '--session-id'),
      );
      assert.deepEqual(
        tools,
        modelQuestions === 'off' ? ['Monitor', 'AskUserQuestion'] : ['Monitor'],
      );
      if (options.resumeSessionId)
        assert.equal(argv[argv.indexOf('--resume') + 1], options.resumeSessionId);
      for (const command of ['work', 'completion']) {
        await session.send('Synthetic turn', command);
        const deadline = Date.now() + 5000;
        while (!completed.has(command)) {
          assert(Date.now() < deadline, 'Turn must complete through the native protocol');
          await new Promise((resolve) => setTimeout(resolve, 10));
        }
      }
    });
  }
}
