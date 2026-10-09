'use strict';

/**
 * generalQuick.cjs — Intent 1: direct LLM response with personality
 *
 * Handles chitchat, greetings, opinions, and simple knowledge questions
 * that the LLM can answer directly without any tools.
 * Uses askEarly() for fast first-sentence resolution (~300-500ms).
 *
 * If the LLM fails (backend down, all providers exhausted), sets
 * metadata.shouldHandoff = true so the server dispatches to the main
 * state graph. Returns a random handoff phrase as immediate acknowledgment.
 *
 * ── Sentinel-based handoff detection ──────────────────────────────────────────
 * The persona prompt teaches the LLM to use handoff phrases ("Routing that to
 * ThinkDrop now"). This conflicts with general_quick's purpose — answering
 * directly. Instead of detecting handoff-style natural language with fragile
 * regex patterns, we append a DIRECT ANSWER MODE directive that overrides the
 * persona's routing instructions and tells the LLM to either answer directly
 * or output exactly `0` (the existing handoff intent number) if it cannot.
 * This is robust across model changes and new phrasings.
 */

const logger = require('../logger.cjs');
const http = require('http');
const { askEarly, buildMessages } = require('../llm-providers.cjs');
const { getRandomHandoffPhrase } = require('../handoffPhrases.cjs');
const { isCannedRefusal, isPromptEcho, isRoutingPromise, stripRoutingPromises } = require('../refusal.cjs');
const { isContextDependent } = require('../../../shared/text-patterns.cjs');

const WEB_SEARCH_PORT = parseInt(process.env.WEB_SEARCH_PORT || '3002', 10);
const WS_API_KEY = process.env.MCP_WEB_SEARCH_API_KEY || process.env.MCP_WEBSEARCH_API_KEY || process.env.MCP_API_KEY || '';
const SERP_FIRST_ENABLED = process.env.GENERAL_QUICK_SERP !== '0';
const SERP_TIMEOUT_MS = 7000;

// Questions asking about ThinkDrop/the assistant itself — a persona echo is
// the CORRECT answer for these, never a sentinel.

// ── Direct answer mode directive ─────────────────────────────────────────────
// Appended to the system prompt to override the persona's handoff phrase
// instructions. Tells the LLM to answer directly or signal 0 (handoff).
const DIRECT_ANSWER_DIRECTIVE = `

═══════════════════════════════════════════════
DIRECT ANSWER MODE — ACTIVE NOW
═══════════════════════════════════════════════
You are in DIRECT ANSWER mode. The user's message was classified as something
you can answer directly with your own knowledge.

Answer the user's question directly and concisely — keep it to 1-2 short sentences.
Do NOT use any handoff or routing phrases like "Routing that to ThinkDrop",
"Let me check on that", "Passing that along", or "Let me look that up".
Do NOT promise to look something up — either answer now, or signal that you cannot.

For "how long" / elapsed-time questions: compute the duration carefully from
CURRENT LOCAL TIME — state the start date and the elapsed span; do the date
arithmetic explicitly before answering.

If you cannot answer because:
- You lack real-time or live data (current prices, news, weather, current office-holders)
- Your knowledge is outdated or has a cutoff date
- You lack the capability or tools for what's being asked
- The question needs web search, browser access, file access, or device context
- A [File: /path] or [Folder: /path] tag appears in the message — those are
  path references you CANNOT open or read; if the request needs the file's
  contents or modifies it, signal 0
- The question asks about PAST CONVERSATIONS or chat history beyond what is shown
  in the context — you can only see this session's recent turns, so questions
  like "what did we talk about yesterday", "have we chatted before", or
  "look up our previous conversation" MUST signal 0 (a deeper system searches
  the full transcript)

...or if a proper answer would be long-form — code blocks, scripts, essays,
detailed step-by-step guides, creative writing, documents (a deeper system
handles those) — then respond with EXACTLY: 0
Nothing else. Just the number 0. No explanation, no handoff phrase.

NEVER confirm or acknowledge an action you cannot perform yourself —
"Understood — I'll add X", "I'll get that done" without an actual result is
the WORST possible output. If the request is an action, signal 0.
A routing phrase is not an answer — if you would say "let me route/pass/hand
that to ThinkDrop", output 0 instead.
═══════════════════════════════════════════════`;

