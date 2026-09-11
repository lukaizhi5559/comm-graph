'use strict';

/**
 * generalQuick.cjs — Intent 1: direct LLM response with personality
 *
 * Handles chitchat, greetings, opinions, and simple knowledge questions
 * that the LLM can answer directly without any tools.
 * Uses askEarly() for fast first-sentence resolution (~300-500ms).
 */

const logger = require('../logger.cjs');
const { askEarly, buildMessages } = require('../llm-providers.cjs');

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

    const response = firstSentence || fullText || "I'm here, though I'm not sure what to say to that.";

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
    logger.error('[GeneralQuick] Error', { error: err.message });
    return {
      text: 'Forgive me — something went amiss just now.',
      fullText: 'Forgive me — something went amiss just now.',
      metadata: { source: 'error', intent: 1 },
    };
  }
}

module.exports = { execute };
