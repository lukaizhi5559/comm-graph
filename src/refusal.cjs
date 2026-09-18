'use strict';

/**
 * refusal.cjs — canned LLM refusal detection + conversation-context hygiene
 *
 * Free-tier providers (notably mistral-small) occasionally emit canned safety
 * refusals like "I'm afraid I can't assist with that." for benign prompts.
 * The backend now intercepts most of these (RefusalError → provider fallback),
 * but two gaps remain on this side:
 *
 *   1. Already-poisoned history — refusal lines logged BEFORE the backend fix
 *      still get injected into prompts as "Assistant: I'm afraid I can't…",
 *      and models mimic the refusal voice. sanitizeContext() strips them.
 *   2. All-providers-refused — the backend's grace path returns the last
 *      refusal text when every provider declines. isCannedRefusal() lets
 *      callers treat that as a handoff signal instead of echoing it.
 *
 * Detection mirrors thinkdrop-backend's REFUSAL_OPENERS approach: normalized
 * startsWith matching against refusal-specific openers plus a length cap —
 * no regexes. Openers are deliberately specific so legitimate answers like
 * "I can't help but notice…" are NOT flagged.
 */

const REFUSAL_OPENERS = [
  "i'm afraid i can't",
  "i'm afraid i cannot",
  "i am afraid i can't",
  "i am afraid i cannot",
  "i can't assist",
  "i cannot assist",
  "i can't help with",
  "i cannot help with",
  "i can't help you with",
  "i cannot help you with",
  "i'm sorry, but i can't",
  "i'm sorry but i can't",
  "i'm sorry, but i cannot",
  "i'm sorry but i cannot",
  "i'm sorry, i can't assist",
  "sorry, but i can't",
  "i'm not able to assist",
  "i'm unable to",
  "i am unable to",
  "i must decline",
  "i have to decline",
  "i cannot fulfill",
  "i can't fulfill",
  "i cannot comply",
  "i can't comply",
  "i can't provide that",
  "i cannot provide that",
  "as an ai, i can't",
  "as an ai, i cannot",
  "as an ai language model",
  "unfortunately, i can't assist",
  "unfortunately, i cannot assist",
  "unfortunately, i'm unable",
  "i apologize, but i can't",
  "i apologize, but i cannot",
];

/** Canned refusals are short (Mistral's is 36 chars). Longer refusal-led
 * answers ("I can't help with that, but here's what I can do: …") are
 * legitimate and must not be flagged. */
const REFUSAL_MAX_LEN = 300;

const _WS_CHARS = new Set([' ', '\t', '\n', '\r', '\f', '\v']);

/** Normalize for matching: lowercase, straight quotes, single spaces — string ops only. */
function _normalize(text) {
  const s = String(text || '')
    .trimStart()
    .toLowerCase()
    .replaceAll('‘', "'")
    .replaceAll('’', "'");
  let out = '';
  let inWs = false;
  for (const ch of s) {
    if (_WS_CHARS.has(ch)) {
      if (!inWs) out += ' ';
      inWs = true;
    } else {
      out += ch;
      inWs = false;
    }
  }
  return out;
}

/**
 * Is this complete text a canned refusal?
 * Requires a refusal opener AND short overall length.
 */
function isCannedRefusal(text) {
  const n = _normalize(text);
  if (!n || n.length > REFUSAL_MAX_LEN) return false;
  return REFUSAL_OPENERS.some(o => n.startsWith(o));
}

/**
 * Strip canned-refusal Assistant lines from formatted conversation context.
 * Both _formatContext() and service-fetched history render turns as
 * "User: …\nAssistant: …" lines, so line-wise filtering covers both sources.
 * User lines are always kept.
 */
function sanitizeContext(context) {
  if (!context) return context;
  return String(context)
    .split('\n')
    .filter(line => {
      const t = line.trimStart();
      if (!t.startsWith('Assistant:')) return true;
      return !isCannedRefusal(t.slice('Assistant:'.length));
    })
    .join('\n');
}

module.exports = { REFUSAL_OPENERS, REFUSAL_MAX_LEN, isCannedRefusal, sanitizeContext };
