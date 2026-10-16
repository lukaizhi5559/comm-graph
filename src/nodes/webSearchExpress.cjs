'use strict';

/**
 * webSearchExpress.cjs — express lane for standalone public web searches.
 *
 * The stategraph's web_search lane wraps ~1.4s of SERP fetch in ~7-10s of
 * orchestration (LLM classify → classifyTask → spine hops → retrieveMemory →
 * LLM answer synthesis → logConversation). For a standalone lookup none of
 * that context is used — this node calls the same :3002/web.search service
 * directly and returns the overview/cards verbatim.
 *
 * Gate discipline (isEligible): the lane only admits prompts that are
 * context-free — no pronoun referent, no continuation markers, no selection,
 * no open plan, no file/screen/personal referents. Anything ambiguous falls
 * through to classify → handoff → stategraph where resolveReferencesV2 can
 * resolve it properly. Under-claim is safe; over-claim is not.
 *
 * Result shape matches the stategraph lane's renderer contract: metadata
 * carries `sources` + `items` which main.js emits as \x00SOURCES\x00 and
 * \x00ITEMS\x00 sentinel chunks — identical cards in the overlay.
 *
 * Env: WEB_SEARCH_EXPRESS=0 disables the lane entirely.
 */

const http = require('http');
const logger = require('../logger.cjs');
const { askEarly, buildMessages } = require('../llm-providers.cjs');
const {
  isContextDependent,
  FILE_PATH_RE,
  LOCAL_FS_PROBE_RE,
  SCREEN_OBSERVATION_RE,
  LIVE_PAGE_REF_RE,
} = require('../../../shared/text-patterns.cjs');

const WEB_SEARCH_PORT = parseInt(process.env.WEB_SEARCH_PORT || '3002', 10);
const MEMORY_PORT = parseInt(process.env.MEMORY_SERVICE_PORT || '3001', 10);
const WS_API_KEY = process.env.MCP_WEB_SEARCH_API_KEY || process.env.MCP_WEBSEARCH_API_KEY || process.env.MCP_API_KEY || '';
const MEM_API_KEY = process.env.MCP_USER_MEMORY_API_KEY || process.env.USER_MEMORY_API_KEY || process.env.MCP_API_KEY || '';
const SERP_TIMEOUT_MS = parseInt(process.env.WEB_SEARCH_EXPRESS_TIMEOUT_MS || '12000', 10);
const EXPRESS_ENABLED = process.env.WEB_SEARCH_EXPRESS !== '0';

// Media intent hint — computed on the ENGLISH (translated) prompt so it works
// for non-English queries too. The service's own classifier also detects
// explicit phrasing; this hint only reinforces (search.js applies it when the
// service-side classification is 'web').
const IMAGE_HINT_RE = /\b(images?|pictures?|photos?|pics|wallpapers?|logos?|icons?|gifs?|memes?|thumbnails?)\b/i;
const VIDEO_HINT_RE = /\b(videos?|clips?|trailers?|tutorials?|episodes?)\b/i;

// Continuation/follow-up shapes the pronoun check misses — "again", "too",
// "more like that". These only make sense against prior context.
const FOLLOWUP_SHAPE_RE = /^(?:yes|yeah|yep|ok(?:ay)?|sure|please|now|then|again|more|another|same|also|too|and|next|continue|go\s+ahead|what\s+about|how\s+about)\b|\b(?:too|again|instead|as\s+well|this\s+time|as\s+before|the\s+same)\s*[.?!]?\s*$/i;

// Personal/local referents — a web SERP cannot answer these.
const PERSONAL_DATA_RE = /\bmy\s+(notes?|files?|folders?|documents?|downloads?|desktop|inbox|e?-?mails?|calendar|contacts?|bookmarks?|photos?|reminders?|history|saved)\b|\b(?:saved|bookmarked|stored)\s+(?:in|on|to)\s+(?:my|the)\b/i;

/**
 * @param {string} text         - English prompt (selection chips stripped)
 * @param {Object} opts         - { hasSelectionContext, openPlan, hasAttachment }
 */
