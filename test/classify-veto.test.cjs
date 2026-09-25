'use strict';
/**
 * classify-veto.test.cjs — deterministic keyword tier vs LLM residual bucket
 *
 * Regression: providers flake toward intent 0 on trivially classifiable
 * prompts (observed: cerebras returned "0" then "1" for "tell me a joke"
 * across runs — a 33s graph trip each time). A confident keyword hit must
 * veto a parsed 0, but NEVER a specific non-zero intent.
 *
 * ask is lazily destructured from llm-providers inside classify(), so
 * patching the module export here reaches the unit under test.
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
  console.log('\nclassify keyword-veto tests');

  await withAsk(async () => ({ text: '0', provider: 'mock' }), async () => {
    const r = await classify('tell me a joke');
    check('LLM "0" vetoed by keyword hit → general_quick',
      r.intent === 1 && r.source === 'keyword_fallback');
  });

  await withAsk(async () => ({ text: '0', provider: 'mock' }), async () => {
    const r = await classify('good morning');
    check('LLM "0" vetoed for greeting → general_quick',
      r.intent === 1 && r.source === 'keyword_fallback');
  });

  await withAsk(async () => ({ text: '5', provider: 'mock' }), async () => {
    const r = await classify('tell me a joke');
    check('LLM "5" NEVER vetoed — non-zero intent wins over keyword hit',
      r.intent === 5 && r.intentName === 'memory_store');
  });

  await withAsk(async () => ({ text: '3', provider: 'mock' }), async () => {
    const r = await classify('what is 17 times 24');
    check('LLM "3" NEVER vetoed even when keywords disagree',
      r.intent === 3 && r.intentName === 'status_check');
  });

  await withAsk(async () => ({ text: '0', provider: 'mock' }), async () => {
    const r = await classify('what is on my second monitor');
    check('system-surface prompt: keyword blocked by exclusion → LLM "0" stands',
      r.intent === 0 && r.intentName === 'handoff');
  });

  await withAsk(async () => ({ text: '0', provider: 'mock' }), async () => {
    const r = await classify('asdkfj qwovnz blargh');
    check('no keyword hit → LLM "0" stands (handoff)',
      r.intent === 0 && r.intentName === 'handoff');
  });

  await withAsk(async () => ({ text: '0', provider: 'mock' }), async () => {
    const r = await classify('note: buy milk tomorrow');
    check('LLM "0" vetoed by memory_store keyword hit',
      r.intent === 5 && r.source === 'keyword_fallback');
  });

  await withAsk(async () => ({ text: '0', provider: 'mock' }), async () => {
    const r = await classify('cancel that');
    check('LLM "0" vetoed by control_signal keyword hit',
      r.intent === 4 && r.source === 'keyword_fallback');
  });

  console.log(`\n${passed}/${tests} passed`);
  process.exit(passed === tests ? 0 : 1);
})().catch(e => { console.error(e); process.exit(1); });
