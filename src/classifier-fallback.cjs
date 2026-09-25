'use strict';

/**
 * classifier-fallback.cjs — Embedding-based intent classification fallback
 *
 * Used only when the force-prompt LLM classification fails or returns
 * an unparseable response. Uses cosine similarity against pre-computed
 * seed embeddings (same technique as voice-service voice-classifier.cjs).
 *
 * This is intentionally lightweight — the force-prompt is the primary
 * classifier. This just prevents total failure.
 */

const logger = require('./logger.cjs');

// ── Seed examples per intent ──────────────────────────────────────────────────
const HANDOFF_SEEDS = [
  'Go to ChatGPT and search for vegan food',
  'Open Chrome and navigate to Gmail',
  'Look up the weather in Philadelphia',
  'Search the web for the latest AI news',
  'Close Zoom for me',
  'Open Safari and go to biblegateway.com',
  'Find the best restaurants near me',
  'Download this file',
  'Send an email to John about the project',
  'Schedule a meeting for Friday',
  'Go to Perplexity, Grok and ChatGPT and compare results',
  'What was I doing two hours ago',
  'List all my appointments for next week',
  'Remember I have a meeting tomorrow at 3pm',
  'Take a screenshot of my screen',
  'Run the build script',
];

const GENERAL_QUICK_SEEDS = [
  'Hello', 'Hi there', 'Hey', 'Good morning', 'Good afternoon',
  'What do you think about jazz?',
  'Do you like the color black?',
  'Can you hear me?',
  'Are you there?',
  "What's your name?",
  'Who are you?',
  'What can you do?',
  'Thank you', 'Thanks a lot', 'Got it', 'Sure', 'Okay',
  'Why is the sky blue?',
  'What is quantum computing?',
  'Explain how photosynthesis works',
  "What's two plus two?",
];

const MEMORY_QUICK_SEEDS = [
  "What's my name?",
  'What is my name?',
  'Do you know my name?',
  'What is my email?',
  'What is my favorite color?',
  'What do you know about me?',
  'How old am I?',
  'What is my job?',
  'Tell me about myself',
];

const STATUS_CHECK_SEEDS = [
  "How is that task going?",
  'Are you done yet?',
  'What is the status?',
  'How far along are you?',
  'Is it still running?',
  "How's that ChatGPT search coming?",
  'Any progress on that?',
  'Still working on it?',
];

const CONTROL_SIGNAL_SEEDS = [
  'Cancel that task',
  'Stop what you are doing',
  'Pause the current task',
  'Resume the task',
  'Abort',
  'Never mind, forget it',
  'Cancel everything',
];

const MEMORY_STORE_SEEDS = [
  'I have a dentist appt next week friday',
  'Remember I have a meeting at 3pm',
  'Note: buy milk tomorrow',
  'I have a flight on Monday',
  'Remember I need to call my mom this weekend',
  'I have an appointment with Dr. Smith on Tuesday',
  'Just noting that I finished the report',
];

const ALL_SEEDS = {
  0: HANDOFF_SEEDS,
  1: GENERAL_QUICK_SEEDS,
  2: MEMORY_QUICK_SEEDS,
  3: STATUS_CHECK_SEEDS,
  4: CONTROL_SIGNAL_SEEDS,
  5: MEMORY_STORE_SEEDS,
};

