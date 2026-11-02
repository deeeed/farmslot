import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';

import { nativeRunnerDefinitions } from './registry.js';
import { hostReviewSandboxAvailable, reviewProcessSandbox } from './review-sandbox.js';

const exec = promisify(execFile);
test(
  "host review sandbox lets a review write only the runner's named paths in its account home",
  { skip: !hostReviewSandboxAvailable() },
  async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), 'review-protected-')));
    const source = join(root, 'source'),
      output = join(root, 'reports'),
      account = join(root, 'account');
    try {
      for (const dir of [
        source,
        output,
        join(account, 'bin'),
        join(account, 'bundled', 'agents'),
        join(account, 'sessions'),
        join(account, 'logs'),
      ])
        await mkdir(dir, { recursive: true });
      for (const file of [
        'config.toml',
        'bin/main-session-token',
        'models_cache.json',
        'auth.json',
      ])
        await writeFile(join(account, file), 'original');
      const policy = { readOnlyRoots: [source], writableRoots: [output] };
      const access = nativeRunnerDefinitions.grok.reviewRuntimeAccess!({ GROK_HOME: account });
      const { sandbox } = await reviewProcessSandbox(policy, [account], [], access);
      const lock = join(account, 'auth.json.lock');
      const program = `const fs=require('node:fs'),path=require('node:path');const ops=JSON.parse(process.argv[1]);const results={};for(const [name,[op,file,other]]of Object.entries(ops)){try{if(op==='write'){fs.mkdirSync(path.dirname(file),{recursive:true});fs.writeFileSync(file,'changed')}else if(op==='symlink')fs.symlinkSync(other,file);else if(op==='link')fs.linkSync(other,file);else if(op==='rename')fs.renameSync(file,other);else fs.unlinkSync(file);results[name]=true;}catch(e){if(!['EPERM','EACCES'].includes(e.code))throw e;results[name]=false;}}console.log(JSON.stringify(results));`;
      const result = await exec(sandbox.executable, [
        ...sandbox.args,
        process.execPath,
        '-e',
        program,
        JSON.stringify({
          config: ['write', join(account, 'config.toml')],
          managed: ['write', join(account, 'managed_config.toml')],
          hook: ['write', join(account, 'hooks', 'planted.json')],
          // A bundled agent loads as built-in; managed or required settings can select it.
          bundledAgent: ['write', join(account, 'bundled', 'agents', 'planted.md')],
          // The external sign-in command runs at every authenticate, also outside the sandbox.
          signIn: ['write', join(account, 'bin', 'main-session-token')],
          // A profile's HOME is its Grok home, and Grok's login-shell capture runs these.
          shell: ['write', join(account, '.zshenv')],
          // The model catalog cache names the endpoint later sessions send requests to.
          modelCatalog: ['write', join(account, 'models_cache.json')],
          storedLogin: ['write', join(account, 'auth.json')],
          memory: ['write', join(account, 'memory-v2', 'global', 'planted.md')],
          sessionLink: ['symlink', join(account, 'sessions', 'link'), join(account, 'config.toml')],
          logHardLink: ['link', join(account, 'logs', 'hard'), join(account, 'config.toml')],
          lockData: ['write', lock],
          lockRename: ['rename', lock, join(account, 'sessions', 'moved')],
          lockRemove: ['unlink', lock],
          session: ['write', join(account, 'sessions', 'review.jsonl')],
          log: ['write', join(account, 'logs', 'unified.jsonl')],
          newLog: ['write', join(account, 'logs', 'other.jsonl')],
          // A writable directory and the log an unsandboxed Grok start appends to keep their
          // identity: nothing can be moved in to stand for them.
          logReplace: [
            'rename',
            join(account, 'sessions', 'review.jsonl'),
            join(account, 'logs', 'unified.jsonl'),
          ],
          logRemove: ['unlink', join(account, 'logs', 'unified.jsonl')],
          logsMove: ['rename', join(account, 'logs'), join(output, 'logs-moved')],
          sessionsMove: ['rename', join(account, 'sessions'), join(output, 'sessions-moved')],
        }),
      ]);
      assert.deepEqual(JSON.parse(result.stdout), {
        config: false,
        managed: false,
        hook: false,
        bundledAgent: false,
        signIn: false,
        shell: false,
        modelCatalog: false,
        storedLogin: false,
        memory: false,
        sessionLink: false,
        logHardLink: false,
        lockData: true,
        lockRename: false,
        lockRemove: false,
        session: true,
        log: true,
        newLog: true,
        logReplace: false,
        logRemove: false,
        logsMove: false,
        sessionsMove: false,
      });
      for (const file of [
        'config.toml',
        'bin/main-session-token',
        'models_cache.json',
        'auth.json',
      ])
        assert.equal(await readFile(join(account, file), 'utf8'), 'original');
      // A lock that is not a regular file is refused before anything starts.
      await rm(lock);
      await symlink(join(account, 'bin', 'main-session-token'), lock);
      await assert.rejects(
        reviewProcessSandbox(policy, [account], [], access),
        /must be a regular file/,
      );
      await assert.rejects(
        reviewProcessSandbox(policy, [account], [], { writablePaths: [join(root, 'elsewhere')] }),
        /must belong to a runtime root/,
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
);

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

test(
  'review configuration mask blocks startup reads while Git and ordinary source remain readable',
  { skip: !hostReviewSandboxAvailable() },
  async (t) => {
    const root = await realpath(await mkdtemp(join(tmpdir(), 'review-config-mask-')));
    t.after(() => rm(root, { recursive: true, force: true }));
    const source = join(root, 'source'),
      output = join(root, 'output');
    await mkdir(join(source, '.grok'), { recursive: true });
    await mkdir(output);
    await writeFile(join(source, 'code'), 'reviewable');
    await writeFile(
      join(source, '.grok', 'config.toml'),
      '[mcp_servers.example]\ncommand = "node"\n',
    );
    for (const args of [
      ['init', '-q', source],
      ['-C', source, 'add', '.'],
      [
        '-C',
        source,
        '-c',
        'user.name=Fixture',
        '-c',
        'user.email=fixture@example.invalid',
        '-c',
        'commit.gpgsign=false',
        'commit',
        '-qm',
        'fixture',
      ],
    ])
      await exec('git', args);
    const { sandbox } = await reviewProcessSandbox(
      { readOnlyRoots: [source], writableRoots: [output] },
      [],
      nativeRunnerDefinitions.grok.reviewConfigurationRoots!(await realpath(source)),
    );
    await assert.rejects(
      exec(sandbox.executable, [...sandbox.args, '/bin/cat', join(source, '.grok/config.toml')]),
    );
    const code = await exec(sandbox.executable, [
      ...sandbox.args,
      '/bin/cat',
      join(source, 'code'),
    ]);
    assert.equal(code.stdout, 'reviewable');
    const blob = await exec(sandbox.executable, [
      ...sandbox.args,
      'git',
      '-C',
      source,
      'show',
      'HEAD:.grok/config.toml',
    ]);
    assert.ok(blob.stdout.includes('mcp_servers.example'));
    const external = join(root, 'external');
    await mkdir(external);
    await symlink(external, join(source, '.claude'));
    await assert.rejects(
      reviewProcessSandbox(
        { readOnlyRoots: [source], writableRoots: [output] },
        [],
        [join(source, '.claude')],
      ),
      /links outside/,
    );
  },
);
