/** Insert external text without interpreting JavaScript replacement patterns. */
export function literalReplacement(value) {
  return () => value;
}
