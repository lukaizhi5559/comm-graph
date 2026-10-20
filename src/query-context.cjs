'use strict';

/**
 * query-context.cjs — standalone SERP query construction for the quick lanes.
 *
 * The web-search service is stateless: it receives only a query string, so a
 * follow-up utterance ("who has ALS?" after a Chris Johnson NFL lookup) hits
 * Google/Bing/DDG verbatim and returns an answer about the wrong subject.
 * The stategraph's webSearch node already solves this by consuming
 * classifyTask's followUpTarget; this module gives the comms-graph quick
 * lanes (generalQuick SERP-first, webSearchExpress) the same capability:
 *
 *   1. routeDecision.isFollowUp + followUpTarget  → prepend the resolved
 *      subject — free, deterministic, zero extra LLM calls.
 *   2. routeDecision.isFollowUp + no target        → return null; the caller
 *      must SKIP the SERP — a context-free search can only answer wrong, so
 *      the context-aware LLM path takes over.
 *   3. No envelope (direct quick-lane classification) + conversation history →
 *      a bounded LLM rewrite to a standalone query (~300-500ms, temp-0, fail-
 *      open to the raw question). Catches no-pronoun follow-ups that
 *      isContextDependent's regex cannot see ("who has ALS?").
 *   4. No history at all → the question verbatim, zero cost.
 */

const { ask } = require('./llm-providers.cjs');
const logger = require('./logger.cjs');

const REWRITE_TIMEOUT_MS = 5000;
const REWRITE_MAX_TOKENS = 40;
// Longer than this is not a search query — a rewriter leak (instructions,
// explanation) degrades to the raw question instead of polluting the SERP.
const MAX_QUERY_LEN = 200;

const REWRITE_SYSTEM = `You rewrite a user's latest message as a standalone web search query.
Use the conversation context to resolve references — who/what/which the user is
asking about — and add the missing subject so the query stands alone.
If the message is already a self-contained search query, return it VERBATIM.
Output ONLY the query text: no quotes, no explanation, no question-answering.`;

function _rewriteMessages(question, conversationContext) {
  return [
    { role: 'system', content: REWRITE_SYSTEM },
    {
      role: 'user',
      content: `Conversation context (recent turns):\n${conversationContext}\n\nLatest message: ${question}`,
    },
  ];
}

/** Loose sanity check on a rewritten query — single line, sane length, has letters. */
function _looksLikeQuery(s) {
  const t = String(s || '').trim();
  return t.length >= 3 && t.length <= MAX_QUERY_LEN && !/[\n\r]/.test(t) && /[a-z]/i.test(t);
}

/**
 * Prepend the resolved subject unless the question already carries it.
 * "Chris Johnson" + "who has ALS?" → "Chris Johnson who has ALS?" — the same
 * shape stategraph webSearch uses for context-resolved follow-ups.
 */
function _withTarget(target, question) {
  const t = String(target || '').trim();
  const q = String(question || '').trim();
  if (!t) return q;
  return q.toLowerCase().includes(t.toLowerCase()) ? q : `${t} ${q}`;
}

/**
 * @param {string}      question             - English (or original-language) query text
 * @param {string}     [conversationContext] - "User:/Assistant:" recent-turns block
 * @param {Object}     [routeDecision]       - classifyTask envelope from classifyRoute()
 * @returns {Promise<string|null>} the query to send to /web.search, or null to
 *          signal "skip SERP — follow-up referent unresolvable".
 */
async function standaloneSearchQuery(question, conversationContext, routeDecision) {
  const q = String(question || '').trim();
  if (!q) return null;
  const rd = routeDecision || null;
  const hasCtx = !!(conversationContext && String(conversationContext).trim());

  // Envelope path — the single upstream classification already weighed the
  // conversation. Trust its verdict; only the follow-up fork needs action.
  if (rd && rd.isFollowUp === true) {
    if (!rd.followUpTarget) {
      logger.info('[QueryContext] follow-up with unresolved referent — SERP would answer wrong', {
        queryPreview: q.substring(0, 60),
      });
      return null;
    }
    const resolved = _withTarget(rd.followUpTarget, q);
    if (resolved !== q) {
      logger.info('[QueryContext] followUpTarget applied', {
        from: q.substring(0, 60), to: resolved.substring(0, 80),
      });
    }
    return resolved;
  }

  // No envelope (or a standalone verdict) — a follow-up may still have slipped
  // the quick-tier regex gates. When history exists, one bounded rewrite makes
  // the query standalone; standalone questions come back verbatim.
  if (!hasCtx) return q;
  try {
    const { text } = await ask(_rewriteMessages(q, conversationContext), {
      maxTokens: REWRITE_MAX_TOKENS,
      temperature: 0,
      timeoutMs: REWRITE_TIMEOUT_MS,
      taskType: 'classification',
    });
    const rewritten = String(text || '').trim().replace(/^["'`]+|["'`]+$/g, '').trim();
    if (_looksLikeQuery(rewritten)) {
      if (rewritten.toLowerCase() !== q.toLowerCase()) {
        logger.info('[QueryContext] standalone rewrite', {
          from: q.substring(0, 60), to: rewritten.substring(0, 80),
        });
      }
      return rewritten;
    }
    logger.warn('[QueryContext] rewrite unusable — using raw query', { raw: rewritten.substring(0, 80) });
    return q;
  } catch (e) {
    logger.warn('[QueryContext] rewrite failed — using raw query', { error: e.message });
    return q;
  }
}

module.exports = { standaloneSearchQuery };
