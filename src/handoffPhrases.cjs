'use strict';

/**
 * handoffPhrases.cjs — Intent-specific acknowledgment phrases for handoff
 *
 * When comms-graph can't answer a prompt directly (needs main state graph),
 * it picks a phrase from the intent-specific pool so the user gets an
 * immediate, natural, varied response that matches what ThinkDrop is about
 * to do — instead of a generic "routing to ThinkDrop".
 *
 * Phrases are short, personable, and match ThinkDrop's tone.
 * Emojis are included for mood/personality where appropriate.
 */

// ── Intent-specific phrase pools ──────────────────────────────────────────────
const HANDOFF_PHRASES = {
  // Web search — "let me look that up online" energy
  web_search: [
    'One sec while I look that up online. 🔍',
    'Let me search for that — back in a moment.',
    'Looking that up now… 🔎',
    'Give me a sec — checking the web for you.',
    'On it — pulling that up from the web.',
    'Let me find you a solid answer on that. 🌐',
    'Searching now — won\'t be a moment.',
    'Hold on, let me look that up for you.',
  ],

  // Memory retrieval — "trying to remember" energy
  memory_retrieve: [
    'Hmm, one moment — trying to remember. 🤔',
    'Hold on, let me check my memory…',
    'Thinking… give me just a second. 💭',
    'Let me dig into that for you — one moment.',
    'Checking my notes on that. 📝',
    'Let me see what I can recall…',
    'One sec — looking through my memories.',
    'Hold on, that\'s in here somewhere…',
  ],

  // Command automation — "on it, doing that now" energy
  command_automate: [
    'On it — I\'ll look into that now. ⚡',
    'Got it — starting that right away.',
    'Let me take care of that for you. ✨',
    'Working on it now — won\'t be long.',
    'Sure thing — getting that done.',
    'On the case. 🛠️',
    'Let me handle that for you now.',
    'Got it — one moment while I set that up.',
  ],

  // General fallback (unknown intent or screen_intelligence)
  general_handoff: [
    'One moment.',
    'On it.',
    'Let me look into that.',
    'Give me a second.',
    'Checking now.',
    'Let me check.',
    'Hold on — I\'ll find out.',
    'Just a moment.',
    'Working on it.',
    'Let me think about that.',
    'Give me a beat.',
    'Hang tight.',
  ],
};

// ── Goal extraction for command_automate ───────────────────────────────────────
// Extracts the core action+object from a prompt so the phrase can reference it
// (e.g., "Open Google Docs and create a document" → "Creating that document now.")
const _GOAL_PATTERNS = [
  { regex: /\b(?:create|make|new)\s+(?:a\s+)?(?:document|doc|note|page|file|spreadsheet|sheet|presentation|slide|playlist|album)\b/i, phrase: (m) => `Creating that ${m[0].replace(/^(?:create|make|new)\s+(?:a\s+)?/i, '').trim()} now. ✨` },
  { regex: /\b(?:send|email|message|text|dm)\s+/i, phrase: (m) => `Sending that now. 📨` },
  { regex: /\b(?:open|launch|go to|navigate to)\s+/i, phrase: (m) => `Opening that up now. 🚀` },
  { regex: /\b(?:search|find|look up|look for)\s+/i, phrase: (m) => `Looking that up now. 🔍` },
  { regex: /\b(?:schedule|remind|set (?:a )?reminder)\b/i, phrase: (m) => `Setting that up now. ⏰` },
  { regex: /\b(?:update|edit|modify|change|rename)\s+/i, phrase: (m) => `Updating that now. ✏️` },
  { regex: /\b(?:delete|remove|close|cancel)\s+/i, phrase: () => `Taking care of that now.` },
];

/**
 * Try to generate a goal-specific phrase for command_automate prompts.
 * Returns null if no pattern matches.
 * @param {string} promptText
 * @returns {string|null}
 */
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

// ── Last-index tracking per pool to avoid repeats ──────────────────────────────
const _lastIndex = {};

/**
 * Get an intent-specific handoff phrase.
 *
 * @param {string} intentName - One of: 'web_search', 'memory_retrieve', 'command_automate',
 *                              'general_knowledge', 'screen_intelligence', or null
 * @param {string} [promptText] - The user's prompt (for goal extraction in command_automate)
 * @returns {string}
 */
function getHandoffPhrase(intentName, promptText) {
  // Map stategraph intent names to our pools
  let poolKey = 'general_handoff';
  if (intentName === 'web_search' || intentName === 'general_knowledge') {
    poolKey = 'web_search';
  } else if (intentName === 'memory_retrieve') {
    poolKey = 'memory_retrieve';
  } else if (intentName === 'command_automate') {
    poolKey = 'command_automate';
  }

  // For command_automate, try goal-specific phrase first (more personal)
  if (poolKey === 'command_automate') {
    const goalPhrase = _extractGoalPhrase(promptText);
    if (goalPhrase && Math.random() < 0.6) {
      return goalPhrase;
    }
  }

  const pool = HANDOFF_PHRASES[poolKey] || HANDOFF_PHRASES.general_handoff;
  if (pool.length <= 1) return pool[0];

  let idx;
  const last = _lastIndex[poolKey] ?? -1;
  do {
    idx = Math.floor(Math.random() * pool.length);
  } while (idx === last);
  _lastIndex[poolKey] = idx;
  return pool[idx];
}

/**
 * Get a random handoff phrase (legacy API — uses general pool).
 * Kept for backward compatibility.
 * @returns {string}
 */
function getRandomHandoffPhrase() {
  return getHandoffPhrase(null, null);
}

// Legacy export of the flat phrase list (for any code that imports PHRASES directly)
const PHRASES = HANDOFF_PHRASES.general_handoff;

module.exports = { PHRASES, HANDOFF_PHRASES, getHandoffPhrase, getRandomHandoffPhrase };
