// Disposable proof provider: a headless canvas whose stills and video are rendered from app state,
// with the recipe HUD drawn into every frame.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { deflateSync } from 'node:zlib';

const COLORS = {
  red: [220, 30, 30],
  green: [20, 160, 60],
  blue: [30, 90, 220],
  white: [255, 255, 255],
  hud: [32, 32, 32],
};
const WIDTH = 480;
const HEIGHT = 270;
const HUD_TOP = 196;
const FRAME_MS = 200;
const SCALE = 2;
const LINE_CHARS = Math.floor((WIDTH - 16) / (6 * SCALE));

// 5x7 glyphs, one hex byte per row (bit 4 is the leftmost pixel).
const GLYPHS = {
  A: '0e11111f111111',
  B: '1e11111e11111e',
  C: '0e11101010110e',
  D: '1e11111111111e',
  E: '1f10101e10101f',
  F: '1f10101e101010',
  G: '0e111017111f0f',
  H: '1111111f111111',
  I: '0e04040404040e',
  J: '0702020202120c',
  K: '11121418141211',
  L: '1010101010101f',
  M: '111b1515111111',
  N: '11111915131111',
  O: '0e11111111110e',
  P: '1e11111e101010',
  Q: '0e11111115120d',
  R: '1e11111e141211',
  S: '0f10100e01011e',
  T: '1f040404040404',
  U: '1111111111110e',
  V: '11111111110a04',
  W: '1111111515150a',
  X: '11110a040a1111',
  Y: '1111110a040404',
  Z: '1f01020408101f',
  0: '0e11131519110e',
  1: '040c040404040e',
  2: '0e11010204081f',
  3: '1f02040201110e',
  4: '02060a121f0202',
  5: '1f101e0101110e',
  6: '0608101e11110e',
  7: '1f010204080808',
  8: '0e11110e11110e',
  9: '0e11110f01020c',
  ' ': '00000000000000',
  '.': '00000000000c0c',
  ',': '000000000c0408',
  '-': '0000001f000000',
  ':': '000c0c000c0c00',
  "'": '0c040800000000',
  '(': '02040808080402',
  ')': '08040202020408',
  '/': '00010204081000',
  '#': '0a0a1f0a1f0a0a',
  '?': '0e110102040004',
  '!': '04040404040004',
};

const hex = (value) =>
  typeof value === 'string' && /^#[0-9a-f]{6}$/iu.test(value)
    ? [1, 3, 5].map((index) => parseInt(value.slice(index, index + 2), 16))
    : undefined;

/** Word-wrap the step intent into the HUD band. */
function hudLines(text) {
  const lines = [];
  let line = '';
  for (const word of text.toUpperCase().split(/\s+/u).filter(Boolean)) {
    const next = line ? `${line} ${word}` : word;
    if (next.length <= LINE_CHARS) line = next;
    else {
      if (line) lines.push(line);
      line = word.slice(0, LINE_CHARS);
    }
  }
  if (line) lines.push(line);
  return lines.slice(0, 3);
}

function png(pixels) {
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
  header.writeUInt32BE(WIDTH, 0);
  header.writeUInt32BE(HEIGHT, 4);
  header[8] = 8;
  header[9] = 2;
  const rows = Buffer.alloc(HEIGHT * (WIDTH * 3 + 1));
  for (let y = 0; y < HEIGHT; y++)
    pixels.copy(rows, y * (WIDTH * 3 + 1) + 1, y * WIDTH * 3, (y + 1) * WIDTH * 3);
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(rows)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/** A header band and a centered square painted through the app theme, under the step's HUD intent. */
function render(state, theme, intent) {
  const paint = (name) => hex(theme[name]) ?? COLORS[name] ?? COLORS.white;
  const pixels = Buffer.alloc(WIDTH * HEIGHT * 3);
  const set = (x, y, color) => pixels.set(color, (y * WIDTH + x) * 3);
  for (let y = 0; y < HEIGHT; y++)
    for (let x = 0; x < WIDTH; x++)
      set(
        x,
        y,
        y >= HUD_TOP
          ? COLORS.hud
          : y < 36
            ? paint(state.header)
            : x >= 200 && x < 280 && y >= 70 && y < 150
              ? paint(state.square)
              : COLORS.white,
      );
  hudLines(intent).forEach((line, row) => {
    [...line].forEach((char, column) => {
      const glyph = GLYPHS[char] ?? GLYPHS['?'];
      for (let gy = 0; gy < 7; gy++) {
        const bits = parseInt(glyph.slice(gy * 2, gy * 2 + 2), 16);
        for (let gx = 0; gx < 5; gx++)
          if (bits & (0x10 >> gx))
            for (let sy = 0; sy < SCALE; sy++)
              for (let sx = 0; sx < SCALE; sx++)
                set(
                  8 + column * 6 * SCALE + gx * SCALE + sx,
                  HUD_TOP + 8 + row * 9 * SCALE + gy * SCALE + sy,
                  COLORS.white,
                );
      }
    });
  });
  return png(pixels);
}

export function createProvider(context) {
  const target = context.target.value;
  const read = () => JSON.parse(fs.readFileSync(path.join(target, 'app/state.json'), 'utf8'));
  const theme = () => {
    const file = path.join(target, 'app/theme.json');
    return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : {};
  };
  // Each HUD update the runner publishes, so every recorded frame shows its step's intent.
  const hud = [];
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
              action: 'app.hud',
              async execute(node) {
                const text = node.clear ? '' : String(node.intent ?? node.text ?? '');
                hud.push({ at: Date.now(), text });
                return { output: { shown: text } };
              },
            },
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
                  const durationMs = Math.max(1000, Date.now() - zero + 500);
                  const frames = `${request.outputPath}.frames`;
                  fs.mkdirSync(frames, { recursive: true });
                  const state = read();
                  const colors = theme();
                  const framesMs = [];
                  for (let time = 0; time < durationMs; time += FRAME_MS) {
                    const shown = hud.filter((entry) => entry.at - zero <= time).at(-1);
                    const name = String(framesMs.length).padStart(4, '0');
                    fs.writeFileSync(
                      path.join(frames, `${name}.png`),
                      render(state, colors, shown?.text ?? ''),
                    );
                    framesMs.push(time);
                  }
                  execFileSync('ffmpeg', [
                    '-loglevel',
                    'error',
                    '-y',
                    '-framerate',
                    String(1000 / FRAME_MS),
                    '-i',
                    path.join(frames, '%04d.png'),
                    '-pix_fmt',
                    'yuv420p',
                    request.outputPath,
                  ]);
                  fs.rmSync(frames, { recursive: true, force: true });
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
