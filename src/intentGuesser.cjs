'use strict';

/**
 * intentGuesser.cjs — Lightweight regex-based intent guesser for handoff phrases
 *
 * When comms-graph classifies a prompt as intent 0 (handoff), this module
 * guesses which stategraph intent (web_search, memory_retrieve, screen_analysis,
 * command_automate, etc.) the prompt is likely to be, so comms-graph can:
 *   1. Pick the right handoff phrase pool (multilingual static phrases)
 *   2. Signal the renderer to play the right intent sound
 *
 * This is a HINT — the stategraph's parseIntentV2 does the real classification.
 * The regex doesn't need to be 100% accurate; if it misses, the default generic
 * phrase + default sound are used.
 *
 * Pattern precedence matters: more specific patterns (command_automate with
 * named apps) are checked before general patterns (web_search keywords).
 */

const logger = require('./logger.cjs');

// ── Named apps/sites that indicate command_automate (not web_search) ──────────
const _NAMED_APP_RE = /\b(chatgpt|chat\s*gpt|openai|claude|anthropic|perplexity|grok|x\.ai|gmail|google\s*mail|youtube|yt|amazon|twitter|x\.com|tweet|reddit|github|git\s*hub|notion|slack|spotify|netflix|whatsapp|telegram|discord|linkedin|facebook|instagram|tiktok|maps|google\s*maps|apple\s*music|zoom|figma|vscode|vs\s*code|safari|chrome|firefox|edge|word|excel|powerpoint|outlook|calendar|notion|dropbox|drive|google\s*docs|google\s*sheets|google\s*slides)\b/i;

// ── Action verbs that indicate command_automate ───────────────────────────────
const _ACTION_VERB_RE = /\b(open|close|send|email|message|text|dm|post|share|create|make|new|delete|remove|cancel|navigate|go\s+to|launch|start|stop|schedule|remind|set\s+a\s+reminder|update|edit|modify|change|rename|fill|submit|download|upload|copy|paste|click|type|press|install|uninstall|sign\s+in|log\s+in|log\s+out)\b/i;

