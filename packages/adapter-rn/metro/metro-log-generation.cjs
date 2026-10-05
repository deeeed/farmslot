#!/usr/bin/env node
'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const generationIdPattern = /^[A-Za-z0-9-]+$/u;

function archiveGenerationId(name) {
  if (!name.startsWith('metro.') || !name.endsWith('.log')) return null;
  const generationId = name.slice('metro.'.length, -'.log'.length);
  return generationIdPattern.test(generationId) ? generationId : null;
}

function positiveInteger(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  if (!/^[1-9][0-9]*$/u.test(raw)) throw new Error(`${name} must be a positive integer`);
  return Number(raw);
}

function main() {
  const runtimeArg = process.argv[2];
  const port = process.argv[3];
  const reason = process.argv[4];
  if (!runtimeArg || !/^[1-9][0-9]*$/u.test(port ?? '') || !reason) {
    throw new Error('usage: metro-log-generation.cjs <runtime-dir> <port> <reason>');
  }
  const runtimeDir = fs.realpathSync(runtimeArg);
  const activeLog = path.join(runtimeDir, 'metro.log');
  const evidenceFile = path.join(runtimeDir, 'metro-generation.json');
  const maxArchives = positiveInteger('RECIPE_RN_METRO_LOG_ARCHIVE_COUNT', 4);
  const maxArchiveBytes = positiveInteger('RECIPE_RN_METRO_LOG_ARCHIVE_BYTES', 8 * 1024 * 1024);
  const generationId = `${new Date().toISOString().replace(/[-:.]/gu, '')}-${port}-${process.pid}-${crypto.randomBytes(4).toString('hex')}`;
  if (!generationIdPattern.test(generationId))
    throw new Error('generated Metro log identity is invalid');
  let rotatedLog = null;

  rotatedLog = path.join(runtimeDir, `metro.${generationId}.log`);
  try {
    fs.renameSync(activeLog, rotatedLog);
    const stat = fs.lstatSync(rotatedLog);
    if (!stat.isFile()) {
      fs.renameSync(rotatedLog, activeLog);
      throw new Error('metro.log must be a regular file');
    }
  } catch (error) {
    if (error && error.code === 'ENOENT') rotatedLog = null;
    else throw error;
  }
  try {
    fs.closeSync(fs.openSync(activeLog, 'wx', 0o600));
  } catch (error) {
    if (error && error.code === 'EEXIST')
      throw new Error('another Metro generation recreated metro.log; refusing to truncate it');
    throw error;
  }

  const archives = fs
    .readdirSync(runtimeDir)
    .filter((name) => archiveGenerationId(name) !== null)
    .map((name) => {
      const file = path.join(runtimeDir, name);
      const stat = fs.lstatSync(file);
      if (!stat.isFile()) return null;
      return { file, size: stat.size, mtimeMs: stat.mtimeMs };
    })
    .filter(Boolean)
    .sort((left, right) => right.mtimeMs - left.mtimeMs || right.file.localeCompare(left.file));

  let retainedBytes = 0;
  let retainedCount = 0;
  const retained = [];
  const removed = [];
  for (const archive of archives) {
    if (retainedCount < maxArchives && retainedBytes + archive.size <= maxArchiveBytes) {
      retained.push(archive.file);
      retainedCount += 1;
      retainedBytes += archive.size;
      continue;
    }
    fs.unlinkSync(archive.file);
    removed.push({
      path: archive.file,
      size: archive.size,
      reason: retainedCount >= maxArchives ? 'count-limit' : 'size-limit',
    });
  }

  const evidence = {
    schemaVersion: 1,
    generationId,
    port: Number(port),
    startedAt: new Date().toISOString(),
    currentLog: activeLog,
    rotatedLog: rotatedLog && fs.existsSync(rotatedLog) ? rotatedLog : null,
    archivedLogs: retained,
    rotationReason: reason,
    retention: { maxArchives, maxArchiveBytes, retainedBytes, removed },
  };
  const temporary = `${evidenceFile}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(evidence, null, 2)}\n`, {
    mode: 0o600,
    flag: 'wx',
  });
  fs.renameSync(temporary, evidenceFile);
  process.stdout.write(`${JSON.stringify(evidence)}\n`);
}

try {
  main();
} catch (error) {
  console.error(`metro-log-generation: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
}
