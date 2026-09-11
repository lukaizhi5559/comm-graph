'use strict';

/**
 * statusCheck.cjs — Intent 3: task status query
 *
 * Handles "how is my task going?", "are you done?", "what's the status?"
 * Reads the task journal and responds instantly with progress info.
 * No LLM call needed for the data — only for naturalizing the response.
 */

const logger = require('../logger.cjs');
const { ask, buildMessages } = require('../llm-providers.cjs');
const { formatStatusSummary, getActiveTasks, getRecentTasks } = require('../taskJournal.cjs');

// ── Status query patterns ──────────────────────────────────────────────────────
const STATUS_PATTERNS = [
  /\bhow\s+(is|'s)\s+(that|it|the)\b/i,
  /\bwhat('?s| is)\s+the\s+status\b/i,
  /\bare\s+you\s+done\b/i,
  /\bstill\s+running\b/i,
  /\bhow\s+far\s+along\b/i,
  /\bany\s+progress\b/i,
  /\bcoming\s+along\b/i,
];

/**
 * Check if a message is a status query.
 * @param {string} englishText
 * @returns {boolean}
 */
function isStatusQuery(englishText) {
  return STATUS_PATTERNS.some(p => p.test(englishText));
}

/**
 * @param {string} englishText  - English user message
 * @param {string} systemPrompt - Full system prompt (persona + personality)
 * @returns {Promise<{ text: string, fullText: string, metadata: Object }>}
 */
async function execute(englishText, systemPrompt) {
  // Get status summary from task journal
  const summary = formatStatusSummary();

  logger.info('[StatusCheck] Summary', {
    activeCount: getActiveTasks().length,
    recentCount: getRecentTasks().length,
    summaryPreview: summary.substring(0, 80),
  });

  if (summary === 'Nothing is currently running. The slate is clean.') {
    // No active tasks — respond directly
    return {
      text: summary,
      fullText: summary,
      metadata: { source: 'status_check_empty', intent: 3 },
    };
  }

  // Naturalize the status summary through the personality layer
  const naturalizePrompt = `The user asked: "${englishText}"\n\nCurrent task status:\n${summary}\n\nRespond naturally in 1-2 sentences as ThinkDrop. Summarize what's running and the progress. No markdown. Be conversational.`;
  const messages = buildMessages(naturalizePrompt, systemPrompt);
  const { text: naturalized } = await ask(messages, {
    maxTokens: 100,
    temperature: 0.7,
    timeoutMs: 5000,
  });

  const response = naturalized || summary;

  return {
    text: response,
    fullText: response,
    metadata: { source: 'status_check', intent: 3, taskCount: getActiveTasks().length },
  };
}

module.exports = { execute, isStatusQuery };