// ── Selection variant ────────────────────────────────────────────────────────
// Used when the prompt carries [Highlighted:] text — the user pointed at text
// and asked about it. Same rules, but the answer deserves real depth (the
// chitchat 1-2-sentence cap is too thin for "explain this").
const SELECTION_ANSWER_DIRECTIVE = `

═══════════════════════════════════════════════
DIRECT ANSWER MODE — ACTIVE NOW
═══════════════════════════════════════════════
You are in DIRECT ANSWER mode. The user's message includes a [Highlighted:]
block — text they selected on screen. Their question is about THAT text.

Answer the question about the highlighted text fully but concisely — up to ~4
sentences, more structure only if the text genuinely warrants it.
If the highlighted text is short, ambiguous, or partial, still answer
best-effort — say what the text appears to be, or ask a one-line clarifying
question — rather than signaling 0. Reserve 0 for requests that need tools
or access you don't have.
Do NOT use any handoff or routing phrases like "Routing that to ThinkDrop",
"Let me check on that", "Passing that along", or "Let me look that up".
Do NOT promise to look something up — either answer now, or signal that you cannot.

If you cannot answer because:
- The question asks for an ACTION (search, open, save, send, run, edit a file…),
  not an answer about the text
- A [File: /path] or [Folder: /path] tag appears in the message — those are
  path references you CANNOT open or read; if the request needs the file's
  contents or modifies it, signal 0
- You lack real-time or live data, web/browser/file access, or device context
- The question asks about PAST CONVERSATIONS or chat history beyond what is shown

...then respond with EXACTLY: 0
Nothing else. Just the number 0. No explanation, no handoff phrase.

NEVER confirm or acknowledge an action you cannot perform yourself —
"Understood — I'll add X", "I'll get that done" without an actual result is
the WORST possible output. If the request is an action, signal 0.
A routing phrase is not an answer — if you would say "let me route/pass/hand
that to ThinkDrop", output 0 instead.
═══════════════════════════════════════════════`;

// Questions asking about ThinkDrop/the assistant itself — a persona echo is
// the CORRECT answer for these, never a sentinel.
const SELF_REFERENTIAL_RE = /\bthinkdrop\b|\bwho are you\b|\bwhat can you do\b|\byour (?:capabilit\w*|features?|tools?|skills?|limits?)\b|\babout yourself\b/i;

// ── SERP-first gate ──────────────────────────────────────────────────────────
// Knowledge-shaped questions try web.search before the LLM: a captured AI
// Overview is a free, fresher, sourced answer. Chitchat/personal/recall/
// self-referential/selection prompts are excluded — they have no SERP answer.
const KNOWLEDGE_QUESTION_RE = /^(?:who|what|when|where|which|whose|why|how)\b|\bwhat(?:'s| is| are| was| were)\b|\bwho(?:'s| is| are| was| were)\b|\bdefine\b|\bexplain\b|\btell me about\b|\bhow (?:many|much|old|long|far|tall|deep|fast)\b|\bwhen (?:did|does|will|is|was)\b|\blatest\b|\bcurrent(?:ly)?\b|\btoday'?s?\b|\bnews\b|\bprice of\b|\bweather\b/i;
const PERSONAL_OR_RECALL_RE = /\b(my|our|we|us)\b|\b(yesterday|earlier|before|last time|we talked|we discussed|chatted|our conversation|remind me what)\b/i;
const GREETING_RE = /^\s*(hi|hello|hey|yo|good\s+(morning|afternoon|evening)|thanks|thank you|ok(?:ay)?|cool|nice|lol)\b/i;

