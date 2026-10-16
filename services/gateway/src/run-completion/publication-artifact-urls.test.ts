import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

await import('../runtime/mock-pty.test-support.js');
const { uploadedArtifactUrl, assertUploadedArtifactUrlsReachable } =
  await import('./publication-artifacts.js');

test('uploaded URLs and HEAD verification preserve literal percent escapes and special filename characters', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'publication-artifact-urls-'));
  const files = [
    'stills/ac7-place%2Ffresh_page%2Fchart-1.png',
    'stills/ac7 place%2F图表 #2?.png',
    'stills/plain.png',
  ];
  await mkdir(path.join(root, 'stills'));
  for (const file of files) await writeFile(path.join(root, file), 'PNG fixture');
  const requests: string[] = [];
  const server = createServer(async (req, res) => {
    requests.push(req.url ?? '');
    const url = new URL(req.url ?? '/', 'http://localhost');
    const file = decodeURIComponent(url.pathname).slice(1);
    if (!files.includes(file)) {
      res.writeHead(404).end();
      return;
    }
    const bytes = await readFile(path.join(root, file));
    res.writeHead(200, { 'Content-Length': bytes.length }).end();
  });
  t.after(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(root, { recursive: true, force: true });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  const base = `http://127.0.0.1:${address.port}`;
  const urls = new Map(files.map((file) => [file, uploadedArtifactUrl(base, file, 'abc123')]));
  for (const [file, url] of urls) {
    assert.equal(decodeURIComponent(new URL(url).pathname), `/${file}`);
    assert.equal(new URL(url).searchParams.get('sha'), 'abc123');
  }
  await assertUploadedArtifactUrlsReachable(urls, { failOnError: true });
  assert.ok(
    requests.every((url) => !url.includes('?')),
    'Verification omits only the digest query',
  );
  assert.ok(requests[0].includes('%252F'), 'A literal percent escape is encoded, not decoded');
  await assert.rejects(
    assertUploadedArtifactUrlsReachable(new Map([[files[0], `${base}/${files[0]}`]]), {
      failOnError: true,
    }),
    /404/,
  );
});
