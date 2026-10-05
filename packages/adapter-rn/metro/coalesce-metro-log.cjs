#!/usr/bin/env node
'use strict';

const readline = require('node:readline');

const progressPattern = /^\s*(?:iOS|Android).*?(\d{1,3}(?:\.\d+)?)%/u;
let lastPercent = null;
let lastProgressAt = 0;

const lines = readline.createInterface({
  input: process.stdin,
  crlfDelay: Infinity,
  terminal: false,
});
lines.on('line', (line) => {
  const progress = progressPattern.exec(line);
  if (!progress) {
    process.stdout.write(`${line}\n`);
    return;
  }
  const percent = Math.floor(Number(progress[1]));
  const now = Date.now();
  if (percent !== lastPercent || now - lastProgressAt >= 15_000) {
    process.stdout.write(`${line} [metro-progress ${new Date(now).toISOString()}]\n`);
    lastPercent = percent;
    lastProgressAt = now;
  }
});
