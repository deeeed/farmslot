const COMMON_IMPORT_SUFFIXES = [
  '.ts',
  '.tsx',
  '.js',
  '.jsx',
  '.json',
  '/index.ts',
  '/index.tsx',
  '/index.js',
] as const;

export function resolveSlotViewOpenFilePath(
  fileIndex: readonly string[],
  requestedPath: string,
): string {
  if (fileIndex.length === 0 || fileIndex.includes(requestedPath)) return requestedPath;

  const exactSuffix = fileIndex.find(
    (file) => file === requestedPath || file.endsWith(`/${requestedPath}`),
  );
  if (exactSuffix) return exactSuffix;

  for (const ext of COMMON_IMPORT_SUFFIXES) {
    const match = fileIndex.find((file) => file === requestedPath + ext);
    if (match) return match;
  }

  const fuzzySuffix = fileIndex.find(
    (file) =>
      file.endsWith(requestedPath) ||
      file.endsWith(`${requestedPath}.ts`) ||
      file.endsWith(`${requestedPath}.tsx`),
  );
  return fuzzySuffix ?? requestedPath;
}
