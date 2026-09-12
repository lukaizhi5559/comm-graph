'use strict';

/**
 * handoffPhrases.cjs — Intent-specific acknowledgment phrases for handoff
 *
 * When comms-graph can't answer a prompt directly (needs main state graph),
 * it picks a phrase from the intent-specific pool so the user gets an
 * immediate, natural, varied response that matches what ThinkDrop is about
 * to do — instead of a generic "routing to ThinkDrop".
 *
 * Phrases are loaded from handoffPhrases.json — a multilingual pool with
 * ~8-12 phrases per intent per language (en, zh, es, fr, pt, ar, ja, ko, hi,
 * de, it, ru). For languages NOT in the pool, no phrase is displayed.
 *
 * command_automate phrases are LLM-generated (see getCommandAutomatePhrase).
 */

const fs = require('fs');
const path = require('path');
const logger = require('./logger.cjs');

// ── Load multilingual phrase pool from JSON ────────────────────────────────────
function _loadPhrasePool() {
  try {
    const jsonPath = path.join(__dirname, 'handoffPhrases.json');
    const raw = fs.readFileSync(jsonPath, 'utf8');
    return JSON.parse(raw);
  } catch (err) {
    logger.warn('[HandoffPhrases] Failed to load handoffPhrases.json', { error: err.message });
    return {};
  }
}

const HANDOFF_PHRASES_JSON = _loadPhrasePool();

// ── Legacy English-only pools (for backward compat with getHandoffPhrase) ──────
// Kept so existing callers that don't pass a language still work.
const HANDOFF_PHRASES = {
  web_search: HANDOFF_PHRASES_JSON.web_search?.en || [],
  memory_retrieve: HANDOFF_PHRASES_JSON.memory_retrieve?.en || [],
  command_automate: [
    'On it — I\'ll look into that now. ⚡',
    'Got it — starting that right away.',
    'Let me take care of that for you. ✨',
    'Working on it now — won\'t be long.',
    'Sure thing — getting that done.',
    'On the case. �️',
    'Let me handle that for you now.',
    'Got it — one moment while I set that up.',
  ],
  general_handoff: HANDOFF_PHRASES_JSON.general_handoff?.en || [
    'One moment.', 'On it.', 'Let me look into that.', 'Give me a second.',
    'Checking now.', 'Let me check.', 'Hold on — I\'ll find out.', 'Just a moment.',
    'Working on it.', 'Let me think about that.', 'Give me a beat.', 'Hang tight.',
  ],
};

// ── Last-index tracking per pool to avoid repeats ──────────────────────────────
const _lastIndex = {};

/**
 * Pick a random phrase from a pool, avoiding immediate repeats.
 * @param {string[]} pool
 * @param {string} poolKey - for last-index tracking
 * @returns {string}
 */
function _pickRandom(pool, poolKey) {
  if (!pool || pool.length === 0) return '';
  if (pool.length === 1) return pool[0];
  let idx;
  const last = _lastIndex[poolKey] ?? -1;
  do {
    idx = Math.floor(Math.random() * pool.length);
  } while (idx === last);
  _lastIndex[poolKey] = idx;
  return pool[idx];
}

/**
 * Get an intent-specific handoff phrase for a non-command_automate intent.
 *
 * @param {string|null} guessedIntent - 'web_search', 'memory_retrieve', 'screen_analysis',
 *                                       'general_knowledge', or null (regex miss → general)
 * @param {string} language - ISO 639-1 language code (e.g. 'en', 'es', 'zh')
 * @param {string} [promptText] - The user's prompt (unused for non-CA, kept for API compat)
 * @returns {string} The phrase, or empty string if language not in pool
 */
function getHandoffPhraseForIntent(guessedIntent, language, promptText) {
  // Map guessed intent to pool key
  let poolKey = 'general_handoff';
  if (guessedIntent === 'web_search' || guessedIntent === 'general_knowledge') {
    poolKey = 'web_search';
  } else if (guessedIntent === 'memory_retrieve') {
    poolKey = 'memory_retrieve';
  } else if (guessedIntent === 'screen_analysis' || guessedIntent === 'screen_intelligence') {
    poolKey = 'screen_analysis';
  } else if (guessedIntent === 'command_automate') {
    // command_automate uses LLM generation — caller should use getCommandAutomatePhrase
    // Fall back to general pool if called here
    poolKey = 'general_handoff';
  }

  const langCode = (language || 'en').toLowerCase();
  const pool = HANDOFF_PHRASES_JSON[poolKey]?.[langCode];

  if (!pool || pool.length === 0) {
    // Language not in pool — return empty string (no phrase displayed)
    logger.info('[HandoffPhrases] No pool for', { poolKey, langCode });
    return '';
  }

  return _pickRandom(pool, `${poolKey}:${langCode}`);
}

/**
 * Generate a command_automate handoff phrase using the LLM.
 * Falls back to a static English pool if LLM fails.
 *
 * @param {string} englishPrompt - The user's prompt (English)
 * @param {string} [conversationContext] - Recent conversation turns
 * @returns {Promise<string>} The generated phrase
 */
