'use strict';

const path = require('node:path');
const { createRequire } = require('node:module');

function loadChromium() {
  const runtimeRequire = createRequire(path.join(process.cwd(), 'package.json'));
  try {
    return runtimeRequire('@playwright/test').chromium;
  } catch {
    return runtimeRequire('playwright').chromium;
  }
}

async function connectBrowserViaCdp(endpoint) {
  return loadChromium().connectOverCDP(endpoint);
}

function buildEvaluationExpression(callbackOrExpression, argument) {
  if (typeof callbackOrExpression === 'string') return callbackOrExpression;
  if (typeof callbackOrExpression !== 'function') {
    throw new TypeError('CDP evaluation requires a function or expression string.');
  }
  return argument === undefined
    ? `(${callbackOrExpression.toString()})()`
    : `(${callbackOrExpression.toString()})(${JSON.stringify(argument)})`;
}

async function evaluatePageViaCdp(page, callbackOrExpression, argument) {
  const session = await page.context().newCDPSession(page);
  try {
    const response = await session.send('Runtime.evaluate', {
      expression: buildEvaluationExpression(callbackOrExpression, argument),
      awaitPromise: true,
      returnByValue: true,
    });
    if (response.exceptionDetails) {
      const detail =
        response.exceptionDetails.exception?.description ??
        response.exceptionDetails.text ??
        'unknown evaluation failure';
      throw new Error(`CDP evaluation failed: ${detail}`);
    }
    return response.result?.value;
  } finally {
    await session.detach().catch(() => {});
  }
}

module.exports = { buildEvaluationExpression, connectBrowserViaCdp, evaluatePageViaCdp };
