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

  // ── Screen-observation guard (deterministic, pre-LLM) ──────────────────────
  // Regression: "describe what I'm looking at" classified general_quick by
  // cerebras in run3 (confident-but-wrong — no veto applies to non-zero).
  // Screen questions need a live capture; general_quick has no eyes.

  await withAsk(async () => { throw new Error('LLM must not be called — guard fires first'); }, async () => {
    const r = await classify("describe what I'm looking at");
    check('screen-observation guard → handoff (LLM verdict bypassed)',
      r.intent === 0 && r.source === 'screen_observation_guard');
  });

  await withAsk(async () => { throw new Error('LLM must not be called'); }, async () => {
    const r = await classify("what's on my screen right now");
    check('"what\'s on my screen" → handoff (either screen guard)',
      r.intent === 0 && r.source.startsWith('screen_'));
  });

  await withAsk(async () => { throw new Error('LLM must not be called'); }, async () => {
    const r = await classify('is there an error dialog visible on my screen');
    check('visible-on-screen phrasing → handoff (either screen guard)',
      r.intent === 0 && r.source.startsWith('screen_'));
  });

  await withAsk(async () => { throw new Error('LLM must not be called'); }, async () => {
    const r = await classify('read the text visible on my screen');
    check('read-text-on-screen phrasing → handoff (either screen guard)',
      r.intent === 0 && r.source.startsWith('screen_'));
  });

  await withAsk(async () => { throw new Error('LLM must not be called'); }, async () => {
    const r = await classify('what app am I in');
    check('no literal "screen" words → observation guard specifically',
      r.intent === 0 && r.source === 'screen_observation_guard');
  });

  await withAsk(async () => ({ text: '1', provider: 'mock' }), async () => {
    const r = await classify('what is a screen');
    check('non-observational "screen" mention → LLM verdict stands (no guard)',
      r.intent === 1);
  });

  // Bare-deictic continuations — the referent lives in the transcript;
  // general_quick hallucinates a referent it can't see. Hand off even when
  // the LLM would happily quick-answer (observed: "when was that" → a
  // keyword hit vetoed the LLM's handoff and invented a date).
  await withAsk(async () => ({ text: '1', provider: 'mock' }), async () => {
    const r = await classify('when was that');
    check('deictic "when was that" → handoff (beats LLM general_quick)',
      r.intent === 0 && r.source === 'deictic_continuation_guard');
  });

  await withAsk(async () => { throw new Error('LLM must not be called'); }, async () => {
    const r = await classify('tell me more about that');
    check('deictic "tell me more about that" → handoff (pre-LLM guard)',
      r.intent === 0 && r.source === 'deictic_continuation_guard');
  });

  await withAsk(async () => { throw new Error('LLM must not be called'); }, async () => {
    const r = await classify('what about that');
    check('deictic "what about that" → handoff',
      r.intent === 0 && r.source === 'deictic_continuation_guard');
  });

  // ── Action veto (deterministic guesser vs quick-tier flake) ────────────────
  // Regression: "post a tweet saying hello world" drew general_quick — comms
  // answered "tweet going live" and nothing ran. Quick tiers emit text only;
  // a deterministic guesser hit for a graph-only intent must veto them.

  await withAsk(async () => ({ text: '1', provider: 'mock' }), async () => {
    const r = await classify('post a tweet saying hello world');
    check('tweet prompt: guesser command_automate vetoes LLM general_quick → handoff',
      r.intent === 0 && r.source === 'action_veto');
  });

  await withAsk(async () => ({ text: '1', provider: 'mock' }), async () => {
    const r = await classify('send an email to Sarah about the meeting');
    check('send-email phrasing → action veto → handoff',
      r.intent === 0 && r.source === 'action_veto');
  });

  await withAsk(async () => ({ text: '1', provider: 'mock' }), async () => {
    const r = await classify('remind me to call mom tomorrow at 5');
    check('scheduling phrasing → action veto → handoff',
      r.intent === 0 && r.source === 'action_veto');
  });

  await withAsk(async () => ({ text: '1', provider: 'mock' }), async () => {
    const r = await classify('tell me a joke');
    check('pure knowledge: guesser general_knowledge → no veto, LLM quick stands',
      r.intent === 1 && r.intentName === 'general_quick');
  });

  console.log(`\n${passed}/${tests} passed`);
  process.exit(passed === tests ? 0 : 1);
})().catch(e => { console.error(e); process.exit(1); });
