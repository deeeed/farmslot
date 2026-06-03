const FRAMES = [
  '\u28CB',
  '\u28D9',
  '\u28F9',
  '\u28F8',
  '\u28FC',
  '\u28F4',
  '\u28E6',
  '\u28E7',
  '\u28C7',
  '\u28CF',
];

export async function withProgress<T>(
  label: string,
  work: () => Promise<T>,
  enabled = true,
): Promise<T> {
  if (!enabled || !(process.stderr.isTTY ?? false)) return work();

  let i = 0;
  const timer = setInterval(() => {
    process.stderr.write(`\r${FRAMES[i++ % FRAMES.length]} ${label}`);
  }, 80);

  try {
    return await work();
  } finally {
    clearInterval(timer);
    process.stderr.write('\r\x1b[K');
  }
}
