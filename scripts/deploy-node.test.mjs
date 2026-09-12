import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// Execute the actual deployment script with remote side effects replaced by command stubs.
// This proves generated service documents, not remote installation or runner execution.
for (const platform of ['Darwin', 'Linux']) {
  for (const native of [false, true]) {
    test(`deploy-node renders ${platform} service with native=${native}`, () => {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), 'node-deploy-render-'));
      try {
        const write = (relative, content, executable = false) => {
          const target = path.join(root, relative);
          fs.mkdirSync(path.dirname(target), { recursive: true });
          fs.writeFileSync(target, content, { mode: executable ? 0o700 : 0o600 });
        };
        write('scripts/deploy-node.sh', fs.readFileSync(path.join(repo, 'scripts/deploy-node.sh')));
        write(
          'services/node/package.json',
          fs.readFileSync(path.join(repo, 'services/node/package.json')),
        );
        for (const name of ['protocol', 'capabilities', 'agent-runtime']) {
          write(
            `packages/${name}/package.json`,
            fs.readFileSync(path.join(repo, 'packages', name, 'package.json')),
          );
          fs.mkdirSync(path.join(root, 'packages', name, 'dist'));
        }
        write('node-token', 'fixture-node-credential');
        write(
          'bin/ssh',
          `#!/usr/bin/env python3
import os,sys
from pathlib import Path
command=' '.join(sys.argv[2:])
body=sys.stdin.read()
if body.startswith('<?xml'): Path(os.environ['RENDER_ROOT'],'service.plist').write_text(body)
elif body.startswith('[Unit]'): Path(os.environ['RENDER_ROOT'],'service.unit').write_text(body)
if command=='uname -s': print(os.environ['RENDER_OS'])
elif command=='echo $HOME': print('/home/node-validation')
elif command=='id -u': print('501')
elif 'SHELL:-/bin/sh' in command: print('/bin/zsh' if os.environ['RENDER_OS']=='Darwin' else '/bin/bash')
elif 'which yarn' in command: print('no')
elif command.startswith('test -d '): sys.exit(1)
`,
          true,
        );
        for (const command of ['rsync', 'yarn', 'sleep'])
          write(`bin/${command}`, '#!/bin/sh\nexit 0\n', true);
        const env = {
          ...process.env,
          PATH: `${root}/bin:${process.env.PATH}`,
          RENDER_ROOT: root,
          RENDER_OS: platform,
          FARMSLOT_NODE_PATH: platform === 'Darwin' ? '/opt/homebrew/bin/node' : '/usr/bin/node',
          FARMSLOT_NATIVE_OWNER_PRINCIPAL_ID: native ? 'fixture-owner' : '',
          FARMSLOT_NODE_INSTANCE: 'prod',
        };
        execFileSync(
          'bash',
          [
            path.join(root, 'scripts/deploy-node.sh'),
            'fixture-machine',
            '127.0.0.1',
            '--node-token-file',
            path.join(root, 'node-token'),
          ],
          {
            env,
            cwd: root,
            encoding: 'utf8',
            stdio: ['ignore', 'pipe', 'pipe'],
            timeout: 30000,
          },
        );
        let args;
        let servicePath;
        if (platform === 'Darwin') {
          const document = JSON.parse(
            execFileSync(
              'python3',
              [
                '-c',
                'import plistlib,json,sys; print(json.dumps(plistlib.load(open(sys.argv[1],"rb"))))',
                path.join(root, 'service.plist'),
              ],
              { encoding: 'utf8' },
            ),
          );
          args = document.ProgramArguments;
          servicePath = document.EnvironmentVariables.PATH;
          assert.equal(
            document.EnvironmentVariables.FARMSLOT_NATIVE_OWNER_PRINCIPAL_ID,
            native ? 'fixture-owner' : undefined,
          );
        } else {
          const unit = fs.readFileSync(path.join(root, 'service.unit'), 'utf8');
          const command = unit
            .split('\n')
            .find((line) => line.startsWith('ExecStart='))
            .slice(10);
          args = JSON.parse(
            execFileSync(
              'python3',
              ['-c', 'import shlex,json,sys; print(json.dumps(shlex.split(sys.argv[1])))', command],
              { encoding: 'utf8' },
            ),
          );
          servicePath = unit
            .split('\n')
            .find((line) => line.startsWith('Environment=PATH='))
            .slice(17);
          assert.equal(unit.includes('FARMSLOT_NATIVE_OWNER_PRINCIPAL_ID=fixture-owner'), native);
        }
        assert.equal(new Set(servicePath.split(':')).size, servicePath.split(':').length);
        if (native) {
          assert.deepEqual(args.slice(0, 2), [
            platform === 'Darwin' ? '/bin/zsh' : '/bin/bash',
            '-lc',
          ]);
          assert.equal(args.length, 3);
          assert.ok(args[2].startsWith(`exec ${env.FARMSLOT_NODE_PATH} --require `));
          assert.ok(servicePath.includes('/home/node-validation/.npm-global/bin'));
        } else {
          assert.equal(args[0], env.FARMSLOT_NODE_PATH);
          assert.equal(args[1], '--require');
          assert.equal(args.length, 6);
        }
      } finally {
        fs.rmSync(root, { recursive: true, force: true });
      }
    });
  }
}
