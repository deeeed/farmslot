import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { REVIEW_SKILL_INSTALL_SCRIPT } from './skill-install.js';

test('fresh review skills are discoverable, verified, and cleaned without discarding user changes', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'review-skill-install-'));
  const checkout = path.join(root, 'source'),
    source = path.join(root, 'frozen');
  mkdirSync(checkout);
  mkdirSync(source);
  writeFileSync(path.join(source, 'skill.md'), '# Frozen review');
  const input = {
    checkout,
    skills: [{ name: 'review-skill', path: path.join(source, 'skill.md') }],
  };
  const run = (extra = {}) =>
    execFileSync(
      process.execPath,
      ['-e', REVIEW_SKILL_INSTALL_SCRIPT, JSON.stringify({ ...input, ...extra })],
      { stdio: 'pipe' },
    );
  try {
    run();
    run({ verifyOnly: true });
    for (const surface of ['.agents', '.cursor', '.claude'])
      assert.equal(
        readFileSync(path.join(checkout, surface, 'skills/review-skill/SKILL.md'), 'utf8'),
        '# Frozen review',
      );
    const unexpected = path.join(checkout, '.agents/skills/review-skill/user-note');
    writeFileSync(unexpected, 'keep');
    assert.throws(() => run({ action: 'cleanup' }), /Review skill changed/);
    assert.equal(readFileSync(unexpected, 'utf8'), 'keep');
    unlinkSync(unexpected);
    run({ action: 'cleanup' });
    run({ action: 'cleanup' });
    for (const surface of ['.agents', '.cursor', '.claude'])
      assert.equal(existsSync(path.join(checkout, surface)), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('a skill review links its writable round folders into the read-only checkout and unlinks them on cleanup', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'review-skill-install-'));
  const checkout = path.join(root, 'source'),
    source = path.join(root, 'skill-sources/mms-perps-review-pr'),
    reviewTasks = path.join(root, 'review-tasks');
  mkdirSync(checkout);
  execFileSync('git', ['init', '-q', checkout]);
  mkdirSync(path.join(source, 'tools'), { recursive: true });
  // The repository installer, reduced to what the gateway verifies it wrote.
  writeFileSync(
    path.join(source, 'tools/install'),
    [
      'target=""; while [ $# -gt 0 ]; do [ "$1" = --target ] && target="$2"; shift; done',
      'workspace=$(dirname "$target")',
      'test "$target" != "$workspace/source" || exit 41',
      'test ! -e "$workspace/.installed-review-skill-mms-perps-review-pr.json" || exit 42',
      'test ! -e "$workspace/source/.agents/skills/mms-perps-review-pr" || exit 43',
      'test ! -e "$workspace/source/temp/tasks" || exit 44',
      'if [ -f "$workspace/fail-installer" ]; then echo partial > "$target/partial"; echo private-install-failed >&2; exit 7; fi',
      'for dir in .agents/skills .claude/skills .cursor/rules; do mkdir -p "$target/$dir/mms-perps-review-pr/scripts"; done',
      'echo "# Installed" > "$target/.agents/skills/mms-perps-review-pr/SKILL.md"',
      'echo "" > "$target/.agents/skills/mms-perps-review-pr/scripts/review-task.mjs"',
      'echo "# Installed" > "$target/.claude/skills/mms-perps-review-pr/SKILL.md"',
      'echo "# Installed" > "$target/.cursor/rules/mms-perps-review-pr/RULE.md"',
    ].join('\n'),
  );
  chmodSync(path.join(source, 'tools/install'), 0o755);
  const input = {
    checkout,
    reviewTasks,
    skills: [
      {
        name: 'mms-perps-review-pr',
        path: path.join(source, 'domains/perps/skills/perps-review-pr/skill.md'),
        install: {
          repo: 'core',
          source,
          include: 'perps/perps-review-pr',
          installedName: 'mms-perps-review-pr',
        },
      },
    ],
  };
  const run = (extra = {}, preload?: string) =>
    execFileSync(
      process.execPath,
      [
        ...(preload ? ['--require', preload] : []),
        '-e',
        REVIEW_SKILL_INSTALL_SCRIPT,
        JSON.stringify({ ...input, ...extra }),
      ],
      { stdio: 'pipe' },
    );
  try {
    assert.throws(() => run({ reviewTasks: path.join(root, 'elsewhere') }), /review task root/);
    const outside = path.join(root, 'outside');
    const cursor = path.join(checkout, '.cursor');
    mkdirSync(outside);
    symlinkSync(outside, cursor);
    assert.throws(() => run(), /destination is not an owned directory/);
    assert.equal(existsSync(path.join(outside, 'rules')), false);
    unlinkSync(cursor);
    const installerFailure = path.join(root, 'fail-installer');
    writeFileSync(installerFailure, '');
    assert.throws(() => run(), /private-install-failed/);
    assert.equal(
      readdirSync(root).some((name) => name.startsWith('.review-skills-')),
      false,
    );
    assert.equal(existsSync(path.join(checkout, '.agents')), false);
    assert.equal(
      existsSync(path.join(root, '.installed-review-skill-mms-perps-review-pr.json')),
      false,
    );
    unlinkSync(installerFailure);
    const failPublish = path.join(root, 'fail-publish.cjs');
    writeFileSync(
      failPublish,
      `const cp = require('node:child_process');
      const spawn = cp.spawnSync;
      cp.spawnSync = (program, args, options) => {
        if (program === 'python3') {
          args = [...args];
          args[2] = args[2].replace("    os.link('.receipt.json',", "    raise OSError('Receipt publication refused by fixture')\\n    os.link('.receipt.json',");
        }
        return spawn(program, args, options);
      };`,
    );
    assert.throws(() => run({}, failPublish), /Receipt publication refused by fixture/);
    for (const surface of ['.agents', '.claude', '.cursor'])
      assert.equal(existsSync(path.join(checkout, surface)), false);
    assert.equal(
      existsSync(path.join(root, '.installed-review-skill-mms-perps-review-pr.json')),
      false,
    );
    const existing = path.join(checkout, '.agents/skills/mms-perps-review-pr');
    mkdirSync(existing, { recursive: true });
    writeFileSync(path.join(existing, 'original.txt'), 'preserve this file');
    assert.throws(() => run(), /destination already exists without an owner/);
    run({ action: 'cleanup' });
    assert.equal(readFileSync(path.join(existing, 'original.txt'), 'utf8'), 'preserve this file');
    rmSync(existing, { recursive: true });
    const temp = path.join(checkout, 'temp');
    const taskConflict = path.join(temp, 'tasks');
    mkdirSync(taskConflict, { recursive: true });
    writeFileSync(path.join(taskConflict, 'owner.txt'), 'foreign task');
    const assertNoOwnedSkillLinks = () => {
      for (const surface of ['.agents', '.claude', '.cursor'])
        assert.equal(existsSync(path.join(checkout, surface)), false);
      assert.equal(
        existsSync(path.join(root, '.installed-review-skill-mms-perps-review-pr.json')),
        false,
      );
    };
    assert.throws(() => run(), /destination already exists without an owner/);
    run({ action: 'cleanup' });
    assertNoOwnedSkillLinks();
    assert.equal(readFileSync(path.join(taskConflict, 'owner.txt'), 'utf8'), 'foreign task');
    rmSync(taskConflict, { recursive: true });

    const publicationRace = path.join(root, 'publication-race.cjs');
    writeFileSync(
      publicationRace,
      `const fs = require('node:fs'), cp = require('node:child_process'), path = require('node:path');
      const spawn = cp.spawnSync;
      cp.spawnSync = (program, args, options) => {
        if (program === 'python3') {
          const destination = path.join(args[4], 'temp', 'tasks');
          fs.mkdirSync(destination);
          fs.writeFileSync(path.join(destination, 'owner.txt'), 'foreign task');
        }
        return spawn(program, args, options);
      };`,
    );
    assert.throws(() => run({}, publicationRace), /EEXIST/);
    assert.equal(readFileSync(path.join(taskConflict, 'owner.txt'), 'utf8'), 'foreign task');
    assertNoOwnedSkillLinks();
    assert.equal(
      readdirSync(root).some((name) => name.startsWith('.review-skills-')),
      false,
    );
    assert.equal(
      existsSync(path.join(root, '.installed-review-skill-mms-perps-review-pr.json')),
      false,
    );
    rmSync(taskConflict, { recursive: true });
    const displacement = [
      "os.rename('temp', 'displaced-temp', src_dir_fd=checkout, dst_dir_fd=checkout)",
      "os.mkdir('temp', dir_fd=checkout)",
      "os.mkdir('temp/tasks', dir_fd=checkout)",
      "with open(os.path.join(sys.argv[2], 'temp/tasks/owner.txt'), 'w') as sentinel:",
      "    sentinel.write('replacement parent')",
    ];
    const moveNeedle = "        move(source, entry['name'], parent, parts[-1])";
    const receiptNeedle = "    os.link('.receipt.json',";
    const swaps = [
      {
        needle: moveNeedle,
        source: [
          "        if entry['relative'] == 'temp/tasks':",
          ...displacement.map((line) => '            ' + line),
          moveNeedle,
        ].join('\n'),
      },
      {
        needle: receiptNeedle,
        source: [...displacement.map((line) => '    ' + line), receiptNeedle].join('\n'),
      },
    ];
    const displaced = path.join(checkout, 'displaced-temp');
    for (const { needle, source } of swaps) {
      mkdirSync(temp, { recursive: true });
      writeFileSync(path.join(temp, 'original.txt'), 'original parent');
      const parentSwap = path.join(root, 'parent-swap.cjs');
      writeFileSync(
        parentSwap,
        `const cp = require('node:child_process');
        const spawn = cp.spawnSync;
        cp.spawnSync = (program, args, options) => {
          if (program === 'python3') {
            args = [...args];
            args[2] = args[2].replace(${JSON.stringify(needle)}, ${JSON.stringify(source)});
          }
          return spawn(program, args, options);
        };`,
      );
      assert.throws(() => run({}, parentSwap), /publication parent changed: temp\/tasks/);
      assertNoOwnedSkillLinks();
      assert.equal(
        readFileSync(path.join(taskConflict, 'owner.txt'), 'utf8'),
        'replacement parent',
      );
      assert.equal(readFileSync(path.join(displaced, 'original.txt'), 'utf8'), 'original parent');
      assert.equal(existsSync(path.join(displaced, 'tasks')), false);
      assert.equal(
        readdirSync(root).some((name) => name.startsWith('.review-skills-')),
        false,
      );
      rmSync(displaced, { recursive: true });
      rmSync(temp, { recursive: true });
    }

    const receiptSwap = path.join(root, 'receipt-swap.cjs');
    const receiptSwapSource = [
      '    receipt_published = True',
      "    os.rename(receipt, 'original-receipt', src_dir_fd=workspace, dst_dir_fd=workspace)",
      '    fd = os.open(receipt, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600, dir_fd=workspace)',
      "    os.write(fd, b'foreign receipt')",
      '    os.close(fd)',
    ].join('\n');
    writeFileSync(
      receiptSwap,
      `const cp = require('node:child_process');
      const spawn = cp.spawnSync;
      cp.spawnSync = (program, args, options) => {
        if (program === 'python3') {
          args = [...args];
          args[2] = args[2].replace('    receipt_published = True', ${JSON.stringify(receiptSwapSource)});
        }
        return spawn(program, args, options);
      };`,
    );
    assert.throws(() => run({}, receiptSwap), /publication receipt identity changed/);
    const marker = path.join(root, '.installed-review-skill-mms-perps-review-pr.json');
    assert.equal(readFileSync(marker, 'utf8'), 'foreign receipt');
    unlinkSync(marker);
    assertNoOwnedSkillLinks();
    assert.equal(existsSync(path.join(temp, 'tasks')), false);
    assert.equal(
      readdirSync(root).some((name) => name.startsWith('.review-skills-')),
      false,
    );
    unlinkSync(path.join(root, 'original-receipt'));

    const missingPublisher = path.join(root, 'missing-publisher.cjs');
    writeFileSync(
      missingPublisher,
      `const cp = require('node:child_process');
      const spawn = cp.spawnSync;
      cp.spawnSync = (program, args, options) => program === 'python3'
        ? { status: null, error: new Error('spawnSync python3 ENOENT') }
        : spawn(program, args, options);`,
    );
    assert.throws(() => run({}, missingPublisher), /python3 ENOENT/);
    assertNoOwnedSkillLinks();
    assert.equal(existsSync(path.join(temp, 'tasks')), false);
    assert.equal(
      readdirSync(root).some((name) => name.startsWith('.review-skills-')),
      false,
    );

    const failIdentity = path.join(root, 'fail-identity.cjs');
    writeFileSync(
      failIdentity,
      `const fs = require('node:fs'), path = require('node:path');
      const lstat = fs.lstatSync;
      fs.lstatSync = (file, options) => {
        if (path.basename(file).startsWith('.review-skills-') && options?.bigint)
          throw Error('Stage identity capture refused by fixture');
        return lstat(file, options);
      };`,
    );
    assert.throws(() => run({}, failIdentity), /Stage identity capture refused by fixture/);
    assertNoOwnedSkillLinks();
    const unclaimed = readdirSync(root).find((name) => name.startsWith('.review-skills-'));
    assert.ok(unclaimed);
    assert.equal(lstatSync(path.join(root, unclaimed)).isDirectory(), true);
    run({ action: 'cleanup' });
    assert.equal(existsSync(path.join(root, unclaimed)), true);

    run();
    run();
    run({ verifyOnly: true });
    const saved = path.join(root, 'saved-install');
    const privateInstall = realpathSync(existing);
    renameSync(privateInstall, saved);
    mkdirSync(privateInstall);
    writeFileSync(path.join(privateInstall, 'replacement.txt'), 'preserve the replacement');
    assert.throws(() => run({ verifyOnly: true }), /destination identity changed/);
    assert.equal(
      readFileSync(path.join(privateInstall, 'replacement.txt'), 'utf8'),
      'preserve the replacement',
    );
    rmSync(privateInstall, { recursive: true });
    renameSync(saved, privateInstall);
    const published = path.join(realpathSync(checkout), '.agents');
    assert.equal(lstatSync(published).isSymbolicLink(), true);
    const swap = path.join(root, 'swap-before-retire.cjs');
    writeFileSync(
      swap,
      `const fs = require('node:fs');
      const rename = fs.renameSync;
      fs.renameSync = (from, to) => {
        if (from === ${JSON.stringify(published)} && to.endsWith('/directory')) {
          const target = fs.readlinkSync(from);
          rename(from, ${JSON.stringify(saved)});
          fs.symlinkSync(target, from);
        }
        return rename(from, to);
      };`,
    );
    assert.throws(
      () => run({ action: 'cleanup' }, swap),
      /publication link identity changed; preserved at/,
    );
    const retained = readdirSync(root).find((name) => name.startsWith('.review-skill-retire-'));
    assert.ok(retained);
    assert.equal(readlinkSync(path.join(root, retained, 'directory')), readlinkSync(saved));
    assert.throws(() => run({ action: 'cleanup' }), /awaiting recovery/);
    renameSync(path.join(root, retained), path.join(root, 'retained-replacement'));
    renameSync(saved, published);
    const link = path.join(checkout, 'temp/tasks');
    assert(lstatSync(link).isSymbolicLink());
    assert.equal(readlinkSync(link), '../../review-tasks');
    assert(lstatSync(reviewTasks).isDirectory());
    const exclude = readFileSync(path.join(checkout, '.git/info/exclude'), 'utf8');
    assert.equal(exclude.split('\n').filter((line) => line === '/temp/tasks').length, 1);
    // A round the skill writes through the link lands in the writable sibling.
    mkdirSync(path.join(link, 'review/pr-1/r1'), { recursive: true });
    assert(existsSync(path.join(reviewTasks, 'review/pr-1/r1')));
    run({ action: 'cleanup' });
    assert.equal(existsSync(path.join(checkout, 'temp')), false);
    assert.equal(existsSync(path.join(checkout, '.agents/skills/mms-perps-review-pr')), false);
    assert.equal(existsSync(path.join(checkout, '.cursor/rules')), false);
    assert(existsSync(path.join(reviewTasks, 'review/pr-1/r1')));
    assert.throws(() => run({ verifyOnly: true }), /installation missing|link missing/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
