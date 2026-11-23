/**
 * Whether two reads of a nullable slot-row field name the same value. A missing key and null are
 * the same: resets write `null`, a fleet refresh drops some empty keys and fills in others.
 */
export function sameSlotField(a: unknown, b: unknown): boolean {
  return (a ?? null) === (b ?? null);
}
