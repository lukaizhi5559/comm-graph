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
const _NAMED_APP_RE = /\b(chatgpt|chat\s*gpt|openai|claude|anthropic|perplexity|grok|x\.ai|gmail|google\s*mail|youtube|yt|amazon|twitter|x\.com|tweet|reddit|github|git\s*hub|notion|slack|spotify|netflix|whatsapp|telegram|discord|linkedin|facebook|instagram|tiktok|maps|google\s*maps|apple\s*music|zoom|figma|vscode|vs\s*code|safari|chrome|firefox|edge|word|excel|powerpoint|outlook|calendar|dropbox|drive|google\s*docs|google\s*sheets|google\s*slides)\b/i;

// ── Action verbs that indicate command_automate (paired with a named app) ─────
// Lookup verbs (search/find/check) are intentionally EXCLUDED — "search X on
// YouTube" is a lookup on a site, which the stategraph routes as web_search.
const _ACTION_VERB_RE = /\b(open|close|send|post|share|create|make|new|delete|remove|cancel|navigate|go\s+to|launch|start|stop|schedule|remind|update|edit|modify|change|rename|fill|submit|download|upload|copy|paste|click|type|press|install|uninstall|sign\s+in|log\s+in|log\s+out|play|pause|watch|listen|order|book|buy|shop|browse|scroll|refresh|reload|turn|toggle|enable|disable|connect|disconnect|pair|mute|unmute|record|print|quit|restart|shut\s*down|lock|unlock|sleep|wake|minimize|maximize|screenshot|snap|capture|adjust|set)\b/i;

// ── Episodic-recall markers — used by memory_retrieve and as a command_automate
// guard so "what was I watching on Netflix" isn't stolen by named-app + verb.
const _EPISODIC_RE = /\b(yesterday|last\s+(night|week|time|monday|tuesday|wednesday|thursday|friday|saturday|sunday)|this\s+(morning|afternoon)|earlier(\s+today)?|a\s+(few|couple)\s+(minutes|hours|days|weeks)\s+ago|the\s+other\s+day|what\s+was\s+i|was\s+i\s+(watching|listening|reading|playing|browsing|looking)|what\s+did\s+i|what\s+was\s+on\s+my\s+screen)\b/i;

