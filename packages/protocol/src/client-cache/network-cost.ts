function connectionInformation(): unknown {
  const navigator = Reflect.get(globalThis, 'navigator');
  return navigator && typeof navigator === 'object'
    ? Reflect.get(navigator, 'connection')
    : undefined;
}

/** A missing network-cost API is unknown, not an assertion that a connection is free. */
export function networkCostHint(value: unknown = connectionInformation()): boolean | undefined {
  if (!value || typeof value !== 'object') return undefined;
  if (Reflect.get(value, 'saveData') === true) return true;
  const type = Reflect.get(value, 'type');
  if (type === 'cellular') return true;
  if (type === 'wifi' || type === 'ethernet') return false;
  return undefined;
}

export function networkInformationEvents(): EventTarget | undefined {
  const value = connectionInformation();
  return typeof EventTarget !== 'undefined' && value instanceof EventTarget ? value : undefined;
}
