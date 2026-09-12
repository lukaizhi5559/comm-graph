'use strict';

/**
 * memoryQuick.cjs — Intent 2: quick personal fact recall
 *
 * Handles quick profile/fact lookups: name, favorite color, email, job, age.
 * Queries the user-memory-service (port 3001) for profile data.
 * NOT for deep temporal history or complex queries — those are handoffs.
 *
 * Target response time: <2s (memory service call + LLM naturalization)
 */

const http = require('http');
const logger = require('../logger.cjs');
const { ask, buildMessages } = require('../llm-providers.cjs');

const MEMORY_PORT = parseInt(process.env.MEMORY_SERVICE_PORT || '3001', 10);
const MEM_API_KEY = process.env.MCP_USER_MEMORY_API_KEY || process.env.USER_MEMORY_API_KEY || process.env.MCP_API_KEY || '';

// ── Quick fact patterns ────────────────────────────────────────────────────────
// Maps user query patterns to memory-service profile keys
const FACT_PATTERNS = [
  { pattern: /\bwhat('?s| is)\s+my\s+name\b|do\s+you\s+know\s+my\s+name\b/i, key: 'name', label: 'name' },
  { pattern: /\bwhat('?s| is)\s+my\s+(email|e-mail)\b/i, key: 'email', label: 'email' },
  { pattern: /\bwhat('?s| is)\s+my\s+favorite\s+color\b/i, key: 'favorite_color', label: 'favorite color' },
  { pattern: /\bhow\s+old\s+am\s+i\b/i, key: 'age', label: 'age' },
  { pattern: /\bwhat('?s| is)\s+my\s+(job|occupation|profession)\b/i, key: 'job', label: 'job' },
  { pattern: /\bwhat('?s| is)\s+my\s+phone\s+number\b/i, key: 'phone', label: 'phone number' },
  { pattern: /\bwhere\s+do\s+i\s+(live|work)\b/i, key: 'location', label: 'location' },
  { pattern: /\bwhat('?s| is)\s+my\s+birthday\b/i, key: 'birthday', label: 'birthday' },
];

/**
 * Detect which profile fact the user is asking about.
 * @param {string} englishText
 * @returns {{ key: string, label: string }|null}
 */
function detectFactQuery(englishText) {
  for (const { pattern, key, label } of FACT_PATTERNS) {
    if (pattern.test(englishText)) return { key, label };
  }
  return null;
}

/**
 * Query user-memory-service for a profile fact.
 * @param {string} key
 * @returns {Promise<string|null>} the fact value, or null if not found
 */
function _queryMemory(key) {
  return new Promise((resolve) => {
    const body = JSON.stringify({
      version: 'mcp.v1',
      service: 'user-memory',
      action: 'profile.get',
      payload: { key },
      requestId: 'cg_mem_' + Date.now(),
    });
    const headers = { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) };
    if (MEM_API_KEY) headers['Authorization'] = 'Bearer ' + MEM_API_KEY;

    const req = http.request({
      hostname: '127.0.0.1',
      port: MEMORY_PORT,
      path: '/profile.get',
      method: 'POST',
      headers,
      timeout: 3000,
    }, (res) => {
      let raw = '';
      res.on('data', c => { raw += c; });
      res.on('end', () => {
        try {
          const parsed = JSON.parse(raw);
          const value = parsed?.data?.value || parsed?.data?.[key] || null;
          resolve(value);
        } catch (_) { resolve(null); }
      });
    });
    req.on('error', () => resolve(null));
    req.on('timeout', () => { req.destroy(); resolve(null); });
    req.write(body);
    req.end();
  });
}

/**
 * @param {string} englishText  - English user message
 * @param {string} systemPrompt - Full system prompt (persona + personality)
 * @param {string} [conversationContext] - Recent conversation turns for context awareness
 * @returns {Promise<{ text: string, fullText: string, metadata: Object }>}
 */
async function execute(englishText, systemPrompt, conversationContext) {
  const fact = detectFactQuery(englishText);

  if (!fact) {
    // Not a recognizable quick fact — this shouldn't happen (classifier should
    // have routed to handoff), but handle gracefully.
    logger.info('[MemoryQuick] No fact pattern matched, falling back', { text: englishText.substring(0, 60) });
    return {
      text: "Let me check your records — I'll have that for you in a moment.",
      fullText: "Let me check your records — I'll have that for you in a moment.",
      metadata: { source: 'memory_quick_no_match', intent: 2, shouldHandoff: true },
    };
  }

  logger.info('[MemoryQuick] Looking up', { key: fact.key, label: fact.label });

  const value = await _queryMemory(fact.key);

  if (!value) {
    // Fact not in memory — respond honestly
    const response = `I don't seem to have your ${fact.label} on record. If you tell me, I'll remember it for next time.`;
    logger.info('[MemoryQuick] Not found', { key: fact.key });
    return {
      text: response,
      fullText: response,
      metadata: { source: 'memory_quick_not_found', intent: 2, factKey: fact.key },
    };
  }

  // Naturalize the response through the personality layer
  const naturalizePrompt = `The user asked: "${englishText}"\nTheir ${fact.label} is: ${value}\nRespond naturally in 1-2 sentences as ThinkDrop. No markdown. Be conversational, not robotic.`;
  const messages = buildMessages(naturalizePrompt, systemPrompt, conversationContext);
  const { text: naturalized } = await ask(messages, {
    maxTokens: 100,
    temperature: 0.7,
    timeoutMs: 5000,
  });

  const response = naturalized || `Your ${fact.label} is ${value}.`;

  logger.info('[MemoryQuick] Found', { key: fact.key, valuePreview: String(value).substring(0, 40) });

  return {
    text: response,
    fullText: response,
    metadata: { source: 'memory_quick', intent: 2, factKey: fact.key, factValue: value },
  };
}

module.exports = { execute, detectFactQuery };