function _isKnowledgeQuestion(text) {
  const t = String(text || '').trim();
  if (!t || t.length < 8) return false;
  if (SELF_REFERENTIAL_RE.test(t)) return false;
  if (GREETING_RE.test(t)) return false;
  if (PERSONAL_OR_RECALL_RE.test(t)) return false;
  // Pronoun-subject prompts ("how long has he been in office") carry no
  // referent — a SERP lookup sends the literal "he" to Google and returns
  // whoever IT picks (observed: Trump→Biden follow-up). The LLM path gets
  // conversationContext and binds the pronoun itself.
  if (isContextDependent(t)) return false;
  if (!KNOWLEDGE_QUESTION_RE.test(t)) return false;
  return true;
}

function _postJson(port, urlPath, payload, apiKey, timeoutMs) {
  return new Promise((resolve) => {
    const body = JSON.stringify(payload);
    const req = http.request({
      hostname: '127.0.0.1', port, path: urlPath, method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
        ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
      },
      timeout: timeoutMs,
    }, (res) => {
      let data = '';
      res.on('data', (c) => { data += c; });
      res.on('end', () => { try { resolve(JSON.parse(data)); } catch (_) { resolve(null); } });
    });
    req.on('timeout', () => { req.destroy(); resolve(null); });
    req.on('error', () => resolve(null));
    req.write(body);
    req.end();
  });
}

// Returns { answer, sources } when the SERP captured a usable AI Overview,
// else null. Never throws — any failure falls through to the LLM path.
async function _serpAnswer(query, lang) {
  if (!WS_API_KEY) return null;
  const res = await _postJson(WEB_SEARCH_PORT, '/web.search', {
    version: 'mcp.v1', service: 'web-search', action: 'web.search',
    payload: { query, maxResults: 3, ...(lang && lang !== 'en' ? { lang } : {}) },
    requestId: 'cg_gq_ws_' + Date.now(),
    context: { userId: 'local_user' },
  }, WS_API_KEY, SERP_TIMEOUT_MS);
  const data = res?.data || res;
  const overview = typeof data?.aiOverview === 'string' ? data.aiOverview.trim() : '';
  if (overview.length > 40) {
    const sources = (data?.results || [])
      .filter(r => r.url && r.url.startsWith('http')).slice(0, 5)
      .map(r => ({ url: r.url, title: r.title || '', hostname: (() => { try { return new URL(r.url).hostname.replace(/^www\./, ''); } catch (_) { return ''; } })() }));
    return { answer: overview, sources };
  }
  // No overview — return whatever snippets exist so the caller can ground the
  // LLM call on fresh results instead of stale training knowledge.
  const snippets = (data?.results || []).slice(0, 3)
    .map(r => `- ${r.title || ''}: ${r.snippet || r.description || ''}`.trim())
    .filter(s => s.length > 4);
  return snippets.length ? { snippets } : null;
}

/**
 * @param {string} englishText  - English user message
 * @param {string} systemPrompt - Full system prompt (persona + personality overlay + language)
 * @param {string} [conversationContext] - Recent conversation turns for context awareness
 * @param {Object} [opts] - { hasSelectionContext } — swap in the selection-aware directive
 * @returns {Promise<{ text: string, fullText: string, metadata: Object }>}
 */
