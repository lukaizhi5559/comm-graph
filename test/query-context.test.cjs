'use strict';
/**
 * query-context.test.cjs — standalone SERP query construction contract
 *
 * Regression: "who has ALS?" after a Chris Johnson NFL turn reached
 * /web.search verbatim — the stateless service answered with generic ALS
 * stats instead of the player. Covered here:
 *
 *   - followUp + followUpTarget prepends the resolved subject (stategraph
 *     webSearch parity) — no double-prepend when the target already appears
 *   - followUp with NO target returns null (caller skips SERP — a raw search
 *     can only answer off-context)
 *   - non-follow-up envelopes and context-free prompts pass through verbatim
 *   - no envelope + history → bounded LLM rewrite path (mocked ask)
 */
// Mock the LLM provider before the module under test loads it.
const llmPath = require.resolve('../src/llm-providers.cjs');
let _mockReply = '';
let _mockCalls = 0;
require(llmPath);
require.cache[llmPath].exports = {
  ...require.cache[llmPath].exports,
  ask: async () => { _mockCalls++; return { text: _mockReply, provider: 'mock' }; },
};
const { standaloneSearchQuery } = require('../src/query-context.cjs');

const CTX = 'User: Who is Chris Johnson NFL and what\'s his height weight etc.\nAssistant: There are two notable Chris Johnsons in the NFL — CJ2K (5\'11", 195 lbs) and a younger RB (6\'0", 196 lbs).';

let tests = 0, passed = 0;
async function check(name, p) { tests++; try { const cond = await p; if (cond) { passed++; console.log(`  PASS: ${name}`); } else { console.error(`  FAIL: ${name}`); } } catch (e) { console.error(`  FAIL: ${name} — ${e.message}`); } }

(async () => {
  console.log('\nquery-context tests');

  // ── Envelope: follow-up with resolved target ─────────────────────────
  await check('follow-up + target prepends subject',
    await standaloneSearchQuery('who has ALS?', CTX, { isFollowUp: true, followUpTarget: 'Chris Johnson' })
      === 'Chris Johnson who has ALS?');
  await check('target already in question — no double prepend',
    await standaloneSearchQuery('does Chris Johnson have ALS?', CTX, { isFollowUp: true, followUpTarget: 'Chris Johnson' })
      === 'does Chris Johnson have ALS?');
  await check('case-insensitive dedupe',
    await standaloneSearchQuery('chris johnson height', CTX, { isFollowUp: true, followUpTarget: 'Chris Johnson' })
      === 'chris johnson height');
  // No LLM call on the envelope path
  {
    const before = _mockCalls;
    await standaloneSearchQuery('who has ALS?', CTX, { isFollowUp: true, followUpTarget: 'Chris Johnson' });
    await check('envelope path makes zero LLM calls', before === _mockCalls);
  }

  // ── Envelope: follow-up without a resolved target → skip SERP ────────
  await check('follow-up, no target → null (skip SERP)',
    await standaloneSearchQuery('who has ALS?', CTX, { isFollowUp: true, followUpTarget: null }) === null);

  // ── No envelope / standalone verdict → rewrite or verbatim ───────────
  _mockReply = 'which Chris Johnson NFL player has ALS';
  await check('no envelope + history → rewritten standalone query',
    await standaloneSearchQuery('who has ALS?', CTX, null) === 'which Chris Johnson NFL player has ALS');
  _mockReply = 'who has ALS?';
  await check('rewrite returning verbatim passes through',
    await standaloneSearchQuery('who has ALS?', CTX, null) === 'who has ALS?');
  _mockReply = 'what is PRD';
  await check('rd.isFollowUp=false + history → still rewritten (envelope miss safety net)',
    await standaloneSearchQuery('what is PRD', CTX, { isFollowUp: false }) === 'what is PRD');
  _mockReply = '';
  await check('empty rewrite → raw query (fail-open)',
    await standaloneSearchQuery('who has ALS?', CTX, null) === 'who has ALS?');
  _mockReply = 'Here is the rewritten query:\nwho has ALS';
  await check('multi-line leak → raw query (fail-open)',
    await standaloneSearchQuery('who has ALS?', CTX, null) === 'who has ALS?');
  _mockReply = '"Chris Johnson ALS"';
  await check('quoted rewrite unwrapped',
    await standaloneSearchQuery('who has ALS?', CTX, null) === 'Chris Johnson ALS');

  // ── No history → verbatim, zero LLM cost ─────────────────────────────
  {
    const before = _mockCalls;
    await check('no history → verbatim',
      await standaloneSearchQuery('who has ALS?', '', null) === 'who has ALS?');
    await check('no history → no LLM call', _mockCalls === before);
  }
  await check('empty question → null',
    await standaloneSearchQuery('  ', CTX, { isFollowUp: false }) === null);

  console.log(`\n${passed}/${tests} passed`);
  process.exit(passed === tests ? 0 : 1);
})();
