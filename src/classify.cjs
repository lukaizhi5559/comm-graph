'use strict';

/**
 * classify.cjs — Force-prompt intent classification for comms-graph
 *
 * Uses the same proven technique as stategraph-module's decomposePromptV2:
 * "Return ONLY a single number" with maxTokens:5, temperature:0.1.
 *
 * Intent taxonomy:
 *   0 - handoff              → needs tools/MCPs/automation → enqueue to main stategraph
 *   1 - general_quick        → chitchat, opinions, known facts → direct LLM respond
 *   2 - memory_quick         → quick profile/fact recall (name, favorite color) → user-memory lookup
 *   3 - status_check         → "how is my task going?" → read task journal
 *   4 - control_signal       → cancel/pause/resume → write to journal
 *
 * Falls back to embedding-based classification (classifier-fallback.cjs) if LLM
 * returns an unparseable response.
 */

const fs = require('fs');
const path = require('path');
const logger = require('./logger.cjs');

// ── Intent definitions ─────────────────────────────────────────────────────────
const INTENTS = {
  0: { name: 'handoff',           description: 'Anything needing tools, web search, browser automation, computer actions, deep memory retrieval, scheduling, file operations, or multi-step tasks' },
  1: { name: 'general_quick',    description: 'Chitchat, greetings, opinions, simple knowledge questions the LLM can answer directly without tools' },
  2: { name: 'memory_quick',      description: 'Quick personal fact recall — name, favorite color, email, job, age. Also handles explicit profile fact storage ("my name is X"). NOT deep temporal history or complex queries' },
  3: { name: 'status_check',      description: 'Asking about the status/progress of a running or recently completed task' },
  4: { name: 'control_signal',    description: 'Cancel, pause, resume, or stop a running task' },
  5: { name: 'memory_store',      description: 'Storing a general memory, note, appointment, or event — NOT a personal profile fact. E.g., "i have a dentist appt next week", "remember I have a meeting at 3pm", "note: buy milk tomorrow"' },
};

// ── Load classification prompt ─────────────────────────────────────────────────
function _loadClassifyPrompt() {
  try {
    return fs.readFileSync(path.join(__dirname, '../prompts/classify.md'), 'utf8').trim();
  } catch (_) {
    return null;
  }
}
const CLASSIFY_PROMPT_TEMPLATE = _loadClassifyPrompt();

/**
 * Build the force-classification prompt for a given English user message.
 */
function _buildClassifyMessages(englishText, conversationContext) {
  const intentList = Object.entries(INTENTS)
    .map(([num, info]) => `${num} - ${info.name}: ${info.description}`)
    .join('\n');

  const systemPrompt = CLASSIFY_PROMPT_TEMPLATE
    ? CLASSIFY_PROMPT_TEMPLATE.replace('{{INTENT_LIST}}', intentList)
    : `You are an intent classifier for ThinkDrop AI. Classify the user's message into exactly one of these intents:

${intentList}

Return ONLY a single number (${_intentListStr}). No words, no explanation, no punctuation — just the number.`;

  const userContent = conversationContext
    ? `Conversation context (last 3 turns):\n${conversationContext}\n\nCurrent message: ${englishText}`
    : `Message: ${englishText}`;

  return [
    { role: 'system', content: systemPrompt },
    { role: 'user', content: userContent },
  ];
}

// ── Regex guard for parsing (derived from INTENTS — auto-maintains) ─────────────
const _intentKeys = Object.keys(INTENTS).map(Number);
const _intentMin = Math.min(..._intentKeys);
const _intentMax = Math.max(..._intentKeys);
const NUMBER_RE = new RegExp(`^\\s*([${_intentMin}-${_intentMax}])\\s*$`);
const _EXTRACT_RE = new RegExp(`([${_intentMin}-${_intentMax}])`);
const _intentListStr = _intentKeys.join(', ');

/**
 * Classify an English user message into an intent.
 *
 * @param {string} englishText       - English translation of user input
 * @param {string[]} [conversationContext] - Recent conversation turns for context
 * @returns {Promise<{ intent: number, intentName: string, confidence: number, source: string }>}
 */
async function classify(englishText, conversationContext) {
  if (!englishText || !englishText.trim()) {
    return { intent: 1, intentName: 'general_quick', confidence: 0.5, source: 'empty_input' };
  }

  // ── Try force-prompt classification (primary) ────────────────────────────────
  try {
    const { ask } = require('./llm-providers.cjs');
    const messages = _buildClassifyMessages(englishText, conversationContext);
    const { text, provider } = await ask(messages, {
      maxTokens: 5,
      temperature: 0.1,
      timeoutMs: 12000,
    });

    if (text) {
      const trimmed = text.trim();
      const match = trimmed.match(NUMBER_RE);
      if (match) {
        const intent = parseInt(match[1], 10);
        const info = INTENTS[intent];
        logger.info('[Classify] Force-prompt result', {
          intent, intentName: info.name, provider, text: trimmed,
          inputPreview: englishText.substring(0, 60),
        });
        return { intent, intentName: info.name, confidence: 0.92, source: 'force_prompt' };
      }
      // LLM returned something but not a clean number — try to extract
      const numMatch = trimmed.match(_EXTRACT_RE);
      if (numMatch) {
        const intent = parseInt(numMatch[1], 10);
        const info = INTENTS[intent];
        logger.info('[Classify] Force-prompt (extracted)', {
          intent, intentName: info.name, provider, raw: trimmed,
        });
        return { intent, intentName: info.name, confidence: 0.75, source: 'force_prompt_extracted' };
      }
      logger.warn('[Classify] Force-prompt returned unparseable response', { raw: trimmed, provider });
    }
  } catch (err) {
    logger.warn('[Classify] Force-prompt error', { error: err.message });
  }

  // ── Fallback: default to handoff (safe) ──────────────────────────────────────
  // When the LLM fails, default to handoff — the main stategraph can handle
  // anything (including chitchat — it would just answer directly). Don't run
  // a regex classifier that can misclassify commands as chitchat.
  logger.info('[Classify] LLM failed — defaulting to handoff (safe)');
  return { intent: 0, intentName: 'handoff', confidence: 0.3, source: 'default_handoff' };
}

module.exports = { classify, INTENTS };
