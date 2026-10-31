/**
 * Text as a fenced Markdown code block that it cannot close early: the fence is longer
 * than any backtick run inside. Line endings become `\n`; trailing newlines are dropped.
 */
export function markdownFence(content: string, info = ''): string {
  let longest = 0;
  for (const run of content.match(/`+/g) ?? []) longest = Math.max(longest, run.length);
  const fence = '`'.repeat(Math.max(3, longest + 1));
  return `${fence}${info}\n${content.replace(/\r\n?/g, '\n').replace(/\n+$/, '')}\n${fence}`;
}
