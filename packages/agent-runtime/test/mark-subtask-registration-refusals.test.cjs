const {
  makeTask,
  mark,
  assert,
  existsSync,
  path,
  writeFileSync,
  readFileSync,
  index,
} = require('./mark-subtask.test-support.cjs');

// ---------------------------------------------------------------------------
// 3. Registration refusals that never write a unit.
{
  const dir = makeTask({
    checklist: ['# Worker: dev', '', '- [x] **1. Already done**', '- [ ] **2. Open**', ''].join(
      '\n',
    ),
  });
  const cases = [
    {
      args: ['sub', 'start', 'on-checked', '--step', '1', '--from', 'skill.md'],
      code: 1,
      match: /step 1 is already checked/,
    },
    {
      args: ['sub', 'start', 'no-steps', '--step', '2', '--from', 'inline:# nothing here'],
      code: 1,
      match: /a child unit must have at least one step/,
    },
    {
      args: [
        'sub',
        'start',
        'skewed',
        '--step',
        '2',
        '--from',
        'inline:- [ ] **1. one**\n- [ ] **1a. inserted**\n',
      ],
      code: 1,
      match: /position 2 is labeled "1a"/,
    },
    {
      args: ['sub', 'start', 'Bad_Id', '--step', '2', '--from', 'inline:- [ ] one'],
      code: 1,
      match: /invalid subtask id 'Bad_Id'/,
    },
    {
      args: ['sub', 'start', 'catalog', '--step', '2', '--from', 'template:dev/autonomous'],
      code: 1,
      match: /--from template:dev\/autonomous is not supported by mark/,
    },
    {
      args: ['sub', 'start', 'missing-source', '--step', '2', '--from', 'no/such/file.md'],
      code: 1,
      match: /--from source not found/,
    },
    {
      args: ['sub', 'start', 'no-step-flag', '--from', 'skill.md'],
      code: 2,
      match: /sub start requires --step N/,
    },
    {
      args: ['sub', 'start', 'no-source', '--step', '2'],
      code: 2,
      match: /sub start requires --from/,
    },
    {
      args: ['sub', 'start', 'out-of-range', '--step', '9', '--from', 'skill.md'],
      code: 1,
      match: /checklist step 9 not found in CHECKLIST\.md/,
    },
    {
      args: ['sub', 'unknown-id', 'status'],
      code: 1,
      match: /unknown subtask unknown-id/,
    },
  ];
  for (const { args, code, match } of cases) {
    const result = mark(dir, ...args);
    assert.equal(result.status, code, `${args.join(' ')} → ${result.stderr}${result.stdout}`);
    assert.match(result.stderr, match);
  }
  assert.ok(
    !existsSync(path.join(dir, 'subtasks')),
    'a refused registration writes nothing under subtasks/',
  );

  // An unknown placeholder is a refusal, never a rendered {{TOKEN}}.
  writeFileSync(path.join(dir, 'bad.md'), '- [ ] Read {{NOPE}}\n');
  const refused = mark(dir, 'sub', 'start', 'bad-vars', '--step', '2', '--from', 'bad.md');
  assert.equal(refused.status, 1);
  assert.match(refused.stderr, /placeholder\(s\) with no expansion value: \{\{NOPE\}\}/);
  // …and --var supplies it.
  const ok = mark(
    dir,
    'sub',
    'start',
    'bad-vars',
    '--step',
    '2',
    '--from',
    'bad.md',
    '--var',
    'NOPE=the docs',
  );
  assert.equal(ok.status, 0, ok.stderr);
  assert.equal(
    readFileSync(path.join(dir, 'subtasks', 'bad-vars.md'), 'utf8'),
    '- [ ] Read the docs\n',
  );
  assert.equal(index(dir).units[0].source.kind, 'skill');
}
