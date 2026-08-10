#!/usr/bin/env node

const PLACEHOLDER_PATTERNS = [
  /active-development baseline/i,
  /add user-facing changes here/i,
  /before release or package publication/i,
];

export function isPlaceholderBullet(line) {
  const trimmed = line.trim();
  if (!trimmed.startsWith('-')) return false;
  return PLACEHOLDER_PATTERNS.some((pattern) => pattern.test(trimmed));
}

export function parseBullets(sectionText) {
  return sectionText
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.startsWith('-'))
    .map((line) => line.replace(/^-\s*/, '').trim())
    .filter((line) => line.length > 0);
}

export function meaningfulBullets(sectionText) {
  return parseBullets(sectionText).filter((bullet) => !isPlaceholderBullet(`- ${bullet}`));
}

export function unreleasedMeaningfulBullets(changelogContent) {
  const unreleased = extractSection(changelogContent, (line) => /^##\s+Unreleased\b/i.test(line));
  return unreleased ? meaningfulBullets(unreleased.body) : [];
}

export function extractSection(changelog, headingMatches) {
  const lines = changelog.split(/\r?\n/);
  const headingIndex = lines.findIndex((line) => headingMatches(line.trim()));
  if (headingIndex < 0) return undefined;
  const sectionLines = [];
  for (let i = headingIndex + 1; i < lines.length; i += 1) {
    if (lines[i].startsWith('## ')) break;
    sectionLines.push(lines[i]);
  }
  return {
    heading: lines[headingIndex].trim(),
    body: sectionLines.join('\n'),
    headingIndex,
  };
}

export function parseReleasedHeadings(changelog) {
  const lines = changelog.split(/\r?\n/);
  const headings = [];
  for (const line of lines) {
    const match = line
      .trim()
      .match(/^##\s+(?:\[)?(\d+\.\d+\.\d+)(?:\])?(?:\s*-\s*(\d{4}-\d{2}-\d{2}))?/);
    if (match) {
      headings.push({ version: match[1], date: match[2] ?? null, heading: line.trim() });
    }
  }
  return headings;
}

export function parseChangelog(changelogPath, content) {
  const unreleased = extractSection(content, (line) => /^##\s+Unreleased\b/i.test(line));
  const released = parseReleasedHeadings(content);
  return {
    path: changelogPath,
    unreleased: unreleased ? meaningfulBullets(unreleased.body) : [],
    released,
  };
}

export function bumpSemver(version, bump) {
  const match = version.match(/^(\d+)\.(\d+)\.(\d+)$/);
  if (!match) throw new Error(`Invalid semver '${version}'`);
  let major = Number(match[1]);
  let minor = Number(match[2]);
  let patch = Number(match[3]);
  if (bump === 'major') {
    major += 1;
    minor = 0;
    patch = 0;
  } else if (bump === 'minor') {
    minor += 1;
    patch = 0;
  } else if (bump === 'patch') {
    patch += 1;
  } else {
    throw new Error(`Unknown bump '${bump}'`);
  }
  return `${major}.${minor}.${patch}`;
}

export function compareSemver(left, right) {
  const parse = (version) => {
    const match = version.match(/^(\d+)\.(\d+)\.(\d+)$/);
    if (!match) throw new Error(`Invalid semver '${version}'`);
    return match.slice(1).map(Number);
  };
  const leftParts = parse(left);
  const rightParts = parse(right);
  for (let index = 0; index < leftParts.length; index += 1) {
    if (leftParts[index] !== rightParts[index]) return leftParts[index] - rightParts[index];
  }
  return 0;
}

export function applyChangelogCut(content, { version, date, include, defer }) {
  const unreleased = extractSection(content, (line) => /^##\s+Unreleased\b/i.test(line));
  if (!unreleased) throw new Error('Missing ## Unreleased section');

  const lines = content.split(/\r?\n/);
  const releaseHeading = `## ${version} - ${date}`;
  const releaseLines = include.map((bullet) => `- ${bullet}`);
  const deferLines = defer.map((bullet) => `- ${bullet}`);
  const placeholder =
    '- Active-development baseline; add user-facing changes here before release or package publication.';

  const afterUnreleasedIndex = (() => {
    for (let i = unreleased.headingIndex + 1; i < lines.length; i += 1) {
      if (lines[i].startsWith('## ')) return i;
    }
    return lines.length;
  })();

  const head = lines.slice(0, unreleased.headingIndex);
  const tail = lines.slice(afterUnreleasedIndex);
  const next = [
    ...head,
    '## Unreleased',
    '',
    ...(deferLines.length > 0 ? [...deferLines, ''] : []),
    placeholder,
    '',
    releaseHeading,
    '',
    ...releaseLines,
    '',
    ...tail,
  ];
  return `${next
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()}\n`;
}
