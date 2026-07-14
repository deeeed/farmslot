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

/**
 * Spinner for streaming operations: shows `label` immediately, then hands the
 * caller an `onData` sink. The spinner is cleared the instant the first byte of
 * stream output arrives, after which output flows straight to stderr — closing
 * the silent gap between invocation and the first `script.output` line. When
 * disabled or stderr is not a TTY, output streams without a spinner.
 */
export async function withStreamProgress<T>(
  label: string,
  run: (onData: (data: string) => void) => Promise<T>,
  enabled = true,
): Promise<T> {
  if (!enabled || !(process.stderr.isTTY ?? false)) {
    return run((data) => process.stderr.write(data));
  }

  let i = 0;
  let cleared = false;
  const timer = setInterval(() => {
    if (!cleared) process.stderr.write(`\r${FRAMES[i++ % FRAMES.length]} ${label}`);
  }, 80);
  const stop = () => {
    if (cleared) return;
    cleared = true;
    clearInterval(timer);
    process.stderr.write('\r\x1b[K');
  };

  try {
    return await run((data) => {
      stop();
      process.stderr.write(data);
    });
  } finally {
    stop();
  }
}
