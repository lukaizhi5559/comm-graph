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
 */

const logger = require('../logger.cjs');
const { askEarly, buildMessages } = require('../llm-providers.cjs');
const { getRandomHandoffPhrase } = require('../handoffPhrases.cjs');

/**
 * @param {string} englishText  - English user message
 * @param {string} systemPrompt - Full system prompt (persona + personality overlay + language)
 * @returns {Promise<{ text: string, fullText: string, metadata: Object }>}
 */
async function execute(englishText, systemPrompt) {
  try {
    const messages = buildMessages(englishText, systemPrompt);
    const { firstSentence, fullText, provider } = await askEarly(messages, {
      maxTokens: 150,
      temperature: 0.7,
    });

    const response = firstSentence || fullText;

    // If the LLM returned an empty response, hand off to main state graph
    if (!response || !response.trim()) {
      const phrase = getRandomHandoffPhrase();
      logger.info('[GeneralQuick] LLM empty — handing off', { phrase, provider });
      return {
        text: phrase,
        fullText: phrase,
        metadata: { source: 'handoff', provider, intent: 1, shouldHandoff: true },
      };
    }

    // Guard: if the LLM admits it can't answer (no real-time access, no capability),
    // hand off to the main state graph which has tools and device context.
    const _unhelpful = /^(?:i don'?t have access to|i don'?t have a|i cannot|i can'?t|i am unable to|i have no access)/i.test(response.trim());
    if (_unhelpful) {
      const phrase = getRandomHandoffPhrase();
      logger.info('[GeneralQuick] Unhelpful response — handing off', { phrase, provider, responsePreview: response.substring(0, 60) });
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