async function getCommandAutomatePhrase(englishPrompt, conversationContext) {
  // Try LLM generation
  try {
    const { ask } = require('./llm-providers.cjs');
    const systemPrompt = `You are ThinkDrop AI. The user asked you to do something that requires running a background task (browser automation, app control, file operations, etc.).

Generate a SINGLE natural, warm sentence that:
1. Acknowledges you'll handle the task in the background
2. Says you'll notify them when it's done
3. Asks what else you can help with

Be brief, casual, and friendly. No markdown, no emojis, no bullet points. Just one sentence.

Examples:
- "I'll run that in the background and let you know when done. What else can I help you with?"
- "I'll take care of that and notify you when it's finished. Anything else?"
- "On it — I'll let you know as soon as it's done. What else can I do for you?"`;

    const userContent = conversationContext
      ? `Conversation context:\n${conversationContext}\n\nUser request: ${englishPrompt}`
      : `User request: ${englishPrompt}`;

    const { text } = await ask([
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userContent },
    ], {
      maxTokens: 60,
      temperature: 0.7,
      timeoutMs: 5000,
    });

    if (text && text.trim()) {
      const phrase = text.trim();
      logger.info('[HandoffPhrases] LLM-generated CA phrase', {
        preview: phrase.substring(0, 80),
      });
      return phrase;
    }
  } catch (err) {
    logger.warn('[HandoffPhrases] LLM CA phrase failed, using fallback', { error: err.message });
  }

  // Fallback: static English pool
  const fallbackPool = [
    "I'll run that in the background and let you know when done. What else can I help you with?",
    "I'll take care of that and notify you when it's finished. Anything else?",
    "On it — I'll let you know as soon as it's done. What else can I do for you?",
    "Got it — running that now. I'll notify you when complete. What else?",
  ];
  return _pickRandom(fallbackPool, 'command_automate:fallback');
}

// ── Legacy: Goal extraction for command_automate (kept for backward compat) ────
const _GOAL_PATTERNS = [
  { regex: /\b(?:create|make|new)\s+(?:a\s+)?(?:document|doc|note|page|file|spreadsheet|sheet|presentation|slide|playlist|album)\b/i, phrase: (m) => `Creating that ${m[0].replace(/^(?:create|make|new)\s+(?:a\s+)?/i, '').trim()} now. ✨` },
  { regex: /\b(?:send|email|message|text|dm)\s+/i, phrase: (m) => `Sending that now. 📨` },
  { regex: /\b(?:open|launch|go to|navigate to)\s+/i, phrase: (m) => `Opening that up now. 🚀` },
  { regex: /\b(?:search|find|look up|look for)\s+/i, phrase: (m) => `Looking that up now. 🔍` },
  { regex: /\b(?:schedule|remind|set (?:a )?reminder)\b/i, phrase: (m) => `Setting that up now. ⏰` },
  { regex: /\b(?:update|edit|modify|change|rename)\s+/i, phrase: (m) => `Updating that now. ✏️` },
  { regex: /\b(?:delete|remove|close|cancel)\s+/i, phrase: () => `Taking care of that now.` },
];

function _extractGoalPhrase(promptText) {
  if (!promptText) return null;
  for (const { regex, phrase } of _GOAL_PATTERNS) {
    const match = promptText.match(regex);
    if (match) {
      try { return phrase(match); } catch (_) { return null; }
    }
  }
  return null;
}

/**
 * Legacy: Get an intent-specific handoff phrase (English-only, from in-file pools).
 * Kept for backward compatibility. New code should use getHandoffPhraseForIntent.
 *
 * @param {string} intentName - One of: 'web_search', 'memory_retrieve', 'command_automate',
 *                              'general_knowledge', 'screen_intelligence', or null
 * @param {string} [promptText] - The user's prompt (for goal extraction in command_automate)
 * @returns {string}
 */
function getHandoffPhrase(intentName, promptText) {
  let poolKey = 'general_handoff';
  if (intentName === 'web_search' || intentName === 'general_knowledge') {
    poolKey = 'web_search';
  } else if (intentName === 'memory_retrieve') {
    poolKey = 'memory_retrieve';
  } else if (intentName === 'command_automate') {
    poolKey = 'command_automate';
  }

  if (poolKey === 'command_automate') {
    const goalPhrase = _extractGoalPhrase(promptText);
    if (goalPhrase && Math.random() < 0.6) {
      return goalPhrase;
    }
  }

  const pool = HANDOFF_PHRASES[poolKey] || HANDOFF_PHRASES.general_handoff;
  if (!pool || pool.length <= 1) return pool[0] || '';

  let idx;
  const last = _lastIndex[poolKey] ?? -1;
  do {
    idx = Math.floor(Math.random() * pool.length);
  } while (idx === last);
  _lastIndex[poolKey] = idx;
  return pool[idx];
}

/**
 * Legacy: Get a random handoff phrase (uses general pool).
 * @returns {string}
 */
function getRandomHandoffPhrase() {
  return getHandoffPhrase(null, null);
}

// Legacy export of the flat phrase list (for any code that imports PHRASES directly)
const PHRASES = HANDOFF_PHRASES.general_handoff;

module.exports = {
  PHRASES,
  HANDOFF_PHRASES,
  getHandoffPhrase,
  getRandomHandoffPhrase,
  getHandoffPhraseForIntent,
  getCommandAutomatePhrase,
};
