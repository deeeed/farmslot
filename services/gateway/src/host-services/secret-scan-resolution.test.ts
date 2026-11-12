import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';
import { fileURLToPath } from 'node:url';

const gatewayDir = fileURLToPath(new URL('../..', import.meta.url));
const scratch = mkdtempSync(path.join(tmpdir(), 'secret-scan-resolution-'));
after(() => rmSync(scratch, { recursive: true, force: true }));

// CI and the pinned toolchain have no built handoff. Refuse every module under its dist in the
// gateway process and, through the inherited --import, in the scan process: the scanner must
// resolve there exactly as in the gateway (to source), never to a build.
const registerHooks = `import { registerHooks } from 'node:module';
registerHooks({
  resolve(specifier, context, next) {
    const resolved = next(specifier, context);
    if (resolved.url.includes('/packages/handoff/dist/'))
      throw new Error('built handoff is not available: ' + resolved.url);
    return resolved;
  },
});`;

test('the scan process resolves the scanner as the gateway does, never from a built handoff', async () => {
  const script = path.join(scratch, 'scan.mjs');
  writeFileSync(
    script,
    `const { default: scan } = await import(${JSON.stringify(
      new URL('./secret-scan.ts', import.meta.url).href,
    )});
try {
  const hits = await scan.publication('token ghp_' + 'a'.repeat(36));
  process.stdout.write(JSON.stringify(hits.map((hit) => hit.kind)));
} finally {
  await scan.stop();
}
`,
  );
  const child = spawn(
    process.execPath,
    [
      ...process.execArgv.filter((arg) => !arg.startsWith('--test')),
      '--import',
      `data:text/javascript,${encodeURIComponent(registerHooks)}`,
      script,
    ],
    { cwd: gatewayDir, stdio: ['ignore', 'pipe', 'pipe'] },
  );
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (chunk: Buffer) => (stdout += chunk));
  child.stderr.on('data', (chunk: Buffer) => (stderr += chunk));
  const timer = setTimeout(() => child.kill('SIGKILL'), 60_000);
  const code = await new Promise<number | null>((resolve) => child.on('close', resolve));
  clearTimeout(timer);
  assert.equal(code, 0, stderr);
  assert.deepEqual(JSON.parse(stdout), ['github-token']);
});