async function execute(englishText, systemPrompt, conversationContext, opts = {}) {
  try {
    // ── SERP-first for knowledge questions ────────────────────────────────────
    // A captured AI Overview is a free, fresher, sourced answer — skip the LLM
    // entirely. Selection-context prompts are excluded (the highlighted text
    // lives on the user's screen, not on the SERP).
    let serpSnippets = null;
    if (SERP_FIRST_ENABLED && !opts.hasSelectionContext && _isKnowledgeQuestion(englishText)) {
      const _searchQuery = (opts.detectedLanguage && opts.detectedLanguage !== 'en' && opts.originalPrompt)
        ? opts.originalPrompt : englishText;
      try {
        const serp = await _serpAnswer(_searchQuery, opts.detectedLanguage);
        if (serp?.answer) {
          logger.info('[GeneralQuick] serp_overview — skipping LLM', {
            chars: serp.answer.length, lang: opts.detectedLanguage || 'en',
            inputPreview: englishText.substring(0, 60),
          });
          return {
            text: serp.answer,
            fullText: serp.answer,
            metadata: { source: 'serp_overview', provider: 'web-search', intent: 1, sources: serp.sources },
          };
        }
        serpSnippets = serp?.snippets || null;
      } catch (e) {
        logger.warn('[GeneralQuick] SERP-first failed — falling through to LLM', { error: e.message });
      }
    }

    // Append direct-answer directive to override the persona's routing instructions
    let directPrompt = systemPrompt +
      (opts.hasSelectionContext ? SELECTION_ANSWER_DIRECTIVE : DIRECT_ANSWER_DIRECTIVE);
    // No overview but we do have fresh snippets — ground the LLM on them so the
    // answer isn't stale-cutoff knowledge (and fewer sentinel-0 handoffs).
    if (serpSnippets) {
      directPrompt += `\n\nWEB CONTEXT (fresh search results — ground your answer in these when relevant):\n${serpSnippets.join('\n')}`;
    }
    const messages = buildMessages(englishText, directPrompt, conversationContext);
    const { firstSentence, fullText, provider } = await askEarly(messages, {
      maxTokens: opts.hasSelectionContext ? 400 : 150,
      temperature: 0.7,
    });

    const response = firstSentence || fullText;

    // ── Sentinel check: LLM signals it cannot answer ────────────────────────
    // Covers empty responses, explicit 0 (handoff) signals, canned refusals —
    // and system-prompt echoes: a failing provider may dump the persona block
    // ("ThinkDrop is a full desktop AI …") as the answer instead of emitting
    // 0 (observed on a TCP/UDP interview-prep question). Self-referential
    // questions ("what can you do") are exempt — the persona block IS the
    // correct answer there.
    const refusal = isCannedRefusal(response);
    const promptEcho = !SELF_REFERENTIAL_RE.test(englishText) && isPromptEcho(response, systemPrompt);
    // Routing-promise backstop: the persona teaches "route with confidence —
    // never say I can't", so the model sometimes writes "Let me route that to
    // ThinkDrop now" instead of the 0 sentinel. Check fullText — the deferral
    // usually trails a benign-looking first sentence. Whatever the words
    // claim, a quick lane cannot route — honor the intent and hand off.
    const routingPromise = isRoutingPromise(fullText || response);
    if (!response || !response.trim() || response.trim() === '0' || refusal || promptEcho || routingPromise) {
      const phrase = getRandomHandoffPhrase();
      // A non-routing lead sentence ("Understood — I'll add placeholders …")
      // is a better ack than a generic phrase — and stays true now that the
      // dispatch is real.
      const handoffAck = routingPromise ? (stripRoutingPromises(fullText || response) || null) : null;
      logger.info('[GeneralQuick] Handoff signaled', {
        phrase, provider,
        reason: !response ? 'empty' : (refusal ? 'refusal' : (promptEcho ? 'prompt-echo' : (routingPromise ? 'routing-promise' : 'sentinel'))),
      });
      return {
        text: phrase,
        fullText: phrase,
        metadata: { source: 'handoff', provider, intent: 1, shouldHandoff: true, ...(handoffAck ? { handoffAck } : {}) },
      };
    }

    logger.info('[GeneralQuick] Response', {
      provider,
      chars: response.length,
      inputPreview: englishText.substring(0, 60),
    });

    return {
      text: response,
      fullText: fullText || response,
      metadata: { source: 'general_quick', provider, intent: 1 },
    };
  } catch (err) {
    // LLM call threw — hand off to main state graph
    const phrase = getRandomHandoffPhrase();
    logger.error('[GeneralQuick] Error — handing off', { error: err.message, phrase });
    return {
      text: phrase,
      fullText: phrase,
      metadata: { source: 'handoff', provider: 'none', intent: 1, shouldHandoff: true },
    };
  }
}

module.exports = { execute };
