'use strict';
/**
 * screen-guard-veto.test.cjs — rule/automation phrasing vetoes the
 * screen-output guard
 *
 * Observed failure (2026-10-29): "I need to set a rule that if I goto
 * youtube and look at a mike winger video you [put it] on my screen" hit
 * the screen-output guard's bare `on (my|the) screen` match and the whole
 * prompt was swallowed into intent=7 display — the rule was never created
 * (user Esc'd out). Rule phrasing now vetoes the display lane the same way
 * _serviceRef already does, so the compound reaches normal classification.
 */
const assert = require('assert');
const { classify } = require('../src/classify.cjs');
const providers = require('../src/llm-providers.cjs');

const realAsk = providers.ask;
let tests = 0, passed = 0;

async function withAsk(impl, fn) {
  providers.ask = impl;
  try { return await fn(); } finally { providers.ask = realAsk; }
}
function check(name, cond) { tests++; if (cond) { passed++; console.log(`  PASS: ${name}`); } else { console.error(`  FAIL: ${name}`); } }

(async () => {
  console.log('\nscreen-output guard rule-veto tests');

  // The compound rule prompt must NOT be display-swallowed — whatever the
  // LLM picks downstream, the screen lane must not fire.
  await withAsk(async () => ({ text: '0', provider: 'mock' }), async () => {
    const r = await classify('I need to set a rule that if I goto youtube and look at a mike winger video you put it on my screen');
    check('rule prompt with embedded "on my screen" does not route to screen lane',
      r.intent !== 7 && r.source !== 'screen_output_guard');
  });

  await withAsk(async () => ({ text: '4', provider: 'mock' }), async () => {
    const r = await classify('whenever a new video drops on youtube put it on my screen');
    check('"whenever" automation phrasing not display-swallowed',
      r.intent !== 7 && r.source !== 'screen_output_guard');
  });

  // Pure display commands must still take the lane.
  await withAsk(async () => ({ text: '0', provider: 'mock' }), async () => {
    const r = await classify('put fireworks on my screen');
    check('pure display command still routes to screen lane',
      r.intent === 7 && r.source === 'screen_output_guard');
  });

  await withAsk(async () => ({ text: '0', provider: 'mock' }), async () => {
    const r = await classify('clear the screen');
    check('"clear the screen" still routes to screen lane',
      r.intent === 7 && r.source === 'screen_output_guard');
  });

  console.log(`\n${passed}/${tests} passed`);
  process.exit(passed === tests ? 0 : 1);
})().catch(e => { console.error(e); process.exit(1); });
