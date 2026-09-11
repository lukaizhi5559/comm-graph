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

const ALL_SEEDS = {
  0: HANDOFF_SEEDS,
  1: GENERAL_QUICK_SEEDS,
  2: MEMORY_QUICK_SEEDS,
  3: STATUS_CHECK_SEEDS,
  4: CONTROL_SIGNAL_SEEDS,
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

  // Status checks
  if (/\b(how\s+is|how's|status|progress|done\s+yet|still\s+running|how\s+far|coming\s+along)\b/i.test(lower)) {
    return { intent: 3, confidence: 0.7 };
  }

  // Memory quick — personal fact recall
  if (/\b(what's?\s+my\s+name|my\s+name|my\s+email|my\s+favorite\s+color|how\s+old\s+am\s+i|my\s+job|about\s+me)\b/i.test(lower)) {
    return { intent: 2, confidence: 0.75 };
  }

  // Handoff — action verbs + targets
  if (/\b(go\s+to|open|close|search|look\s+up|find|browse|navigate|download|send|schedule|screenshot|remember\s+i|what\s+was\s+i\s+doing|list\s+my)\b/i.test(lower)) {
    return { intent: 0, confidence: 0.65 };
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

module.exports = { classify };
