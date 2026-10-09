/** Quote a value as one POSIX shell word, so it survives spaces and apostrophes. */
export function shSingleQuote(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}