function isEligible(text, opts = {}) {
  if (!EXPRESS_ENABLED) return false;
  const t = String(text || '').trim();
  if (t.length < 8 || t.split(/\s+/).length < 3) return false;
  if (opts.hasSelectionContext || opts.openPlan || opts.hasAttachment) return false;
  // Pronoun-subject follow-ups ("how long has he been in office") — the
  // referent lives in conversation history; classifyTask resolves it.
  if (isContextDependent(t)) return false;
  if (FOLLOWUP_SHAPE_RE.test(t)) return false;
  if (PERSONAL_DATA_RE.test(t)) return false;
  // File paths, local-fs probes, and live screen/page referents can never be
  // answered by a public SERP — the stategraph owns those.
  if (FILE_PATH_RE.test(t) || LOCAL_FS_PROBE_RE.test(t)) return false;
  if (SCREEN_OBSERVATION_RE.test(t) || LIVE_PAGE_REF_RE.test(t)) return false;
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

function _hostname(url) {
  try { return new URL(url).hostname.replace(/^www\./, ''); } catch (_) { return ''; }
}

// Semantic memory search — runs in parallel with the SERP fetch so memory
// blending costs ~0 added latency. Hits only fold into the synth prompt.
function _memorySearch(query) {
  if (!MEM_API_KEY) return Promise.resolve(null);
  return _postJson(MEMORY_PORT, '/memory.search', {
    version: 'mcp.v1', service: 'user-memory', action: 'memory.search',
    payload: { query, limit: 3, minSimilarity: 0.3 },
    requestId: 'cg_wsx_mem_' + Date.now(),
  }, MEM_API_KEY, 3000).then((parsed) => {
    const results = parsed?.data?.results || parsed?.data || [];
    if (!Array.isArray(results) || !results.length) return null;
    return results
      .map(r => r.text || r.content || r.value || '')
      .filter(s => s.length > 4)
      .slice(0, 2)
      .join('\n') || null;
  });
}

// Normalize a raw result to the stategraph's contextDoc shape (webSearch.js
// :130-172) then project to the renderer's item contract (answer.js :826-846).
function _toItem(r) {
  const url = r.url || r.link || null;
  const isImage = r.type === 'image-result' || r.type === 'image';
  const isVideo = r.type === 'video-result' || r.type === 'video';
  const imageUrl = isImage
    ? (r.metadata?.properties?.url || r.thumbnail || r.imageUrl || null)
    : isVideo
      ? (r.metadata?.thumbnail?.src || r.thumbnail?.src || r.metadata?.properties?.thumbnail
          || (typeof r.thumbnail === 'string' ? r.thumbnail : null))
      : (r.metadata?.thumbnail?.src || (typeof r.thumbnail === 'string' ? r.thumbnail : null));
  const itemUrl = (url && url.startsWith('http')) ? url
    : (isImage ? (r.metadata?.properties?.originalUrl || r.originalUrl || null) : null);
  const item = {
    title: r.title || undefined,
    imageUrl: imageUrl || undefined,
    url: itemUrl || undefined,
    snippet: r.snippet || r.description || undefined,
    // Real destination host from the SERP cite row — r.url is often a wrapped
    // google.com/goto link whose derived hostname would render 'google.com'.
    hostname: r.displayDomain || _hostname(itemUrl || imageUrl || '') || undefined,
    // Structured rich-snippet fields (google-serp extraction); the card also
    // parses item.snippet as fallback for providers that don't emit them.
    rating: r.rating !== undefined ? r.rating : undefined,
    ratingMax: r.ratingMax !== undefined ? r.ratingMax : undefined,
    reviewCount: r.reviewCount !== undefined ? r.reviewCount : undefined,
    priceRange: r.priceRange || undefined,
    mediaType: isVideo ? 'video' : undefined,
    duration: isVideo ? (r.metadata?.duration || r.duration || undefined) : undefined,
    channel: isVideo ? (r.metadata?.channel || r.channel || undefined) : undefined,
  };
  return (item.imageUrl || item.url) ? item : null;
}

/**
 * Attempt the express answer. Returns a result object on success, null to
 * abstain (service down, no results) — the caller then takes the normal path.
 *
 * @param {Object} opts
 *   englishText      - translated prompt
 *   originalText     - raw prompt (used as the SERP query when non-English)
 *   detectedLanguage - 'en', 'zh', …
 *   context          - formatted conversation history for the synth fallback
 */
async function execute(opts) {
  const { englishText, originalText, detectedLanguage, context } = opts || {};
  const t0 = Date.now();
  try {
    // Search in the user's own language (mirrors the webSearch node's
    // original-language logic); the media hint comes from the translation.
    const query = (detectedLanguage && detectedLanguage !== 'en' && originalText)
      ? originalText.trim() : englishText.trim();
    const mediaHint = VIDEO_HINT_RE.test(englishText) ? 'video'
      : IMAGE_HINT_RE.test(englishText) ? 'image' : null;

    const [serp, memoryCtx] = await Promise.all([
      _postJson(WEB_SEARCH_PORT, '/web.search', {
        version: 'mcp.v1', service: 'web-search', action: 'web.search',
        payload: {
          query,
          limit: mediaHint ? 8 : 5,
          ...(mediaHint ? { maxResults: 8, intent: mediaHint } : {}),
          ...(detectedLanguage && detectedLanguage !== 'en' ? { lang: detectedLanguage } : {}),
        },
        requestId: 'cg_wsx_' + Date.now(),
        context: { userId: 'local_user' },
      }, WS_API_KEY, SERP_TIMEOUT_MS),
      _memorySearch(englishText),
    ]);

    const data = serp?.data || serp;
    const results = Array.isArray(data?.results) ? data.results : [];
    const overview = typeof data?.aiOverview === 'string' ? data.aiOverview.trim() : '';
    if (!results.length && overview.length < 40) {
      // Distinguish "service unreachable/timed out" (serp null) from "service
      // answered but empty" — both abstain, but they mean very different things.
      logger.warn('[SearchExpress] abstained', {
        reason: serp ? 'no-results' : 'serp-unreachable-or-timeout',
        latencyMs: Date.now() - t0, queryPreview: query.substring(0, 60),
      });
      return null;
    }

    // Dedupe by hostname — two Yelp results add no value as separate source
    // pills. displayDomain (from the SERP cite row) gives the real host even
    // when r.url is a wrapped google.com/goto link.
    const seenHosts = new Set();
    const sources = results
      .filter(r => (r.url || r.link || '').startsWith('http'))
      .map(r => {
        const url = r.url || r.link;
        return {
          url, title: r.title || '',
          hostname: r.displayDomain || _hostname(url),
          snippet: r.snippet || r.description || '',
        };
      })
      .filter(s => s.hostname && !seenHosts.has(s.hostname) && seenHosts.add(s.hostname))
      .slice(0, 10);
    const items = results.map(_toItem).filter(Boolean).slice(0, 24);

    let text;
    if (overview.length > 40) {
      // Google's AI Overview IS the answer — zero LLM calls.
      text = overview;
    } else {
      // One-shot synthesis grounded on fresh snippets (+ any memory hits).
      const snippets = results.slice(0, 5)
        .map(r => `- ${r.title || ''}: ${r.snippet || r.description || ''}`.trim())
        .filter(s => s.length > 6);
      let synthPrompt = 'You are answering a web search query. Answer in 1-3 short sentences using ONLY the fresh results below — do not invent facts. If the results do not answer the question, say what you found instead.';
      if (snippets.length) synthPrompt += `\n\nRESULTS:\n${snippets.join('\n')}`;
      if (memoryCtx) synthPrompt += `\n\nUSER CONTEXT (personal memories — use only if relevant):\n${memoryCtx}`;
      try {
        const { firstSentence, fullText } = await askEarly(
          buildMessages(englishText, synthPrompt, context),
          { maxTokens: 220, temperature: 0.5 },
        );
        text = (fullText || firstSentence || '').trim();
      } catch (_) { text = ''; }
      if (!text) text = "Here's what I found:"; // cards carry the answer
    }

    logger.info('[SearchExpress] answered', {
      latencyMs: Date.now() - t0, overview: overview.length > 40,
      results: results.length, items: items.length,
      mediaHint, queryPreview: query.substring(0, 60),
    });
    return {
      text,
      fullText: text,
      metadata: {
        source: 'search_express',
        provider: 'web-search',
        intent: 1,
        guessedIntent: 'web_search',
        sources,
        items,
        mediaHint,
      },
    };
  } catch (err) {
    logger.warn('[SearchExpress] failed — falling through to normal pipeline', { error: err.message });
    return null;
  }
}

module.exports = { execute, isEligible };