// ── Intent patterns (ordered by specificity — first match wins) ──────────────
// Order: screen_analysis (most specific) → memory_retrieve (recall must beat
// named-app + action-verb hits like "what was I watching on Netflix") →
// command_automate → web_search → general_knowledge (last — only matches if
// nothing more specific did).
const INTENT_PATTERNS = [
  // ── screen_analysis: "what's on my screen", "describe what I see" ────────────
  {
    intent: 'screen_analysis',
    test: (text) => {
      if (/\b(what'?s\s+on\s+(my\s+)?screen|what\s+am\s+i\s+looking\s+at|what\s+i'?m\s+looking\s+at|describe\s+(what'?s\s+on|what\s+i'?m\s+looking\s+at)|read\s+(what'?s\s+)?on\s+screen|what\s+(does|do)\s+(my|the)\s+screen\s+show|what\s+app\s+am\s+i\s+in|what'?s\s+the\s+active\s+app|what\s+window\s+is\s+open|analyze\s+(the\s+|my\s+)?screen|scan\s+(my\s+)?screen|what\s+app\s+is\s+(open|focused|running)|what\s+program\s+is\s+running|what\s+is\s+currently\s+displayed|check\s+(this|the)\s+\w+\s+on\s+(my\s+|the\s+)?screen)\b/i.test(text)) return true;
      return false;
    },
  },

  // ── memory_retrieve: recall of conversation, personal info, past activity ───
  // Checked BEFORE command_automate so episodic phrasing wins over named apps
  // ("what was I watching on Netflix" → recall, not automation).
  {
    intent: 'memory_retrieve',
    test: (text) => {
      // Conversation recall
      if (/\b(did\s+we\s+talk|do\s+you\s+remember|have\s+we\s+(talked|discussed|mentioned|chatted|chatting)|what\s+did\s+we\s+(talk|chat|discuss|go\s+over|cover|speak)|what\s+(were|have|had)\s+we\s+(been\s+)?(talk\w*|chat\w*|discuss\w*)|we'?ve\s+been\s+\w{0,10}\s*(talk\w*|chat\w*|discuss\w*)|what\s+did\s+i\s+(just\s+)?(ask|say|tell\s+you)|what\s+was\s+my\s+last|we\s+(talked|discussed|spoke|chatted|went\s+over|covered)\s+about|previous\s+(conversation|chat)|conversation\s+(history|logs?)|chat\s+(history|logs?)|conversations?\s+with\s+you|messages?\s+we\s+(chatted|talked|sent|exchanged)|look\s+(that|it)\s+up\s+in\s+(your\s+)?(memory|conversation|chat|history)|check\s+(your\s+)?(memory|conversation|chat|history)|in\s+our\s+(conversation|chat|history)|remind\s+me\s+what\s+we|didn'?t\s+i\s+(say|tell|mention|ask)|you\s+(told|said|mentioned)\s+(me|that)|earlier\s+you\s+(said|told|mentioned))\b/i.test(text)) return true;
      // Personal fact recall
      if (/\b(what'?s\s+my\s+(name|email|phone|favorite|address|job|age|birthday|number|wifi|password|username)|who\s+is\s+my\s+(wife|husband|mom|dad|brother|sister|boss|doctor|dentist|lawyer|manager)|what\s+do\s+you\s+know\s+about\s+my|show\s+my\s+(info|profile|contacts|family|notes|bookmarks)|list\s+my\s+(info|contacts|family|appointments|meetings|notes))\b/i.test(text)) return true;
      // Third-party personal data: "what's John's number", "Sarah's email"
      if (/\bwhat'?s\s+\w+'?s\s+(phone|number|email|e-?mail|address|birthday|contact|cell)\b/i.test(text)) return true;
      // Stored-item checks: "do I have X saved", "did I save that number"
      if (/\b(do\s+i\s+have\s+.{0,30}\b(saved|stored|noted|bookmarked)|have\s+i\s+(saved|stored|got|noted|written)|did\s+i\s+(save|store|note|write\s+down|bookmark))\b/i.test(text)) return true;
      // Episodic memory — past activity / screen / media history
      if (/\b(what\s+was\s+i\s+(doing|working\s+on|looking\s+at|watching|listening|reading|playing|browsing|editing|writing)|what\s+was\s+on\s+my\s+screen|what\s+was\s+playing|what\s+(song|music|video|show|movie)\s+was\s+(playing|on)|what\s+was\s+that|show\s+me\s+(my\s+)?(recent|past)\s+(activity|screen|history))\b/i.test(text)) return true;
      // "that thing/link/article I saw earlier" style recall
      if (/\bthat\s+(thing|article|link|page|site|website|video|song|music|post|tweet|image|picture|photo|meme|file|email|message|recipe|document|tab|window)\b.{0,50}\b(i\s+)?(saw|had|looked|read|watched|opened|visited|saved|copied|sent|received|found)\b/i.test(text)) return true;
      // Time-qualified recall: a past-time marker + recall-ish verb/noun
      if (_EPISODIC_RE.test(text) && /\b(what|did|show|find|was|were|saw|looked|watched|read|played|listened|open|had|screen|activity|doing|working|listening|watching)\b/i.test(text)) return true;
      return false;
    },
  },

  // ── memory_store: "remember that X", "note this down" ───────────────────────
  {
    intent: 'memory_store',
    test: (text) => {
      if (/\b(remember\s+(that|this|it)|note\s+(that|this|down)|take\s+a\s+note|write\s+(this|that|it)\s+down|jot\s+(this|that|it)\s+down|keep\s+(this|that|it)\s+in\s+mind|add\s+(this|that|it)\s+to\s+(your\s+)?(memory|notes|records))\b/i.test(text)) return true;
      return false;
    },
  },

  // ── command_automate: named app + action verb, or app-free action patterns ──
  {
    intent: 'command_automate',
    test: (text) => {
      // Episodic/recall phrasing is never automation — let memory_retrieve win
      // even when a named app + action verb are both present.
      if (_EPISODIC_RE.test(text)) return false;
      // Named app with an action verb → command_automate
      if (_NAMED_APP_RE.test(text) && _ACTION_VERB_RE.test(text)) return true;
      // Action verb + specific site (e.g. "go to amazon.com")
      if (/\b(go\s+to|navigate\s+to|open|launch|visit|browse\s+to)\s+\S+\.(com|org|net|io|ai|co|app|gov|edu)\b/i.test(text)) return true;
      // Scheduling/reminders — ACTION phrasing only ("remind me to/at/in"),
      // never recall ("remind me what we…" is memory_retrieve, checked above).
      if (/\b(schedule|set\s+(up\s+)?(a\s+|an\s+)?(reminder|alarm|timer|meeting|event|appointment)|alarm|timer|cron)\b/i.test(text)) return true;
      if (/\bremind\s+me\s+(to|at|in|on|tomorrow|today|tonight)\b/i.test(text)) return true;
      // Messaging without a named app: "send an email to Bob", "text Sarah", "call my mom"
      if (/\b(send|compose|reply\s+to|forward|write|draft)\s+(an?\s+|the\s+)?(email|e-?mail|message|msg|text|dm|note|letter|invite|invitation)\b/i.test(text)) return true;
      if (/\b(email|e-mail|text|dm|message|call|phone|facetime)\s+(my\s+|me\s+)?(mom|dad|wife|husband|boss|team|him|her|them|back|[a-z]{2,})\b/i.test(text)) return true;
      // Post/share/upload to a platform: "post this on social media", "share to twitter"
      if (/\b(post|tweet|share|upload|publish|comment)\b.{0,30}\b(on|to)\s+(my\s+)?\w+/i.test(text)) return true;
      // App/window/file ops without a named app: "open my downloads folder", "quit the app"
      if (/\b(open|launch|start|close|quit|restart|minimize|maximize|hide|show)\s+(the\s+|my\s+|this\s+|that\s+|a\s+|an\s+)?[\w\s]{0,25}?\s*(app|application|program|folder|window|tab|browser|terminal|settings|preferences)\b/i.test(text)) return true;
      // Local file ops: "create a file", "find my downloads folder", "delete this document"
      if (/\b(create|make|new|add|delete|rename|move|copy|find|locate|open|show)\s+(a\s+|an\s+|the\s+|my\s+)?[\w\s]{0,25}?\s*(file|folder|document|doc|note|page|spreadsheet|sheet|presentation|slide|playlist)\b/i.test(text)) return true;
      // New personal items: "new reminder", "add a contact", "create a calendar event"
      if (/\b(create|make|new|add|set\s+up)\s+(a\s+|an\s+)?(note|event|calendar\s+event|reminder|contact|playlist|album|board|task|to-?do|appointment|meeting)\b/i.test(text)) return true;
      // System controls: "turn off wifi", "toggle dark mode", "set volume to 50"
      if (/\b(turn|toggle|switch|enable|disable|activate|deactivate)\s+(on|off|up|down)?\s*(the\s+|my\s+)?(wi-?fi|bluetooth|volume|brightness|dark\s*mode|light\s*mode|do\s*not\s*disturb|dnd|airplane(\s*mode)?|night\s*shift|true\s*tone|hotspot|vpn|microphone|mic|camera|location|notifications?|flashlight|low\s*power\s*mode)\b/i.test(text)) return true;
      if (/\b(set|adjust|change|increase|decrease|raise|lower|turn\s+(up|down)|mute|unmute)\s+(the\s+|my\s+)?(volume|brightness|resolution|wallpaper|font\s*size|screen\s*time|keyboard|mouse|trackpad|display|backlight)\b/i.test(text)) return true;
      // Media transport: "play some music", "skip this track", "next episode"
      if (/\b(play|pause|resume|stop|skip|rewind|fast\s*forward)\s+(the\s+|my\s+|some\s+|this\s+)?(song|music|track|video|movie|show|episode|podcast|playlist|album|audio|it|this)\b/i.test(text)) return true;
      if (/\b(next|previous|prev|skip)\s+(track|song|episode|video|chapter)\b/i.test(text)) return true;
      // Screenshots & screen recording
      if (/\b(take|capture|grab|snap)\s+(a\s+|an\s+)?(screenshot|screen\s*shot|screen\s*(recording|capture|grab)|photo\s+of\s+(my|the)\s+screen|picture\s+of\s+(my|the)\s+screen)\b|\bscreenshot\s+(this|my|the)\b|\bscreen\s*record/i.test(text)) return true;
      // Inbox/calendar checks that require opening an app: "check my email"
      if (/\b(check|read|open|show|pull\s+up|look\s+at)\s+(my\s+)?(email|e-?mail|inbox|gmail|messages|texts|dms|calendar|schedule|notifications?|voicemail|slack|teams)\b/i.test(text)) return true;
      // Browser automation keywords
      if (/\b(click|type\s+into|fill\s+(out|in)|submit|press\s+(the\s+)?(button|key|enter))\b/i.test(text)) return true;
      return false;
    },
  },

  // ── web_search: "what's the best X", "latest Y", "current Z", media lookup ──
  // MUST be checked before general_knowledge so "What is the best pizza?" matches
  // web_search (recommendation) not general_knowledge (stable fact).
  {
    intent: 'web_search',
    test: (text) => {
      // Explicit web search / lookup verbs
      if (/\b(search|google|look\s+up|look\s+for|find\s+(me\s+)?(online|on\s+the\s+(web|internet)|info|information|details|a|an|the|some))\b/i.test(text)) return true;
      // Image/media display: "show me a thinking emoji", "find pictures of cats"
      if (/\b(show|find|get|display|pull\s+up|give)\s+(me\s+)?(a\s+|an\s+|the\s+|some\s+)?[\w-]{0,15}[\w\s-]{0,20}?\s*(image|images|picture|pictures|photo|photos|pic|pics|emoji|emojis|icon|icons|logo|logos|gif|gifs|meme|memes|thumbnail|thumbnails|wallpaper|wallpapers|video|videos)\b/i.test(text)) return true;
      if (/\bwhat\s+(does|do)\s+.{0,50}?\s+look\s+like\b/i.test(text)) return true;
      // "Best X" / "top X" (recommendations need search)
      // Matches both "What's the best X" and "What is the best X"
      if (/\b(what'?(?:s|\s+is)\s+the\s+best|what\s+are\s+the\s+best|top\s+\d+|best\s+\w+\s+(for|to|in)|recommend\s+(a|an|some))\b/i.test(text)) return true;
      if (/\b(best|top|top\s+rated|good|great|highest\s+rated|most\s+popular|recommended)\s+[\w\s]{1,40}\s+(nearby|near\s+me|in\s+\w+|to\s+(buy|get|try|watch|read|visit|use)|for)\b/i.test(text)) return true;
      // Recipes & how-to
      if (/\b(recipe|recipes|how\s+to\s+(make|cook|bake|fix|repair|build|grow|tie|draw|do|get|remove|clean|install|set\s+up)|instructions\s+(for|on|to)|tutorial|diy)\b/i.test(text)) return true;
      // Time-sensitive queries
      if (/\b(latest|current|today'?s|this\s+week'?s|recent\s+news|what\s+happened\s+today|right\s+now|as\s+of\s+(now|today)|news|headlines|breaking\s+news|weather)\b/i.test(text)) return true;
      // Prices, reviews, comparisons
      if (/\b(price|prices|pricing|cost|costs|cheapest|deals?|discounts?|sales?|reviews?|ratings?)\s+(of|for|on|to)\b/i.test(text)) return true;
      if (/\b(vs\.?|versus|compare|comparison|difference\s+between|better\s+than)\b/i.test(text)) return true;
      // Current office-holders / live data
      if (/\b(who\s+is\s+the\s+current|who\s+is\s+the\s+\w+\s+right\s+now|what\s+is\s+the\s+latest|price\s+of|stock\s+price)\b/i.test(text)) return true;
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
      // Question words — contracted AND expanded forms ("what's", "what is")
      if (/\b(what('?s|\s+is|\s+are|\s+was|\s+were|\s+does|\s+do|\s+did)|who('?s|\s+is|\s+was|\s+were|\s+wrote|\s+invented|\s+discovered|\s+created|\s+made)|when\s+(was|were|did|is|will)|where\s+(is|was|were|are|did)|why\s+(is|are|does|do|did|was|were)|how\s+(does|do|did|many|much|long|old|far|tall|big)|which\s+(is|are|was|were))\b/i.test(text)) return true;
      if (/\b(explain|define|tell\s+me\s+(about|what|who|why|how)|meaning\s+of|capital\s+of|population\s+of|what\s+(time|day|date)(\s+is|\s+of)?)\b/i.test(text)) return true;
      // Math & unit conversions: "what is 5*7", "convert 88s to minutes"
      if (/\b(calculate|compute|convert|solve|what\s+is|what'?s)\b.{0,30}\b\d+|\b\d+\s*(plus|minus|times|divided|percent|degrees|celsius|fahrenheit|miles|km|feet|inches|kg|pounds|ounces|cups|minutes|seconds|hours)\b/i.test(text)) return true;
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
