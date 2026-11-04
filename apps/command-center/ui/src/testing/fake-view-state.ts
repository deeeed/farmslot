/** A URL/history boundary for renderer tests that use configured display choices. */
export function installFakeViewState(hash = '#runs'): () => void {
  const original = new Map(
    ['location', 'history'].map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]),
  );
  const location = { hash };
  const write = (_data: unknown, _title: string, url: string) => {
    location.hash = url;
  };
  Object.defineProperty(globalThis, 'location', { configurable: true, value: location });
  Object.defineProperty(globalThis, 'history', {
    configurable: true,
    value: { pushState: write, replaceState: write },
  });
  return () => {
    for (const [key, descriptor] of original) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  };
}
