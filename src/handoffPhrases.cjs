'use strict';

/**
 * handoffPhrases.cjs — Natural acknowledgment phrases for handoff
 *
 * When comms-graph can't answer a prompt directly (LLM failure or needs
 * main state graph), it picks a random phrase from this list so the user
 * gets an immediate, natural, varied response instead of a static fallback
 * or an apology.
 *
 * Phrases are short (1-6 words), personable, and match ThinkDrop's
 * "sharp, composed AI butler" tone.
 */

const PHRASES = [
  'One moment.',
  'Checking now.',
  'On it.',
  'Let me look into that.',
  'Give me a second.',
  'Looking that up.',
  'Right away.',
  'Let me check.',
  'Hold on — I\'ll find out.',
  'Processing that now.',
  'Just a moment.',
  'Let me think about that.',
  'Working on it.',
  'Give me just a sec.',
  'Checking that for you.',
  'On it — one moment.',
  'Let me get that for you.',
  'Sure — looking now.',
  'Let me see what I can find.',
  'Digging into that now.',
  'Give me a beat.',
  'Hang tight.',
  'Let me pull that up.',
  'Coming right up.',
  'Let me work on that.',
  'I\'m on it.',
  'Checking my notes.',
  'One sec.',
  'Let me find out for you.',
  'Looking into it now.',
  'Just a sec.',
  'Let me get right back to you.',
  'Processing — hold tight.',
  'Let me sort that out.',
  'Give me a moment to check.',
  'On the case.',
  'Let me see what I\'ve got.',
  'Checking now — won\'t be long.',
  'Let me dig into that.',
  'Brief pause — looking it up.',
  'Let me trace that down.',
  'Working on it now.',
  'Give me a second to check.',
  'Let me pull that together.',
  'Hold on, checking.',
  'Let me get you an answer.',
  'Right — looking into that.',
  'Let me sort that out for you.',
  'Just looking that up now.',
  'One moment, please.',
  'Let me check on that.',
  'Checking — just a moment.',
  'On it — give me a second.',
  'Let me find the right answer.',
  'Looking that up now.',
  'Let me get to the bottom of that.',
  'Give me a flash.',
  'Let me see here.',
  'Checking that out.',
  'Let me work through that.',
  'Hold tight — checking now.',
  'Let me get you sorted.',
  'On it — won\'t be a minute.',
  'Let me look that over.',
  'Checking into it.',
  'Let me get the details.',
  'Give me a tick.',
  'Let me track that down.',
  'Looking it up — one moment.',
  'Let me put that together.',
  'Checking — back in a flash.',
  'Let me see what comes up.',
  'On it — just looking now.',
  'Let me find you a solid answer.',
  'Give me a moment to dig in.',
  'Checking that out now.',
  'Let me get to work on that.',
  'Let me see what I can pull up.',
  'On it — checking the details.',
  'Give me a second to look that up.',
  'Let me get that sorted for you.',
];

let _lastIndex = -1;

/**
 * Get a random handoff phrase.
 * Tracks the last index to avoid repeating the same phrase twice in a row.
 * @returns {string}
 */
function getRandomHandoffPhrase() {
  if (PHRASES.length <= 1) return PHRASES[0];
  let idx;
  do {
    idx = Math.floor(Math.random() * PHRASES.length);
  } while (idx === _lastIndex);
  _lastIndex = idx;
  return PHRASES[idx];
}

module.exports = { PHRASES, getRandomHandoffPhrase };
