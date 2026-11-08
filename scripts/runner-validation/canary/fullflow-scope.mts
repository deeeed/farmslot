import path from 'node:path';

interface ScopeRoots { slot: string; task?: string; fixture: string; home: string }
interface ToolCall { name?: string; arguments?: Record<string, unknown> }
interface ScopeRecord {
  type?: string; cwd?: string; timestamp?: string; at?: string;
  message?: { content?: Array<ToolCall & { type?: string }> };
  tool?: { name?: string; input?: Record<string, unknown> };
}
interface ScopeFinding { path: string; source: string; at?: string; tool?: string; input: Record<string, unknown> }

/** Audit recorded tool inputs, never runner text or filesystem contents outside the fixture. */
export function fullflowScopeAudit(sources: Array<{ file: string; text: string }>, roots: ScopeRoots) {
  // macOS logs can name the same temporary checkout through either /tmp alias.
  const normalize = (value: string) => path.resolve(value).replace(/^\/private\/tmp(?=\/|$)/, '/tmp');
  const allowed = [roots.slot, roots.task, roots.fixture].filter((value): value is string => Boolean(value)).map(normalize);
  const findings: ScopeFinding[] = [];
  const inspectedSources: string[] = [];
  let toolCalls = 0;
  for (const source of sources) {
    const records: ScopeRecord[] = source.text.split('\n').filter(Boolean).map((line) => JSON.parse(line));
    const session = records.find((record) => record.type === 'session');
    if (session && (!session.cwd || normalize(session.cwd) !== normalize(roots.slot))) continue;
    inspectedSources.push(source.file);
    for (const record of records) {
      const calls = record.tool && record.type === 'tool.started'
        ? [{ name: record.tool.name, arguments: record.tool.input }]
        : Array.isArray(record.message?.content) ? record.message.content.filter((item) => item.type === 'toolCall') : [];
      for (const call of calls) {
        const input = call.arguments ?? {};
        toolCalls++;
        const paths = new Set<string>();
        const command = typeof input.command === 'string' ? input.command : '';
        const cwd = typeof input.cwd === 'string' ? input.cwd : roots.slot;
        for (const key of ['path', 'file_path', 'cwd']) {
          if (typeof input[key] === 'string') paths.add(input[key]);
        }
        // Shell inputs are evidence of a reference, not proof of an actual read or write.
        for (const match of command.matchAll(/(?:^|[\s"'`=<>;(])((?:\/|~\/|\$HOME\/|(?:\.\.\/)+)[^\s"'`<>;|&)\]}]+)/g)) paths.add(match[1]);
        for (const value of paths) {
          // Inline JavaScript regex assertions are code, not absolute filesystem paths.
          if (/^\/.*\/[dgimsuvy]*\.(?:test|exec)\(/.test(value)) continue;
          const expanded = value.replace(/^(?:~|\$HOME)(?=\/)/, roots.home);
          const resolved = normalize(path.resolve(cwd, expanded));
          if (allowed.some((base) => resolved === base || resolved.startsWith(base + '/'))) continue;
          if (findings.some((finding) => finding.path === resolved && finding.source === source.file && finding.at === (record.timestamp ?? record.at))) continue;
          findings.push({ path: resolved, source: source.file, at: record.timestamp ?? record.at, tool: call.name, input });
        }
      }
    }
  }
  return {
    observationOnly: true, allowedRoots: allowed, sources: inspectedSources, toolCalls, findings,
    limits: 'Recorded tool path arguments and literal shell path references only. References can include failed probes or payload literals; computed paths, subprocess accesses and unlogged activity may be absent. No syscall tracing or sandboxing.',
  };
}
