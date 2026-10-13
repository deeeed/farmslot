/** Manual fleet-proof Git upstream. TLS trust and repositories stay inside the owned proof root. */
import { execFile, spawn } from 'node:child_process';
import { chmod, cp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { createServer, type Server } from 'node:https';
import path from 'node:path';
import { promisify } from 'node:util';

const execute = promisify(execFile);

export class ProofSourceUpstream {
  private constructor(
    readonly port: number,
    readonly caFile: string,
    readonly repository: string,
    readonly worktree: string,
    private readonly server: Server,
  ) {}

  static async start(root: string, frameworkRoot: string): Promise<ProofSourceUpstream> {
    await mkdir(root, { recursive: true });
    const worktree = path.join(root, 'worktree');
    const repositories = path.join(root, 'repositories');
    const bare = path.join(repositories, 'source-proof', 'pack.git');
    await mkdir(path.dirname(bare), { recursive: true });
    await execute('git', ['init', '--bare', '-q', bare]);
    await execute('git', ['--git-dir', bare, 'config', 'http.receivepack', 'true']);
    await mkdir(worktree);
    await execute('git', ['-C', worktree, 'init', '-q', '-b', 'main']);
    await cp(
      path.join(frameworkRoot, 'scripts/sources-validation/fixture'),
      path.join(worktree, 'scripts/sources-validation/fixture'),
      { recursive: true },
    );
    await cp(
      path.join(frameworkRoot, 'projects/farmslot-farm/templates'),
      path.join(worktree, 'framework/templates'),
      { recursive: true },
    );
    await mkdir(path.join(worktree, 'framework'), { recursive: true });
    await writeFile(
      path.join(worktree, 'framework/project.json'),
      JSON.stringify({
        name: 'farmslot-farm',
        default_branch: 'main',
        type: 'monorepo',
        paths: { runtime_dir: '.agent', artifact_dir: '.task' },
        qa: {
          default_profile: 'source-smoke',
          profiles: [{ id: 'source-smoke', title: 'Source smoke', template_id: 'qa-checklist' }],
        },
      }),
    );
    const fixture = path.join(worktree, 'scripts/sources-validation/fixture');
    await mkdir(path.join(fixture, 'templates/prompts'), { recursive: true });
    for (const name of ['worker-dispatch.md', 'worker-nudge.md'])
      await cp(
        path.join(worktree, 'framework/templates/prompts', name),
        path.join(fixture, 'templates/prompts', name),
      );
    await mkdir(path.join(fixture, 'templates/worker'), { recursive: true });
    await cp(
      path.join(worktree, 'framework/templates/worker'),
      path.join(fixture, 'templates/worker'),
      { recursive: true },
    );
    await cp(
      path.join(frameworkRoot, 'templates/worker/ci-fix.md'),
      path.join(fixture, 'templates/worker/ci-fix.md'),
    );

    // Exercise static Review with automatic QA in the same declared proof pack.
    const fixtureConfig = JSON.parse(await readFile(path.join(fixture, 'project.json'), 'utf8'));
    fixtureConfig.repo_url = 'https://github.com/deeeed/farmslot.git';
    fixtureConfig.static_review = { template_id: 'review-pr/default' };
    fixtureConfig.execution_templates = {
      sources: [{ id: 'workspace:shared', kind: 'workspace', root: { projectPath: 'shared' } }],
      defaults: [
        { when: { flow: 'dev', runMode: 'interactive' }, templateId: 'dev/interactive' },
        { when: { flow: 'dev', runMode: 'autonomous' }, templateId: 'dev/default' },
        {
          when: { flow: 'pr-complete', runMode: 'interactive' },
          templateId: 'pr-complete/default',
        },
      ],
    };
    fixtureConfig.qa.after_review = { enabled: true, profile_id: 'source-smoke' };
    await writeFile(path.join(fixture, 'project.json'), JSON.stringify(fixtureConfig));
    for (const [flow, name] of [
      ['dev', 'interactive'],
      ['dev', 'default'],
      ['pr-complete', 'default'],
      ['review-pr', 'default'],
    ]) {
      await mkdir(path.join(fixture, 'shared', flow), { recursive: true });
      await writeFile(
        path.join(fixture, 'shared', flow, name + '.md'),
        '---\nplatforms: [cli]\n---\n\n- [ ] Complete the assigned proof task.\n',
      );
    }

    const caFile = path.join(root, 'ca.pem');
    const privateKey = path.join(root, 'server.key');
    const tlsConfig = path.join(root, 'openssl.conf');
    await writeFile(
      tlsConfig,
      '[req]\ndistinguished_name=dn\nx509_extensions=proof\nprompt=no\n[dn]\nCN=localhost\n[proof]\nsubjectAltName=IP:127.0.0.1\nbasicConstraints=critical,CA:TRUE\n',
    );
    await execute('openssl', [
      'req',
      '-x509',
      '-nodes',
      '-newkey',
      'rsa:2048',
      '-days',
      '1',
      '-config',
      tlsConfig,
      '-keyout',
      privateKey,
      '-out',
      caFile,
    ]);
    await chmod(privateKey, 0o600);
    const active = new Set<ReturnType<typeof spawn>>();
    const server = createServer(
      { key: await readFile(privateKey), cert: await readFile(caFile) },
      (request, response) => {
        const url = new URL(request.url ?? '/', 'https://127.0.0.1');
        if (!/^\/source-proof\/pack(?:\.git)?\//.test(url.pathname)) {
          response.writeHead(404).end();
          return;
        }
        const gitPath = url.pathname.replace(/^\/source-proof\/pack\//, '/source-proof/pack.git/');
        const child = spawn('git', ['http-backend'], {
          env: {
            ...process.env,
            GIT_PROJECT_ROOT: repositories,
            GIT_HTTP_EXPORT_ALL: '1',
            REQUEST_METHOD: request.method,
            PATH_INFO: gitPath,
            QUERY_STRING: url.search.slice(1),
            CONTENT_TYPE: request.headers['content-type'] ?? '',
            REMOTE_ADDR: '127.0.0.1',
            ...(request.headers['git-protocol']
              ? { HTTP_GIT_PROTOCOL: String(request.headers['git-protocol']) }
              : {}),
          },
          stdio: ['pipe', 'pipe', 'pipe'],
        });
        active.add(child);
        let headers = Buffer.alloc(0);
        let sent = false;
        child.stdout.on('data', (chunk: Buffer) => {
          if (sent) {
            response.write(chunk);
            return;
          }
          headers = Buffer.concat([headers, chunk]);
          const boundary = headers.indexOf('\r\n\r\n');
          if (boundary < 0) return;
          let status = 200;
          const fields: Record<string, string> = {};
          for (const line of headers.subarray(0, boundary).toString().split('\r\n')) {
            const split = line.indexOf(':');
            const name = line.slice(0, split);
            const value = line.slice(split + 1).trim();
            if (name.toLowerCase() === 'status') status = Number(value.split(' ')[0]);
            else fields[name] = value;
          }
          response.writeHead(status, fields);
          sent = true;
          response.write(headers.subarray(boundary + 4));
          headers = Buffer.alloc(0);
        });
        let failure = '';
        child.stderr.on('data', (chunk) => {
          failure += chunk.toString();
        });
        child.on('error', (error) => {
          response.destroy(error);
        });
        child.on('close', (code) => {
          active.delete(child);
          if (code !== 0) response.destroy(new Error(`Proof Git request failed: ${failure}`));
          else response.end();
        });
        request.pipe(child.stdin);
      },
    );
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = (server.address() as { port: number }).port;
    server.on('close', () => {
      for (const child of active) child.kill('SIGTERM');
    });
    const upstream = new ProofSourceUpstream(
      port,
      caFile,
      `https://127.0.0.1:${port}/source-proof/pack`,
      worktree,
      server,
    );
    await execute('git', ['-C', worktree, 'remote', 'add', 'origin', upstream.repository]);
    try {
      await upstream.advance('main', 'main');
      for (const branch of ['experiment/farm', 'experiment/node', 'experiment/run'])
        await upstream.advance(branch, branch);
      await upstream.alias('experiment/same', 'main');
    } catch (error) {
      await upstream.close();
      throw error;
    }
    return upstream;
  }

  async advance(branch: string, marker: string): Promise<string> {
    const refs = (
      await execute('git', [
        '-C',
        this.worktree,
        'for-each-ref',
        '--format=%(refname)',
        'refs/heads',
      ])
    ).stdout.split('\n');
    // git init already selects unborn main; there is no base commit to check out yet.
    if (branch !== 'main' || refs.some(Boolean))
      await execute('git', [
        '-C',
        this.worktree,
        'checkout',
        ...(refs.includes(`refs/heads/${branch}`) ? [branch] : ['-b', branch, 'main']),
      ]);
    await writeFile(path.join(this.worktree, 'source-version.txt'), marker + '\n');
    await execute('git', ['-C', this.worktree, 'add', '.']);
    await execute('git', [
      '-C',
      this.worktree,
      '-c',
      'core.hooksPath=/dev/null',
      'commit',
      '-S',
      '-m',
      'test(sources): publish isolated source proof inputs',
    ]);
    await execute('git', [
      '-C',
      this.worktree,
      '-c',
      `http.sslCAInfo=${this.caFile}`,
      '-c',
      'core.hooksPath=/dev/null',
      'push',
      'origin',
      branch,
    ]);
    return (await execute('git', ['-C', this.worktree, 'rev-parse', 'HEAD'])).stdout.trim();
  }

  async alias(branch: string, ref: string): Promise<void> {
    await execute('git', [
      '-C',
      this.worktree,
      '-c',
      `http.sslCAInfo=${this.caFile}`,
      '-c',
      'core.hooksPath=/dev/null',
      'push',
      'origin',
      `${ref}:refs/heads/${branch}`,
    ]);
  }

  /** Observe a real fetch so permission changes happen after the RPC's initial authorization. */
  onNextRequest(action: () => void): () => void {
    this.server.once('request', action);
    return () => this.server.off('request', action);
  }

  async close(): Promise<void> {
    this.server.closeAllConnections();
    await new Promise<void>((resolve, reject) =>
      this.server.close((error) => (error ? reject(error) : resolve())),
    );
  }
}
