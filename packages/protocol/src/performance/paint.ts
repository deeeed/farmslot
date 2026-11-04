interface PaintHost {
  requestAnimationFrame?: (callback: () => void) => number;
  cancelAnimationFrame?: (handle: number) => void;
  document?: { visibilityState: string };
}
/** Two frames allow the subscriber's queued render and its first data paint. */
export function afterForegroundPaint(callback: () => void): (() => void) | undefined {
  const host = globalThis as PaintHost;
  if (
    !host.requestAnimationFrame ||
    !host.cancelAnimationFrame ||
    (host.document && host.document.visibilityState !== 'visible')
  )
    return undefined;
  const frame = host.requestAnimationFrame.bind(host),
    cancel = host.cancelAnimationFrame.bind(host);
  let handle = frame(() => {
    handle = frame(callback);
  });
  return () => cancel(handle);
}
