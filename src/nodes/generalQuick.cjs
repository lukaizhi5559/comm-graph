'use strict';

/**
 * generalQuick.cjs — Intent 1: direct LLM response with personality
 *
 * Handles chitchat, greetings, opinions, and simple knowledge questions
 * that the LLM can answer directly without any tools.
 * Uses askEarly() for fast first-sentence resolution (~300-500ms).
 *
 * If the LLM fails (backend down, all providers exhausted), sets
 * metadata.shouldHandoff = true so the server dispatches to the main
 * state graph. Returns a random handoff phrase as immediate acknowledgment.
 *
 * ── Sentinel-based handoff detection ──────────────────────────────────────────
 * The persona prompt teaches the LLM to use handoff phrases ("Routing that to
 * ThinkDrop now"). This conflicts with general_quick's purpose — answering
 * directly. Instead of detecting handoff-style natural language with fragile
 * regex patterns, we append a DIRECT ANSWER MODE directive that overrides the
 * persona's routing instructions and tells the LLM to either answer directly
 * or output exactly `0` (the existing handoff intent number) if it cannot.
 * This is robust across model changes and new phrasings.
 */

const logger = require('../logger.cjs');
const { askEarly, buildMessages } = require('../llm-providers.cjs');
const { getRandomHandoffPhrase } = require('../handoffPhrases.cjs');
const { isCannedRefusal } = require('../refusal.cjs');

// ── Direct answer mode directive ─────────────────────────────────────────────
// Appended to the system prompt to override the persona's handoff phrase
// instructions. Tells the LLM to answer directly or signal 0 (handoff).
const DIRECT_ANSWER_DIRECTIVE = `

═══════════════════════════════════════════════
DIRECT ANSWER MODE — ACTIVE NOW
═══════════════════════════════════════════════
You are in DIRECT ANSWER mode. The user's message was classified as something
you can answer directly with your own knowledge.

Answer the user's question directly and concisely — keep it to 1-2 short sentences.
Do NOT use any handoff or routing phrases like "Routing that to ThinkDrop",
"Let me check on that", "Passing that along", or "Let me look that up".
Do NOT promise to look something up — either answer now, or signal that you cannot.

If you cannot answer because:
- You lack real-time or live data (current prices, news, weather, current office-holders)
- Your knowledge is outdated or has a cutoff date
- You lack the capability or tools for what's being asked
- The question needs web search, browser access, file access, or device context
- The question asks about PAST CONVERSATIONS or chat history beyond what is shown
  in the context — you can only see this session's recent turns, so questions
  like "what did we talk about yesterday", "have we chatted before", or
  "look up our previous conversation" MUST signal 0 (a deeper system searches
  the full transcript)

...or if a proper answer would be long-form — code blocks, scripts, essays,
detailed step-by-step guides, creative writing, documents (a deeper system
handles those) — then respond with EXACTLY: 0
Nothing else. Just the number 0. No explanation, no handoff phrase.
═══════════════════════════════════════════════`;

/**
 * @param {string} englishText  - English user message
 * @param {string} systemPrompt - Full system prompt (persona + personality overlay + language)
 * @param {string} [conversationContext] - Recent conversation turns for context awareness
 * @returns {Promise<{ text: string, fullText: string, metadata: Object }>}
 */
async function execute(englishText, systemPrompt, conversationContext) {
  try {
    // Append direct-answer directive to override the persona's routing instructions
    const directPrompt = systemPrompt + DIRECT_ANSWER_DIRECTIVE;
    const messages = buildMessages(englishText, directPrompt, conversationContext);
    const { firstSentence, fullText, provider } = await askEarly(messages, {
      maxTokens: 150,
      temperature: 0.7,
    });

    const response = firstSentence || fullText;

    // ── Sentinel check: LLM signals it cannot answer ────────────────────────
    // Covers empty responses, explicit 0 (handoff) signals, and canned
    // refusals — the backend's last-refusal grace returns refusal text when
    // EVERY provider declined; never echo that to the user, hand off instead.
    const refusal = isCannedRefusal(response);
    if (!response || !response.trim() || response.trim() === '0' || refusal) {
      const phrase = getRandomHandoffPhrase();
      logger.info('[GeneralQuick] Handoff signaled', {
        phrase, provider,
        reason: !response ? 'empty' : (refusal ? 'refusal' : 'sentinel'),
      });
      return {
        text: phrase,
        fullText: phrase,
        metadata: { source: 'handoff', provider, intent: 1, shouldHandoff: true },
      };
    }

    logger.info('[GeneralQuick] Response', {
      provider,
      chars: response.length,
      inputPreview: englishText.substring(0, 60),
    });

    return {
      text: response,
      fullText: fullText || response,
      metadata: { source: 'general_quick', provider, intent: 1 },
    };
  } catch (err) {
    // LLM call threw — hand off to main state graph
    const phrase = getRandomHandoffPhrase();
    logger.error('[GeneralQuick] Error — handing off', { error: err.message, phrase });
    return {
      text: phrase,
      fullText: phrase,
      metadata: { source: 'handoff', provider: 'none', intent: 1, shouldHandoff: true },
    };
  }
}

module.exports = { execute };