// ── Simple keyword-based fallback (no model dependency) ────────────────────────
// This is a pure regex/keyword matcher — no embeddings needed.
// It's less accurate than the model-based approach but works with zero
// dependencies and zero startup time. The force-prompt is the primary
// classifier; this only fires when the LLM is completely unavailable.
function _keywordClassify(text) {
  const lower = text.toLowerCase().trim();

  // Control signals
  if (/\b(cancel|stop|abort|pause|resume|never\s*mind|forget\s*it)\b/i.test(lower)) {
    return { intent: 4, confidence: 0.7 };
  }

  // Status checks — asking about the system's own in-flight work.
  // Covers "how is it going", "status", "still running", plus interrogatives
  // like "what's running right now" and "did my task finish" — the class of
  // questions whose subject is the task journal, not the outside world.
  if (/\b(how\s+is|how's|status|progress|done\s+yet|still\s+running|how\s+far|coming\s+along)\b/i.test(lower)
      || /\b(did|has|is|are|was|were)\b[^?]{0,40}\b(task|job|it|that|this|anything|something)\b[^?]{0,25}\b(finish|finished|done|complete|completed|running|working|going)\b/i.test(lower)
      || /\bwhat'?s?\s+(still\s+)?(running|going\s+on|happening|in\s+progress|pending|queued)\b/i.test(lower)) {
    return { intent: 3, confidence: 0.7 };
  }

  // Conversation recall — meta-questions about the chat transcript itself
  // Route to handoff so the stategraph can search the full conversation history
  if (/\b(did\s+we|have\s+we|what\s+did\s+we|what\s+were\s+we|what\s+we\s+were)\s+(talk|speak|chat|discuss)|what\s+did\s+i\s+(just\s+)?(ask|say)|what\s+was\s+my\s+(last|previous)\s+(question|prompt|message)|look\s+(that\s+|it\s+)?up\s+in\s+(your\s+|the\s+)?(memory|conversation|chat|history)|remind\s+me\s+what\s+we|check\s+(your\s+|the\s+)?(memory|conversation|chat|history)|in\s+our\s+(conversation|chat|history)\b/i.test(lower)) {
    return { intent: 0, confidence: 0.7 };
  }

  // Memory quick — personal fact recall
  if (/\b(what's?\s+my\s+name|my\s+name|my\s+email|my\s+favorite\s+color|how\s+old\s+am\s+i|my\s+job|about\s+me)\b/i.test(lower)) {
    return { intent: 2, confidence: 0.75 };
  }

  // Memory store — general memory/note/appointment (NOT personal profile fact).
  // NOTE: no trailing \b on the group — 'note:' ends in a non-word char so a
  // shared boundary can never match; and the "i have a(n) X event" pattern
  // allows zero middle words ("i have a flight") or one ("a dentist appt").
  if (/\b(remember\s+i\s+have|i\s+need\s+to\s+remember|just\s+noting|note\s*[:)]|i\s+have\s+an?\s+(?:\w+\s+){0,2}(appt|appointment|meeting|event|flight|call|reminder|deadline))/i.test(lower)) {
    return { intent: 5, confidence: 0.7 };
  }

  // Handoff — action verbs + targets
  if (/\b(go\s+to|open|close|search|look\s+up|find|browse|navigate|download|send|schedule|screenshot|what\s+was\s+i\s+doing|list\s+my)\b/i.test(lower)) {
    return { intent: 0, confidence: 0.65 };
  }

  // General quick — greetings, pleasantries, opinions, simple knowledge.
  // Mirrors GENERAL_QUICK_SEEDS vocabulary: short prompts with greeting or
  // question-word markers and no action/recall content. Fires above the 0.5
  // residual so the wiring threshold (conf > 0.5) accepts it — otherwise
  // "good morning" falls through to handoff and pays a full graph run.
  // "what is/what's" knowledge questions count too — but anything referencing
  // the system surface (screen/app/task/memory/history) is excluded: those
  // need the real graph (screen_intelligence / status / deep memory), and the
  // tiers above that wanted them have already had their shot.
  const _hasSystemRef = /\b(screen|app|window|task|memory|conversation|history|running|process)\b/i.test(lower);
  if (lower.split(/\s+/).length <= 15 && !_hasSystemRef &&
      /\b(hello|hi|hey|howdy|greetings|good\s+(morning|afternoon|evening|night|day)|how\s+are\s+you|how'?s\s+it\s+going|what'?s\s+up|thank(s|\s+you)|you'?re\s+welcome|bye|goodbye|see\s+you|joke|who\s+are\s+you|what'?s\s+your\s+name|are\s+you\s+(there|awake|alive)|can\s+you\s+hear\s+me|what\s+do\s+you\s+think|explain|tell\s+me\s+(a\s+|about\s+|why|how)|why\s+(is|are|does|do|did)|who\s+(is|was|were|wrote|invented)|when\s+(is|was|did)|where\s+(is|was)|how\s+(many|much|long|old|far)|is\s+(it|there|this|that)|do\s+you|what\s+(is|are|was|were)|what'?s)\b/i.test(lower)) {
    return { intent: 1, confidence: 0.65 };
  }

  // Default: general quick
  return { intent: 1, confidence: 0.5 };
}

/**
 * Classify using keyword matching (no model dependency).
 * @param {string} text - English utterance
 * @returns {Promise<{ intent: number, confidence: number }>}
 */
async function classify(text) {
  const result = _keywordClassify(text);
  logger.info('[ClassifyFallback] Keyword classification', {
    intent: result.intent,
    confidence: result.confidence,
    textPreview: text.substring(0, 60),
  });
  return result;
}

module.exports = { classify, _keywordClassify };