// ── Intent patterns (ordered by specificity — first match wins) ──────────────
// Order matters: web_search must be checked BEFORE general_knowledge so that
// "What is the best pizza?" matches web_search (recommendation) not general_knowledge.
const INTENT_PATTERNS = [
  // ── command_automate: named app + action verb ───────────────────────────────
  // "Open Chrome and go to google.com", "Send an email via Gmail", "Post on Twitter"
  {
    intent: 'command_automate',
    test: (text) => {
      // Named app with an action verb → command_automate
      if (_NAMED_APP_RE.test(text) && _ACTION_VERB_RE.test(text)) return true;
      // Action verb + specific site (e.g. "go to amazon.com")
      if (/\b(go\s+to|navigate\s+to|open|launch)\s+\S+\.(com|org|net|io|ai|co|app|gov|edu)\b/i.test(text)) return true;
      // Scheduling/reminders (always command_automate)
      if (/\b(schedule|remind|set\s+a\s+reminder|set\s+an\s+alarm|timer|cron)\b/i.test(text)) return true;
      // File operations
      if (/\b(create|make|new|delete|rename|move|copy)\s+(a\s+)?(file|folder|document|doc|note|page|spreadsheet|sheet|presentation|slide|playlist)\b/i.test(text)) return true;
      // Browser automation keywords
      if (/\b(click|type\s+into|fill\s+(out|in)|submit|press\s+(the\s+)?(button|key|enter))\b/i.test(text)) return true;
      return false;
    },
  },

  // ── screen_analysis: "what's on my screen", "describe what I see" ────────────
  {
    intent: 'screen_analysis',
    test: (text) => {
      if (/\b(what'?s\s+on\s+(my\s+)?screen|what\s+am\s+i\s+looking\s+at|what\s+i'?m\s+looking\s+at|describe\s+(what'?s\s+on|what\s+i'?m\s+looking\s+at)|read\s+(what'?s\s+)?on\s+screen|what\s+(does|do)\s+(my|the)\s+screen\s+show|what\s+app\s+am\s+i\s+in|what'?s\s+the\s+active\s+app|what\s+window\s+is\s+open|analyze\s+(the\s+)?screen|scan\s+(my\s+)?screen)\b/i.test(text)) return true;
      return false;
    },
  },

  // ── memory_retrieve: "do you remember", "what did we talk about" ────────────
  {
    intent: 'memory_retrieve',
    test: (text) => {
      // Conversation recall
      if (/\b(did\s+we\s+talk|do\s+you\s+remember|have\s+we\s+(talked|discussed|mentioned)|what\s+did\s+we\s+(talk|discuss)|what\s+were\s+we\s+talking|what\s+did\s+i\s+(just\s+)?(ask|say)|what\s+was\s+my\s+last|we\s+talked\s+about|look\s+(that|it)\s+up\s+in\s+(your\s+)?(memory|conversation|chat|history)|check\s+(your\s+)?(memory|conversation|chat|history)|in\s+our\s+(conversation|chat|history)|remind\s+me\s+what\s+we)\b/i.test(text)) return true;
      // Personal fact recall
      if (/\b(what'?s\s+my\s+(name|email|phone|favorite|address|job|age|birthday)|who\s+is\s+my\s+(wife|husband|mom|dad|brother|sister|boss)|what\s+do\s+you\s+know\s+about\s+my|show\s+my\s+(info|profile|contacts|family)|list\s+my\s+(info|contacts|family|appointments|meetings))\b/i.test(text)) return true;
      // Episodic memory
      if (/\b(what\s+was\s+i\s+(doing|working\s+on|looking\s+at)|what\s+did\s+i\s+(do|see|was\s+doing)\s+(yesterday|today|earlier|this\s+morning|this\s+week|recently)|show\s+me\s+(my\s+)?(recent|past)\s+(activity|screen|history))\b/i.test(text)) return true;
      return false;
    },
  },

  // ── web_search: "what's the best X", "latest Y", "current Z" ────────────────
  // MUST be checked before general_knowledge so "What is the best pizza?" matches
  // web_search (recommendation) not general_knowledge (stable fact).
  {
    intent: 'web_search',
    test: (text) => {
      // Explicit web search
      if (/\b(search\s+(the\s+)?(web|internet|online)|google\s+(this|that|for)|look\s+(that|this|it)\s+up\s+online|find\s+(me\s+)?(online|on\s+the\s+web))\b/i.test(text)) return true;
      // "Best X" / "top X" (recommendations need search)
      // Matches both "What's the best X" and "What is the best X"
      if (/\b(what'?(?:s|\s+is)\s+the\s+best|what\s+are\s+the\s+best|top\s+\d+|best\s+\w+\s+(for|to|in)|recommend\s+(a|an|some))\b/i.test(text)) return true;
      // Time-sensitive queries
      if (/\b(latest|current|today'?s|this\s+week'?s|recent\s+news|what\s+happened\s+today|right\s+now|as\s+of\s+(now|today))\b/i.test(text)) return true;
      // Current office-holders / live data
      if (/\b(who\s+is\s+the\s+current|who\s+is\s+the\s+\w+\s+right\s+now|what\s+is\s+the\s+latest|price\s+of|weather\s+(in|today|forecast)|stock\s+price)\b/i.test(text)) return true;
      // General factual question that needs live data
      if (/\b(how\s+many\s+(people|users|countries)|what\s+is\s+the\s+population|what\s+is\s+happening)\b/i.test(text)) return true;
      return false;
    },
  },

  // ── general_knowledge: stable facts the LLM can answer (but was handed off) ──
  // Checked LAST — only matches if no more specific intent matched.
  {
    intent: 'general_knowledge',
    test: (text) => {
      if (/\b(what\s+is|what\s+are|who\s+wrote|who\s+(was|were|invented|discovered)|when\s+(was|did)|where\s+is|how\s+does|explain|define|tell\s+me\s+about)\b/i.test(text)) return true;
      return false;
    },
  },
];

/**
 * Guess the stategraph intent from the English prompt text.
 * Returns the guessed intent name, or null if no pattern matches.
 *
 * @param {string} englishText - English translation of user prompt
 * @returns {{ guessedIntent: string|null, confidence: number }}
 */
function guess(englishText) {
  if (!englishText || !englishText.trim()) {
    return { guessedIntent: null, confidence: 0 };
  }

  for (const { intent, test } of INTENT_PATTERNS) {
    try {
      if (test(englishText)) {
        logger.info('[IntentGuesser] Matched', {
          intent,
          textPreview: englishText.substring(0, 60),
        });
        return { guessedIntent: intent, confidence: 0.75 };
      }
    } catch (_) {
      // Continue to next pattern on error
    }
  }

  logger.info('[IntentGuesser] No match — defaulting to null', {
    textPreview: englishText.substring(0, 60),
  });
  return { guessedIntent: null, confidence: 0 };
}

module.exports = { guess };
