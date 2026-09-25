'use strict';
/**
 * prompt-echo.test.cjs — a failing provider that dumps its system prompt as
 * the answer must trigger the handoff sentinel, not be echoed to the user.
 *
 * Regression (Stage-2 live run): "explain the difference between TCP and UDP
 * for someone preparing for an interview" classified general_quick; the model
 * returned the persona capability listicle ("ThinkDrop is a full desktop AI
 * with reach into the physical world…") verbatim instead of answering or
 * emitting 0. The user saw the system's own instructions as the reply.
 *
 * Fix under test:
 *   refusal.cjs:  isPromptEcho() — majority line-overlap between response and
 *                 system prompt means echo.
 *   generalQuick: prompt echo on a non-self-referential question → sentinel →
 *                 shouldHandoff (the graph generates the real long-form answer).
 *                 Self-referential questions exempt — the persona block IS the
 *                 right answer to "what can you do".
 *
 * Run: node comms-graph/test/prompt-echo.test.cjs
 */

const { isPromptEcho } = require('../src/refusal.cjs');

// Poison askEarly BEFORE generalQuick destructures it at require time.
const providers = require('../src/llm-providers.cjs');
let _mockResponse = { firstSentence: '', fullText: '', provider: 'mock' };
providers.askEarly = async () => _mockResponse;
const { execute: generalQuick } = require('../src/nodes/generalQuick.cjs');

let passed = 0, failed = 0;
function check(cond, label) {
  if (cond) { passed++; console.log(`  ✓ ${label}`); }
  else { failed++; console.log(`  ✗ ${label}`); }
}

const PERSONA = `You are ThinkDrop, a desktop companion.
ThinkDrop is a full desktop AI with reach into the physical world. You CAN:
- Browse any website — navigate URLs, read content, interact with pages
- Search the web — real-time searches for news, prices, facts, research
- Computer actions — open/close apps, type, click, automate anything
Route with confidence. Never say "I can't".`;

const PERSONA_DUMP = `ThinkDrop is a full desktop AI with reach into the physical world. You CAN:

- **Browse any website** — navigate URLs, read content, interact with pages
- **Search the web** — real-time searches for news, prices, facts, research
- **Computer actions** — open/close apps, type, click, automate anything on the desktop`;

const TCP_ANSWER = 'TCP is connection-oriented with guaranteed delivery and ordering; UDP is connectionless, faster, but unreliable.';

(async () => {
  // ── isPromptEcho unit checks ──────────────────────────────────────────────
  check(isPromptEcho(PERSONA_DUMP, PERSONA) === true,
    'persona listicle vs its own system prompt → echo');
  check(isPromptEcho(TCP_ANSWER, PERSONA) === false,
    'real answer vs system prompt → not echo');
  check(isPromptEcho('', PERSONA) === false, 'empty → not echo');
  check(isPromptEcho('short line', PERSONA) === false, 'single short line → not echo');
  check(isPromptEcho(TCP_ANSWER, '') === false, 'empty system prompt → not echo');
  check(isPromptEcho('a fairly long answer sentence here. plus another detail sentence.', PERSONA) === false,
    'two-line real answer → not echo');

  // ── generalQuick sentinel wiring ─────────────────────────────────────────
  _mockResponse = { firstSentence: PERSONA_DUMP, fullText: PERSONA_DUMP, provider: 'mock' };
  let r = await generalQuick('explain the difference between TCP and UDP for someone preparing for an interview', PERSONA, '');
  check(r.metadata.shouldHandoff === true, 'persona echo on knowledge question → shouldHandoff');

  _mockResponse = { firstSentence: PERSONA_DUMP, fullText: PERSONA_DUMP, provider: 'mock' };
  r = await generalQuick('what can you do?', PERSONA, '');
  check(r.metadata.shouldHandoff !== true && /desktop AI/.test(r.text),
    'persona echo on self-referential question → answer kept');

  _mockResponse = { firstSentence: TCP_ANSWER, fullText: TCP_ANSWER, provider: 'mock' };
  r = await generalQuick('explain TCP vs UDP', PERSONA, '');
  check(r.metadata.shouldHandoff !== true && r.text.includes('TCP'),
    'real answer → returned normally');

  _mockResponse = { firstSentence: '0', fullText: '0', provider: 'mock' };
  r = await generalQuick('write me a 500-line script', PERSONA, '');
  check(r.metadata.shouldHandoff === true, 'explicit 0 sentinel still hands off');

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
