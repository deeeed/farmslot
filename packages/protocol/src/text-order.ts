/**
 * `left.localeCompare(right)` through one shared collator. Hermes on Android builds a collator
 * for every `localeCompare` call (about 50 µs on a Pixel 6), so sorting with it blocks the JS
 * thread; the shared one orders the same way at a fraction of the cost.
 */
export const compareText: (left: string, right: string) => number = new Intl.Collator().compare;
