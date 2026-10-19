import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { parentPort } from 'node:worker_threads';

import encode, { init } from '@jsquash/webp/encode.js';
import { PNG } from 'pngjs';

/** Evidence stills are lossy WebP at this quality (ADR-062 Amendment 17). */
const QUALITY = 85;

const require = createRequire(import.meta.url);
const ready = init({
  wasmBinary: readFileSync(require.resolve('@jsquash/webp/codec/enc/webp_enc_simd.wasm')),
});

parentPort?.on('message', ({ id, png }: { id: number; png: Uint8Array }) => {
  void ready
    .then(async () => {
      const image = PNG.sync.read(Buffer.from(png));
      const pixels = new Uint8ClampedArray(
        image.data.buffer,
        image.data.byteOffset,
        image.data.length,
      );
      const webp = new Uint8Array(
        await encode(
          { data: pixels, width: image.width, height: image.height },
          { quality: QUALITY },
        ),
      );
      parentPort?.postMessage({ id, webp }, [webp.buffer]);
    })
    .catch((error: unknown) =>
      parentPort?.postMessage({
        id,
        error: error instanceof Error ? error.message : String(error),
      }),
    );
});
