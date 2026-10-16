// Disposable proof provider: a headless canvas whose stills and video are rendered from app state.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { deflateSync } from 'node:zlib';

const COLORS = {
  red: [220, 30, 30],
  green: [20, 160, 60],
  blue: [30, 90, 220],
  white: [255, 255, 255],
};

const hex = (value) =>
  typeof value === 'string' && /^#[0-9a-f]{6}$/iu.test(value)
    ? [1, 3, 5].map((index) => parseInt(value.slice(index, index + 2), 16))
    : undefined;

/** A header band and a centered square, painted through the app theme like the real app. */
function render(state, theme) {
  const paint = (name) => hex(theme[name]) ?? COLORS[name] ?? COLORS.white;
  const width = 160;
  const height = 120;
  const crc = (bytes) => {
    let value = 0xffffffff;
    for (const byte of bytes) {
      value ^= byte;
      for (let bit = 0; bit < 8; bit++) value = (value >>> 1) ^ (value & 1 ? 0xedb88320 : 0);
    }
    return (value ^ 0xffffffff) >>> 0;
  };
  const chunk = (type, data) => {
    const length = Buffer.alloc(4);
    length.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type), data]);
    const sum = Buffer.alloc(4);
    sum.writeUInt32BE(crc(body));
    return Buffer.concat([length, body, sum]);
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = 2;
  const rows = Buffer.alloc(height * (width * 3 + 1));
  for (let y = 0; y < height; y++) {
    const row = y * (width * 3 + 1);
    rows[row] = 0;
    for (let x = 0; x < width; x++) {
      const color =
        y < 24
          ? paint(state.header)
          : x >= 50 && x < 110 && y >= 40 && y < 100
            ? paint(state.square)
            : COLORS.white;
      rows.set(color, row + 1 + x * 3);
    }
  }
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(rows)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

export function createProvider(context) {
  const target = context.target.value;
  const read = () => JSON.parse(fs.readFileSync(path.join(target, 'app/state.json'), 'utf8'));
  const theme = () => {
    const file = path.join(target, 'app/theme.json');
    return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : {};
  };
  return {
    // The proof task has no provider step gates; checklist marks need no extra evidence.
    commandOptions: { task: { stepGates: [] } },
    runtime: {
      id: 'proof-canvas',
      sdkVersion: 1,
      headless: true,
      runtimeStatus: async () => ({ decision: 'ready', reasons: [] }),
      resolveSlotPorts() {},
      logSources: () => [],
      appLogSource: () => null,
      devServer: { label: 'none', describe: () => 'none', stop: () => ({ kind: 'none' }) },
      hints: { launch: 'unused', relaunch: 'unused', runtimeProbeRecovery: () => '' },
      harness: {
        install: { entry: 'i', fallback: 'i' },
        cleanup: { entry: 'c', fallback: 'c' },
        verify: () => ({ error: 'none' }),
      },
      runtimeContext: { forbiddenFields: [] },
      launch: async () => 0,
      actions: {
        manifestPath: () => new URL('./manifest.json', import.meta.url).pathname,
        semantic: [],
        cdpTarget: { transport: 'none' },
        async adapters() {
          return [
            {
              action: 'ui.press',
              async execute(node) {
                return { output: { pressed: node.target } };
              },
            },
            {
              action: 'ui.wait_for',
              async execute(node) {
                const value = read()[node.selector];
                if (value === undefined || (node.text !== 'visible' && value !== node.text))
                  throw new Error(`${node.selector} shows ${value}`);
                return { output: { selector: node.selector, value } };
              },
            },
          ];
        },
      },
      recording: {
        async target() {
          return { kind: 'pid', pid: process.pid };
        },
        async videoRecorder() {
          return {
            name: 'proof-canvas',
            async start(request) {
              const zero = Date.now();
              return {
                async stop() {
                  const frame = `${request.outputPath}.png`;
                  fs.writeFileSync(frame, render(read(), theme()));
                  const durationMs = Math.max(1000, Date.now() - zero + 500);
                  execFileSync('ffmpeg', [
                    '-loglevel',
                    'error',
                    '-y',
                    '-loop',
                    '1',
                    '-i',
                    frame,
                    '-t',
                    String(durationMs / 1000),
                    '-r',
                    '5',
                    '-pix_fmt',
                    'yuv420p',
                    request.outputPath,
                  ]);
                  fs.rmSync(frame);
                  const framesMs = [];
                  for (let time = 0; time < durationMs; time += 200) framesMs.push(time);
                  return {
                    segments: [
                      {
                        path: path.basename(request.outputPath),
                        timing: {
                          framesMs,
                          durationMs,
                          clock: {
                            source: 'proof-canvas',
                            earliestZeroUnixMs: zero,
                            latestZeroUnixMs: zero,
                          },
                        },
                      },
                    ],
                  };
                },
              };
            },
          };
        },
      },
    },
  };
}
