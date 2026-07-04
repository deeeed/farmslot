#!/usr/bin/env node
'use strict';

const path = require('node:path');
const { createRequire } = require('node:module');

const requireFromHere = createRequire(__filename);

function resolveRuntimeScript() {
  try {
    return requireFromHere.resolve('@farmslot/agent-runtime/scripts/mark-checklist-step.cjs');
  } catch (error) {
    if (error.code !== 'MODULE_NOT_FOUND') throw error;
    return path.resolve(__dirname, '../../agent-runtime/scripts/mark-checklist-step.cjs');
  }
}

require(resolveRuntimeScript());
