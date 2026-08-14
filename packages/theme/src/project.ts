export const PROJECT_COLORS = [
  '#60a5fa',
  '#a78bfa',
  '#f472b6',
  '#f59e0b',
  '#34d399',
  '#22d3ee',
] as const;

export function projectColor(project: string): string {
  const hash = [...project].reduce(
    (value, character) => (value * 31 + character.charCodeAt(0)) >>> 0,
    0,
  );
  return PROJECT_COLORS[hash % PROJECT_COLORS.length] ?? PROJECT_COLORS[0];
}
