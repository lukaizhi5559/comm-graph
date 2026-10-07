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
const { isCannedRefusal, isPromptEcho } = require('../refusal.cjs');

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

For "how long" / elapsed-time questions: compute the duration carefully from
CURRENT LOCAL TIME — state the start date and the elapsed span; do the date
arithmetic explicitly before answering.

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

// ── Selection variant ────────────────────────────────────────────────────────
// Used when the prompt carries [Highlighted:] text — the user pointed at text
// and asked about it. Same rules, but the answer deserves real depth (the
// chitchat 1-2-sentence cap is too thin for "explain this").
const SELECTION_ANSWER_DIRECTIVE = `

═══════════════════════════════════════════════
DIRECT ANSWER MODE — ACTIVE NOW
═══════════════════════════════════════════════
You are in DIRECT ANSWER mode. The user's message includes a [Highlighted:]
block — text they selected on screen. Their question is about THAT text.

Answer the question about the highlighted text fully but concisely — up to ~4
sentences, more structure only if the text genuinely warrants it.
If the highlighted text is short, ambiguous, or partial, still answer
best-effort — say what the text appears to be, or ask a one-line clarifying
question — rather than signaling 0. Reserve 0 for requests that need tools
or access you don't have.
Do NOT use any handoff or routing phrases like "Routing that to ThinkDrop",
"Let me check on that", "Passing that along", or "Let me look that up".
Do NOT promise to look something up — either answer now, or signal that you cannot.

If you cannot answer because:
- The question asks for an ACTION (search, open, save, send, run, edit a file…),
  not an answer about the text
- You lack real-time or live data, web/browser/file access, or device context
- The question asks about PAST CONVERSATIONS or chat history beyond what is shown

...then respond with EXACTLY: 0
Nothing else. Just the number 0. No explanation, no handoff phrase.
═══════════════════════════════════════════════`;

// Questions asking about ThinkDrop/the assistant itself — a persona echo is
// the CORRECT answer for these, never a sentinel.
const SELF_REFERENTIAL_RE = /\bthinkdrop\b|\bwho are you\b|\bwhat can you do\b|\byour (?:capabilit\w*|features?|tools?|skills?|limits?)\b|\babout yourself\b/i;

/**
 * @param {string} englishText  - English user message
 * @param {string} systemPrompt - Full system prompt (persona + personality overlay + language)
 * @param {string} [conversationContext] - Recent conversation turns for context awareness
 * @param {Object} [opts] - { hasSelectionContext } — swap in the selection-aware directive
 * @returns {Promise<{ text: string, fullText: string, metadata: Object }>}
 */
async function execute(englishText, systemPrompt, conversationContext, opts = {}) {
  try {
    // Append direct-answer directive to override the persona's routing instructions
    const directPrompt = systemPrompt +
      (opts.hasSelectionContext ? SELECTION_ANSWER_DIRECTIVE : DIRECT_ANSWER_DIRECTIVE);
    const messages = buildMessages(englishText, directPrompt, conversationContext);
    const { firstSentence, fullText, provider } = await askEarly(messages, {
      maxTokens: opts.hasSelectionContext ? 400 : 150,
      temperature: 0.7,
    });

    const response = firstSentence || fullText;

    // ── Sentinel check: LLM signals it cannot answer ────────────────────────
    // Covers empty responses, explicit 0 (handoff) signals, canned refusals —
    // and system-prompt echoes: a failing provider may dump the persona block
    // ("ThinkDrop is a full desktop AI …") as the answer instead of emitting
    // 0 (observed on a TCP/UDP interview-prep question). Self-referential
    // questions ("what can you do") are exempt — the persona block IS the
    // correct answer there.
    const refusal = isCannedRefusal(response);
    const promptEcho = !SELF_REFERENTIAL_RE.test(englishText) && isPromptEcho(response, systemPrompt);
    if (!response || !response.trim() || response.trim() === '0' || refusal || promptEcho) {
      const phrase = getRandomHandoffPhrase();
      logger.info('[GeneralQuick] Handoff signaled', {
        phrase, provider,
        reason: !response ? 'empty' : (refusal ? 'refusal' : (promptEcho ? 'prompt-echo' : 'sentinel')),
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
