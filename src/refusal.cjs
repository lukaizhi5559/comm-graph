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

const { ROUTING_PROMISE_RE } = require('../../shared/text-patterns.cjs');

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

/**
 * Is this response an echo of the model's own system prompt? Failing
 * providers sometimes dump their instructions verbatim as the answer
 * (observed: "explain the difference between TCP and UDP" → the persona
 * capability listicle "ThinkDrop is a full desktop AI …" instead of an
 * answer or a 0 sentinel). Detection is line-overlap: if a majority of the
 * response's content lines appear verbatim in the system prompt, it is an
 * echo, not an answer.
 */
function isPromptEcho(response, systemPrompt) {
  // Compare word sequences — markdown (**bold**, - bullets, #) decorates the
  // echo but never the source, so strip to alphanumerics before matching.
  const strip = s => _normalize(s).replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim();
  const sys = strip(systemPrompt);
  if (!sys) return false;
  // Split the RAW response on sentence/line boundaries first — a bullet
  // block echoes as one long segment whose words still align contiguously.
  const lines = String(response || '')
    .split(/[.\n!?]+/)
    .map(strip)
    .filter(l => l.length >= 12);
  // Short single-line replies ("Hi! How can I help you today?") contain the
  // same assistant boilerplate the persona prompt itself uses — a 12-char
  // substring match flags them as echoes and spuriously hands them off. Only
  // the multi-line path is reliable; a lone line must be long AND not generic
  // boilerplate to count as an echo.
  if (lines.length < 2) {
    const whole = strip(response);
    if (whole.length < 60) return false;
    const BOILERPLATE = /\b(how can i (help|assist)|how may i (help|assist)|what can i do|let me know|anything else|how are you|nice to (meet|see))\b/;
    return !BOILERPLATE.test(whole) && sys.includes(whole);
  }
  const hits = lines.filter(l => sys.includes(l)).length;
  return hits >= 2 && hits >= Math.ceil(lines.length / 2);
}

/**
 * Is this response a routing/deferral promise instead of an answer?
 * The persona teaches "route with confidence — never say I can't", so quick
 * lanes sometimes emit "Let me route that to ThinkDrop now" / "let me pull
 * that up" instead of the 0 sentinel. From a lane with no execution, those
 * words are a lie — callers must convert the match into a real handoff.
 * English-only; runs on the lane's pre-translation output.
 */
function isRoutingPromise(text) {
  return ROUTING_PROMISE_RE.test(String(text || ''));
}

/**
 * Remove routing-promise sentences from a response, keeping whatever real
 * content preceded them ("Understood — I'll add placeholders …" survives
 * once the "Let me route that to ThinkDrop now." tail is dropped). Returns
 * '' when nothing but deferral prose remains.
 */
function stripRoutingPromises(text) {
  const s = String(text || '');
  if (!s.trim()) return '';
  const kept = s
    .split(/(?<=[.!?])\s+|\n+/)
    .map(sentence => sentence.trim())
    .filter(sentence => sentence && !ROUTING_PROMISE_RE.test(sentence));
  return kept.join(' ').trim();
}

module.exports = { REFUSAL_OPENERS, REFUSAL_MAX_LEN, isCannedRefusal, isPromptEcho, isRoutingPromise, stripRoutingPromises, sanitizeContext };
